# Dates

Load the dates stdlib when you need current timestamps, UTC formatting, or day differences between timestamps.

```ts
import { dates } from 'bonsai-js/stdlib'
expr.use(dates)
```

| Type | Name | Example | Result |
|---|---|---|---|
| Function | `now()` | `now()` | Current Unix timestamp in milliseconds |
| Transform | `formatDate(fmt)` | `1704067200000 \|> formatDate("YYYY-MM-DD")` | `"2024-01-01"` |
| Transform | `diffDays(other)` | `ts1 \|> diffDays(ts2)` | Absolute day difference |

All date transforms work with Unix timestamps in milliseconds. `formatDate()` uses UTC components, not local time-zone formatting.

Format patterns: `YYYY` (year), `MM` (month), `DD` (day), `HH` (hours), `mm` (minutes), `ss` (seconds).

```ts
// Fixed timestamp example
1704153600000 |> formatDate("YYYY-MM-DD HH:mm:ss")
// "2024-01-02 00:00:00"

// Difference in whole days
1704153600000 |> diffDays(1704067200000)
// 1
```
