---
'bonsai-js': minor
---

Add `bonsai-js/runtime/core` and `bonsai-js/builtins`: a runtime with only the built-in functions passed in `builtins`, so a browser bundle carries just what its rules call (about 30 KB gzipped for typical rules, against 44 KB for `bonsai-js/runtime`). `bonsai()` takes the same `builtins` option, and a call to a built-in left out is a CHECK error, so rules are checked against what the browser can run.
