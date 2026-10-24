/**
 * `bonsai-js/builtins`: every built-in function as its own export, for the
 * `builtins` option of bonsai-js/runtime/core's runtime() and of bonsai(). A
 * bundle keeps only the built-ins it imports. Namespace imports avoid clashes
 * with names such as `map` and `keys` in your own code:
 *
 * ```ts
 * import * as b from 'bonsai-js/builtins'
 * const builtins = [b.includes, b.some, b.now, b.days]
 * ```
 *
 * It lists every built-in in src/functions/builtins.ts; tests/runtime-core.test.ts
 * checks that it names each one.
 */
import type { Builtin } from '../environment.js'
import * as defs from '../functions/builtins.js'

export const toUpperCase = defs.toUpperCase as unknown as Builtin
export const toLowerCase = defs.toLowerCase as unknown as Builtin
export const trim = defs.trim as unknown as Builtin
export const trimStart = defs.trimStart as unknown as Builtin
export const trimEnd = defs.trimEnd as unknown as Builtin
export const startsWith = defs.startsWith as unknown as Builtin
export const endsWith = defs.endsWith as unknown as Builtin
export const includes = defs.includes as unknown as Builtin
export const indexOf = defs.indexOf as unknown as Builtin
export const lastIndexOf = defs.lastIndexOf as unknown as Builtin
export const slice = defs.slice as unknown as Builtin
export const split = defs.split as unknown as Builtin
export const replace = defs.replace as unknown as Builtin
export const replaceAll = defs.replaceAll as unknown as Builtin
export const padStart = defs.padStart as unknown as Builtin
export const padEnd = defs.padEnd as unknown as Builtin
export const repeat = defs.repeat as unknown as Builtin
export const at = defs.at as unknown as Builtin
export const matches = defs.matches as unknown as Builtin
export const toString = defs.toString as unknown as Builtin
export const toNumber = defs.toNumber as unknown as Builtin
export const round = defs.round as unknown as Builtin
export const floor = defs.floor as unknown as Builtin
export const ceil = defs.ceil as unknown as Builtin
export const trunc = defs.trunc as unknown as Builtin
export const abs = defs.abs as unknown as Builtin
export const sqrt = defs.sqrt as unknown as Builtin
export const clamp = defs.clamp as unknown as Builtin
export const toFixed = defs.toFixed as unknown as Builtin
export const formatNumber = defs.formatNumber as unknown as Builtin
export const formatCurrency = defs.formatCurrency as unknown as Builtin
export const min = defs.min as unknown as Builtin
export const max = defs.max as unknown as Builtin
export const sum = defs.sum as unknown as Builtin
export const avg = defs.avg as unknown as Builtin
export const map = defs.map as unknown as Builtin
export const filter = defs.filter as unknown as Builtin
export const find = defs.find as unknown as Builtin
export const findIndex = defs.findIndex as unknown as Builtin
export const some = defs.some as unknown as Builtin
export const every = defs.every as unknown as Builtin
export const none = defs.none as unknown as Builtin
export const flatMap = defs.flatMap as unknown as Builtin
export const sortBy = defs.sortBy as unknown as Builtin
export const groupBy = defs.groupBy as unknown as Builtin
export const count = defs.count as unknown as Builtin
export const reduce = defs.reduce as unknown as Builtin
export const sort = defs.sort as unknown as Builtin
export const reverse = defs.reverse as unknown as Builtin
export const unique = defs.unique as unknown as Builtin
export const flat = defs.flat as unknown as Builtin
export const first = defs.first as unknown as Builtin
export const last = defs.last as unknown as Builtin
export const join = defs.join as unknown as Builtin
export const isEmpty = defs.isEmpty as unknown as Builtin
export const keys = defs.keys as unknown as Builtin
export const values = defs.values as unknown as Builtin
export const entries = defs.entries as unknown as Builtin
export const type = defs.type as unknown as Builtin
export const now = defs.now as unknown as Builtin
export const timestamp = defs.timestamp as unknown as Builtin
export const duration = defs.duration as unknown as Builtin
export const weeks = defs.weeks as unknown as Builtin
export const days = defs.days as unknown as Builtin
export const hours = defs.hours as unknown as Builtin
export const minutes = defs.minutes as unknown as Builtin
export const seconds = defs.seconds as unknown as Builtin
export const milliseconds = defs.milliseconds as unknown as Builtin
export const inDays = defs.inDays as unknown as Builtin
export const inHours = defs.inHours as unknown as Builtin
export const inMinutes = defs.inMinutes as unknown as Builtin
export const inSeconds = defs.inSeconds as unknown as Builtin
export const inMilliseconds = defs.inMilliseconds as unknown as Builtin
export const year = defs.year as unknown as Builtin
export const month = defs.month as unknown as Builtin
export const day = defs.day as unknown as Builtin
export const hour = defs.hour as unknown as Builtin
export const minute = defs.minute as unknown as Builtin
export const second = defs.second as unknown as Builtin
export const dayOfWeek = defs.dayOfWeek as unknown as Builtin
export const startOfDay = defs.startOfDay as unknown as Builtin
export const startOfMonth = defs.startOfMonth as unknown as Builtin
export const startOfYear = defs.startOfYear as unknown as Builtin
export const addDays = defs.addDays as unknown as Builtin
export const addMonths = defs.addMonths as unknown as Builtin
export const addYears = defs.addYears as unknown as Builtin
export const formatDate = defs.formatDate as unknown as Builtin

export type { Builtin } from '../environment.js'
