/**
 * Single source of truth for the safe built-in method allowlist.
 *
 * Both the runtime enforcement (`isAllowedReceiver` in eval-ops.ts) and the
 * autocomplete catalog (`METHODS_BY_TYPE` in autocomplete/catalog.ts) derive
 * from this table, so a method can never be suggested but rejected (or vice
 * versa). Keep this list intentionally small and audited: every entry is a
 * non-mutating, callback-or-primitive method that is safe to call on untrusted
 * data. `tests/autocomplete/catalog-sync.test.ts` enforces that the two views
 * stay aligned.
 */

/** Receiver types that have a method allowlist. */
export type MethodReceiverType = 'string' | 'array' | 'number'

// `as const` keeps each entry precisely typed; the exported view below adds a
// string index signature so methods can be looked up by an arbitrary name.
const SAFE_METHODS_TABLE = {
  // String-only
  startsWith: ['string'],
  endsWith: ['string'],
  substring: ['string'],
  charAt: ['string'],
  charCodeAt: ['string'],
  repeat: ['string'],
  trim: ['string'],
  trimStart: ['string'],
  trimEnd: ['string'],
  toLowerCase: ['string'],
  toUpperCase: ['string'],
  replace: ['string'],
  replaceAll: ['string'],
  padStart: ['string'],
  padEnd: ['string'],
  split: ['string'],
  // String + Array
  includes: ['string', 'array'],
  indexOf: ['string', 'array'],
  lastIndexOf: ['string', 'array'],
  slice: ['string', 'array'],
  at: ['string', 'array'],
  concat: ['string', 'array'],
  // Array-only (higher-order)
  filter: ['array'],
  map: ['array'],
  find: ['array'],
  findIndex: ['array'],
  some: ['array'],
  every: ['array'],
  flatMap: ['array'],
  // Array-only (non-callback, non-mutating)
  join: ['array'],
  flat: ['array'],
  toReversed: ['array'],
  toSorted: ['array'],
  toSpliced: ['array'],
  with: ['array'],
  // Number
  toFixed: ['number'],
  // Number + String
  toString: ['number', 'string'],
} as const

/** Method name -> the receiver types it is permitted on. */
export const SAFE_METHODS: Readonly<Record<string, readonly MethodReceiverType[]>> = SAFE_METHODS_TABLE

/** Map a runtime value to its method-receiver type, or undefined if it has none. */
export function receiverTypeOf(obj: unknown): MethodReceiverType | undefined {
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
  return allowed !== undefined && allowed.includes(receiver)
}

/** All safe method names available on a given receiver type. */
export function methodsForReceiverType(type: MethodReceiverType): string[] {
  return Object.keys(SAFE_METHODS).filter(method => SAFE_METHODS[method].includes(type))
}
