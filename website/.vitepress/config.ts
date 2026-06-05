import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Bonsai',
  description:
    'A safe expression language for rules, filters, templates, and user-authored logic. Runs in any JavaScript runtime.',
  lang: 'en-US',
  base: '/bonsai-js/',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: 'https://danfry1.github.io/bonsai-js/' },
  head: [
    ['link', { rel: 'icon', href: '/bonsai-js/logo.png', type: 'image/png' }],
    ['meta', { name: 'theme-color', content: '#0a0a0f' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Bonsai' }],
    ['meta', { property: 'og:image', content: 'https://danfry1.github.io/bonsai-js/og-card.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://danfry1.github.io/bonsai-js/og-card.png' }],
  ],
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/danfry1/bonsai-js' },
    ],
  },
})
