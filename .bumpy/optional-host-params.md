---
'bonsai-js': minor
---

Trailing host function parameters declared with `t.optional(...)` may now be omitted without setting `required`: `fn({ params: [t.number(), t.optional(t.string())], ... })` accepts `f(1)` and passes `null` for the missing argument. A trailing `t.any()` stays required, and an explicit `required` still decides. The artifact digest of such a function changes with its signature, so artifacts that call one need to be made again.
