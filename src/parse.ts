import type { Limits } from './environment.js'
import type { Node } from './syntax/ast.js'
import { DEFAULT_PARSE_LIMITS, parse as parseTree } from './syntax/parser.js'

const PARSE_LIMIT_KEYS = ['maxSourceLength', 'maxDepth', 'maxNodes'] as const

/** The limits parse() takes: the parse limits of {@link Limits}. */
export type ParseOptions = Pick<Limits, (typeof PARSE_LIMIT_KEYS)[number]>

/**
 * Parses an expression into a syntax tree without an environment, for tools
 * that only read, edit, and print trees (a visual editor ships just the
 * parser). It is what `env.parse` does: no checking, and the same limits
 * (default `maxSourceLength` 100,000, `maxDepth` 128, `maxNodes` 20,000).
 * Throws BonsaiSyntaxError or BonsaiLimitError.
 */
export function parse(source: string, limits: ParseOptions = {}): Node {
  if (typeof source !== 'string') throw new TypeError('An expression must be a string')
  if (typeof limits !== 'object' || limits === null) throw new TypeError('Limits must be an object')
  for (const key of Object.keys(limits)) {
    if (!(PARSE_LIMIT_KEYS as readonly string[]).includes(key))
      throw new TypeError(
        `Unknown parse limit "${key}" (expected one of: ${PARSE_LIMIT_KEYS.join(', ')})`,
      )
  }
  const value = (key: (typeof PARSE_LIMIT_KEYS)[number]): number => {
    const given = limits[key]
    if (given === undefined) return DEFAULT_PARSE_LIMITS[key]
    if (typeof given !== 'number') throw new TypeError(`Limit "${key}" must be a number`)
    if (!Number.isSafeInteger(given) || given < 1)
      throw new RangeError(`Limit "${key}" must be an integer of at least 1`)
    return given
  }
  return parseTree(source, {
    maxSourceLength: value('maxSourceLength'),
    maxDepth: value('maxDepth'),
    maxNodes: value('maxNodes'),
  })
}
