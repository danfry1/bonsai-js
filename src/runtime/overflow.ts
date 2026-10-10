import { BonsaiLimitError } from '../errors.js'

/**
 * Whether `error` is the engine running out of call stack: a RangeError in V8
 * and JavaScriptCore, an InternalError ("too much recursion") in SpiderMonkey.
 * The depth limits keep every stage well inside the stack, so this is a
 * backstop for an engine with a smaller stack than the ones measured.
 */
export function isStackOverflow(error: unknown): boolean {
  if (error instanceof RangeError) return /call stack|stack size/iu.test(error.message)
  return (
    error instanceof Error && error.name === 'InternalError' && /recursion/iu.test(error.message)
  )
}

/**
 * The limit error for a stack overflow: the expression or a value nests too
 * deeply for the call stack. No option raises that bound, so `limit` is unset.
 */
export function tooDeep(source: string | undefined): BonsaiLimitError {
  return new BonsaiLimitError(
    'TOO_DEEP',
    'The expression or a value is nested too deeply for the call stack',
    { source, limit: null },
  )
}

/** Runs `run`, turning a stack overflow into a TOO_DEEP limit error. */
export function guardDepth<T>(source: string | undefined, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (isStackOverflow(error)) throw tooDeep(source)
    throw error
  }
}
