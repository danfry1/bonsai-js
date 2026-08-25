const bonsaiLambdas = new WeakSet()

/** Mark a callback created by the expression evaluator as safe to invoke. */
export function createBonsaiLambda<T extends (...args: never[]) => unknown>(lambda: T): T {
  bonsaiLambdas.add(lambda)
  return lambda
}

/** Whether a callback was created by Bonsai rather than supplied as context data. */
export function isBonsaiLambda(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function' && bonsaiLambdas.has(value)
}
