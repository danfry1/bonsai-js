import { defineAsyncComponent } from 'vue'
import DefaultTheme from 'vitepress/theme'
import HomeShowcase from './components/HomeShowcase.vue'
import HowItWorks from './components/HowItWorks.vue'
import '@fontsource-variable/bricolage-grotesque/opsz.css'
import './custom.css'

// Loaded on demand, so CodeMirror is fetched only by the pages that show it.
const CodeMirrorDemo = defineAsyncComponent(() => import('./components/CodeMirrorDemo.vue'))
const Playground = defineAsyncComponent(() => import('./components/Playground.vue'))

export default {
  ...DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeShowcase', HomeShowcase)
    app.component('Playground', Playground)
    app.component('HowItWorks', HowItWorks)
    app.component('CodeMirrorDemo', CodeMirrorDemo)
  },
}
