---
'bonsai-js': minor
---

Enforce the evaluation timeout as a real boundary: the synchronous evaluator now checks the deadline at completion and after every registered function, transform, and native method call, and both evaluators charge per-element work in lambda callbacks, flat literal loops, and spread materialization against the timeout budget. Arrays with a custom `Symbol.iterator` are materialized through the guarded loop instead of being re-iterated unchecked. Deadlines use a monotonic clock. Expressions that previously ran past a configured `timeout` inside host calls or large array operations now throw `BonsaiSecurityError` with code `TIMEOUT`.
