---
'bonsai-js': patch
---

Shrink `bonsai-js/runtime` by about 2 KB gzipped: built-in function descriptions, which only `describeFunction()`, `listFunctions()`, and the language service read, are no longer bundled with the runtime.
