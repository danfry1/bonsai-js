/**
 * Internal helpers for invoking native array operations without delegating
 * control to receiver-provided constructors, species hooks, or spreadability
 * hooks. The common case (a normal array without own control hooks) remains
 * allocation-free; unusual receivers are copied by own index into a neutral
 * array-like input. Application-wide mutation of Array/Object primordials is a
 * trusted-host concern, not something expression text can perform.
 */

interface StepCharger {
  addSteps: (count: number) => void
}

const ARRAY_PROTOTYPE = Array.prototype

function readsArraySpecies(methodName: string): boolean {
  switch (methodName) {
    case 'concat':
    case 'filter':
    case 'flat':
    case 'flatMap':
    case 'map':
    case 'slice':
      return true
    default:
      return false
  }
}

/** Copy array data without consulting its iterator or inherited numeric keys. */
export function copyOwnArray(
  value: readonly unknown[],
  options: { readonly materializeHoles?: boolean; readonly charger?: StepCharger } = {},
): unknown[] {
  const length = value.length
  options.charger?.addSteps(length)
  const out: unknown[] = new Array<unknown>(length)
  for (let index = 0; index < length; index++) {
    if (Object.hasOwn(value, index)) out[index] = value[index]
    else if (options.materializeHoles === true) out[index] = undefined
  }
  return out
}

/**
 * Return an array suitable for a captured intrinsic call.
 *
 * Native result-producing array methods consult `receiver.constructor` and
 * `constructor[Symbol.species]`, even for ordinary arrays. `concat` also reads
 * `Symbol.isConcatSpreadable`. When those paths are receiver-controlled—or the
 * array is subclassed—we copy it and shadow `constructor` with `undefined`,
 * forcing ArraySpeciesCreate to use a plain Array without invoking host code.
 */
export function prepareArrayReceiver(
  value: unknown[],
  methodName: string,
  charger?: StepCharger,
): unknown[] {
  const readsSpecies = readsArraySpecies(methodName)
  const canUseDirectly =
    Object.getPrototypeOf(value) === ARRAY_PROTOTYPE &&
    (!readsSpecies || !Object.hasOwn(value, 'constructor')) &&
    (methodName !== 'concat' || !Object.hasOwn(value, Symbol.isConcatSpreadable))
  if (canUseDirectly) return value

  const out = copyOwnArray(value, { charger })
  Object.defineProperty(out, 'constructor', {
    configurable: true,
    value: undefined,
  })
  return out
}
