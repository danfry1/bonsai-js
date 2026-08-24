/**
 * Single source of truth for the safe built-in method allowlist.
 *
 * Both runtime enforcement (`safeMethodFor` in this module) and the
 * autocomplete catalog (`METHODS_BY_TYPE` in autocomplete/catalog.ts) derive
 * from this table, so a method can never be suggested but rejected (or vice
 * versa). Keep this list intentionally small and audited: every entry is a
 * non-mutating, callback-or-primitive method that is safe to call on untrusted
 * data. `tests/autocomplete/catalog-sync.test.ts` enforces that the two views
 * stay aligned.
 */

/** Receiver types that have a method allowlist. */
export type MethodReceiverType = 'string' | 'array' | 'number'

/** Compact argument codes stored beside each allowlisted receiver. */
export type MethodArgumentCode = 's' | 'n' | 'p' | 'u' | 'a' | 'l'

type SafeMethodSpec = Partial<Readonly<Record<MethodReceiverType, string>>>

// Signature encoding: first character = required count; remaining characters
// are parameter kinds (s=string, n=number, p=primitive, u=unknown,
// a=array-or-primitive, l=Bonsai lambda); a trailing * repeats the last kind.
// Keeping the code beside the allowlist avoids shipping a duplicate method-key
// registry in the evaluator and checker bundles.
const SAFE_METHODS_TABLE = {
  // String-only
  startsWith: { string: '1sn' },
  endsWith: { string: '1sn' },
  substring: { string: '0nn' },
  charAt: { string: '0n' },
  charCodeAt: { string: '0n' },
  repeat: { string: '1n' },
  trim: { string: '0' },
  trimStart: { string: '0' },
  trimEnd: { string: '0' },
  toLowerCase: { string: '0' },
  toUpperCase: { string: '0' },
  replace: { string: '2ss' },
  replaceAll: { string: '2ss' },
  padStart: { string: '1ns' },
  padEnd: { string: '1ns' },
  split: { string: '0sn' },
  // String + Array
  includes: { string: '1sn', array: '1un' },
  indexOf: { string: '1sn', array: '1un' },
  lastIndexOf: { string: '1sn', array: '1un' },
  slice: { string: '0nn', array: '0nn' },
  at: { string: '1n', array: '1n' },
  concat: { string: '0p*', array: '0a*' },
  // Array-only (higher-order)
  filter: { array: '1l' },
  map: { array: '1l' },
  find: { array: '1l' },
  findIndex: { array: '1l' },
  some: { array: '1l' },
  every: { array: '1l' },
  flatMap: { array: '1l' },
  // Array-only (non-callback, non-mutating)
  join: { array: '0s' },
  flat: { array: '0n' },
  toReversed: { array: '0' },
  toSorted: { array: '0' },
  toSpliced: { array: '0nnu*' },
  with: { array: '2nu' },
  // Number
  toFixed: { number: '0n' },
  // Number + String
  toString: { number: '0n', string: '0' },
} as const satisfies Readonly<Record<string, SafeMethodSpec>>

const SAFE_METHODS: Readonly<Record<string, SafeMethodSpec>> = SAFE_METHODS_TABLE

// Capture audited intrinsics once. Looking them up on every call would allow
// application code to monkey-patch a built-in prototype after Bonsai loads and
// substitute arbitrary code behind an allowlisted method name.
const INTRINSIC_METHODS: Readonly<
  Record<
    MethodReceiverType,
    Readonly<Record<string, ((...args: unknown[]) => unknown) | undefined>>
  >
> = Object.freeze({
  string: captureIntrinsics(String.prototype, 'string'),
  number: captureIntrinsics(Number.prototype, 'number'),
  array: captureIntrinsics(Array.prototype, 'array'),
})

function captureIntrinsics(
  prototype: object,
  receiver: MethodReceiverType,
): Readonly<Record<string, ((...args: unknown[]) => unknown) | undefined>> {
  const captured: Record<string, ((...args: unknown[]) => unknown) | undefined> =
    Object.create(null)
  for (const [method, receivers] of Object.entries(SAFE_METHODS)) {
    if (receivers[receiver] === undefined) continue
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
    // Stryker disable next-line all: supported-host feature detection; every available intrinsic is exercised after capture
    captured[method] =
      descriptor && 'value' in descriptor && typeof descriptor.value === 'function'
        ? (descriptor.value as (...args: unknown[]) => unknown)
        : undefined
  }
  return Object.freeze(captured)
}

/** Map a runtime value to its method-receiver type, or undefined if it has none. */
function receiverTypeOf(obj: unknown): MethodReceiverType | undefined {
  const t = typeof obj
  if (t === 'string') return 'string'
  if (t === 'number') return 'number'
  if (Array.isArray(obj)) return 'array'
  return undefined
}

/** Whether `method` is a safe built-in method for the runtime type of `obj`. */
export function isMethodAllowedOn(obj: unknown, method: string): boolean {
  const receiver = receiverTypeOf(obj)
  if (receiver === undefined) return false
  const allowed = SAFE_METHODS[method]
  return allowed?.[receiver] !== undefined
}

/**
 * Resolve an allowlisted method from its audited intrinsic prototype rather
 * than from the receiver. Reading `receiver[method]` would allow an own
 * override, subclass, or inherited replacement to substitute arbitrary host
 * code for a name that Bonsai had classified as a safe built-in.
 */
export function safeMethodFor(
  obj: unknown,
  method: string,
): ((...args: unknown[]) => unknown) | undefined {
  const receiver = receiverTypeOf(obj)
  if (receiver === undefined) return undefined
  const allowed = SAFE_METHODS[method]
  if (allowed?.[receiver] === undefined) return undefined

  return INTRINSIC_METHODS[receiver][method]
}

/** All safe method names available on a given receiver type. */
export function methodsForReceiverType(type: MethodReceiverType): string[] {
  return Object.keys(SAFE_METHODS).filter((method) => SAFE_METHODS[method][type] !== undefined)
}

/** Compact runtime/checker signature code for an allowlisted method. */
export function methodSignatureCode(
  receiver: MethodReceiverType,
  methodName: string,
): string | undefined {
  return SAFE_METHODS[methodName]?.[receiver]
}

export function methodSignatureRequired(code: string): number {
  return Number(code[0])
}

export function methodSignatureHasRest(code: string): boolean {
  return code.endsWith('*')
}

export function methodSignatureParamCount(code: string): number {
  return code.length - 1 - (methodSignatureHasRest(code) ? 1 : 0)
}

export function methodSignatureArgument(
  code: string,
  index: number,
): MethodArgumentCode | undefined {
  const count = methodSignatureParamCount(code)
  if (index < count) return code[index + 1] as MethodArgumentCode
  if (methodSignatureHasRest(code) && count > 0) return code[count] as MethodArgumentCode
  return undefined
}
