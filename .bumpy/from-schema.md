---
'bonsai-js': minor
---

`fromSchema` converts an app's existing schema into a Bonsai type: a Zod 4, Valibot, or ArkType schema (any Standard JSON Schema), or a JSON Schema (draft-07, 2020-12, OpenAPI 3.0). The context is typed as the schema's output. Passing a schema object where a type goes now throws an error that says to use `fromSchema`.
