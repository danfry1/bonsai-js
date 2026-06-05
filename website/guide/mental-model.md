# Mental Model

You only need four ideas to work effectively with Bonsai.

## Expressions are strings

You store or pass source text like `order.total >= freeShippingThreshold`. Bonsai parses and evaluates that string for you.

```ts
expr.evaluateSync('order.total >= freeShippingThreshold', { order, freeShippingThreshold })
```

## Context is just data

The context object becomes the variable scope for the expression. There is no access to globals or hidden ambient state.

```ts
{ order: { total: 129, country: 'GB' }, freeShippingThreshold: 100 }
```

## Pipes are for data flow

Transforms read naturally from left to right, which is why most formatting and collection work is easiest to express with `|>`.

```ts
customerName |> trim |> upper
```

## Compile is a performance tool

If an expression will run many times, compile it once and keep the returned object around.

```ts
const rule = expr.compile('order.total >= freeShippingThreshold')
```

**Simple rule of thumb:** use transforms for "take this value and do something to it", and functions for "call a named operation with arguments".
