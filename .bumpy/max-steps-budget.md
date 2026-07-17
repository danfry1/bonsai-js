---
'bonsai-js': minor
---

Add a default-on `maxSteps` budget: a deterministic cap on the number of evaluator steps a single evaluation may take, enforced independently of the wall-clock `timeout`. Unlike `timeout`, it applies without any opt-in, so every caller gets a runaway bound — most importantly for a higher-order method over a large *context* array, whose receiver size `maxArrayLength` does not cap. Exceeding the budget throws `BonsaiSecurityError` with code `MAX_STEPS`. The default is 1,000,000 (roughly 6x headroom over a realistic pipeline across a full `maxArrayLength`-sized array); set `maxSteps: 0` to disable, or raise it for large-data processing. Accounting adds roughly 6-7% to hot-path throughput and is skipped entirely when both `maxSteps` and `timeout` are disabled.
