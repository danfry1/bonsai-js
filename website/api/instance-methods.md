# Instance Methods

Inspect the registry, remove extensions, and clear caches without rebuilding the entire instance.

| Method | Returns | Description |
|---|---|---|
| `use(plugin)` | `this` | Apply a plugin immediately and return the same instance for chaining. |
| `addTransform(name, fn)` | `this` | Register or replace a transform. |
| `addFunction(name, fn)` | `this` | Register or replace a pure function. |
| `addContextFunction(name, fn)` | `this` | Register or replace a context-aware function. Shares a namespace with `addFunction`. |
| `removeTransform(name)` | `boolean` | Unregister a transform. Returns `true` if it existed. |
| `removeFunction(name)` | `boolean` | Unregister a function (pure or context-aware). Returns `true` if it existed. |
| `hasTransform(name)` | `boolean` | Check if a transform is registered. |
| `hasFunction(name)` | `boolean` | Check if a function (pure or context-aware) is registered. |
| `isContextFunction(name)` | `boolean` | Check whether a registered function reads the evaluation context. |
| `listTransforms()` | `string[]` | List all registered transform names. |
| `listFunctions()` | `string[]` | List all registered function names (both pure and context-aware). |
| `clearCache()` | `void` | Clear the internal AST cache and compiled-expression cache. |

```ts
const expr = bonsai().use(strings)

expr.hasTransform('upper')    // true
expr.listTransforms()          // ["upper", "lower", "trim", ...]

expr.removeTransform('upper') // true
expr.hasTransform('upper')    // false

expr.clearCache()              // clear AST + compiled caches
```
