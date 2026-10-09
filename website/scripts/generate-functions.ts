// Generates the built-in function reference under website/functions/ from
// the real function table (`bonsai().listFunctions()`).
//
//   bun website/scripts/generate-functions.ts
//
// Signatures and descriptions come from the library. Examples are listed
// here and evaluated while generating, so every published result is real.
// The script fails if a built-in is missing from AREAS or EXAMPLES, so new
// built-ins cannot be left undocumented.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bonsai, formatType, type FunctionInfo, type Type } from '../../src/index.ts'
import { CLOCK, display } from './format.ts'


const outDir = fileURLToPath(new URL('../functions/', import.meta.url))
const llmsFull = fileURLToPath(new URL('../public/llms-full.txt', import.meta.url))

interface Area {
  file: string
  title: string
  intro: string
  names: string[]
}

const AREAS: Area[] = [
  {
    file: 'text',
    title: 'Text',
    intro:
      'Functions over strings. Positions and lengths count UTF-16 code units, as in JavaScript. `includes`, `indexOf`, `replace`, and `replaceAll` match literal text; `matches` tests a regular expression.',
    names: [
      'toUpperCase', 'toLowerCase', 'trim', 'trimStart', 'trimEnd', 'startsWith', 'endsWith',
      'includes', 'indexOf', 'lastIndexOf', 'slice', 'split', 'replace', 'replaceAll',
      'padStart', 'padEnd', 'repeat', 'at', 'matches', 'toString', 'toNumber',
    ],
  },
  {
    file: 'lists',
    title: 'Lists',
    intro:
      'Functions over lists. None of them mutate their input: `sort` and `reverse` return new lists. Functions that take a lambda accept an implicit `.` lambda or an arrow lambda, and call it with the item and its index.',
    names: [
      'map', 'filter', 'find', 'findIndex', 'some', 'every', 'none', 'count', 'flatMap', 'reduce',
      'sort', 'sortBy', 'groupBy', 'reverse', 'unique', 'flat', 'first', 'last', 'join', 'slice',
      'at', 'includes', 'indexOf', 'lastIndexOf', 'isEmpty', 'min', 'max', 'sum', 'avg',
    ],
  },
  {
    file: 'numbers',
    title: 'Numbers',
    intro:
      'Arithmetic helpers. A result that is not a finite number (for example `sqrt(-1)`) is a `NON_FINITE` error rather than `NaN`.',
    names: [
      'round', 'floor', 'ceil', 'trunc', 'abs', 'sqrt', 'clamp', 'toFixed', 'formatNumber',
      'formatCurrency', 'min', 'max', 'sum', 'avg',
    ],
  },
  {
    file: 'maps',
    title: 'Maps and Values',
    intro: 'Functions over maps, and functions that inspect any value. Keys are listed in JavaScript property order: integer-like keys first, ascending, then the other keys in the order they were added.',
    names: ['keys', 'values', 'entries', 'isEmpty', 'type', 'toString'],
  },
  {
    file: 'time',
    title: 'Time',
    intro:
      'Timestamps and durations. Calendar functions take an optional IANA time zone as their last argument and default to UTC. The examples on this page run with the clock fixed at `' +
      CLOCK +
      '`, so `now()` returns that instant.',
    names: [
      'now', 'timestamp', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds',
      'inDays', 'inHours', 'inMinutes', 'inSeconds', 'inMilliseconds', 'year', 'month', 'day',
      'hour', 'minute', 'second', 'dayOfWeek', 'startOfDay', 'startOfMonth', 'startOfYear',
      'addDays', 'addMonths', 'addYears', 'formatDate', 'abs', 'sum',
    ],
  },
]

const CONTEXT = {
  items: [
    { name: 'Pen', price: 2, qty: 3 },
    { name: 'Book', price: 12, qty: 1 },
    { name: 'Bag', price: 30, qty: 1 },
  ],
}
const CONTEXT_TEXT =
  '{ items: [{ name: "Pen", price: 2, qty: 3 }, { name: "Book", price: 12, qty: 1 }, { name: "Bag", price: 30, qty: 1 }] }'

// Examples per area and function. Time-only overloads live under `time`.
const EXAMPLES: Record<string, Record<string, string[]>> = {
  text: {
    toUpperCase: ['"hello".toUpperCase()'],
    toLowerCase: ['toLowerCase("Hello")'],
    trim: ['"  hi  ".trim()'],
    trimStart: ['"  hi  ".trimStart()'],
    trimEnd: ['"  hi  ".trimEnd()'],
    startsWith: ['"invoice-42".startsWith("invoice-")'],
    endsWith: ['"report.pdf".endsWith(".pdf")'],
    includes: ['"hello world".includes("lo w")'],
    indexOf: ['"banana".indexOf("an")', '"banana".indexOf("x")'],
    lastIndexOf: ['"banana".lastIndexOf("an")'],
    slice: ['"hello".slice(1, 3)', '"hello".slice(-3)'],
    split: ['"a,b,c".split(",")', '"a,b,c".split(",", 2)'],
    replace: ['"a-b-c".replace("-", "+")'],
    replaceAll: ['"a-b-c".replaceAll("-", "+")'],
    padStart: ['"7".padStart(3, "0")'],
    padEnd: ['"ab".padEnd(4, ".")'],
    repeat: ['"ab".repeat(3)'],
    at: ['"hello".at(-1)', '"hello".at(10)'],
    toString: ['toString(42)', 'toString(null)', 'days(1).toString()'],
    toNumber: ['"42.5".toNumber()', 'try("4x".toNumber(), 0)'],
    matches: ['"INV-2041".matches("^INV-[0-9]+$")', '"Hello".matches("(?i)^hello$")', '"a.b".matches("a\\\\.b")'],
  },
  lists: {
    map: ['items.map(.name)', 'items.map((it, i) => `${i + 1}. ${it.name}`)'],
    filter: ['items.filter(.price > 5).map(.name)'],
    find: ['items.find(.price > 10)', 'items.find(.price > 100)'],
    findIndex: ['items.findIndex(.name == "Bag")'],
    some: ['items.some(.price > 20)'],
    every: ['items.every(.qty >= 1)'],
    none: ['items.none(.price < 0)'],
    count: ['items.count()', 'items.count(.qty > 1)'],
    flatMap: ['[1, 2].flatMap([., . * 10])'],
    reduce: ['items.reduce((total, it) => total + it.price * it.qty, 0)'],
    sort: ['[3, 1, 2].sort()', '["b", "a"].sort("desc")'],
    sortBy: ['items.sortBy(.price, "desc").map(.name)'],
    groupBy: ['items.groupBy(.qty > 1 ? "bulk" : "single").keys()', '[1, 2, 3, 4].groupBy(. % 2 == 0 ? "even" : "odd")'],
    reverse: ['[1, 2, 3].reverse()'],
    unique: ['[1, 2, 1, 3, 2].unique()', '[{ a: 1 }, { a: 1 }].unique()'],
    flat: ['[[1, 2], [3], 4].flat()'],
    first: ['items.first().name', '[].first()'],
    last: ['[1, 2, 3].last()'],
    join: ['items.map(.name).join(", ")', '[1, 2, 3].join()'],
    slice: ['[1, 2, 3, 4].slice(1, 3)', '[1, 2, 3, 4].slice(-2)'],
    at: ['[1, 2, 3].at(-1)', '[1, 2, 3].at(5)'],
    includes: ['[1, 2, 3].includes(2)', '[{ id: 1 }].includes({ id: 1 })'],
    indexOf: ['["a", "b", "c"].indexOf("b")'],
    lastIndexOf: ['[1, 2, 1].lastIndexOf(1)'],
    isEmpty: ['[].isEmpty()', 'isEmpty(null)'],
    min: ['items.map(.price).min()', '[].min()'],
    max: ['items.map(.price).max()'],
    sum: ['items.map(.price * .qty).sum()', '[1, null, 2].sum()'],
    avg: ['items.map(.price).avg()', '[].avg()'],
  },
  numbers: {
    round: ['round(2.5)', 'round(-2.5)', 'round(3.14159, 2)'],
    floor: ['floor(2.7)', 'floor(-2.1)'],
    ceil: ['ceil(2.1)'],
    trunc: ['trunc(-2.7)'],
    abs: ['abs(-4)'],
    sqrt: ['sqrt(16)', 'try(sqrt(-1), 0)'],
    clamp: ['clamp(150, 0, 100)', '(-5).clamp(0, 100)'],
    toFixed: ['toFixed(3.14159, 2)', '(2).toFixed(1)'],
    formatNumber: ['formatNumber(1234567.891)', 'formatNumber(1234.5, 2)', 'formatNumber(1234.5, 2, "de-DE")'],
    formatCurrency: ['formatCurrency(1234.5, "EUR")', 'formatCurrency(1234.5, "EUR", "de-DE")', 'formatCurrency(99, "JPY")'],
    min: ['min(4, 2, 8)', 'min([4, 2, 8])'],
    max: ['max(4, 2, 8)', '[4, 2, 8].max()'],
    sum: ['[1, 2, 3].sum()'],
    avg: ['[2, 4, null].avg()'],
  },
  maps: {
    keys: ['{ a: 1, b: 2 }.keys()'],
    values: ['{ a: 1, b: 2 }.values()'],
    entries: ['{ a: 1, b: 2 }.entries()', '{ a: 1, b: 2 }.entries().map(`${.key}=${.value}`).join("&")'],
    isEmpty: ['{}.isEmpty()', 'isEmpty("")'],
    type: ['type(1)', 'type("a")', 'type([])', 'type({})', 'type(null)', 'type(now())', 'type(days(1))'],
    toString: ['toString(true)', '`${1.5}` == toString(1.5)'],
  },
  time: {
    now: ['now()'],
    timestamp: [
      'timestamp("2026-03-01T12:00:00Z")',
      'timestamp("2026-03-01")',
      'timestamp("2026-03-01T12:00:00+02:00")',
      'timestamp(0)',
    ],
    weeks: ['weeks(2)'],
    days: ['days(3)', 'now() + days(30)'],
    hours: ['hours(1.5)'],
    minutes: ['minutes(90)'],
    seconds: ['seconds(0.5)'],
    milliseconds: ['milliseconds(1500)'],
    inDays: ['inDays(hours(36))', 'inDays(now() - timestamp("2026-01-01T00:00:00Z"))'],
    inHours: ['days(2).inHours()'],
    inMinutes: ['hours(1).inMinutes()'],
    inSeconds: ['minutes(2).inSeconds()'],
    inMilliseconds: ['seconds(1).inMilliseconds()'],
    year: ['year(now())'],
    month: ['month(now())'],
    day: ['day(now())'],
    hour: ['hour(now())', 'hour(now(), "America/New_York")', 'now().hour("Asia/Tokyo")'],
    minute: ['minute(now())'],
    second: ['second(now())'],
    dayOfWeek: ['dayOfWeek(now())'],
    startOfDay: ['startOfDay(now())', 'startOfDay(now(), "Europe/Berlin")'],
    startOfMonth: ['startOfMonth(now())'],
    startOfYear: ['startOfYear(now())'],
    addDays: [
      'addDays(timestamp("2026-03-28T12:00:00Z"), 2, "Europe/Berlin")',
      'timestamp("2026-03-28T12:00:00Z") + days(2)',
    ],
    addMonths: ['addMonths(timestamp("2026-01-31T00:00:00Z"), 1)'],
    addYears: ['addYears(timestamp("2024-02-29T00:00:00Z"), 1)'],
    formatDate: ['formatDate(now(), "yyyy-MM-dd HH:mm")', 'now().formatDate("dd/MM/yyyy HH:mm", "Asia/Tokyo")'],
    abs: ['abs(hours(-2))'],
    sum: ['[hours(1), minutes(30)].sum()'],
  },
}

// Areas where only some overloads of a shared function apply.
type Signature = FunctionInfo['signatures'][number]
const timeish = (s: Signature): boolean => /"(timestamp|duration)"/u.test(JSON.stringify(s))
const OVERLOAD_FILTER: Record<string, (s: Signature) => boolean> = {
  text: (s) => s.params[0]?.kind === 'string' || s.params[0]?.kind === 'union',
  lists: (s) => s.params[0]?.kind === 'list' || s.params[0]?.kind === 'union',
  numbers: (s) => !timeish(s) && (s.params[0]?.kind === 'number' || s.params[0]?.kind === 'list'),
  maps: () => true,
  time: timeish,
}

function paramText(type: Type, optional: boolean): string {
  let text = formatType(type)
  if (optional) text = text.replace(/ \| null$/u, '')
  const needsParens = optional && /[|=]/u.test(text)
  return `${needsParens ? `(${text})` : text}${optional ? '?' : ''}`
}

function signatures(info: FunctionInfo, area: string): string[] {
  const keep = info.name === 'toString' || info.name === 'isEmpty' || info.name === 'type' ? () => true : OVERLOAD_FILTER[area]
  return info.signatures
    .filter((s) => keep(s))
    .map((s) => {
      const params = s.params.map((p, i) => paramText(p, i >= s.required))
      if (s.rest) params.push(`...${formatType(s.rest)}`)
      return `${info.name}(${params.join(', ')}): ${formatType(s.returns)}`
    })
}

const env = bonsai({ clock: () => new Date(CLOCK) })
const functions = new Map(env.listFunctions().map((f) => [f.name, f]))

const covered = new Set(AREAS.flatMap((a) => a.names))
const missing = [...functions.keys()].filter((name) => !covered.has(name))
const unknown = [...covered].filter((name) => !functions.has(name))
if (missing.length > 0 || unknown.length > 0) {
  throw new Error(`Update AREAS. Missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}`)
}

function example(source: string): string {
  let result: unknown
  try {
    result = env.evaluateSync(source, CONTEXT)
  } catch (error) {
    throw new Error(`Example failed: ${source}: ${(error as Error).message}`)
  }
  return `${source} // => ${display(result)}`
}

const HEADER = '<!-- Generated by website/scripts/generate-functions.ts. Do not edit by hand. -->'

for (const area of AREAS) {
  const lines: string[] = [HEADER, '', `# ${area.title}`, '', area.intro, '']
  lines.push(
    'Every function can be called as `f(x, ...)` or as a method, `x.f(...)`. In the signatures, `T` and `U` stand for any type, `T[]` is a list, `?` marks an optional parameter, and `(T, number) => boolean` is a lambda parameter.',
    '',
  )
  if (area.file === 'lists') {
    lines.push('The examples use this context:', '', '```ts', `const context = ${CONTEXT_TEXT}`, '```', '')
  }
  lines.push('| Function | Description |', '| --- | --- |')
  for (const name of area.names) {
    lines.push(`| [\`${name}\`](#${name.toLowerCase()}) | ${functions.get(name)?.description ?? ''} |`)
  }
  lines.push('')
  for (const name of area.names) {
    const info = functions.get(name) as FunctionInfo
    const examples = EXAMPLES[area.file][name]
    if (examples === undefined) throw new Error(`No example for ${name} in ${area.file}`)
    lines.push(`## ${name}`, '', info.description, '')
    for (const s of signatures(info, area.file)) lines.push(`- \`${s}\``)
    lines.push('')
    lines.push(`<!-- context: ${CONTEXT_TEXT} -->`)
    lines.push('```bonsai')
    for (const source of examples) lines.push(example(source))
    lines.push('```', '')
  }
  writeFileSync(`${outDir}${area.file}.md`, lines.join('\n'))
}

// Overview page: every function, grouped.
const overview: string[] = [
  HEADER,
  '',
  '# Built-in Functions',
  '',
  'Bonsai has one function namespace. Every built-in is available in every environment without imports, and every function can be called in either form: `sum(xs)` and `xs.sum()` are the same call. The first argument is the receiver of the method form.',
  '',
  'A host function with the same name as a built-in replaces it for that environment, so built-ins added in later releases never change the meaning of existing expressions. `env.listFunctions()` returns the same list with signatures and descriptions, for building your own documentation or editor tooling.',
  '',
]
for (const area of AREAS) {
  overview.push(`## [${area.title}](./${area.file})`, '')
  overview.push(area.names.map((n) => `[\`${n}\`](./${area.file}#${n.toLowerCase()})`).join(' '), '')
}
overview.push(
  '## Not functions',
  '',
  '`has(...)` and `try(...)` look like calls but are language forms: `has` inspects a property without reading it and `try` catches evaluation errors. See [let, try, and has](/language/let-try-has). `length` is a property of strings and lists, not a function: write `xs.length`.',
  '',
)
writeFileSync(`${outDir}index.md`, overview.join('\n'))

// The function list in llms-full.txt, between its markers.
const BEGIN = '<!-- BEGIN GENERATED FUNCTIONS -->'
const END = '<!-- END GENERATED FUNCTIONS -->'
const listing: string[] = []
for (const area of AREAS) {
  listing.push('', `### ${area.title}`, '')
  for (const name of area.names) {
    const info = functions.get(name) as FunctionInfo
    listing.push(`- ${signatures(info, area.file).join('; ')}: ${info.description}`)
  }
}
const full = readFileSync(llmsFull, 'utf8')
const begin = full.indexOf(BEGIN)
const end = full.indexOf(END)
if (begin === -1 || end === -1) throw new Error('llms-full.txt is missing the generated-functions markers')
writeFileSync(llmsFull, `${full.slice(0, begin + BEGIN.length)}\n${listing.join('\n')}\n\n${full.slice(end)}`)
console.log(`Wrote ${AREAS.length + 1} pages for ${functions.size} functions`)
