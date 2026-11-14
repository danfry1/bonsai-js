---
'bonsai-js': patch
---

An unknown variable in an environment set to `strict: true` with no declared variables now says how to fix it: declare the name in `variables`, or set `strict: false`. The context passed at evaluation supplies values, not declarations.
