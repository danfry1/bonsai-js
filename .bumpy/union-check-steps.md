---
'bonsai-js': patch
---

Charge the step budget for each union member tried when a result is checked against its expected type or a host function's declared type. A list result checked against a large enum could previously run far past `maxSteps` and `timeout`.
