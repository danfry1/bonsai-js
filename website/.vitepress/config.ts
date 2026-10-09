import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitepress'

const src = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url))

export default defineConfig({
  title: 'Bonsai',
  description:
    'A small, safe, typed expression language for rules, filters, formulas, and templates. Zero dependencies; runs in Node.js, Bun, and modern browsers.',
  lang: 'en-US',
  base: '/bonsai-js/',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: 'https://danfry1.github.io/bonsai-js/' },
  markdown: {
    // Bonsai syntax is a subset of JavaScript expression syntax.
    languageAlias: { bonsai: 'js' },
  },
  vite: {
    resolve: {
      alias: {
        'bonsai-src': src('index.ts'),
        'bonsai-service': src('service/index.ts'),
        // Internal: the How It Works page shows raw tokens.
        'bonsai-lexer': src('syntax/lexer.ts'),
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
    ['meta', { property: 'og:title', content: 'Bonsai: safe, typed expressions for rules, filters, and templates' }],
    ['meta', { name: 'twitter:title', content: 'Bonsai: safe, typed expressions for rules, filters, and templates' }],
  ],
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/danfry1/bonsai-js' }],
    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Language', link: '/language/' },
      { text: 'Functions', link: '/functions/' },
      { text: 'API', link: '/api/environment' },
      { text: 'Playground', link: '/playground' },
      { text: 'How It Works', link: '/how-it-works' },
      { text: 'npm', link: 'https://www.npmjs.com/package/bonsai-js' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'What is Bonsai', link: '/guide/' },
          { text: 'Install', link: '/guide/install' },
          { text: 'Quick Start', link: '/guide/quick-start' },
          { text: 'Mental Model', link: '/guide/mental-model' },
          { text: 'Safety', link: '/guide/safety' },
          { text: 'Performance', link: '/guide/performance' },
          { text: 'Editor Support', link: '/guide/editor-support' },
          { text: 'Migrating from 0.x', link: '/guide/migrating' },
        ],
      },
      {
        text: 'Language',
        items: [
          { text: 'Overview and Values', link: '/language/' },
          { text: 'Literals and Comments', link: '/language/literals' },
          { text: 'Operators', link: '/language/operators' },
          { text: 'Property Access', link: '/language/property-access' },
          { text: 'Functions and Calls', link: '/language/functions' },
          { text: 'Lambdas', link: '/language/lambdas' },
          { text: 'let, try, and has', link: '/language/let-try-has' },
          { text: 'Templates', link: '/language/templates' },
          { text: 'Time', link: '/language/time' },
          { text: 'Static Checking', link: '/language/checking' },
        ],
      },
      {
        text: 'Built-in Functions',
        items: [
          { text: 'Overview', link: '/functions/' },
          { text: 'Text', link: '/functions/text' },
          { text: 'Lists', link: '/functions/lists' },
          { text: 'Numbers', link: '/functions/numbers' },
          { text: 'Maps and Values', link: '/functions/maps' },
          { text: 'Time', link: '/functions/time' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'bonsai() and Environment', link: '/api/environment' },
          { text: 'Programs', link: '/api/programs' },
          { text: 'Host Functions', link: '/api/host-functions' },
          { text: 'Types (t)', link: '/api/types' },
          { text: 'Errors', link: '/api/errors' },
          { text: 'Limits', link: '/api/limits' },
          { text: 'Language Service', link: '/api/service' },
          { text: 'Explaining Results', link: '/api/explain' },
          { text: 'Partial Evaluation', link: '/api/partial' },
          { text: 'Syntax Trees and print()', link: '/api/printer' },
        ],
      },
    ],
  },
})
