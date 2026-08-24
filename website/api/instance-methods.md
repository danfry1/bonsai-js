# Instance Methods

Inspect the registry, remove extensions, and clear caches without rebuilding the entire instance.

| Method | Returns | Description |
|---|---|---|
| `use(plugin)` | `this` | Apply a plugin transactionally and return the instance. |
| `addTransform(name, fn, metadata?)` | `this` | Register a transform; duplicate names throw. |
| `replaceTransform(name, fn, metadata?)` | `this` | Explicitly replace an existing transform. |
| `defineTransform(definition)` | `this` | Register a self-describing transform. |
| `addFunction(name, fn, metadata?)` | `this` | Register a pure function; duplicate names throw. |
| `replaceFunction(name, fn, metadata?)` | `this` | Replace an existing function with a pure function. |
| `defineFunction(definition)` | `this` | Register a self-describing pure function. |
| `addContextFunction(name, fn, metadata?)` | `this` | Register a context-aware function in the shared function namespace. |
| `replaceContextFunction(name, fn, metadata?)` | `this` | Replace an existing function with a context-aware function. |
| `defineContextFunction(definition)` | `this` | Register a self-describing context-aware function. |
| `removeTransform(name)` | `boolean` | Unregister a transform. Returns `true` if it existed. |
| `removeFunction(name)` | `boolean` | Unregister a function (pure or context-aware). Returns `true` if it existed. |
| `hasTransform(name)` | `boolean` | Check if a transform is registered. |
| `hasFunction(name)` | `boolean` | Check if a function (pure or context-aware) is registered. |
| `isContextFunction(name)` | `boolean` | Check whether a registered function reads the evaluation context. |
| `listTransforms()` | `string[]` | List all registered transform names. |
| `getTransformMetadata(name)` | metadata or `undefined` | Read static transform metadata. |
| `listFunctions()` | `string[]` | List all registered function names (both pure and context-aware). |
| `getFunctionMetadata(name)` | metadata or `undefined` | Read static function metadata. |
| `seal()` | `this` | Permanently reject later registry mutations. |
| `isSealed()` | `boolean` | Check whether the registry is sealed. |
| `clearCache()` | `void` | Clear the internal AST cache and compiled-expression cache. |

```ts
const expr = bonsai().use(strings)

expr.hasTransform('upper')    // true
expr.listTransforms()          // ["upper", "lower", "trim", ...]

expr.removeTransform('upper') // true
expr.hasTransform('upper')    // false

expr.clearCache()              // clear AST + compiled caches

expr.seal()
expr.isSealed()                // true
```

Compiled rules bind to the registry revision present when `compile()` is
called. Later explicit replacements never change existing compiled behavior.
