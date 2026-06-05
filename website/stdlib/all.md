# All (bundle)

Load every standard library module at once - for quick prototyping or when you want everything available.

```ts
import { all } from 'bonsai-js/stdlib'

const expr = bonsai().use(all)
// All transforms and functions from strings, arrays, math, types, and dates are now available
```

**Tip:** Start with `all` if you are exploring or prototyping. For production packages, prefer individual modules (`strings`, `arrays`, and so on) so your public setup is more deliberate and your bundle stays smaller.
