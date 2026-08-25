import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Bonsai',
  description:
    'A safe expression language for rules, filters, templates, and user-authored logic. Runs in Node.js, Bun, and modern browsers.',
  lang: 'en-US',
  base: '/bonsai-js/',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: 'https://danfry1.github.io/bonsai-js/' },
  vite: {
    resolve: {
      alias: {
        'bonsai-src': fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
        'bonsai-stdlib': fileURLToPath(new URL('../../src/stdlib/index.ts', import.meta.url)),
        'bonsai-autocomplete': fileURLToPath(new URL('../../src/autocomplete/index.ts', import.meta.url)),
      },
    },
  },
  head: [
    ['link', { rel: 'icon', href: '/bonsai-js/logo.png', type: 'image/png' }],
    ['meta', { name: 'theme-color', content: '#0a0a0f' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Bonsai' }],
    ['meta', { property: 'og:image', content: 'https://danfry1.github.io/bonsai-js/og-card.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://danfry1.github.io/bonsai-js/og-card.png' }],
    ['meta', { property: 'og:title', content: 'Bonsai — Safe Expressions for Rules, Filters, and Templates' }],
    ['meta', { name: 'twitter:title', content: 'Bonsai — Safe Expressions for Rules, Filters, and Templates' }],
  ],
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/danfry1/bonsai-js' },
    ],
    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Playground', link: '/playground' },
      { text: 'API', link: '/api/bonsai' },
      { text: 'How It Works', link: '/how-it-works' },
      { text: 'npm', link: 'https://www.npmjs.com/package/bonsai-js' },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is Bonsai', link: '/guide/' },
          { text: 'Install', link: '/guide/install' },
          { text: 'Quick Start', link: '/guide/quick-start' },
          { text: 'Mental Model', link: '/guide/mental-model' },
        ],
      },
      {
        text: 'Language',
        items: [
          { text: 'Literals & Types', link: '/language/literals' },
          { text: 'Operators', link: '/language/operators' },
          { text: 'Property Access', link: '/language/property-access' },
          { text: 'Pipe Operator', link: '/language/pipe' },
          { text: 'Collections', link: '/language/collections' },
          { text: 'Template Literals', link: '/language/templates' },
          { text: 'Lambda Predicates', link: '/language/lambdas' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'bonsai(options)', link: '/api/bonsai' },
          { text: 'evaluateSync & evaluate', link: '/api/evaluate' },
          { text: 'compile & validate', link: '/api/compile' },
          { text: 'Static Checker', link: '/api/checker' },
          { text: 'Extending', link: '/api/extending' },
          { text: 'Instance Methods', link: '/api/instance-methods' },
          { text: 'evaluateExpression', link: '/api/evaluate-expression' },
          { text: 'Error Handling', link: '/api/errors' },
        ],
      },
      {
        text: 'Standard Library',
        items: [
          { text: 'Strings', link: '/stdlib/strings' },
          { text: 'Arrays', link: '/stdlib/arrays' },
          { text: 'Math', link: '/stdlib/math' },
          { text: 'Types', link: '/stdlib/types' },
          { text: 'Dates', link: '/stdlib/dates' },
          { text: 'All (bundle)', link: '/stdlib/all' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Writing Plugins', link: '/guide/plugins' },
          { text: 'Safety & Sandboxing', link: '/guide/safety' },
          { text: 'Performance', link: '/guide/performance' },
          { text: 'Migrate to Bonsai', link: '/guide/migrating' },
          { text: 'Autocomplete: Setup', link: '/guide/autocomplete-setup' },
          { text: 'Autocomplete: API', link: '/guide/autocomplete-api' },
          { text: 'Autocomplete: Editor', link: '/guide/autocomplete-editor' },
          { text: 'Autocomplete: Security', link: '/guide/autocomplete-security' },
        ],
      },
    ],
  },
})
