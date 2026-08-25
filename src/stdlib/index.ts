/** String transforms: upper, lower, trim, split, replace, startsWith, endsWith, includes, padStart, padEnd. */
export { strings } from './strings.js'
/** Array transforms: filter, map, find, some, every, sort, reverse, flatten, unique, join, first, last, count. */
export { arrays } from './arrays.js'
/** Math transforms and functions: round, floor, ceil, abs, sum, avg, clamp, min, max. */
export { math } from './math.js'
/** Type-checking transforms: isString, isNumber, isArray, isNull, toBool, toNumber, toString. */
export { types } from './types.js'
/** Date transforms and functions: now, formatDate, diffDays. */
export { dates, createDates, type DatesOptions } from './dates.js'

import type { BonsaiPlugin } from '../types.js'
import { strings } from './strings.js'
import { arrays } from './arrays.js'
import { math } from './math.js'
import { types } from './types.js'
import { dates } from './dates.js'

/** Convenience plugin that registers all standard library modules at once. */
export const all: BonsaiPlugin = (expr) => {
  expr.use(strings)
  expr.use(arrays)
  expr.use(math)
  expr.use(types)
  expr.use(dates)
}
