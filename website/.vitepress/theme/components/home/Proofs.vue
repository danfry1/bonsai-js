<script setup lang="ts">
import { ref } from 'vue'
import { withBase } from 'vitepress'
import { bonsai, t } from 'bonsai-src'
import { toMongo, toSQL } from 'bonsai-query'
import { display } from '../../../../scripts/format'
import Code from './Code.vue'
import { reasonsOf } from './links'
import { columns, explained, mistakes, refusals, sqlRule, variables } from './proofs-data'

// The home page's "What you get" grid: four claims, each with one small proof
// computed by the real engine when the page renders, laid out as a small table
// so each reads at a glance.

const env = bonsai({ variables })

const caught = mistakes.map((m) => {
  const d = env.check(m.rule, { expect: t.boolean() }).diagnostics[0]
  return { ...m, message: d?.message ?? '', mark: d && { start: d.start, end: d.end, severity: d.severity } }
})

// The explained rule for each order: its result, and the conditions that decided it (explain()'s reasons).
const explainedRule = bonsai({ variables: explained.variables }).compile(explained.rule, { expect: t.boolean() })
const decisions = explained.orders.map((order) => {
  const explanation = explainedRule.explainSync({ order }, { exhaustive: true })
  return {
    order: `${order.total} to ${order.country}`,
    why: reasonsOf(explanation.trace, explanation.reasons()).filter((c) => c.decided),
    result: explanation.ok && explanation.value ? explained.whenTrue : explained.whenFalse,
  }
})

// The database rule in each target, computed once.
const program = env.compile(sqlRule, { expect: t.boolean() })
// SQLite first: its query is the easiest to read.
const targets = (['sqlite', 'postgres', 'mongodb'] as const).map((id) => {
  if (id === 'mongodb') {
    return { id, label: 'MongoDB', query: `find(${display(toMongo(program, { row: 'order', fields: columns }).filter)})` }
  }
  const { sql, params } = toSQL(program, { row: 'order', columns, dialect: id })
  const name = (i: number) => (id === 'postgres' ? `$${i + 1}` : `?${i + 1}`)
  return {
    id,
    label: id === 'postgres' ? 'Postgres' : 'SQLite',
    query: `WHERE ${sql}`,
    params: params.map((p, i) => `${name(i)} = ${display(p)}`).join(', '),
  }
})
const target = ref(0)
</script>

<template>
  <div class="grid">
    <article class="cell">
      <h3>Mistakes are caught before anything runs</h3>
      <p>Checked against your types, with a fix where there is one.</p>
      <div class="proof">
        <table>
          <thead>
            <tr>
              <th scope="col">Someone writes</th>
              <th scope="col">Bonsai says</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in caught" :key="c.rule" :title="c.message">
              <td class="code"><Code :code="c.rule" :mark="c.mark" :wrap="false" /></td>
              <td class="says">{{ c.summary }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <a :href="withBase('/language/checking')">How checking works</a>
    </article>

    <article class="cell">
      <h3>Every result explains itself</h3>
      <p><code>explain()</code> tells you why, for every order.</p>
      <div class="proof">
        <p class="rule"><Code :code="explained.rule" /></p>
        <table>
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Result</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in decisions" :key="d.order">
              <td class="order">{{ d.order }}</td>
              <td class="result">{{ d.result }}</td>
              <td class="code why">
                <span v-for="c in d.why" :key="c.start" class="reason">
                  <Code :code="c.text" :wrap="false" /> <span class="value" :class="c.value">{{ c.value }}</span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <a :href="withBase('/api/explain')">Explaining results</a>
    </article>

    <article class="cell">
      <h3>Nothing in an expression can break your app</h3>
      <p>It reads only the data you pass in: no reaching your app, changing data, endless loops, or runaway memory.</p>
      <div class="proof">
        <table>
          <thead>
            <tr>
              <th scope="col">Someone tries</th>
              <th scope="col">Blocked</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in refusals" :key="r.code" :title="r.message">
              <td class="code"><Code :code="r.code" :wrap="false" /></td>
              <td class="says">{{ r.summary }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <a :href="withBase('/guide/safety')">How Bonsai stays safe</a>
    </article>

    <article class="cell">
      <h3>The same rule can filter your database</h3>
      <p>Translated to a query, so the database does the filtering.</p>
      <div class="proof">
        <div class="targets" role="tablist" aria-label="Database">
          <button
            v-for="(x, i) in targets"
            :key="x.id"
            type="button"
            role="tab"
            :aria-selected="i === target"
            @click="target = i"
          >
            {{ x.label }}
          </button>
        </div>
        <dl class="lines">
          <dt>Rule</dt>
          <dd><Code :code="sqlRule" /></dd>
          <dt>Query</dt>
          <dd>
            <code class="query"
              ><template v-for="(w, i) in targets[target].query.split(' ')" :key="i"
                >{{ i ? ' ' : '' }}<span class="word">{{ w }}</span></template
              ></code
            >
          </dd>
          <template v-if="targets[target].params">
            <dt>Values</dt>
            <dd><code class="params">{{ targets[target].params }}</code></dd>
          </template>
        </dl>
      </div>
      <a :href="withBase('/api/query')">Database filters</a>
    </article>
  </div>
</template>

<style scoped>
/* Each cell's heading, text, proof and link share rows with its neighbour, so the boxes line up. */
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 24px;
}

/* Each claim is one raised card. */
.cell {
  display: grid;
  grid-row: span 4;
  grid-template-rows: subgrid;
  min-width: 0;
  margin-bottom: 24px;
  padding: 28px 28px 24px;
  border-radius: 16px;
  background: var(--bonsai-card);
  box-shadow: var(--bonsai-card-shadow);
}

h3 {
  margin: 0;
  font-family: var(--bonsai-font-display);
  font-size: 22px;
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: -0.015em;
  color: var(--vp-c-text-1);
}

.cell > p {
  margin: 8px 0 18px;
  max-width: 34em;
  color: var(--vp-c-text-2);
  font-size: 15.5px;
  line-height: 1.6;
}

.cell > a {
  justify-self: start;
  margin-top: 14px;
  color: var(--vp-c-brand-1);
  font-size: 15px;
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 3px;
}

code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.92em;
  color: var(--vp-c-text-1);
}

/* The proof: a quiet inset holding a small table. */
.proof {
  min-width: 0;
  padding: 14px 18px 16px;
  border-radius: 10px;
  background: var(--vp-c-bg);
  font-size: 14px;
  line-height: 1.5;
  overflow-x: auto;
}

.proof :deep(.bx) {
  font-size: 13.5px;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  padding: 0 10px 8px 0;
  color: var(--vp-c-text-3);
  font-size: 12.5px;
  font-weight: 600;
  text-align: left;
  vertical-align: bottom;
}

td {
  padding: 9px 10px 9px 0;
  border-top: 1px solid var(--vp-c-divider);
  vertical-align: baseline;
}

th:last-child,
td:last-child {
  padding-right: 0;
}

/*
 * Code stays on one line; only the words beside it wrap (the inset scrolls if
 * a phone is narrower). `pre`, not `nowrap`, so a squiggle runs unbroken over spaces.
 */
.proof .code,
.proof .code :deep(.bx) {
  white-space: pre;
}

/* Plain text: these are Bonsai doing its job, not failures, so the squiggle alone marks the problem. */
.says {
  color: var(--vp-c-text-1);
  font-size: 13.5px;
}

/* The explained rule: one column per condition, one row per order. */
.rule {
  margin: 2px 0 12px;
}

.order {
  color: var(--vp-c-text-2);
  font-size: 13.5px;
  white-space: nowrap;
}

.value {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 600;
}

.value.true {
  color: var(--vp-c-brand-1);
}

.value.false {
  color: var(--vp-c-text-2);
}

/* Each deciding condition on its own line. */
.reason {
  display: block;
}

.reason + .reason {
  margin-top: 2px;
}

.reason .value {
  margin-left: 4px;
}

.result {
  color: var(--vp-c-text-1);
  font-weight: 600;
  white-space: nowrap;
}

/* Database targets. */
.targets {
  display: flex;
  gap: 4px;
  margin: -2px 0 10px -8px;
}

.targets button {
  padding: 3px 8px;
  border-radius: 6px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 500;
}

.targets button:hover {
  color: var(--vp-c-text-1);
}

.targets button[aria-selected='true'] {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

/* The rule, its query and the values sent with it, as labelled lines. */
.lines {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0 16px;
  margin: 0;
}

.lines dt {
  padding: 9px 0;
  border-top: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-3);
  font-size: 12.5px;
  font-weight: 600;
}

.lines dd {
  margin: 0;
  padding: 9px 0;
  border-top: 1px solid var(--vp-c-divider);
  min-width: 0;
}

/* The query wraps only at its spaces, never inside a token like `?3`. */
.query .word {
  white-space: nowrap;
}

.params {
  color: var(--vp-c-text-2);
  font-size: 12.5px;
}

@media (max-width: 860px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .cell {
    padding: 22px 18px 20px;
  }
}
</style>
