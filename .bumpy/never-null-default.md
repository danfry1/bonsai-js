---
'bonsai-js': patch
---

`a ?? b` where `a` is never null now has `a`'s type, since `b` never runs: `(order.total > 50) ?? 0` is a `boolean`, so it meets `expect: t.boolean()`. The `NEVER_NULL` warning now says the right side is never used.
