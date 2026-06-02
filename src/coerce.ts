/**
 * Canonical string coercion for bonsai runtime values.
 *
 * Expression values are dynamic (`unknown`), and the language defines their
 * string form as JavaScript's own `String()` coercion. Centralising it here
 * gives a single, named definition of that semantic for every call site
 * (stdlib transforms, computed property keys, template interpolation).
 *
 * The `unknown` parameter is also what keeps `no-base-to-string` satisfied: the
 * rule rightly rejects `String(someObject)` where the type is statically `{}`,
 * but a genuinely dynamic value is `unknown` at this boundary. Funnelling
 * coercion through one `unknown`-typed function means the rule stays enabled
 * everywhere else to catch real "[object Object]" mistakes.
 */
export function coerceToString(value: unknown): string {
  return String(value)
}
