import { BUILTINS } from './builtins.js'

/**
 * What each built-in does, in BUILTINS order, for describeFunction(),
 * listFunctions(), and the language service. Kept apart from the definitions,
 * so bundles that only evaluate (bonsai-js/runtime) leave the text out, and
 * by position, so the names are not repeated (each entry's comment names its
 * function, and tests/descriptions.test.ts checks them against BUILTINS).
 */
const TEXTS: readonly string[] = [
  // toUpperCase
  'Upper-cases text.',
  // toLowerCase
  'Lower-cases text.',
  // trim
  'Removes leading and trailing whitespace.',
  // trimStart
  'Removes leading whitespace.',
  // trimEnd
  'Removes trailing whitespace.',
  // startsWith
  'Whether text starts with a prefix.',
  // endsWith
  'Whether text ends with a suffix.',
  // includes
  'Whether text contains a substring, or a list contains a value.',
  // indexOf
  'Position of the first match, or -1.',
  // lastIndexOf
  'Position of the last match, or -1.',
  // slice
  'A section of text or a list; negative positions count from the end.',
  // split
  'Splits text on a separator.',
  // replace
  'Replaces the first occurrence of some text (no patterns).',
  // replaceAll
  'Replaces every occurrence of some text (no patterns).',
  // padStart
  'Pads text at the start to a length.',
  // padEnd
  'Pads text at the end to a length.',
  // repeat
  'Repeats text a number of times.',
  // at
  'The item or character at a position; negative positions count from the end.',
  // matches
  'Whether text contains a match for a regular expression (JavaScript syntax without backreferences or lookaround, linear time; anchor with ^ and $; prefix (?i) to ignore case).',
  // toString
  'Renders a value as text, as a template would.',
  // toNumber
  'Parses decimal text as a number, e.g. "-12.5" or "1e3" (surrounding whitespace is ignored; 0x and other bases are not accepted).',
  // round
  'Rounds half away from zero, optionally to a number of decimal digits.',
  // floor
  'Rounds down.',
  // ceil
  'Rounds up.',
  // trunc
  'Drops the fractional part.',
  // abs
  'Absolute value.',
  // sqrt
  'Square root.',
  // clamp
  'Limits a number to a range.',
  // toFixed
  'Formats a number with a fixed number of decimals.',
  // formatNumber
  'Formats a number with grouping, e.g. 1,234.5, with optional decimals and locale (default "en-US"; an unsupported locale is an error).',
  // formatCurrency
  'Formats an amount in a currency (ISO 4217 code such as "EUR"; a code without a known symbol prints as the code), with an optional locale (default "en-US"; an unsupported locale is an error).',
  // min
  'The smallest value (nulls are skipped); null for an empty list.',
  // max
  'The largest value (nulls are skipped); null for an empty list.',
  // sum
  'The sum of the numbers in a list (nulls are skipped), added left to right as a + b + c is.',
  // avg
  'The mean of the numbers or durations in a list (nulls are skipped, summed as sum does); null for an empty list.',
  // map
  'Transforms each item.',
  // filter
  'Keeps the items for which the lambda is true.',
  // find
  'The first item for which the lambda is true, or null.',
  // findIndex
  'The position of the first item for which the lambda is true, or -1.',
  // some
  'Whether the lambda is true for at least one item.',
  // every
  'Whether the lambda is true for every item.',
  // none
  'Whether the lambda is false for every item.',
  // flatMap
  'Transforms each item and flattens list results one level.',
  // sortBy
  'Sorts by a key; pass "desc" to reverse. Nulls sort first ("asc") or last ("desc").',
  // groupBy
  'Groups items into a map of lists by a key. Map keys are text, so a key is its text form: 1 and "1", or true and "true", share a group. A key must be a string, number, or boolean (null is an error). Keys are listed integer-like first, ascending, then in first-seen order.',
  // count
  'The number of items, or of items for which the lambda is true.',
  // reduce
  'Folds a list into one value: reduce(list, (acc, item) => ..., initial). Name both parameters; "." is not allowed, since the first one is the accumulator.',
  // sort
  'Sorts numbers, text, timestamps, or durations; pass "desc" to reverse.',
  // reverse
  'The items in reverse order.',
  // unique
  'The items without duplicates (by value), in first-seen order.',
  // flat
  'Flattens nested lists one level.',
  // first
  'The first item, or null.',
  // last
  'The last item, or null.',
  // join
  'Joins items into text with a separator (default ",").',
  // isEmpty
  'Whether a list, text, or map has no items; null is empty.',
  // keys
  'The keys of a map.',
  // values
  'The values of a map.',
  // entries
  'The entries of a map, as a list of { key, value } maps (not [key, value] pairs as in JavaScript), e.g. m.entries().map(.key + "=" + .value).',
  // type
  'The kind of a value: "null", "boolean", "number", "string", "list", "map", "timestamp", "duration", or "opaque".',
  // now
  'The current time, fixed for one evaluation.',
  // timestamp
  'Parses ISO-8601 text (years 0000-9999, or six digits with a sign such as +012345, as a timestamp renders) or epoch milliseconds (a fraction is dropped toward zero, as Date does) into a timestamp.',
  // duration
  'Parses ISO-8601 duration text in weeks, days, hours, minutes, and seconds (e.g. "PT1H30M", "-P2DT0.5S"), the text a duration renders as.',
  // weeks
  'A duration of n weeks.',
  // days
  'A duration of n days (24 hours each).',
  // hours
  'A duration of n hours.',
  // minutes
  'A duration of n minutes.',
  // seconds
  'A duration of n seconds.',
  // milliseconds
  'A duration of n milliseconds. Durations are whole milliseconds: a fraction rounds to the nearest one, halves away from zero.',
  // inDays
  'A duration as a (fractional) number of days.',
  // inHours
  'A duration as a number of hours.',
  // inMinutes
  'A duration as a number of minutes.',
  // inSeconds
  'A duration as a number of seconds.',
  // inMilliseconds
  'A duration as a number of milliseconds.',
  // year
  'The calendar year, in a time zone (default UTC).',
  // month
  'The month 1-12, in a time zone (default UTC).',
  // day
  'The day of the month, in a time zone (default UTC).',
  // hour
  'The hour 0-23, in a time zone (default UTC).',
  // minute
  'The minute, in a time zone (default UTC).',
  // second
  'The second, in a time zone (default UTC).',
  // dayOfWeek
  'The ISO weekday (Monday 1 to Sunday 7), in a time zone (default UTC).',
  // startOfDay
  'Midnight at the start of the day, in a time zone (default UTC).',
  // startOfMonth
  'Midnight on the first of the month, in a time zone (default UTC).',
  // startOfYear
  'Midnight on January 1, in a time zone (default UTC).',
  // addDays
  'Adds calendar days (keeps the wall-clock time across DST), in a time zone.',
  // addMonths
  'Adds calendar months, clamping the day to the month length.',
  // addYears
  'Adds calendar years (Feb 29 becomes Feb 28).',
  // formatDate
  "Formats a timestamp in a time zone (default UTC). Tokens: yyyy yy MMMM MMM MM M dd d EEEE EEE HH H hh h a mm m ss s SSS; quote literal text ('at'), and write '' for a quote ('it''s').",
]

let positions: Map<string, number> | undefined

/** A function's description: a host function's own, or a built-in's from the table. */
export function descriptionOf(def: {
  readonly name: string
  readonly description?: string
}): string {
  if (def.description !== undefined) return def.description
  positions ??= new Map([...BUILTINS.keys()].map((name, i) => [name, i]))
  const at = positions.get(def.name)
  return at === undefined ? '' : TEXTS[at]
}
