/**
 * Detect any Promise/A+ compatible value, including cross-realm Promises and
 * user-defined thenables. `instanceof Promise` is realm-specific and therefore
 * cannot enforce the synchronous evaluator boundary on its own.
 */
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  return typeof (value as { then?: unknown }).then === 'function'
}
