import { BonsaiLimitError } from '../errors.js'

/**
 * Whether `error` is the engine running out of call stack, by the engines' own
 * messages: a RangeError "Maximum call stack size exceeded" in V8 and
 * JavaScriptCore, an InternalError "too much recursion" in SpiderMonkey. Other
 * RangeErrors are ordinary failures. The depth limits keep every stage well
 * inside the stack, so this is a backstop for an engine with a smaller stack
 * than the ones measured.
 */
export function isStackOverflow(error: unknown): boolean {
  try {
    if (error instanceof RangeError)
      return error.message.startsWith('Maximum call stack size exceeded')
    return (
      error instanceof Error &&
      error.name === 'InternalError' &&
      error.message.startsWith('too much recursion')
    )
  } catch {
    // A thrown Proxy or a throwing `name` getter: host data, not the engine's stack.
    return false
  }
}

/**
 * The limit error for a stack overflow: the expression or a value nests too
 * deeply for the call stack. No option raises that bound, so `limit` is unset;
 * the engine's own error is its `cause`.
 */
export function tooDeep(source: string | undefined, cause?: unknown): BonsaiLimitError {
  return new BonsaiLimitError(
    'TOO_DEEP',
    'The expression or a value is nested too deeply for the call stack',
    { source, limit: null, cause },
  )
}

/** Runs `run`, turning a stack overflow into a TOO_DEEP limit error. */
export function guardDepth<T>(source: string | undefined, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (isStackOverflow(error)) throw tooDeep(source, error)
    throw error
  }
}
