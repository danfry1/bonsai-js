# Literals & Types

Literals are the values you can write directly inside an expression. Everything else comes from the context object, property access, functions, or transforms.

| Expression | Result | Note |
|---|---|---|
| `42` | `42` | number |
| `"hello world"` | `"hello world"` | string (single or double quotes) |
| `true` | `true` | boolean |
| `null` | `null` | |
| `undefined` | `undefined` | useful with `??` fallbacks |

### More number formats

| Expression | Result | Note |
|---|---|---|
| `3.14` | `3.14` | decimals |
| `1_000_000` | `1000000` | underscores for readability (ignored) |
| `0xFF` | `255` | hexadecimal |
| `0b1010` | `10` | binary |
| `1.5e3` | `1500` | scientific notation |

**Remember:** arrays, objects, and template strings have their own syntax sections below. If a value belongs to your application state, pass it in through the `context` object and reference it by name.
