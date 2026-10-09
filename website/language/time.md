# Time

<!-- context: { user: { createdAt: new Date("2025-11-02T08:00:00Z"), trialEnds: new Date("2026-01-20T00:00:00Z") }, order: { placedAt: new Date("2026-01-14T23:30:00Z"), shippedAt: new Date("2026-01-16T09:30:00Z") } } -->

Bonsai has two time types. A **timestamp** is an instant. A **duration** is an exact length of time. Calendar questions (which day, which month, midnight where) are answered by functions that take an optional IANA time zone and default to UTC.

The examples on this page run with the clock fixed at `2026-01-15T10:30:00Z`.

## Timestamps

A `Date` in the context is a timestamp. Expressions create them with `now()` and `timestamp()`, which parses ISO-8601 text or epoch milliseconds. Text without an offset is read as UTC.

```bonsai
now() // => 2026-01-15T10:30:00.000Z
timestamp("2026-03-01") // => 2026-03-01T00:00:00.000Z
timestamp("2026-03-01T12:00:00+02:00") // => 2026-03-01T10:00:00.000Z
timestamp(0) // => 1970-01-01T00:00:00.000Z
timestamp("next tuesday") // error: INVALID_ARGUMENT
```

`now()` is read once per evaluation from the environment's clock, so every `now()` in one expression returns the same instant. Pass `clock` to `bonsai()` to control it, for example in tests.

Timestamps compare by instant with `==`, `<`, and the other ordering operators, and render as ISO-8601 in templates.

## Durations

Durations come from `weeks`, `days`, `hours`, `minutes`, `seconds`, and `milliseconds`, and from subtracting two timestamps. A day is exactly 24 hours. A duration is a whole number of milliseconds, the resolution of timestamps: a fraction is rounded to the nearest millisecond, halves away from zero, when the duration is made (`milliseconds(0.5)` is 1 ms, `days(1) / 7` is 12,342,857 ms), so duration arithmetic is exact. A duration spans at most ±(2^53 - 1) ms, about 285,000 years, the range in which every millisecond is exact; a duration outside it (`days(1e300)`, or the distance between timestamps 300,000 years apart) is `INVALID_ARGUMENT`. Durations render as ISO-8601 durations, and `duration("PT1H30M")` reads that text back: weeks, days, hours, minutes, and seconds to the millisecond, with an optional sign. Years and months have no fixed length, so `duration("P1M")` is `INVALID_ARGUMENT` (and a literal one is a checking error). In TypeScript, build one for a context with `new Duration(ms)`, which rounds the same way and throws a `RangeError` for a length outside that range or not a number.

```bonsai
days(1) + hours(12) // => P1DT12H
minutes(90) // => PT1H30M
hours(1) * 1.5 // => PT1H30M
days(1) == hours(24) // => true
duration("PT1H30M") == minutes(90) // => true
order.shippedAt - order.placedAt // => P1DT10H
inHours(order.shippedAt - order.placedAt) // => 34
```

Convert a duration to a number with `inDays`, `inHours`, `inMinutes`, `inSeconds`, or `inMilliseconds`. Dividing two durations also gives a number.

```bonsai
inDays(now() - user.createdAt) // => 74.10416666666667
floor(inDays(now() - user.createdAt)) // => 74
days(3) / hours(1) // => 72
```

## Arithmetic

| Expression | Result |
| --- | --- |
| timestamp `+` duration, timestamp `-` duration | timestamp |
| timestamp `-` timestamp | duration |
| duration `+` or `-` duration | duration |
| duration `*` number, duration `/` number | duration |
| duration `/` duration | number |

```bonsai
now() + days(30) // => 2026-02-14T10:30:00.000Z
now() - user.createdAt > days(30) // => true
user.trialEnds - now() < days(7) // => true
now() + 30 // error: TYPE_ERROR
```

Adding a number to a timestamp is an error because the unit would be ambiguous: write `days(30)`.

## Calendars and time zones

Durations are exact, so `+ days(1)` always adds 24 hours. Calendar functions work on the wall clock in a time zone instead:

| Function | Result |
| --- | --- |
| `year`, `month`, `day`, `hour`, `minute`, `second`, `dayOfWeek` | numbers (months 1-12, ISO weekday Monday 1 to Sunday 7) |
| `startOfDay`, `startOfMonth`, `startOfYear` | the timestamp of that local midnight |
| `addDays`, `addMonths`, `addYears` | calendar arithmetic |
| `formatDate` | text from a pattern |

Each takes an optional time zone as its last argument; without one (or with `null`) it uses UTC. A time zone is `"UTC"` or an IANA name as the tz database writes it, `Area/Location` (`"Europe/Berlin"`, `"America/Argentina/Buenos_Aires"`, `"Etc/GMT+5"`). Abbreviations and legacy names (`"EST"`, `"GB"`), other spellings (`"utc"`, `"europe/berlin"`), and offsets (`"+05:30"`) are `INVALID_ARGUMENT` errors: which of them a JavaScript runtime accepts, and what it maps them to, differs between runtimes, and an offset ignores daylight saving.

```bonsai
day(order.placedAt) // => 14
day(order.placedAt, "Europe/Berlin") // => 15
hour(now(), "America/New_York") // => 5
dayOfWeek(now()) // => 4
startOfDay(now(), "Europe/Berlin") // => 2026-01-14T23:00:00.000Z
formatDate(order.placedAt, "yyyy-MM-dd HH:mm", "Asia/Tokyo") // => "2026-01-15 08:30"
hour(now(), "Mars/Olympus") // error: INVALID_ARGUMENT
```

`addDays` keeps the wall-clock time across daylight saving changes, where `+ days(n)` keeps the exact length. On 29 March 2026 Berlin moves its clocks forward an hour:

```bonsai
addDays(timestamp("2026-03-28T12:00:00Z"), 1, "Europe/Berlin") // => 2026-03-29T11:00:00.000Z
timestamp("2026-03-28T12:00:00Z") + days(1) // => 2026-03-29T12:00:00.000Z
```

`addMonths` and `addYears` clamp the day to the length of the target month:

```bonsai
addMonths(timestamp("2026-01-31T00:00:00Z"), 1) // => 2026-02-28T00:00:00.000Z
addYears(timestamp("2024-02-29T00:00:00Z"), 1) // => 2025-02-28T00:00:00.000Z
```

## Common patterns

```bonsai
now() - user.createdAt < days(90) // => true
startOfDay(now()) == startOfDay(order.placedAt) // => false
month(now()) == 1 && day(now()) <= 15 // => true
dayOfWeek(now(), "Europe/London") >= 6 // => false
`Ships ${formatDate(order.placedAt + days(2), "dd/MM/yyyy")}` // => "Ships 16/01/2026"
```

See the [time functions reference](/functions/time) for every function and its signatures.
