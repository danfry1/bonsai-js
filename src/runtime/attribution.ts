import type { BonsaiError } from '../errors.js'

/**
 * Which errors an evaluation may report as its own. Host data (a getter, a
 * Proxy trap) can throw a Bonsai error too: one from another evaluation, from
 * parsing, checking, or translating, or one the host built itself. Such an
 * error is the host data's failure, a HOST_ERROR, so an evaluation must tell
 * its own errors from those by identity, not by class or code.
 */

/** Errors an evaluation, a context validation, or a partial evaluation raised itself. */
const raisedHere = new WeakSet<BonsaiError>()
/** Errors that have left an evaluation or a partial evaluation for its caller. */
const escaped = new WeakSet<BonsaiError>()

/** Records `error` as raised by the evaluation (or validation) that creates it. */
export function raised<E extends BonsaiError>(error: E): E {
  raisedHere.add(error)
  return error
}

/**
 * Marks an error leaving an evaluation for its caller. Seen again inside an
 * evaluation, it came through host code (a getter that ran an evaluation of
 * its own, say), so it is that host data's failure, not this evaluation's.
 */
export function escaping<E>(error: E): E {
  if (raisedHere.has(error as BonsaiError)) escaped.add(error as BonsaiError)
  return error
}

/**
 * The reason a host call's signal is aborted with: a copy of the evaluation's
 * error, same class and fields, but not recorded as raised. Host code that
 * throws it from inside another evaluation (a getter calling
 * `signal.throwIfAborted()`, say) gives that evaluation a HOST_ERROR, and the
 * original stays this evaluation's own.
 */
export function forHost<E>(error: E): E {
  if (!raisedHere.has(error as BonsaiError)) return error
  return Object.create(
    Object.getPrototypeOf(error) as object,
    Object.getOwnPropertyDescriptors(error),
  ) as E
}

/**
 * Whether `error`, caught while reading host data, is the reading evaluation's
 * own. Decided by identity alone: a thrown Proxy can trap `instanceof`.
 */
export function isOwn(error: unknown): error is BonsaiError {
  return raisedHere.has(error as BonsaiError) && !escaped.has(error as BonsaiError)
}
