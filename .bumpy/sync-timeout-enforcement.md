---
'bonsai-js': minor
---

Enforce the evaluation timeout as a real boundary. The synchronous evaluator now checks the deadline at completion and after every function, transform, and method call, and evaluates higher-order array methods (`map`, `filter`, `find`, `findIndex`, `some`, `every`) with its own guarded, short-circuiting loop so a host-function callback over a large array is charged per element and pre-empted mid-iteration rather than running to completion. Both evaluators charge per-element work in lambda callbacks, flat literal loops, and spread materialization against the timeout budget; array spreads are materialized by index so a `Proxy` or overridden `Symbol.iterator` cannot bypass the accounting or the `maxArrayLength` cap. Deadlines use a monotonic clock. Expressions that previously ran past a configured `timeout` inside host calls or large array operations now throw `BonsaiSecurityError` with code `TIMEOUT`.
