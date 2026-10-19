import { defineAsyncComponent } from 'vue'
import DefaultTheme from 'vitepress/theme'
import HomeShowcase from './components/HomeShowcase.vue'
import Playground from './components/Playground.vue'
import HowItWorks from './components/HowItWorks.vue'
import './custom.css'

// Loaded on demand, so CodeMirror is fetched only by the page that shows it.
const CodeMirrorDemo = defineAsyncComponent(() => import('./components/CodeMirrorDemo.vue'))

export default {
  ...DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeShowcase', HomeShowcase)
    app.component('Playground', Playground)
    app.component('HowItWorks', HowItWorks)
    app.component('CodeMirrorDemo', CodeMirrorDemo)
  },
}
