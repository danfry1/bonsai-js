import type { CallSite } from '../functions/define.js'
import { MS_PER_DAY, MS_PER_MINUTE, MS_PER_SECOND, timeOf } from './values.js'

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

/** Date.UTC, but without mapping years 0-99 to 1900-1999. */
function utc({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
}: CalendarFields): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millisecond)
  return date.getTime()
}

const formatters = new Map<string, Intl.DateTimeFormat>()
const MAX_CACHED_ZONES = 64

function formatterFor(zone: string, site: CallSite): Intl.DateTimeFormat {
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
    throw site.state.error('INVALID_ARGUMENT', `Unknown time zone "${zone}"`, site.span)
  }
  if (formatters.size >= MAX_CACHED_ZONES) formatters.clear()
  formatters.set(zone, formatter)
  return formatter
}

export function wallClock(date: Date, zone: string | null | undefined, site: CallSite): WallClock {
  const ms = timeOf(date, site.state, site.span)
  if (zone === null || zone === undefined || zone === 'UTC') {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      millisecond: date.getUTCMilliseconds(),
    }
  }
  const parts = formatterFor(zone, site).formatToParts(date)
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
  if (zone === null || zone === undefined || zone === 'UTC') return checked(asUtc, site)
  const before = offsetAt(asUtc - MS_PER_DAY, zone, site)
  const after = offsetAt(asUtc + MS_PER_DAY, zone, site)
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

/** UTC offset (ms) of `zone` at an instant. */
/** Largest instant a Date can hold (±8.64e15 ms). */
const MAX_TIME = 8.64e15

function offsetAt(ms: number, zone: string, site: CallSite): number {
  // Probes a day either side may fall outside the Date range; clamp them.
  if (!Number.isFinite(ms))
    throw site.state.error('INVALID_ARGUMENT', 'Timestamp out of range', site.span)
  const at = Math.max(-MAX_TIME, Math.min(MAX_TIME, ms))
  const clock = wallClock(new Date(at), zone, site)
  return utc(clock) - at
}

function checked(ms: number, site: CallSite): Date {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime()))
    throw site.state.error('INVALID_ARGUMENT', 'Timestamp out of range', site.span)
  return date
}

function daysInMonth(year: number, month: number): number {
  return new Date(utc({ year, month: month + 1, day: 0 })).getUTCDate()
}

/** Adds calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(
  date: Date,
  months: number,
  zone: string | null | undefined,
  site: CallSite,
): Date {
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
  return zone === null || zone === undefined || zone === 'UTC'
    ? undefined
    : offsetAt(date.getTime(), zone, site)
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
      `Cannot parse "${text}" as an ISO-8601 timestamp`,
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
    throw site.state.error('INVALID_ARGUMENT', `"${text}" is not a valid date and time`, site.span)
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
      throw site.state.error('INVALID_ARGUMENT', `"${text}" has an invalid UTC offset`, site.span)
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
  return pattern.replace(TOKENS, (token) => {
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
  })
}
