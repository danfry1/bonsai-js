import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitepress'
import { bonsaiDark, bonsaiLight } from './shiki-themes'

const src = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url))

export default defineConfig({
  title: 'Bonsai',
  description:
    'A small, safe, typed expression language for rules, filters, formulas, and templates. Zero dependencies; runs in Node.js, Bun, and modern browsers.',
  lang: 'en-US',
  base: '/',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: 'https://bonsai.danfry.dev/' },
  markdown: {
    // Bonsai syntax is a subset of JavaScript expression syntax.
    languageAlias: { bonsai: 'js' },
    theme: { light: bonsaiLight, dark: bonsaiDark },
    // Wrap every table so a wide one scrolls inside the content column
    // instead of running under the page outline (custom.css styles the wrapper).
    config(md) {
      md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n'
      md.renderer.rules.table_close = () => '</table></div>\n'
    },
  },
  vite: {
    resolve: {
      alias: {
        'bonsai-src': src('index.ts'),
        'bonsai-service': src('service/index.ts'),
        'bonsai-query': src('query/index.ts'),
        // Internal: the How It Works page shows raw tokens.
        'bonsai-lexer': src('syntax/lexer.ts'),
      },
    },
  },
  head: [
    ['link', { rel: 'icon', href: '/logo.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'icon', href: '/logo.png', type: 'image/png', sizes: '512x512' }],
    ['meta', { name: 'theme-color', content: '#f3f6f1', media: '(prefers-color-scheme: light)' }],
    ['meta', { name: 'theme-color', content: '#0e1712', media: '(prefers-color-scheme: dark)' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Bonsai' }],
    ['meta', { property: 'og:image', content: 'https://bonsai.danfry.dev/og-card.png' }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: 'Bonsai: safe, typed expressions for JavaScript' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://bonsai.danfry.dev/og-card.png' }],
    ['meta', { property: 'og:title', content: 'Bonsai: safe, typed expressions for JavaScript' }],
    ['meta', { name: 'twitter:title', content: 'Bonsai: safe, typed expressions for JavaScript' }],
  ],
  themeConfig: {
    logo: { light: '/logo.svg', dark: '/logo-dark.svg', alt: '' },
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/danfry1/bonsai-js', ariaLabel: 'GitHub repository' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/bonsai-js', ariaLabel: 'npm package' },
    ],
    // Top level follows an evaluator's questions: how do I start (Guide), does
    // it fit my case (Recipes), what can rules say (Language), what do I call
    // (API), how does it stack up (Compare), and can I try it (Playground).
    // Each docs area has its own sidebar, so a page only lists its neighbours.
    nav: [
      { text: 'Guide', link: '/guide/', activeMatch: '^/guide/(?!comparison)|^/how-it-works' },
      { text: 'Recipes', link: '/recipes/', activeMatch: '^/recipes/' },
      { text: 'Syntax', link: '/language/', activeMatch: '^/(language|functions)/' },
      { text: 'API', link: '/api/environment', activeMatch: '^/api/' },
      { text: 'Compare', link: '/guide/comparison', activeMatch: '^/guide/comparison' },
      { text: 'Playground', link: '/playground' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Start',
          items: [
            { text: 'What is Bonsai', link: '/guide/' },
            { text: 'Install', link: '/guide/install' },
            { text: 'Quick Start', link: '/guide/quick-start' },
            { text: 'Mental Model', link: '/guide/mental-model' },
          ],
        },
        {
          text: 'Put It in Your App',
          items: [
            { text: 'Editor Support', link: '/guide/editor-support' },
            { text: 'CodeMirror', link: '/guide/codemirror' },
            { text: 'Safety', link: '/guide/safety' },
            { text: 'Performance', link: '/guide/performance' },
          ],
        },
        {
          text: 'Understand It',
          items: [
            { text: 'How It Works', link: '/how-it-works' },
            { text: 'Compared with Others', link: '/guide/comparison' },
          ],
        },
        {
          text: 'Project',
          items: [
            { text: 'Migrating from 0.x', link: '/guide/migrating' },
            { text: 'Stability Policy', link: '/guide/stability' },
          ],
        },
      ],
      '/recipes/': [
        {
          text: 'Recipes',
          items: [
            { text: 'Overview', link: '/recipes/' },
            { text: 'Feature Flag Targeting', link: '/recipes/feature-flags' },
            { text: 'User-Defined Filters in SQL', link: '/recipes/user-filters-sql' },
            { text: 'Eligibility Rules with Reasons', link: '/recipes/eligibility-rules' },
          ],
        },
      ],
      // The built-in functions are part of the language a rule author writes,
      // so they share its sidebar.
      ...Object.fromEntries(
        ['/language/', '/functions/'].map((path) => [
          path,
          [
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
          ],
        ]),
      ),
      '/api/': [
        {
          text: 'Core',
          items: [
            { text: 'bonsai() and Environment', link: '/api/environment' },
            { text: 'Programs', link: '/api/programs' },
            { text: 'Host Functions', link: '/api/host-functions' },
            { text: 'Types (t)', link: '/api/types' },
            { text: 'Errors', link: '/api/errors' },
            { text: 'Limits', link: '/api/limits' },
          ],
        },
        {
          text: 'Tooling',
          items: [
            { text: 'Language Service', link: '/api/service' },
            { text: 'Explaining Results', link: '/api/explain' },
            { text: 'Partial Evaluation', link: '/api/partial' },
          ],
        },
        {
          text: 'Deployment',
          items: [
            { text: 'Database Filters', link: '/api/query' },
            { text: 'Runtime (precompiled rules)', link: '/api/runtime' },
          ],
        },
        {
          text: 'Syntax Trees',
          items: [
            { text: 'Syntax Trees and print()', link: '/api/printer' },
            { text: 'Syntax Tree Reference', link: '/api/syntax-tree' },
          ],
        },
      ],
    },
    editLink: {
      pattern: 'https://github.com/danfry1/bonsai-js/edit/main/website/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
    },
    notFound: {
      title: 'Page not found',
      quote: 'This page may have moved when the docs were reorganised. Search the docs, or start from the guide.',
      linkText: 'Go to the home page',
    },
  },
})
