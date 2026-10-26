import { toStandardJsonSchema } from '@valibot/to-json-schema'
import { type as ark } from 'arktype'
import * as v from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  bonsai,
  fn,
  formatType,
  fromSchema,
  t,
  type Infer,
  type JSONSchema,
  type Type,
} from '../src/index.js'
import { fromSchema as liteFromSchema } from '../src/lite/index.js'

const shape = (schema: JSONSchema): string => formatType(fromSchema(schema))

describe('fromSchema with Zod', () => {
  const User = z.object({
    age: z.number().int(),
    plan: z.enum(['free', 'pro']),
    nick: z.string().optional(),
    joined: z.date(),
    tags: z.array(z.string()).default([]),
  })

  it('checks and evaluates against the converted type', () => {
    const env = bonsai({ variables: { user: fromSchema(User) } })
    expect(formatType(env.variables!.user)).toBe(
      '{ age: number, plan: "free" | "pro", nick: string | null, joined: timestamp, tags: string[] }',
    )
    const user = User.parse({ age: 30, plan: 'pro', joined: new Date(0) })
    expect(env.evaluateSync('user.age >= 18 && user.plan == "pro"', { user })).toBe(true)
    expect(env.check('user.agee').diagnostics[0]).toMatchObject({ code: 'UNKNOWN_PROPERTY' })
    expect(env.check('user.plan == "gold"').diagnostics[0]).toMatchObject({ code: 'ALWAYS_FALSE' })
    expect(env.check('user.joined > 5').ok).toBe(false)
  })

  it('types the context as the schema output', () => {
    const env = bonsai({ variables: { user: fromSchema(User) } })
    type Context = Parameters<typeof env.evaluateSync>[1]
    expectTypeOf<Context>().toEqualTypeOf<{ readonly user: z.output<typeof User> }>()
    const nested = bonsai({ variables: { order: t.object({ by: fromSchema(User) }) } })
    expectTypeOf<Parameters<typeof nested.evaluateSync>[1]>().toEqualTypeOf<{
      readonly order: { readonly by: z.output<typeof User> }
    }>()
  })

  it('makes a variable from an optional schema an optional key', () => {
    const env = bonsai({ variables: { coupon: fromSchema(z.string().optional()) } })
    // Every key optional, so the context may be left out too.
    expectTypeOf<NonNullable<Parameters<typeof env.evaluateSync>[1]>>().toEqualTypeOf<{
      readonly coupon?: string | undefined
    }>()
    expect(env.evaluateSync('coupon ?? "none"', {})).toBe('none')
  })

  it('gives host function parameters unknown, since only the converted type was checked', () => {
    const lookup = fn({
      params: [fromSchema(z.string().brand('Id'))],
      returns: t.string(),
      run: (id) => {
        expectTypeOf(id).toBeUnknown()
        return String(id)
      },
    })
    expect(bonsai({ functions: { lookup } }).evaluateSync('lookup("a")')).toBe('a')
  })

  it('marks values JSON Schema cannot state', () => {
    const type = fromSchema(
      z.object({
        when: z.date().nullable(),
        dates: z.array(z.date()),
        ids: z.set(z.string()),
        big: z.bigint(),
        pending: z.promise(z.string()),
        meta: z.record(z.string(), z.unknown()),
      }),
    )
    expect(formatType(type)).toBe(
      '{ when: timestamp | null, dates: timestamp[], ids: set, big: bigint, pending: promise, meta: { [key: string]: any } }',
    )
  })

  it('reports a transform by its pointer, and takes a type for it', () => {
    const Order = z.object({ total: z.string().transform(Number) })
    expect(() => fromSchema(Order)).toThrow('"/properties/total" is a transform')
    expect(() => fromSchema(z.object({ x: z.custom<string>() }))).toThrow('is a custom')
    const type = fromSchema(Order, { types: { '/properties/total': t.number() } })
    expect(formatType(type)).toBe('{ total: number }')
  })

  it('stops a recursive schema at its first repeat', () => {
    interface CategoryData {
      name: string
      children: CategoryData[]
    }
    const Category: z.ZodType<CategoryData> = z.object({
      name: z.string(),
      get children() {
        return z.array(Category)
      },
    })
    expect(formatType(fromSchema(Category))).toBe('{ name: string, children: any[] }')
  })

  it('reads records with enum keys, tuples, and discriminated unions', () => {
    expect(formatType(fromSchema(z.record(z.enum(['a', 'b']), z.number())))).toBe(
      '{ a: number, b: number }',
    )
    expect(formatType(fromSchema(z.tuple([z.string(), z.number()])))).toBe('(string | number)[]')
    const Shape = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('circle'), r: z.number() }),
      z.object({ kind: z.literal('square'), side: z.number() }),
    ])
    expect(formatType(fromSchema(Shape))).toBe(
      '{ kind: "circle", r: number } | { kind: "square", side: number }',
    )
  })

  it('runs the caller’s hook after its own, so the hook can mark a part', () => {
    const When = z.instanceof(Date)
    const type = fromSchema(z.object({ at: When }), {
      libraryOptions: {
        override: (ctx: { zodSchema: unknown; jsonSchema: Record<string, unknown> }) => {
          if (ctx.zodSchema === When) ctx.jsonSchema['x-bonsai-type'] = 'timestamp'
        },
      },
    })
    expect(formatType(type)).toBe('{ at: timestamp }')
  })
})

describe('fromSchema with Valibot and ArkType', () => {
  it('reads a Valibot schema wrapped as Standard JSON Schema', () => {
    const Schema = v.object({ name: v.string(), age: v.optional(v.number()), joined: v.date() })
    const User = toStandardJsonSchema(Schema)
    expect(formatType(fromSchema(User))).toBe(
      '{ name: string, age: number | null, joined: timestamp }',
    )
    const env = bonsai({ variables: { user: fromSchema(User) } })
    expectTypeOf<Parameters<typeof env.evaluateSync>[1]>().toEqualTypeOf<{
      readonly user: v.InferOutput<typeof Schema>
    }>()
  })

  it('says how to wrap a bare Valibot schema', () => {
    expect(() => fromSchema(v.string() as never)).toThrow('toStandardJsonSchema')
  })

  it('reads an ArkType type', () => {
    const User = ark({ name: 'string', 'age?': 'number', joined: 'Date', plan: "'free' | 'pro'" })
    expect(formatType(fromSchema(User))).toBe(
      '{ joined: timestamp, name: string, plan: "free" | "pro", age: number | null }',
    )
  })
})

describe('fromSchema with JSON Schema', () => {
  it('maps the core keywords', () => {
    expect(
      shape({
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: ['string', 'null'] },
          status: { enum: ['open', 'closed', null] },
          kind: { type: 'string', const: 'order' },
          lines: {
            type: 'array',
            items: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
          },
          at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'name', 'status', 'kind', 'lines', 'at'],
      }),
    ).toBe(
      '{ id: number, name: string | null, status: "open" | "closed" | null, kind: "order", lines: { sku: string }[], at: string }',
    )
  })

  it('keeps an object closed unless it states its other keys', () => {
    expect(shape({ type: 'object', properties: { a: { type: 'string' } } })).toBe(
      '{ a: string | null }',
    )
    expect(
      shape({ properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } }),
    ).toBe('{ a: string | null, [key: string]: number }')
    expect(
      shape({
        type: 'object',
        patternProperties: { '^x-': { type: 'string' } },
        additionalProperties: false,
      }),
    ).toBe('{ [key: string]: string }')
    // Free-form: nothing is known about its keys.
    expect(shape({ type: 'object' })).toBe('any')
    expect(shape({ type: 'object', additionalProperties: false })).toBe('{}')
  })

  it('follows refs, including JSON pointer escapes', () => {
    expect(
      shape({
        $defs: {
          'a/b': { type: 'number' },
          Money: {
            type: 'object',
            properties: { cents: { $ref: '#/$defs/a~1b' } },
            required: ['cents'],
          },
        },
        type: 'object',
        properties: { price: { $ref: '#/$defs/Money' } },
        required: ['price'],
      }),
    ).toBe('{ price: { cents: number } }')
  })

  it('applies OpenAPI 3.0 nullable, also beside allOf', () => {
    expect(
      shape({
        components: {
          Address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
        allOf: [{ $ref: '#/components/Address' }],
        nullable: true,
      }),
    ).toBe('{ city: string } | null')
  })

  it('merges allOf and applies keywords beside oneOf to each member', () => {
    expect(
      shape({
        allOf: [
          { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          { type: 'object', properties: { name: { type: 'string' } } },
          { description: 'only an annotation' },
        ],
      }),
    ).toBe('{ id: string, name: string | null }')
    expect(
      shape({
        type: 'object',
        properties: { email: { type: 'string' }, phone: { type: 'string' } },
        oneOf: [{ required: ['email'] }, { required: ['phone'] }],
      }),
    ).toBe('{ email: string | null, phone: string | null }')
    expect(() => shape({ allOf: [{ type: 'string' }, { type: 'number' }] })).toThrow(
      'no value can match',
    )
  })

  it('folds properties a condition adds in as optional fields', () => {
    expect(
      shape({
        type: 'object',
        properties: { country: { type: 'string' } },
        required: ['country'],
        if: { properties: { country: { const: 'US' } } },
        then: { properties: { state: { type: 'string' } }, required: ['state'] },
        else: { properties: { region: { type: 'string' } } },
      }),
    ).toBe('{ country: string, state: string | null, region: string | null }')
  })

  it('reads draft-07 tuples and empty arrays', () => {
    expect(
      shape({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'array',
        items: [{ type: 'string' }],
        additionalItems: false,
      }),
    ).toBe('string[]')
    expect(shape({ type: 'array', items: false })).toBe('never[]')
    expect(shape({ type: 'array' })).toBe('any[]')
  })

  it('reads the x-bonsai-type keyword', () => {
    expect(shape({ type: 'string', 'x-bonsai-type': 'timestamp' })).toBe('timestamp')
    expect(shape({ 'x-bonsai-type': 'opaque:Money' })).toBe('Money')
    expect(() => shape({ 'x-bonsai-type': 'date' })).toThrow('must be "timestamp"')
  })

  it('takes types for parts by JSON pointer, inside refs too', () => {
    const type = fromSchema(
      {
        $defs: { When: { type: 'string' } },
        type: 'object',
        properties: { at: { $ref: '#/$defs/When' } },
        required: ['at'],
      },
      { types: { '/$defs/When': t.timestamp() } },
    )
    expect(formatType(type)).toBe('{ at: timestamp }')
  })

  it('refuses what it cannot follow', () => {
    expect(() => shape({ $ref: 'https://example.com/schema.json' })).toThrow(
      'only JSON pointer refs inside the schema',
    )
    expect(() => shape({ $ref: '#/$defs/Missing' })).toThrow('does not contain')
    expect(() => shape({ $ref: '#/constructor/prototype' })).toThrow('does not contain')
    expect(() => shape({ type: 'date' })).toThrow('unknown type "date"')
    expect(() => shape({ enum: [{ a: 1 }] })).toThrow('not a string, number, boolean, or null')
    expect(() => fromSchema(t.string() as never)).toThrow('Bonsai type')
    expect(() => fromSchema(42 as never)).toThrow('expects a schema')
  })

  it('leaves out fields that cannot be read', () => {
    const type = fromSchema(
      JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"string"}}}',
      ) as JSONSchema,
    )
    expect(formatType(type)).toBe('{ ok: string | null }')
    expect(Object.getPrototypeOf(type.kind === 'map' ? type.fields : null)).toBe(Object.prototype)
  })

  it('bounds how far refs expand', () => {
    // Each definition uses the one before it twice: 2^40 parts if inlined.
    const defs: Record<string, JSONSchema> = { d0: { type: 'string' } }
    for (let i = 1; i <= 40; i++)
      defs[`d${i}`] = {
        type: 'object',
        properties: { a: { $ref: `#/$defs/d${i - 1}` }, b: { $ref: `#/$defs/d${i - 1}` } },
      }
    const started = performance.now()
    expect(() => fromSchema({ $defs: defs, $ref: '#/$defs/d40' })).toThrow('expands to more than')
    expect(performance.now() - started).toBeLessThan(2000)
    expect(() => fromSchema({ enum: Array.from({ length: 150_000 }, (_, i) => i) })).toThrow(
      'expands to more than',
    )
    // A code list of 25,000 values fits.
    expect(fromSchema({ enum: Array.from({ length: 25_000 }, (_, i) => `c${i}`) }).kind).toBe(
      'union',
    )
  })

  it('converts a ref used many times once, and charges each use', () => {
    const uses: Record<string, JSONSchema> = {}
    for (let i = 0; i < 300; i++) uses[`u${i}`] = { $ref: '#/$defs/Money' }
    const type = fromSchema({
      $defs: {
        Money: { type: 'object', properties: { cents: { type: 'number' } }, required: ['cents'] },
      },
      type: 'object',
      properties: uses,
      required: Object.keys(uses),
    })
    if (type.kind !== 'map') throw new Error('expected a map')
    expect(type.fields.u0).toBe(type.fields.u299)
  })

  it('lets keys no pattern matches hold anything', () => {
    const extensions = { type: 'object', patternProperties: { '^x-': { type: 'string' } } }
    expect(shape(extensions)).toBe('{ [key: string]: any }')
    expect(accepts(fromSchema(extensions), { 'x-a': 's', other: 1 })).toBe(true)
    expect(shape({ ...extensions, additionalProperties: false })).toBe('{ [key: string]: string }')
    const Loose = z.looseRecord(z.string().regex(/^x/u), z.number())
    expect(accepts(fromSchema(Loose), Loose.parse({ x1: 1, other: 'str' }))).toBe(true)
  })

  it('adds null for OpenAPI nullable beside an enum, and for Swagger x-nullable', () => {
    expect(shape({ type: 'string', enum: ['a', 'b'], nullable: true })).toBe('"a" | "b" | null')
    expect(shape({ type: 'string', 'x-nullable': true })).toBe('string | null')
  })

  it('keeps declared properties beside an enum of key names, and reads draft-07 dependencies', () => {
    expect(
      shape({
        type: 'object',
        properties: { a: { type: 'string' } },
        propertyNames: { enum: ['a', 'b'] },
        additionalProperties: { type: 'number' },
      }),
    ).toBe('{ a: string | null, b: number | null }')
    expect(
      shape({
        type: 'object',
        properties: { a: { type: 'string' } },
        dependencies: { a: { properties: { b: { type: 'number' } } }, c: ['a'] },
      }),
    ).toBe('{ a: string | null, b: number | null }')
  })

  it('refuses a malformed Standard JSON Schema', () => {
    expect(() => fromSchema({ '~standard': null } as never)).toThrow('malformed ~standard')
    const empty = { '~standard': { version: 1, vendor: 'x', jsonSchema: { output: () => null } } }
    expect(() => fromSchema(empty as never)).toThrow('not an object')
  })

  it('makes OpenAPI readOnly and writeOnly keys optional', () => {
    expect(
      shape({
        type: 'object',
        properties: {
          id: { type: 'number', readOnly: true },
          password: { type: 'string', writeOnly: true },
          name: { type: 'string' },
        },
        required: ['id', 'password', 'name'],
      }),
    ).toBe('{ id: number | null, password: string | null, name: string }')
  })

  it('reads a hidden ~standard from another library as a schema', () => {
    const schema = {}
    Object.defineProperty(schema, '~standard', {
      enumerable: false,
      value: { version: 1, vendor: 'other', jsonSchema: { output: () => ({ type: 'string' }) } },
    })
    expect(formatType(fromSchema(schema))).toBe('string')
  })

  it('reads the JSON z.toJSONSchema returns as given', () => {
    const json = z.toJSONSchema(z.object({ when: z.string() }), { target: 'draft-07' })
    ;(json.properties!.when as Record<string, unknown>)['x-bonsai-type'] = 'timestamp'
    expect(formatType(fromSchema(json))).toBe('{ when: timestamp }')
  })

  it('is exported from the lite entry', () => {
    expect(liteFromSchema).toBe(fromSchema)
  })
})

/** Whether a context `{ v: value }` passes validation against `type` (absent when undefined). */
function accepts(type: Type, value: unknown): boolean {
  const env = bonsai({ variables: { v: type }, validateContext: true })
  const context: Record<string, unknown> = value === undefined ? {} : { v: value }
  return env.evaluateSync('v == null || v != null', context) === true
}

describe('fromSchema accepts what each library parses', () => {
  it('Zod: optional values outside objects, bigint literals', () => {
    const List = z.array(z.string().optional())
    expect(accepts(fromSchema(List), List.parse(['x', undefined]))).toBe(true)
    const Pair = z.tuple([z.string(), z.number().optional()])
    expect(accepts(fromSchema(Pair), Pair.parse(['a']))).toBe(true)
    expect(accepts(fromSchema(z.string().optional()), undefined)).toBe(true)
    expect(formatType(fromSchema(z.union([z.string(), z.undefined()])))).toBe('string | null')
    const Maybe = z.literal(['a', undefined])
    expect(accepts(fromSchema(Maybe), Maybe.parse(undefined))).toBe(true)
    // A default takes undefined away again.
    expect(formatType(fromSchema(z.string().optional().default('y')))).toBe('string')
    expect(formatType(fromSchema(z.object({ a: z.string().optional() }).required()))).toBe(
      '{ a: string }',
    )
    const Big = z.object({ a: z.literal(1n) })
    expect(formatType(fromSchema(Big))).toBe('{ a: bigint }')
    expect(accepts(fromSchema(Big), Big.parse({ a: 1n }))).toBe(true)
  })

  it('Valibot: transformations, undefinedable, and optional items', () => {
    const Order = v.object({
      n: v.pipe(v.string(), v.toNumber()),
      at: v.pipe(v.string(), v.toDate()),
      name: v.pipe(v.string(), v.trim()),
      maybe: v.undefinedable(v.string()),
      list: v.array(v.optional(v.string())),
    })
    const type = fromSchema(toStandardJsonSchema(Order))
    expect(formatType(type)).toBe(
      '{ n: number, at: timestamp, name: string, maybe: string | null, list: (string | null)[] }',
    )
    const parsed = v.parse(Order, {
      n: '3',
      at: '2026-01-01',
      name: ' a ',
      maybe: undefined,
      list: ['x', undefined],
    })
    expect(accepts(type, parsed)).toBe(true)
    const Lengths = v.pipe(
      v.array(v.string()),
      v.mapItems((s) => s.length),
    )
    expect(() => fromSchema(toStandardJsonSchema(Lengths))).toThrow('is a transform')
    // A key with a default value is always there; a default function may return undefined.
    const Defaulted = v.object({
      a: v.optional(v.string(), 'x'),
      b: v.nullish(v.number(), 0),
      c: v.optional(v.string(), () => undefined),
    })
    const defaulted = fromSchema(toStandardJsonSchema(Defaulted))
    expect(formatType(defaulted)).toBe('{ a: string, b: number, c: string | null }')
    expect(accepts(defaulted, v.parse(Defaulted, {}))).toBe(true)
    // A null default keeps null.
    const NullDefault = v.object({
      a: v.nullable(v.string(), null),
      b: v.nullish(v.string(), null),
    })
    expect(
      accepts(fromSchema(toStandardJsonSchema(NullDefault)), v.parse(NullDefault, { a: null })),
    ).toBe(true)
    const Lazy = v.optional(v.string(), () => undefined)
    expect(accepts(fromSchema(toStandardJsonSchema(Lazy)), v.parse(Lazy, undefined))).toBe(true)
    expect(formatType(fromSchema(toStandardJsonSchema(v.looseObject({ a: v.string() }))))).toBe(
      '{ a: string, [key: string]: any }',
    )
    expect(formatType(fromSchema(toStandardJsonSchema(v.union([v.string(), v.undefined()]))))).toBe(
      'string | null',
    )
  })

  it('ArkType: postfix tuples, Map instances', () => {
    const Tuple = ark(['...', 'number[]', 'string'])
    expect(accepts(fromSchema(Tuple), Tuple.assert([1, 'a']))).toBe(true)
    expect(formatType(fromSchema(ark({ m: ark.instanceOf(Map) })))).toBe('{ m: map }')
    const Maybe = ark('string | undefined')
    expect(formatType(fromSchema(Maybe))).toBe('string | null')
    expect(accepts(fromSchema(Maybe), Maybe.assert(undefined))).toBe(true)
  })
})

describe('fromSchema input checks', () => {
  it('reads a tuple written as an items array without $schema', () => {
    expect(shape({ type: 'array', items: [{ type: 'string' }], additionalItems: false })).toBe(
      'string[]',
    )
  })

  it('refuses types pointers the schema does not have', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    expect(() => fromSchema(schema, { types: { '/properties/b': t.number() } })).toThrow(
      '"/properties/b", which the schema does not have',
    )
  })

  it('names unevaluatedProperties by its own pointer', () => {
    const type = fromSchema(
      { type: 'object', unevaluatedProperties: { type: 'string' } },
      { types: { '/unevaluatedProperties': t.number() } },
    )
    expect(formatType(type)).toBe('{ [key: string]: number }')
  })

  it('keeps a required field required when a condition narrows it', () => {
    expect(
      shape({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        then: { properties: { a: { const: 'x' }, b: { type: 'number' } } },
      }),
    ).toBe('{ a: string, b: number | null }')
  })

  it('reports nesting deeper than a Bonsai type', () => {
    let schema: JSONSchema = { type: 'string' }
    for (let i = 0; i < 40; i++) schema = { type: 'object', properties: { a: schema } }
    expect(() => fromSchema(schema)).toThrow('nests deeper than a Bonsai type can')
  })

  it('accepts a schema typed by an interface, and a kind property in a JSON Schema', () => {
    interface SchemaObject {
      type?: string
      properties?: Record<string, SchemaObject>
    }
    const schema: SchemaObject = { type: 'object', properties: { kind: { type: 'string' } } }
    expect(formatType(fromSchema(schema))).toBe('{ kind: string | null }')
    expect(shape({ kind: 'x', properties: { a: { type: 'string' } } })).toBe('{ a: string | null }')
    expect(() => shape({ 'x-bonsai-type': 'opaque:' })).toThrow('must be "timestamp"')
  })
})

describe('schema objects passed where a type goes', () => {
  it('says to convert them with fromSchema', () => {
    expect(() => bonsai({ variables: { user: z.object({}) as never } })).toThrow(
      'Variable "user" is a schema object; convert it with fromSchema() first',
    )
    expect(() => bonsai({ variables: { user: ark({ a: 'string' }) as never } })).toThrow(
      'fromSchema()',
    )
    expect(() => bonsai({ variables: { user: v.string() as never } })).toThrow('fromSchema()')
  })

  it('gives Infer the schema output', () => {
    const User = fromSchema(z.object({ age: z.number() }))
    expectTypeOf<Infer<typeof User>>().toEqualTypeOf<{ age: number }>()
  })
})
