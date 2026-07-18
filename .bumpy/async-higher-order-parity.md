---
'bonsai-js': patch
---

Fix async higher-order array methods to match native and synchronous semantics. The async evaluator reimplements `map`/`filter`/`flatMap`/`find`/`findIndex`/`some`/`every` (it must, to await Promise-returning bonsai lambdas), but that reimplementation previously passed only the element to the callback, iterated sparse-array holes, and ignored overridden methods. It now passes `(item, index, array)` as native methods do, skips holes for `map`/`filter`/`flatMap`/`some`/`every` while visiting them for `find`/`findIndex` (matching each method's native behavior), preserves length and holes in `map` results, and defers an overridden array method to its native call instead of substituting the standard implementation. A given expression now produces identical results and consumes an identical `maxSteps` budget whether run via `evaluateSync` or `evaluate`.
