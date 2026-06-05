<script setup lang="ts">
const samples = [
  { comment: 'Transform pipelines', code: '"  hello world  " |> trim |> upper', result: '"HELLO WORLD"' },
  { comment: 'Null-safe navigation', code: 'user?.profile?.avatar ?? "default.png"', result: '"default.png"' },
  { comment: 'Lambda predicates', code: 'users |> filter(.age >= 18) |> map(.name)', result: '["Alice"]' },
]

const useCases = [
  { kicker: 'Pricing & Eligibility', title: 'Business Rules', body: 'A pricing rule changes every quarter. With Bonsai it is a text field in your admin panel that evaluates at runtime.', code: 'order.total >= freeShippingThreshold && customer.tier == "gold"' },
  { kicker: 'Search & Admin UIs', title: 'Filter Builders', body: 'Store a saved view as a string and evaluate it per row — no custom query parser needed.', code: 'orders |> filter(.status == "pending" && .total > 500)' },
  { kicker: 'Notifications & Emails', title: 'Templates', body: 'Template expressions live alongside the copy, not buried in application code.', code: '`Hi ${user.firstName}, order ${order.id} ships ${shipDate |> formatDate}`' },
]
</script>

<template>
  <section class="home-showcase">
    <div class="hs-samples">
      <div v-for="s in samples" :key="s.code" class="hs-sample">
        <p class="hs-comment">// {{ s.comment }}</p>
        <code class="hs-code">{{ s.code }}</code>
        <p class="hs-result">// → {{ s.result }}</p>
      </div>
    </div>

    <h2 class="hs-heading">Use it where <code>eval()</code> would be reckless</h2>
    <div class="hs-usecases">
      <article v-for="u in useCases" :key="u.title" class="hs-card">
        <span class="hs-kicker">{{ u.kicker }}</span>
        <h3>{{ u.title }}</h3>
        <p>{{ u.body }}</p>
        <code>{{ u.code }}</code>
      </article>
    </div>
  </section>
</template>

<style scoped>
.home-showcase { max-width: 1152px; margin: 0 auto; padding: 2rem 24px 4rem; }
.hs-samples { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-bottom: 4rem; }
.hs-sample { background: var(--vp-c-bg-alt); border: 1px solid var(--vp-c-divider); border-radius: 12px; padding: 1rem 1.25rem; font-family: var(--vp-font-family-mono); font-size: 13px; }
.hs-comment { color: var(--vp-c-text-3); margin: 0 0 .25rem; }
.hs-code { display: block; color: var(--vp-c-brand-1); margin: 0 0 .25rem; white-space: pre-wrap; }
.hs-result { color: var(--vp-c-text-2); margin: 0; }
.hs-heading { text-align: center; border: 0; margin: 0 0 2rem; }
.hs-usecases { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.hs-card { background: var(--vp-c-bg-alt); border: 1px solid var(--vp-c-divider); border-radius: 12px; padding: 1.5rem; }
.hs-kicker { color: var(--vp-c-brand-1); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.hs-card h3 { margin: .5rem 0; }
.hs-card code { display: block; margin-top: 1rem; font-size: 12px; word-break: break-word; }
</style>
