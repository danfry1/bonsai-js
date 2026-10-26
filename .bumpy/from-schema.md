---
'bonsai-js': minor
---

`fromSchema` converts an app's existing schema into a Bonsai type: a Zod 4 or ArkType schema, a Valibot schema wrapped with `toStandardJsonSchema` (any Standard JSON Schema), or a JSON Schema (draft-07, 2020-12, OpenAPI 3.0). A context declared with it is typed as the schema's output. New exports: `fromSchema`, and the types `SchemaType`, `FromSchemaOptions`, `JSONSchema`, and `StandardJSONSchema`. Passing a schema object where a type goes now throws an error that says to use `fromSchema`.
