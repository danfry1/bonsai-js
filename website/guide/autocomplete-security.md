# Autocomplete & Security

Autocomplete respects your Bonsai instance's security policy. Properties that are blocked at evaluation time are also blocked from appearing in suggestions.

## allowedProperties

When your instance uses `allowedProperties`, only those properties appear in completions. Everything else is excluded.

```ts
const expr = bonsai({ allowedProperties: ['name', 'age'] })

const ac = createAutocomplete(expr, {
  context: { user: { name: 'Alice', age: 25, role: 'admin' } },
})

ac.complete('user.', 5)
// [{label: 'name', ...}, {label: 'age', ...}]
// 'role' is not suggested because it's not in the allowlist
```

## deniedProperties

When your instance uses `deniedProperties`, those properties are excluded from suggestions. Everything else is allowed.

```ts
const expr = bonsai({ deniedProperties: ['password', 'secret'] })

const ac = createAutocomplete(expr, {
  context: { user: { name: 'Alice', password: 'hunter2' } },
})

ac.complete('user.', 5)
// [{label: 'name', ...}]
// 'password' is never suggested
```

## Lambda and pipe contexts

Security filtering applies everywhere: top-level property access, lambda element properties, pipe transform suggestions, and method completions. There is no context where a blocked property can leak into suggestions.

```ts
const expr = bonsai({ allowedProperties: ['name'] }).use(strings)

const ac = createAutocomplete(expr, {
  context: {
    users: [{ name: 'Alice', age: 25, role: 'admin' }],
  },
})

ac.complete('users.filter(.', 15)
// [{label: 'name', ...}]
// 'age' and 'role' are excluded from lambda suggestions too
```

::: tip Security policy is fixed at construction time
The security policy is read once when `createAutocomplete()` is called and cached for the lifetime of the autocomplete instance. If you need different policies for different users or roles, create separate autocomplete instances.
:::
