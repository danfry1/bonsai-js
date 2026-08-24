import { describe, expect, it } from 'vitest'
import { bonsai } from '../src/index.js'
import { arrays, math, strings } from '../src/stdlib/index.js'
import {
  checkExpression,
  createChecker,
  formatType,
  isAssignable,
  t,
} from '../src/checker/index.js'

describe('static checker', () => {
  const schema = t.object({
    user: t.object({
      name: t.string(),
      age: t.number(),
      active: t.boolean(),
      nickname: t.optional(t.string()),
    }),
    users: t.array(t.object({ name: t.string(), age: t.number(), active: t.boolean() })),
    threshold: t.number(),
    count: t.number(),
    text: t.string(),
    flag: t.boolean(),
    key: t.string(),
    nums: t.array(t.number()),
    tags: t.array(t.string()),
    dynamic: t.unknown(),
    open: t.object({ fixed: t.string() }, { additionalProperties: t.number() }),
    closed: t.object({ fixed: t.string() }, { additionalProperties: false }),
  })

  it('infers nested properties, operators, and an expected result', () => {
    const result = checkExpression(bonsai(), 'user.age >= threshold && user.active', {
      schema,
      expectedType: t.boolean(),
    })

    expect(result.valid).toBe(true)
    expect(result.type).toEqual(t.boolean())
  })

  it('reports unknown roots and properties with stable ranges', () => {
    const result = checkExpression(bonsai(), 'missing + user.agge', { schema })

    expect(result.valid).toBe(false)
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'UNKNOWN_IDENTIFIER',
      'UNKNOWN_PROPERTY',
    ])
    expect(result.diagnostics.every((diagnostic) => diagnostic.end > diagnostic.start)).toBe(true)
  })

  it('matches strict runtime operator semantics', () => {
    const result = checkExpression(bonsai(), 'user.name + user.age', { schema })
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'TYPE_MISMATCH',
          message: expect.stringContaining('two numbers or two strings'),
        }),
      ]),
    )
  })

  it('understands optional chaining and nullable access', () => {
    // Property reads on a nullable value are fine at runtime (they yield
    // undefined), so the type simply widens; method calls are where `?.` is
    // required because the runtime throws on a nullish receiver.
    const read = checkExpression(bonsai(), 'user.nickname.length', { schema })
    const unsafeCall = checkExpression(bonsai(), 'user.nickname.trim()', { schema })
    const safeCall = checkExpression(bonsai(), 'user.nickname?.trim()', { schema })
    const chained = checkExpression(bonsai(), 'user.nickname?.trim().length', { schema })
    const safe = checkExpression(bonsai(), 'user.nickname?.length ?? 0', {
      schema,
      expectedType: t.number(),
    })

    expect(read.valid).toBe(true)
    expect(formatType(read.type)).toBe('number | undefined')
    expect(unsafeCall.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['NULLABLE_ACCESS'])
    expect(safeCall.valid).toBe(true)
    expect(formatType(safeCall.type)).toBe('string | undefined')
    // Bonsai `?.` does not short-circuit the rest of the chain; `.length` on
    // undefined reads as undefined, so the chained type stays nullable.
    expect(chained.valid).toBe(true)
    expect(formatType(chained.type)).toBe('number | undefined')
    expect(safe.valid).toBe(true)
  })

  it('types lambda accessors on string and array elements', () => {
    const lengths = checkExpression(bonsai(), 'tags.map(.length)', { schema })
    const filtered = checkExpression(bonsai(), 'tags.filter(.length > 0)', { schema })
    const typo = checkExpression(bonsai(), 'tags.map(.lenght)', { schema })

    expect(lengths.valid).toBe(true)
    expect(formatType(lengths.type)).toBe('number[]')
    expect(filtered.valid).toBe(true)
    expect(formatType(filtered.type)).toBe('string[]')
    expect(typo.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['UNKNOWN_PROPERTY'])
  })

  it('models join/toSorted element rules and rejects callbacks on non-HOF methods', () => {
    const objectsSorted = checkExpression(bonsai(), 'users.toSorted()', { schema })
    const objectsJoined = checkExpression(bonsai(), 'users.join(",")', { schema })
    const callback = checkExpression(bonsai(), 'tags.toSorted(.length)', { schema })
    const fine = checkExpression(bonsai(), 'tags.toSorted().join("|")', { schema })

    expect(objectsSorted.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'TYPE_MISMATCH',
    ])
    expect(objectsJoined.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'TYPE_MISMATCH',
    ])
    expect(callback.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['TYPE_MISMATCH'])
    expect(fine.valid).toBe(true)
    expect(formatType(fine.type)).toBe('string')
  })

  it('checks built-in method arity and parameter types', () => {
    const badArg = checkExpression(bonsai(), 'text.slice("a")', { schema })
    const badPad = checkExpression(bonsai(), 'text.padStart(10, 5)', { schema })
    const badArity = checkExpression(bonsai(), 'text.trim(1)', { schema })
    const badWith = checkExpression(bonsai(), 'tags.with(0, 5)', { schema })
    const ok = checkExpression(bonsai(), 'text.slice(1, 3).padStart(10, "-")', { schema })

    expect(badArg.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['TYPE_MISMATCH'])
    expect(badPad.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['TYPE_MISMATCH'])
    expect(badArity.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['ARGUMENT_COUNT'])
    // `with` keeps the receiver element type; a number into string[] is a mismatch.
    expect(badWith.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['TYPE_MISMATCH'])
    expect(ok.valid).toBe(true)
  })

  it('reports pipe callback diagnostics once', () => {
    const expr = bonsai().use(arrays)
    const result = checkExpression(expr, 'tags |> filter(.x)', { schema })
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['UNKNOWN_PROPERTY'])
  })

  it('uses declared array type rules instead of transform names', () => {
    const bundled = bonsai().use(arrays)
    expect(formatType(checkExpression(bundled, 'users |> first', { schema }).type)).toBe(
      '{ name: string, age: number, active: boolean } | undefined',
    )
    expect(formatType(checkExpression(bundled, 'users |> reverse |> first', { schema }).type)).toBe(
      '{ name: string, age: number, active: boolean } | undefined',
    )
    expect(formatType(checkExpression(bundled, 'users |> map(.name)', { schema }).type)).toBe(
      'string[]',
    )
    expect(formatType(checkExpression(bundled, '[[1, 2]] |> flatten', { schema }).type)).toBe(
      'number[]',
    )

    const unrelated = bonsai().addTransform('map', (value) => value, {
      inputType: t.string(),
      returnType: t.string(),
    })
    const custom = checkExpression(unrelated, 'text |> map', { schema })
    expect(custom.valid).toBe(true)
    expect(formatType(custom.type)).toBe('string')
  })

  it('supports literal and enum types and flags impossible strict comparisons', () => {
    const plans = t.object({
      plan: t.enum('free', 'pro'),
      role: t.literal('admin'),
      tier: t.union(t.literal(1), t.literal(2)),
    })
    const ok = checkExpression(bonsai(), 'plan == "pro" && tier >= 1', { schema: plans })
    const typo = checkExpression(bonsai(), 'plan == "prem"', { schema: plans })
    const wrongKind = checkExpression(bonsai(), 'tier == "1"', { schema: plans })
    const asString = checkExpression(bonsai(), 'plan.toUpperCase()', { schema: plans })
    const widened = checkExpression(bonsai(), '[1, 2]', { schema: plans })

    expect(ok.valid).toBe(true)
    expect(typo.diagnostics[0]).toMatchObject({ code: 'TYPE_MISMATCH' })
    expect(typo.diagnostics[0]?.message).toContain('always false')
    expect(wrongKind.diagnostics[0]).toMatchObject({ code: 'TYPE_MISMATCH' })
    expect(asString.valid).toBe(true)
    expect(formatType(asString.type)).toBe('string')
    expect(formatType(widened.type)).toBe('number[]')
    expect(formatType(plans.properties.plan)).toBe('"free" | "pro"')
    expect(isAssignable(t.literal('pro'), t.string())).toBe(true)
    expect(isAssignable(t.string(), t.literal('pro'))).toBe(false)
    expect(formatType(t.array(t.union(t.number(), t.undefined())))).toBe('(number | undefined)[]')
    expect(formatType(t.record(t.string()))).toBe('{ [key: string]: string }')
    expect(formatType(t.nullable(t.string()))).toBe('string | null')
  })

  it('infers lambda element and result types for array methods', () => {
    const checker = createChecker(bonsai(), { schema })
    const mapped = checker.check('users.map(.age + 1)')
    const filtered = checker.check('users.filter(.active).map(.name)')

    expect(mapped.valid).toBe(true)
    expect(formatType(mapped.type)).toBe('number[]')
    expect(filtered.valid).toBe(true)
    expect(formatType(filtered.type)).toBe('string[]')
  })

  it('checks transform/function metadata without executing host code', () => {
    let calls = 0
    const expr = bonsai()
      .defineTransform({
        name: 'slug',
        inputType: t.string(),
        parameters: [{ name: 'separator', type: t.string(), optional: true }],
        returnType: t.string(),
        evaluate: () => {
          calls++
          throw new Error('must not execute')
        },
      })
      .defineFunction({
        name: 'between',
        parameters: [
          { name: 'value', type: t.number() },
          { name: 'min', type: t.number() },
          { name: 'max', type: t.number() },
        ],
        returnType: t.boolean(),
        evaluate: () => {
          calls++
          throw new Error('must not execute')
        },
      })

    const valid = checkExpression(expr, 'user.name |> slug("-")', { schema })
    const invalid = checkExpression(expr, 'between(user.age, "0")', { schema })

    expect(valid.valid).toBe(true)
    expect(formatType(valid.type)).toBe('string')
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'ARGUMENT_COUNT',
      'TYPE_MISMATCH',
    ])
    expect(calls).toBe(0)
  })

  it('uses bundled extension metadata and reports missing bindings', () => {
    const expr = bonsai().use(strings).use(arrays).use(math)
    expect(checkExpression(expr, 'user.name |> upper', { schema }).valid).toBe(true)

    expect(
      checkExpression(expr, 'user.name |> startsWith', { schema }).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(['ARGUMENT_COUNT'])
    expect(
      checkExpression(expr, 'users |> sum', { schema }).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(['TYPE_MISMATCH'])

    const missing = checkExpression(expr, 'unknown(user.age) || user.name |> absent', { schema })
    expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'UNKNOWN_FUNCTION',
      'UNKNOWN_TRANSFORM',
    ])
  })

  it('respects member policy and expected result types', () => {
    const expr = bonsai({ allowedProperties: ['age'] })
    const result = checkExpression(expr, 'user.name', { schema, expectedType: t.boolean() })
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'PROPERTY_NOT_ALLOWED',
      'EXPECTED_RESULT',
    ])

    const nonCanonicalIndex = checkExpression(bonsai({ allowedProperties: [] }), 'nums["01"]', {
      schema,
    })
    expect(nonCanonicalIndex.diagnostics[0]?.code).toBe('PROPERTY_NOT_ALLOWED')
  })

  it('rejects method calls when any concrete receiver union member is unsupported', () => {
    const unionSchema = t.object({ value: t.union(t.string(), t.boolean()) })
    const result = checkExpression(bonsai(), 'value.trim()', { schema: unionSchema })
    const dynamic = checkExpression(bonsai(), 'value.trim()', {
      schema: t.object({ value: t.unknown() }),
    })

    expect(result.diagnostics[0]?.code).toBe('METHOD_NOT_ALLOWED')
    expect(dynamic.valid).toBe(true)
  })

  it('returns syntax diagnostics instead of throwing', () => {
    const result = checkExpression(bonsai(), '1 +', { schema })
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ code: 'SYNTAX_ERROR', start: 3 })
  })

  it('uses the instance structural policy while parsing', () => {
    const result = checkExpression(bonsai({ maxSourceLength: 2 }), '1 + 2')
    expect(result.diagnostics[0]).toMatchObject({ code: 'RESOURCE_LIMIT' })
  })

  it('checks every source branch before compiler dead-branch elimination', () => {
    const result = checkExpression(bonsai(), 'true ? user.age : missing', { schema })
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['UNKNOWN_IDENTIFIER'])
  })

  it('supports open schemas and normalized serializable unions', () => {
    const open = t.object({}, { additionalProperties: t.unknown() })
    const result = checkExpression(bonsai(), 'anything.deeply.nested', { schema: open })
    const union = t.union(t.string(), t.string(), t.undefined())

    expect(result.valid).toBe(true)
    expect(JSON.parse(JSON.stringify(union))).toEqual({
      kind: 'union',
      members: [{ kind: 'string' }, { kind: 'undefined' }],
    })
  })

  it('only resolves own schema properties, including dangerous names', () => {
    const inherited = checkExpression(bonsai(), 'toString', {
      schema: t.object({}),
    })
    const declared = checkExpression(bonsai(), 'toString', {
      schema: t.object({ toString: t.string() }),
    })
    const dangerous = t.object({ ['__proto__']: t.number(), constructor: t.boolean() })

    expect(inherited.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'UNKNOWN_IDENTIFIER',
    ])
    expect(declared.valid).toBe(true)
    expect(Object.getPrototypeOf(dangerous.properties)).toBeNull()
    expect(Object.hasOwn(dangerous.properties, '__proto__')).toBe(true)
    expect(Object.hasOwn(dangerous.properties, 'constructor')).toBe(true)
  })

  it('formats and compares the complete schema vocabulary', () => {
    const composite = t.union(
      t.array(t.string()),
      t.object({ count: t.number() }),
      t.boolean(),
      t.null(),
    )

    expect(formatType(composite)).toBe('string[] | { count: number } | boolean | null')
    expect(formatType(t.unknown())).toBe('unknown')
    expect(formatType(t.undefined())).toBe('undefined')
    expect(t.union()).toEqual(t.unknown())
    expect(t.union(t.string(), t.union(t.string(), t.number()))).toEqual(
      t.union(t.string(), t.number()),
    )
    expect(t.union(t.string(), t.unknown())).toEqual(t.unknown())

    expect(isAssignable(t.array(t.number()), t.array(t.number()))).toBe(true)
    expect(isAssignable(t.array(t.string()), t.array(t.number()))).toBe(false)
    expect(isAssignable(t.union(t.string(), t.number()), t.string())).toBe(false)
    expect(isAssignable(t.string(), t.union(t.string(), t.number()))).toBe(true)
    expect(
      isAssignable(
        t.object({ count: t.number(), extra: t.string() }),
        t.object({ count: t.number() }),
      ),
    ).toBe(true)
    expect(isAssignable(t.object({}), t.object({ count: t.number() }))).toBe(false)
    expect(isAssignable(t.object({}), t.object({ name: t.optional(t.string()) }))).toBe(true)
    expect(isAssignable(t.object({ value: t.number() }), t.record(t.number()))).toBe(true)
    expect(isAssignable(t.object({ value: t.string() }), t.record(t.number()))).toBe(false)
    expect(
      isAssignable(
        t.object({ count: t.number(), extra: t.string() }),
        t.object({ count: t.number() }, { additionalProperties: false }),
      ),
    ).toBe(false)
    expect(isAssignable(t.boolean(), t.number())).toBe(false)
    expect(isAssignable(t.unknown(), t.number())).toBe(true)
    expect(
      t.union(
        t.object({ a: t.string(), b: t.number() }),
        t.object({ b: t.number(), a: t.string() }),
      ),
    ).toEqual(t.object({ a: t.string(), b: t.number() }))
    expect(() => t.literal(Number.NaN)).toThrow(TypeError)
  })

  it('covers literal, unary, logical, comparison, and membership inference', () => {
    const cases = [
      ['!flag', 'boolean'],
      ['-count + +threshold', 'number'],
      ['text + user.name', 'string'],
      ['count == threshold', 'boolean'],
      ['count != threshold', 'boolean'],
      ['"x" in text', 'boolean'],
      ['"x" not in tags', 'boolean'],
      ['count in nums', 'boolean'],
      ['text < user.name', 'boolean'],
      ['flag && text', 'boolean | string'],
      ['user.nickname ?? text', 'string'],
      ['flag ? null : undefined', 'null | undefined'],
    ] as const

    for (const [source, expected] of cases) {
      const result = checkExpression(bonsai(), source, { schema })
      expect(result.valid, source).toBe(true)
      expect(formatType(result.type), source).toBe(expected)
    }

    expect(checkExpression(bonsai(), 'count in user', { schema }).diagnostics[0]?.code).toBe(
      'TYPE_MISMATCH',
    )
    expect(checkExpression(bonsai(), 'text < count', { schema }).diagnostics[0]?.code).toBe(
      'TYPE_MISMATCH',
    )
    expect(checkExpression(bonsai(), 'text - count', { schema }).diagnostics[0]?.code).toBe(
      'TYPE_MISMATCH',
    )
  })

  it('infers arrays, strings, records, computed access, spreads, and templates', () => {
    const cases = [
      ['nums.length', 'number'],
      ['nums[0]', 'number | undefined'],
      ['nums[key]', 'number | undefined'],
      ['text.length', 'number'],
      ['text[0]', 'string | undefined'],
      ['open.anything', 'number | undefined'],
      ['closed[key]', 'undefined'],
      ['[count, ...nums]', 'number[]'],
      ['{ name: text, [key]: count }', '{ name: string }'],
      ['`hello ${text} ${count}`', 'string'],
    ] as const

    for (const [source, expected] of cases) {
      const result = checkExpression(bonsai(), source, { schema })
      expect(result.valid, source).toBe(true)
      expect(formatType(result.type), source).toBe(expected)
    }

    expect(checkExpression(bonsai(), 'count.missing', { schema }).diagnostics[0]?.code).toBe(
      'UNKNOWN_PROPERTY',
    )
    expect(checkExpression(bonsai(), '[...text]', { schema }).diagnostics[0]?.code).toBe(
      'TYPE_MISMATCH',
    )
    expect(checkExpression(bonsai(), '`bad ${users}`', { schema }).diagnostics[0]?.code).toBe(
      'TYPE_MISMATCH',
    )
  })

  it('checks safe methods and every higher-order result family', () => {
    const cases = [
      ['text.trim()', 'string'],
      ['text.includes("x")', 'boolean'],
      ['count.toFixed(2)', 'string'],
      ['nums.at(0)', 'number | undefined'],
      ['nums.slice(1)', 'number[]'],
      ['nums.concat([4])', 'number[]'],
      ['nums.concat(tags)', '(number | string)[]'],
      ['nums.map(. * 2)', 'number[]'],
      ['nums.filter(. > 1)', 'number[]'],
      ['nums.find(. > 1)', 'number | undefined'],
      ['nums.findIndex(. > 1)', 'number'],
      ['nums.some(. > 1)', 'boolean'],
      ['nums.every(. > 1)', 'boolean'],
      ['nums.flatMap(. * 2)', 'number[]'],
    ] as const

    for (const [source, expected] of cases) {
      const result = checkExpression(bonsai(), source, { schema })
      expect(result.valid, source).toBe(true)
      expect(formatType(result.type), source).toBe(expected)
    }

    expect(checkExpression(bonsai(), 'text.push(1)', { schema }).diagnostics[0]?.code).toBe(
      'METHOD_NOT_ALLOWED',
    )
    expect(checkExpression(bonsai(), 'text[key]()', { schema }).diagnostics[0]?.code).toBe(
      'METHOD_NOT_ALLOWED',
    )
    expect(checkExpression(bonsai(), 'nums.map(count)', { schema }).diagnostics[0]?.code).toBe(
      'TYPE_MISMATCH',
    )
    expect(checkExpression(bonsai(), 'nums.map()', { schema }).diagnostics[0]?.code).toBe(
      'ARGUMENT_COUNT',
    )
  })

  it('supports precise, union-input, optional, rest, and undeclared extension signatures', () => {
    const expr = bonsai()
      .addTransform('either', (value) => value, {
        inputType: t.union(t.string(), t.number()),
        returnType: t.boolean(),
      })
      .addTransform('opaque', (value) => value)
      .defineFunction({
        name: 'collect',
        parameters: [
          { name: 'first', type: t.string() },
          { name: 'rest', type: t.number(), rest: true },
        ],
        returnType: t.array(t.number()),
        evaluate: () => [],
      })
      .addFunction('anyArray', () => [], { returnType: t.array(t.unknown()) })
      .addFunction('anyObject', () => ({}), { returnType: t.record(t.unknown()) })
      .addFunction('alwaysNull', () => null, { returnType: t.null() })
      .addFunction('alwaysUndefined', () => undefined, { returnType: t.undefined() })
      .addFunction('untyped', () => undefined)

    const cases = [
      ['text |> either', 'boolean'],
      ['text |> opaque(count)', 'unknown'],
      ['collect(text, 1, 2, 3)', 'number[]'],
      ['anyArray()', 'unknown[]'],
      ['anyObject()', '{ [key: string]: unknown }'],
      ['alwaysNull()', 'null'],
      ['alwaysUndefined()', 'undefined'],
      ['untyped(count)', 'unknown'],
    ] as const

    for (const [source, expected] of cases) {
      const result = checkExpression(expr, source, { schema })
      expect(result.valid, source).toBe(true)
      expect(formatType(result.type), source).toBe(expected)
    }

    expect(checkExpression(expr, 'collect()', { schema }).diagnostics[0]?.code).toBe(
      'ARGUMENT_COUNT',
    )
    expect(checkExpression(expr, 'collect(text, "bad")', { schema }).diagnostics[0]?.code).toBe(
      'TYPE_MISMATCH',
    )
    expect(checkExpression(expr, 'flag |> either', { schema }).diagnostics[0]?.code).toBe(
      'TYPE_MISMATCH',
    )
  })

  it('applies allow, deny, blocked, open-root, and unknown-root policies', () => {
    const denied = checkExpression(bonsai({ deniedProperties: ['name'] }), 'user.name', {
      schema,
    })
    const blocked = checkExpression(bonsai(), 'user.constructor', { schema })
    const numeric = checkExpression(bonsai({ allowedProperties: [] }), 'nums[0]', { schema })
    const unknown = checkExpression(bonsai(), 'anything.deep', {
      schema,
      allowUnknownIdentifiers: true,
    })

    expect(denied.diagnostics[0]?.code).toBe('PROPERTY_NOT_ALLOWED')
    expect(blocked.diagnostics[0]?.code).toBe('PROPERTY_NOT_ALLOWED')
    expect(numeric.valid).toBe(true)
    expect(unknown.valid).toBe(true)
  })
})
