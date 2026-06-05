<script setup lang="ts">
const samples = [
  { comment: 'Transform pipelines', code: '"  hello world  " |> trim |> upper', result: '"HELLO WORLD"' },
  { comment: 'Null-safe navigation', code: 'user?.profile?.avatar ?? "default.png"', result: '"default.png"' },
  { comment: 'Lambda predicates', code: 'users |> filter(.age >= 18) |> map(.name)', result: '["Alice"]' },
]

const useCases = [
  { kicker: 'Pricing & Eligibility', title: 'Business Rules', body: 'A pricing rule changes every quarter. With Bonsai it is a text field in your admin panel that evaluates at runtime.', code: 'order.total\n  >= freeShippingThreshold\n  && customer.tier == "gold"' },
  { kicker: 'Search & Admin UIs', title: 'Filter Builders', body: 'Store a saved view as a string and evaluate it per row, with no custom query parser to build or maintain.', code: 'orders |> filter(\n  .status == "pending"\n  && .total > 500\n)' },
  { kicker: 'Notifications & Emails', title: 'Templates', body: 'Template expressions live alongside the copy, not buried in application code or a separate engine.', code: '`Hi ${user.firstName},\n  order ${order.id} ships\n  ${shipDate |> formatDate}`' },
]
</script>

<template>
  <section class="home-showcase">
    <div class="hs-samples">
      <div v-for="s in samples" :key="s.code" class="hs-sample">
        <p class="hs-comment">// {{ s.comment }}</p>
        <code class="hs-code">{{ s.code }}</code>
        <p class="hs-result"><span class="hs-arrow">→</span> {{ s.result }}</p>
      </div>
    </div>

    <h2 class="hs-heading">Use it where <code>eval()</code> would be reckless</h2>
    <div class="hs-usecases">
      <article v-for="u in useCases" :key="u.title" class="hs-card">
        <span class="hs-kicker">{{ u.kicker }}</span>
        <h3>{{ u.title }}</h3>
        <p>{{ u.body }}</p>
        <pre class="hs-card-code"><code>{{ u.code }}</code></pre>
      </article>
    </div>
  </section>
</template>

<style scoped>
.home-showcase {
  max-width: 1152px;
  margin: 0 auto;
  padding: 1rem 24px 5rem;
}

/* Live snippet cards ------------------------------------------- */
.hs-samples {
  display: grid;
  gap: 1.25rem;
  grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
  margin: 0 0 5rem;
}

.hs-sample {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  padding: 1.3rem 1.4rem;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.7;
  transition: border-color 0.2s ease, transform 0.2s ease;
}

.hs-sample:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.hs-comment {
  color: var(--vp-c-text-3);
  margin: 0 0 0.4rem;
}

.hs-code {
  display: block;
  color: var(--vp-c-text-1);
  background: none;
  padding: 0;
  margin: 0 0 0.5rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.hs-result {
  color: var(--vp-c-brand-1);
  margin: 0;
  font-weight: 500;
}

.hs-arrow {
  opacity: 0.6;
}

/* Section heading ---------------------------------------------- */
.hs-heading {
  text-align: center;
  border: 0;
  margin: 0 0 2.5rem;
  padding: 0;
  font-size: 1.9rem;
  letter-spacing: -0.01em;
}

.hs-heading code {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

/* Use-case cards ----------------------------------------------- */
.hs-usecases {
  display: grid;
  gap: 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}

.hs-card {
  display: flex;
  flex-direction: column;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  padding: 1.6rem;
  transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}

.hs-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-3px);
  box-shadow: 0 14px 34px -16px rgba(0, 0, 0, 0.35);
}

.hs-kicker {
  color: var(--vp-c-brand-1);
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.hs-card h3 {
  margin: 0.6rem 0 0.5rem;
  font-size: 1.25rem;
  border: 0;
  letter-spacing: -0.01em;
}

.hs-card p {
  color: var(--vp-c-text-2);
  margin: 0 0 1.4rem;
  line-height: 1.65;
  font-size: 14.5px;
}

/* Code block pinned to the bottom of every card, so heights line up. */
.hs-card-code {
  margin: auto 0 0;
  padding: 0.8rem 0.9rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}

.hs-card-code code {
  display: block;
  background: none;
  padding: 0;
  color: var(--vp-c-text-1);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
