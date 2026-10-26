<script setup lang="ts">
import { ref } from 'vue'
import { withBase } from 'vitepress'
import Proofs from './home/Proofs.vue'
import LanguageHero from './home/LanguageHero.vue'
import { VERSION } from '../../../../src/version.ts'

const install = 'npm install bonsai-js'
const copied = ref(false)

async function copyInstall() {
  try {
    await navigator.clipboard.writeText(install)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    // Clipboard access denied; the command stays selectable.
  }
}

// From guide/comparison.md (measured 2026-10-14; Bonsai's sizes for 1.2.2 on 2026-10-26); keep the two in step.
const compared = [
  {
    name: 'bonsai-js',
    syntax: 'Text, JS-like',
    features: [true, true, true, true],
    size: '28.9 KB',
    sizeNote: '69.2 KB checking in the browser',
  },
  { name: 'cel-js', syntax: 'Text, CEL', features: [true, false, false, false], size: '24.3 KB' },
  { name: 'json-logic-js', syntax: 'JSON', features: [false, false, false, false], size: '2.0 KB' },
  { name: 'jexl', syntax: 'Text, JS-like', features: [false, false, false, false], size: '6.1 KB' },
  { name: 'filtrex', syntax: 'Text, own syntax', features: [false, false, false, false], size: '7.8 KB' },
]
const featureNames = ['Checked against types', 'Suggests fixes', 'Explains results', 'Filters a database']
</script>

<template>
  <div class="home">
    <section class="hero">
      <h1 class="hero-title">Safe, typed expressions for JavaScript.</h1>
      <p class="hero-what">
        Keep rules like <code>order.total &gt;= 50</code> as text, in your config, your database, or your users' hands.
        Bonsai checks them against your types, runs them safely, and explains every result.
      </p>
      <div class="actions">
        <a class="btn btn-primary" :href="withBase('/guide/quick-start')">Get started</a>
        <a class="btn" :href="withBase('/playground')">Open the playground</a>
      </div>
      <p class="facts">
        <button type="button" class="install" @click="copyInstall">
          <code>{{ install }}</code>
          <span class="install-copy">{{ copied ? 'Copied' : 'Copy' }}</span>
        </button>
        <span>v{{ VERSION }}, MIT licence, zero dependencies</span>
      </p>
      <!-- The logo's bonsai as the tree of a rule: its canopy pads are the rule's operators. -->
      <svg class="hero-tree" viewBox="0 0 64 64" aria-hidden="true">
        <path
          class="trunk"
          d="M24 52C27.4 50.6 28.6 48.4 27.4 45.6 26 42.4 22.4 40.6 22.9 36.6 23.6 29.9 33.6 30.4 31.6 21.6L36.2 21C38.6 31.4 29 33.6 28.7 37.4 28.4 40.4 32.4 42.6 34 45.6 35.4 48.4 36.6 50.8 40 52Z"
        />
        <path class="branch" d="M24.4 38.6 16 35.4M32.8 29.8 44.5 26.6" />
        <path class="trunk" d="M9 52H55L51.5 59H12.5Z" />
        <circle class="node" cx="14" cy="34.5" r="6" />
        <circle class="node" cx="46.5" cy="25.5" r="7.5" />
        <circle class="node" cx="33" cy="13.5" r="9.5" />
        <text x="14" y="35.9">&gt;=</text>
        <text x="46.5" y="26.9">==</text>
        <text x="33" y="15">&amp;&amp;</text>
      </svg>
    </section>

    <div class="demo">
      <LanguageHero />
    </div>

    <section class="band">
      <h2>Three calls in your app</h2>
      <ol class="steps">
        <li>
          <h3>Describe your data</h3>
          <p>Tell Bonsai what an expression can read.</p>
          <pre><code><span class="c-k">const</span> env = <span class="c-f">bonsai</span>({
  variables: { total: t.<span class="c-f">number</span>() },
})</code></pre>
        </li>
        <li>
          <h3>Check what someone wrote</h3>
          <p>Catch typos and wrong types when the rule is saved.</p>
          <pre><code><span class="c-k">const</span> rule = env.<span class="c-f">compile</span>(<span class="c-s">'total &gt;= 50'</span>)
<span class="c-c">// throws on a typo or a wrong type</span></code></pre>
        </li>
        <li>
          <h3>Run it</h3>
          <p>Against real data, as often as you like.</p>
          <pre><code>rule.<span class="c-f">evaluateSync</span>({ total: 84.5 })
<span class="c-c">// true</span></code></pre>
        </li>
      </ol>
    </section>

    <section class="band">
      <h2>What you get</h2>
      <Proofs />
    </section>

    <section class="band">
      <h2>How it compares</h2>
      <p class="lede">
        If the same rules must also run in Go or Java, use CEL. For a visual builder that stores JSON, use json-logic.
      </p>
      <div class="compare-wrap">
        <table class="compare">
          <thead>
            <tr>
              <th scope="col">Library</th>
              <th scope="col">Rules are</th>
              <th v-for="f in featureNames" :key="f" scope="col" class="mark">{{ f }}</th>
              <th scope="col" class="num">Browser, gzip</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in compared" :key="row.name" :class="{ us: row.name === 'bonsai-js' }">
              <th scope="row">{{ row.name }}</th>
              <td>{{ row.syntax }}</td>
              <td v-for="(has, i) in row.features" :key="i" class="mark" :class="has ? 'y' : 'n'">
                <span aria-hidden="true">{{ has ? '✓' : '–' }}</span>
                <span class="sr">{{ has ? 'Yes' : 'No' }}</span>
              </td>
              <td class="num">
                {{ row.size }}
                <span v-if="row.sizeNote" class="size-note">{{ row.sizeNote }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="compare-more">
        Bonsai's 28.9 KB is for rules checked on a server. The
        <a :href="withBase('/guide/comparison')">full comparison</a> covers nine libraries, what each part of Bonsai's
        size buys, and when each library is the better choice.
      </p>
    </section>

    <section class="closing">
      <h2>Try it on one rule.</h2>
      <p>Five minutes from install to your first checked rule.</p>
      <button type="button" class="install install-big" @click="copyInstall">
        <code>{{ install }}</code>
        <span class="install-copy">{{ copied ? 'Copied' : 'Copy' }}</span>
      </button>
      <div class="actions">
        <a class="btn btn-light" :href="withBase('/guide/quick-start')">Read the quick start</a>
        <a class="btn btn-ghost" :href="withBase('/recipes/')">See recipes</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  --gutter: 24px;
  max-width: 1160px;
  margin: 0 auto;
  padding: 0 var(--gutter);
}

h1,
h2,
h3 {
  font-family: var(--bonsai-font-display);
  color: var(--vp-c-text-1);
  border: 0;
  margin: 0;
  padding: 0;
}

code {
  font-family: var(--vp-font-family-mono);
}

/*
 * Full-bleed bands: the colour is a shadow spread past the column and clipped
 * to the band's height, so it reaches the window edges without a horizontal
 * scrollbar. The hero's reaches up behind the (transparent) home nav.
 */
.hero,
.closing {
  position: relative;
  background: var(--band);
  box-shadow: 0 0 0 100vmax var(--band);
}

.hero {
  --band: var(--bonsai-band);
  clip-path: inset(calc(-1 * var(--vp-nav-height)) -100vmax 0);
  padding: 80px 0 172px;
}

.closing {
  --band: var(--bonsai-ink);
  clip-path: inset(0 -100vmax);
}

/* Hero ---------------------------------------------------------- */
.hero-title {
  max-width: 12em;
  font-size: clamp(42px, 5.8vw, 74px);
  font-weight: 700;
  line-height: 0.94;
  letter-spacing: -0.045em;
  font-variation-settings: 'opsz' 96;
  text-wrap: balance;
}

.hero-what {
  max-width: 34em;
  margin: 24px 0 0;
  color: var(--vp-c-text-2);
  font-size: clamp(17px, 1.6vw, 20px);
  line-height: 1.5;
}

.hero-what code {
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--bonsai-card);
  color: var(--vp-c-text-1);
  font-size: 0.86em;
  white-space: nowrap;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 30px;
}

.btn {
  display: inline-flex;
  align-items: center;
  height: 44px;
  padding: 0 20px;
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  background: var(--bonsai-card);
  color: var(--vp-c-text-1);
  font-size: 15px;
  font-weight: 550;
  text-decoration: none;
  transition: border-color 0.15s, background-color 0.15s, transform 0.15s;
}

.btn:hover {
  border-color: var(--vp-c-text-3);
}

.btn-primary {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: var(--bonsai-on-brand);
}

.btn-primary:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
}

.facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 20px;
  margin: 20px 0 0;
  color: var(--vp-c-text-3);
  font-size: 13px;
}

/* The install command doubles as its copy button. */
.install {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
}

.install code {
  color: var(--vp-c-text-2);
}

.install code::before {
  content: '$ ';
  color: var(--vp-c-text-3);
}

.install-copy {
  color: var(--vp-c-brand-1);
  font-size: 13px;
  font-weight: 500;
}

.hero-tree {
  position: absolute;
  right: -12px;
  bottom: 132px;
  width: min(32vw, 400px);
  pointer-events: none;
}

.hero-tree .trunk {
  fill: var(--vp-c-brand-1);
  opacity: 0.14;
}

.hero-tree .branch {
  fill: none;
  stroke: var(--vp-c-brand-1);
  stroke-width: 4;
  stroke-linecap: round;
  opacity: 0.14;
}

.hero-tree .node {
  fill: var(--bonsai-card);
  stroke: var(--vp-c-brand-1);
  stroke-width: 0.6;
  stroke-opacity: 0.35;
}

.hero-tree text {
  fill: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 4px;
  font-weight: 600;
  text-anchor: middle;
}

/* Only where it has clear room beside the headline. */
@media (max-width: 1240px) {
  .hero-tree {
    display: none;
  }
}

/* The demo crosses the hero band's lower edge. */
.demo {
  position: relative;
  margin-top: -124px;
}

/* Sections ------------------------------------------------------ */
.band {
  padding: 120px 0 0;
}

.band > h2,
.closing h2 {
  font-size: clamp(30px, 3.6vw, 44px);
  font-weight: 700;
  line-height: 1.02;
  letter-spacing: -0.03em;
}

.band > h2 {
  margin-bottom: 36px;
}

.lede {
  max-width: 40em;
  margin: -20px 0 28px;
  color: var(--vp-c-text-2);
  font-size: 16px;
  line-height: 1.6;
}

/* Three calls: one dark panel, a column per step (a real sequence, so numbered). */
.steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
  padding: 0;
  border-radius: 16px;
  background: var(--bonsai-ink);
  color: var(--bonsai-ink-text);
  list-style: none;
  counter-reset: step;
  overflow: hidden;
}

.steps li {
  display: grid;
  grid-row: span 3;
  grid-template-rows: subgrid;
  min-width: 0;
  padding: 28px 28px 30px;
  counter-increment: step;
}

.steps li + li {
  border-left: 1px solid rgba(213, 225, 211, 0.1);
}

.steps h3 {
  color: #f1f6ef;
  font-size: 19px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.steps h3::before {
  content: counter(step);
  display: inline-block;
  width: 26px;
  height: 26px;
  margin-right: 10px;
  border-radius: 50%;
  background: #9fdcb4;
  color: #0e1712;
  font-size: 14px;
  line-height: 26px;
  text-align: center;
  vertical-align: 2px;
}

.steps p {
  margin: 8px 0 18px;
  color: #a6b4a8;
  font-size: 15px;
  line-height: 1.55;
}

.steps pre {
  margin: 0;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--bonsai-ink-2);
  white-space: pre-wrap;
}

.steps pre code {
  font-size: 13px;
  line-height: 1.65;
}

.c-k {
  color: #9fc9ff;
}
.c-f {
  color: #9fdcb4;
}
.c-s {
  color: #e3b98f;
}
.c-c {
  color: #7f9585;
}

/* Comparison ---------------------------------------------------- */
.compare-wrap {
  overflow-x: auto;
  border-radius: 14px;
  background: var(--bonsai-card);
  box-shadow: var(--bonsai-card-shadow);
}

.compare {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  font-size: 14.5px;
}

.compare th,
.compare td {
  padding: 14px 16px;
  text-align: left;
  border-bottom: 1px solid var(--vp-c-divider);
}

.compare tr:last-child > * {
  border-bottom: 0;
}

.compare thead th {
  color: var(--vp-c-text-2);
  font-size: 13px;
  font-weight: 500;
  vertical-align: bottom;
}

.compare tbody th {
  font-family: var(--vp-font-family-mono);
  font-size: 13.5px;
  font-weight: 500;
  color: var(--vp-c-text-1);
}

.compare .us {
  background: var(--vp-c-brand-soft);
}

.compare .us th {
  color: var(--vp-c-brand-1);
  font-weight: 700;
}

.compare .mark {
  text-align: center;
}

.compare .y {
  color: var(--vp-c-brand-1);
  font-size: 17px;
  font-weight: 700;
}

.compare .n {
  color: var(--vp-c-text-3);
}

.compare .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.size-note {
  display: block;
  color: var(--vp-c-text-3);
  font-size: 12px;
  white-space: normal;
}

.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.compare-more {
  max-width: 48em;
  margin: 18px 0 0;
  color: var(--vp-c-text-2);
  font-size: 15px;
  line-height: 1.6;
}

.compare-more a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* Closing: a dark pine band to end on. */
.closing {
  margin-top: 140px;
  padding: 96px 0 104px;
  text-align: center;
}

.closing h2 {
  color: #f1f6ef;
}

.closing > p {
  margin: 14px 0 0;
  color: #a6b4a8;
  font-size: 17px;
}

.install-big {
  margin-top: 28px;
  padding: 14px 20px;
  border-radius: 10px;
  background: var(--bonsai-ink-2);
  font-size: 16px;
}

.install-big code {
  color: #f1f6ef;
}

.install-big code::before {
  color: #7f9585;
}

.install-big .install-copy {
  color: #9fdcb4;
}

.closing .actions {
  justify-content: center;
}

.btn-light {
  background: #9fdcb4;
  border-color: #9fdcb4;
  color: #0e1712;
}

.btn-light:hover {
  background: #b7e6c7;
  border-color: #b7e6c7;
}

.btn-ghost {
  background: transparent;
  border-color: rgba(213, 225, 211, 0.25);
  color: #f1f6ef;
}

.btn-ghost:hover {
  border-color: rgba(213, 225, 211, 0.5);
}

/* Responsive ---------------------------------------------------- */
@media (max-width: 860px) {
  .steps {
    grid-template-columns: minmax(0, 1fr);
  }

  .steps li + li {
    border-left: 0;
    border-top: 1px solid rgba(213, 225, 211, 0.1);
  }
}

@media (max-width: 640px) {
  .home {
    --gutter: 16px;
  }

  .hero {
    padding: 44px 0 140px;
  }

  .demo {
    margin-top: -100px;
  }

  .band {
    padding-top: 88px;
  }

  .closing {
    margin-top: 100px;
    padding: 72px 0 80px;
  }
}
</style>
