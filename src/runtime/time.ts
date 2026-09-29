import type { CallSite } from '../functions/define.js'
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND, shown, timeOf } from './values.js'

/** Calendar fields of an instant as seen on a wall clock in some time zone. */
export interface WallClock {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
  millisecond: number
}

const MONTHS_PER_YEAR = 12
const HOURS_PER_HALF_DAY = 12
const YEARS_PER_CENTURY = 100
const MINUTES_PER_HOUR = 60
const MAX_HOUR = 23
const MAX_MINUTE = 59
const MAX_SECOND = 59
const SUNDAY = 7

type CalendarFields = Pick<WallClock, 'year' | 'month' | 'day'> &
  Partial<Pick<WallClock, 'hour' | 'minute' | 'second' | 'millisecond'>>

/**
 * Date.UTC, but without mapping years 0-99 to 1900-1999, and by arithmetic.
 * Fields may overflow (day 0, month 13, hour 25) and normalize as in Date.UTC.
 * Out-of-range results stay finite; `checked` rejects them.
 */
function utc({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
}: CalendarFields): number {
  const months = month - 1
  const whole = year + Math.floor(months / MONTHS_PER_YEAR)
  const within = months - Math.floor(months / MONTHS_PER_YEAR) * MONTHS_PER_YEAR + 1
  return (
    (daysFromCivil(whole, within) + day - 1) * MS_PER_DAY +
    hour * MS_PER_HOUR +
    minute * MS_PER_MINUTE +
    second * MS_PER_SECOND +
    millisecond
  )
}

/** Days from 1970-01-01 to the first of a month (month 1-12): Hinnant's days_from_civil. */
function daysFromCivil(year: number, month: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / YEARS_PER_ERA)
  const yearOfEra = y - era * YEARS_PER_ERA
  const dayOfYear = Math.floor(
    (MONTH_CYCLE_DAYS * (month > 2 ? month - MARCH : month + MONTHS_AFTER_MARCH) + 2) /
      MONTH_CYCLE_MONTHS,
  )
  const dayOfEra =
    yearOfEra * DAYS_PER_YEAR +
    Math.floor(yearOfEra / YEARS_PER_LEAP) -
    Math.floor(yearOfEra / YEARS_PER_CENTURY) +
    dayOfYear
  return era * DAYS_PER_ERA + dayOfEra - EPOCH_SHIFT
}

/*
 * Time zones. Intl's formatter is the source of truth, but calling it costs
 * about a microsecond, so offsets are cached. Time is cut into 6-hour spans;
 * the offset is read at each span boundary, and a span whose two boundaries
 * agree has that offset throughout (a zone never changes offset twice within
 * 6 hours and changes back: in tzdata 2025b the closest such pair is further
 * apart, and tests/hardening-bounds.test.ts checks real transitions against
 * Intl). A span whose boundaries differ holds one
 * transition, found once by bisection. Each evaluation pays for the formatter,
 * for every boundary it touches, and for every bisection the first time, as if
 * nothing were cached (steps never depend on the cache), plus a small fixed
 * cost per read.
 */

const formatters = new Map<string, Intl.DateTimeFormat>()
const MAX_CACHED_ZONES = 64
/** Steps charged for creating a time zone formatter (about 20 microseconds of work). */
const ZONE_FORMAT_COST = 1024
/** Steps charged for one formatter call (a few microseconds). */
const ZONE_PROBE_COST = 40
/** Steps charged for reading an offset out of a span already in use. */
const ZONE_READ_COST = 2
const HOURS_PER_SPAN = 6
const SPAN_MS = HOURS_PER_SPAN * MS_PER_HOUR
/** Cached boundaries and transitions per zone before that zone's cache starts over. */
const MAX_CACHED_POINTS = 65_536
/** Largest instant a Date can hold (±8.64e15 ms). */
const MAX_TIME = 8.64e15

/** The UTC offset of a zone during one span: `before` until `change`, then `after`. */
interface ZoneSpan {
  readonly change: number
  readonly before: number
  readonly after: number
}

/** A transition found by bisection, and the formatter calls it took. */
interface Transition extends ZoneSpan {
  readonly probes: number
}

/** Shared by every evaluation: offsets at span boundaries, and transitions. */
interface ZoneData {
  readonly boundaries: Map<number, number>
  readonly transitions: Map<number, Transition>
}

/** One evaluation's view of a zone: what it has used (and paid for). */
interface EvaluationZone {
  readonly formatter: Intl.DateTimeFormat
  readonly spans: Map<number, ZoneSpan>
  readonly paid: Set<number>
}

const zoneData = new Map<string, ZoneData>()

function formatterFor(zone: string, site: CallSite): Intl.DateTimeFormat {
  return site.state.resource(`f${zone}`, ZONE_FORMAT_COST, () => {
    let formatter = formatters.get(zone)
    if (formatter !== undefined) return formatter
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        era: 'short',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      })
    } catch {
      throw site.state.error('INVALID_ARGUMENT', `Unknown time zone ${shown(zone)}`, site.span)
    }
    if (formatters.size >= MAX_CACHED_ZONES)
      formatters.delete(formatters.keys().next().value as string)
    formatters.set(zone, formatter)
    return formatter
  })
}

/** The wall clock a formatter shows at an instant (the exact, uncached read). */
function formattedClock(formatter: Intl.DateTimeFormat, ms: number): WallClock {
  const parts = formatter.formatToParts(new Date(ms))
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const era = parts.find((part) => part.type === 'era')?.value
  const year = get('year')
  return {
    year: era !== undefined && /^B/iu.test(era) ? 1 - year : year,
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
    millisecond: ((ms % MS_PER_SECOND) + MS_PER_SECOND) % MS_PER_SECOND,
  }
}

function exactOffset(formatter: Intl.DateTimeFormat, ms: number): number {
  const at = Math.max(-MAX_TIME, Math.min(MAX_TIME, ms))
  return utc(formattedClock(formatter, at)) - at
}

function dataFor(zone: string): ZoneData {
  let data = zoneData.get(zone)
  if (data === undefined) {
    if (zoneData.size >= MAX_CACHED_ZONES) zoneData.delete(zoneData.keys().next().value as string)
    data = { boundaries: new Map(), transitions: new Map() }
    zoneData.set(zone, data)
  }
  if (data.boundaries.size >= MAX_CACHED_POINTS) data.boundaries.clear()
  if (data.transitions.size >= MAX_CACHED_POINTS) data.transitions.clear()
  return data
}

function isUtc(zone: string | null | undefined): zone is 'UTC' | null | undefined {
  return zone === null || zone === undefined || zone === 'UTC'
}

/** The offset at the start of span `index`, charged the first time this evaluation uses it. */
function boundary(zone: EvaluationZone, data: ZoneData, index: number, site: CallSite): number {
  if (!zone.paid.has(index)) {
    zone.paid.add(index)
    site.state.charge(ZONE_PROBE_COST)
  }
  let offset = data.boundaries.get(index)
  if (offset === undefined) {
    offset = exactOffset(zone.formatter, index * SPAN_MS)
    data.boundaries.set(index, offset)
  }
  return offset
}

function spanOf(zone: EvaluationZone, name: string, index: number, site: CallSite): ZoneSpan {
  const data = dataFor(name)
  const before = boundary(zone, data, index, site)
  const after = boundary(zone, data, index + 1, site)
  if (before === after) return { change: Infinity, before, after }
  let transition = data.transitions.get(index)
  if (transition === undefined) {
    // Transitions happen on whole seconds: bisect for the first second showing `after`.
    let low = Math.floor((index * SPAN_MS) / MS_PER_SECOND)
    let high = Math.floor(((index + 1) * SPAN_MS) / MS_PER_SECOND)
    let probes = 0
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      probes++
      if (exactOffset(zone.formatter, middle * MS_PER_SECOND) === before) low = middle
      else high = middle
    }
    transition = { change: high * MS_PER_SECOND, before, after, probes }
    data.transitions.set(index, transition)
  }
  site.state.charge(transition.probes * ZONE_PROBE_COST)
  return transition
}

/** UTC offset (ms) of `zone` at an instant. */
function offsetAt(ms: number, zone: string, site: CallSite): number {
  // Probes a day either side may fall outside the Date range; clamp them.
  if (!Number.isFinite(ms))
    throw site.state.error('INVALID_ARGUMENT', 'Timestamp out of range', site.span)
  const at = Math.max(-MAX_TIME, Math.min(MAX_TIME, ms))
  const s = site.state
  s.charge(ZONE_READ_COST)
  const zones = (s.zones ??= new Map())
  let used = zones.get(zone) as EvaluationZone | undefined
  if (used === undefined) {
    used = { formatter: formatterFor(zone, site), spans: new Map(), paid: new Set() }
    zones.set(zone, used)
  }
  const index = Math.floor(at / SPAN_MS)
  let span = used.spans.get(index)
  if (span === undefined) {
    span = spanOf(used, zone, index, site)
    used.spans.set(index, span)
  }
  return at < span.change ? span.before : span.after
}

export function wallClock(date: Date, zone: string | null | undefined, site: CallSite): WallClock {
  const ms = timeOf(date, site.state, site.span)
  if (isUtc(zone)) return utcClock(ms)
  const shifted = ms + offsetAt(ms, zone, site)
  // At the very ends of the Date range the shifted instant may not exist: read
  // the formatter directly, which costs a probe every time (nothing caches it).
  if (Math.abs(shifted) > MAX_TIME) {
    site.state.charge(ZONE_PROBE_COST)
    return formattedClock(formatterFor(zone, site), ms)
  }
  return utcClock(shifted)
}

// Days from 0000-03-01 to 1970-01-01, and the days in a 400-year cycle.
const EPOCH_SHIFT = 719_468
const DAYS_PER_ERA = 146_097
const DAYS_PER_4_YEARS = 1460
const DAYS_PER_CENTURY = 36_524
const LAST_DAY_OF_ERA = 146_096
const DAYS_PER_YEAR = 365
const YEARS_PER_ERA = 400
const YEARS_PER_LEAP = 4
const MONTH_CYCLE_DAYS = 153
const MONTH_CYCLE_MONTHS = 5
const MARCH = 3
const MONTHS_AFTER_MARCH = 9
/** March to December: the months of the shifted year (it starts in March) before its new year. */
const MONTHS_FROM_MARCH = 10

/**
 * The UTC calendar fields of an instant, by integer arithmetic (the civil
 * calendar algorithm of H. Hinnant): several times faster than Date's getters.
 */
function utcClock(ms: number): WallClock {
  const days = Math.floor(ms / MS_PER_DAY)
  let rest = ms - days * MS_PER_DAY
  const hour = Math.floor(rest / MS_PER_HOUR)
  rest -= hour * MS_PER_HOUR
  const minute = Math.floor(rest / MS_PER_MINUTE)
  rest -= minute * MS_PER_MINUTE
  const second = Math.floor(rest / MS_PER_SECOND)
  const shifted = days + EPOCH_SHIFT
  const era = Math.floor(shifted / DAYS_PER_ERA)
  const dayOfEra = shifted - era * DAYS_PER_ERA
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / DAYS_PER_4_YEARS) +
      Math.floor(dayOfEra / DAYS_PER_CENTURY) -
      Math.floor(dayOfEra / LAST_DAY_OF_ERA)) /
      DAYS_PER_YEAR,
  )
  const dayOfYear =
    dayOfEra -
    (DAYS_PER_YEAR * yearOfEra +
      Math.floor(yearOfEra / YEARS_PER_LEAP) -
      Math.floor(yearOfEra / YEARS_PER_CENTURY))
  const monthIndex = Math.floor((MONTH_CYCLE_MONTHS * dayOfYear + 2) / MONTH_CYCLE_DAYS)
  const month =
    monthIndex < MONTHS_FROM_MARCH ? monthIndex + MARCH : monthIndex - MONTHS_AFTER_MARCH
  return {
    year: yearOfEra + era * YEARS_PER_ERA + (month <= 2 ? 1 : 0),
    month,
    day: dayOfYear - Math.floor((MONTH_CYCLE_DAYS * monthIndex + 2) / MONTH_CYCLE_MONTHS) + 1,
    hour,
    minute,
    second,
    millisecond: rest - second * MS_PER_SECOND,
  }
}

/**
 * The instant at which a wall clock in `zone` shows the given fields.
 *
 * Wall times that occur twice (a DST overlap) resolve to the instant with
 * `preferOffset` when it is valid (calendar arithmetic keeps the input's
 * offset, so addDays(t, 0, zone) is t), and otherwise to the earlier one. Wall times that do not
 * occur (a DST gap) move forward by the length of the gap. This matches the
 * "compatible" disambiguation of JavaScript's Temporal proposal.
 */
export function fromWallClock(
  clock: WallClock,
  zone: string | null | undefined,
  site: CallSite,
  preferOffset?: number,
): Date {
  const asUtc = utc(clock)
  if (isUtc(zone)) return checked(asUtc, site)
  const before = offsetAt(asUtc - MS_PER_DAY, zone, site)
  const after = offsetAt(asUtc + MS_PER_DAY, zone, site)
  // No transition near (one offset a day either side, and valid): the one candidate.
  if (before === after && offsetAt(asUtc - before, zone, site) === before)
    return checked(asUtc - before, site)
  const candidates = [...new Set([before, after, offsetAt(asUtc, zone, site)])]
    .map((offset) => ({ offset, instant: asUtc - offset }))
    .filter(({ instant, offset }) => offsetAt(instant, zone, site) === offset)
    .sort((a, b) => a.instant - b.instant)
  const preferred = candidates.find((c) => c.offset === preferOffset)
  if (preferred !== undefined) return checked(preferred.instant, site)
  const first = candidates[0]
  if (first !== undefined) return checked(first.instant, site)
  // In a gap: apply the offset from before the transition, which lands after it.
  return checked(asUtc - before, site)
}

/** The timestamp at `ms`, or INVALID_ARGUMENT when it is outside the Date range. */
export function checked(ms: number, site: CallSite): Date {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime()))
    throw site.state.error('INVALID_ARGUMENT', 'Timestamp out of range', site.span)
  return date
}

function daysInMonth(year: number, month: number): number {
  return month === MONTHS_PER_YEAR
    ? daysFromCivil(year + 1, 1) - daysFromCivil(year, month)
    : daysFromCivil(year, month + 1) - daysFromCivil(year, month)
}

/** Adds calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(
  date: Date,
  months: number,
  zone: string | null | undefined,
  site: CallSite,
): Date {
  if (!Number.isFinite(months))
    throw site.state.error('INVALID_ARGUMENT', 'Timestamp out of range', site.span)
  if (!Number.isInteger(months))
    throw site.state.error('INVALID_ARGUMENT', 'Months must be an integer', site.span)
  const clock = wallClock(date, zone, site)
  const total = clock.year * MONTHS_PER_YEAR + (clock.month - 1) + months
  const year = Math.floor(total / MONTHS_PER_YEAR)
  const month = (((total % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR) + 1
  return fromWallClock(
    { ...clock, year, month, day: Math.min(clock.day, daysInMonth(year, month)) },
    zone,
    site,
    zoneOffset(date, zone, site),
  )
}

export function addDays(
  date: Date,
  days: number,
  zone: string | null | undefined,
  site: CallSite,
): Date {
  if (!Number.isInteger(days))
    throw site.state.error('INVALID_ARGUMENT', 'Days must be an integer', site.span)
  const clock = wallClock(date, zone, site)
  const shifted = new Date(utc({ year: clock.year, month: clock.month, day: clock.day + days }))
  return fromWallClock(
    {
      ...clock,
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    },
    zone,
    site,
    zoneOffset(date, zone, site),
  )
}

function zoneOffset(
  date: Date,
  zone: string | null | undefined,
  site: CallSite,
): number | undefined {
  return isUtc(zone) ? undefined : offsetAt(timeOf(date, site.state, site.span), zone, site)
}

/** ISO weekday: Monday = 1 ... Sunday = 7. */
export function isoWeekday(clock: WallClock): number {
  const weekday = new Date(
    utc({ year: clock.year, month: clock.month, day: clock.day }),
  ).getUTCDay()
  return weekday === 0 ? SUNDAY : weekday
}

const ISO_PATTERN =
  /^(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})(?:[T ](?<h>\d{2}):(?<mi>\d{2})(?::(?<sec>\d{2})(?:\.(?<frac>\d{1,9}))?)?(?<zone>Z|[+-]\d{2}:?\d{2})?)?$/u

/** Strict ISO-8601 parsing. Date-only and zone-less times are read as UTC. */
export function parseTimestamp(text: string, site: CallSite): Date {
  const groups = ISO_PATTERN.exec(text.trim())?.groups
  if (groups === undefined) {
    throw site.state.error(
      'INVALID_ARGUMENT',
      `Cannot parse ${shown(text)} as an ISO-8601 timestamp`,
      site.span,
    )
  }
  const { y, mo, d, h = '0', mi = '0', sec = '0', frac = '0', zone } = groups
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (
    month < 1 ||
    month > MONTHS_PER_YEAR ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    Number(h) > MAX_HOUR ||
    Number(mi) > MAX_MINUTE ||
    Number(sec) > MAX_SECOND
  ) {
    throw site.state.error(
      'INVALID_ARGUMENT',
      `${shown(text)} is not a valid date and time`,
      site.span,
    )
  }
  let ms = utc({
    year,
    month,
    day,
    hour: Number(h),
    minute: Number(mi),
    second: Number(sec),
    millisecond: Number(frac.slice(0, 3).padEnd(3, '0')),
  })
  if (zone !== undefined && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    const offsetHours = Number(digits.slice(0, 2))
    const offsetMinutes = Number(digits.slice(2))
    if (offsetHours > MAX_HOUR || offsetMinutes > MAX_MINUTE) {
      throw site.state.error(
        'INVALID_ARGUMENT',
        `${shown(text)} has an invalid UTC offset`,
        site.span,
      )
    }
    ms -= sign * (offsetHours * MINUTES_PER_HOUR + offsetMinutes) * MS_PER_MINUTE
  }
  return checked(ms, site)
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

// Longest tokens first. Any other ASCII letter is an error, so a typo such as
// "YYYY" or "DD" fails loudly instead of being printed literally.
/** Rendering one format token costs about as much as a few ordinary steps. */
const TOKEN_COST = 4
const TOKENS = /'[^']*'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|m|ss|s|SSS|a|[A-Za-z]/gu

/** An error message for a pattern with unknown letters, or undefined. */
export function checkDatePattern(pattern: string): string | undefined {
  for (const token of pattern.match(TOKENS) ?? []) {
    if (token.length === 1 && !'MdHhmsa'.includes(token)) {
      return `Unknown date format letter "${token}"; quote literal text, e.g. "'at' HH:mm"`
    }
  }
  return undefined
}

/**
 * Formats a timestamp. Tokens: yyyy yy (year), MMMM MMM MM M (month), dd d
 * (day), EEEE EEE (weekday), HH H (hour 0-23), hh h (hour 1-12), a (AM/PM),
 * mm m (minute), ss s (second), SSS (millisecond). Text in single quotes is
 * literal; '' is a quote. Names are English.
 */
export function formatTimestamp(
  date: Date,
  pattern: string,
  zone: string | null | undefined,
  site: CallSite,
): string {
  const clock = wallClock(date, zone, site)
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  const hour12 =
    clock.hour % HOURS_PER_HALF_DAY === 0 ? HOURS_PER_HALF_DAY : clock.hour % HOURS_PER_HALF_DAY
  const weekday = WEEKDAYS[isoWeekday(clock) - 1]
  const month = MONTHS[clock.month - 1]
  const render = (token: string): string => {
    switch (token) {
      case 'yyyy':
        return clock.year < 0 ? `-${pad(-clock.year, 4)}` : pad(clock.year, 4)
      case 'yy':
        return pad(((clock.year % YEARS_PER_CENTURY) + YEARS_PER_CENTURY) % YEARS_PER_CENTURY, 2)
      case 'MMMM':
        return month
      case 'MMM':
        return month.slice(0, 3)
      case 'MM':
        return pad(clock.month, 2)
      case 'M':
        return String(clock.month)
      case 'dd':
        return pad(clock.day, 2)
      case 'd':
        return String(clock.day)
      case 'EEEE':
        return weekday
      case 'EEE':
        return weekday.slice(0, 3)
      case 'HH':
        return pad(clock.hour, 2)
      case 'H':
        return String(clock.hour)
      case 'hh':
        return pad(hour12, 2)
      case 'h':
        return String(hour12)
      case 'a':
        return clock.hour < HOURS_PER_HALF_DAY ? 'AM' : 'PM'
      case 'mm':
        return pad(clock.minute, 2)
      case 'm':
        return String(clock.minute)
      case 'ss':
        return pad(clock.second, 2)
      case 's':
        return String(clock.second)
      case 'SSS':
        return pad(clock.millisecond, 3)
      default:
        if (token.startsWith("'")) return token === "''" ? "'" : token.slice(1, -1)
        throw site.state.error(
          'INVALID_ARGUMENT',
          `Unknown date format letter "${token}"; quote literal text, e.g. "'at' HH:mm"`,
          site.span,
        )
    }
  }
  // Token by token: each is charged as it is rendered, and the text is
  // checked against the string limit before it grows, never after.
  const s = site.state
  let out = ''
  let from = 0
  for (const match of pattern.matchAll(TOKENS)) {
    s.charge(TOKEN_COST)
    const piece = pattern.slice(from, match.index) + render(match[0])
    s.stringLimit(out.length + piece.length, site.span)
    out += piece
    from = match.index + match[0].length
  }
  s.stringLimit(out.length + pattern.length - from, site.span)
  return out + pattern.slice(from)
}
