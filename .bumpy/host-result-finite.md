---
'bonsai-js': patch
---

A host function that returns `NaN` or an infinity where its `returns` type declares a number, including inside a list or map, is now a `HOST_CONTRACT` error, as other results that break the declared type already were. Before, the value reached the expression and failed later, away from its cause (for example when sorting). Arguments read from an unvalidated context still reach `run` as the host gave them.
