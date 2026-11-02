---
'bonsai-js': patch
---

A variable or field declared `t.opaque(...)` is now a required key in the inferred TypeScript context type, as context validation and the checker already treat it. Before, TypeScript accepted a context without it because an opaque value is `unknown`, and the evaluation then failed validation or saw `null`. Declare `t.optional(t.opaque(name))` for a handle that may be missing.
