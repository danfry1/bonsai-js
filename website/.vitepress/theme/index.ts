import DefaultTheme from 'vitepress/theme'
import HomeShowcase from './components/HomeShowcase.vue'
import Playground from './components/Playground.vue'
import HowItWorks from './components/HowItWorks.vue'
import './custom.css'

export default {
  ...DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeShowcase', HomeShowcase)
    app.component('Playground', Playground)
    app.component('HowItWorks', HowItWorks)
  },
}
