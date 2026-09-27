<template>
  <div ref="root" class="hiw-root">
    <main>
      <!-- Section 1: Hook -->
      <section class="hiw-section hiw-hero-section" id="hiw-hook">
        <div class="container">
          <div class="hiw-hero">
            <h1>How does a computer evaluate an expression?</h1>
            <p class="hiw-subtitle">
              You type <code>1 + 2 * 3</code> and get <code>7</code>. But to a computer, that's
              just a string of characters: it has no idea what <code>+</code> or <code>*</code>
              means. So how does it figure it out? It turns out the answer involves one of the most
              elegant ideas in computer science.
            </p>
          </div>
        </div>
      </section>

      <!-- Section 2: Tokenization -->
      <section class="hiw-section" id="hiw-tokenization">
        <div class="container">
          <div class="hiw-layout">
            <div class="hiw-narrative">
              <span class="hiw-step-label">Step 1</span>
              <h2>See the characters, not the string</h2>
              <p>
                To you, <code>1 + 2 * 3</code> is obvious. To a computer, it's just nine characters:
                <code>1</code>, <code> </code>, <code>+</code>, <code> </code>, <code>2</code>,
                <code> </code>, <code>*</code>, <code> </code>, <code>3</code>. It doesn't know that
                <code>+</code> means "add" or that <code>*</code> means "multiply."
              </p>
              <p>
                The first step is <strong>tokenization</strong>: scanning the characters and
                grouping them into meaningful chunks called <strong>tokens</strong>. Think of it
                like reading: you don't process one letter at a time, you recognize whole words.
                That's what the tokenizer does: it turns a stream of characters into a list of
                meaningful pieces.
              </p>
            </div>
            <div class="hiw-interactive-panel">
              <label for="token-input" class="hiw-panel-label">Expression</label>
              <input
                id="token-input"
                class="hiw-input"
                type="text"
                value="1 + 2 * 3"
                spellcheck="false"
                autocomplete="off"
              />
              <div id="token-error" class="hiw-error" hidden></div>
              <div id="token-display" class="hiw-token-display" aria-live="polite"></div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section 3: Operator Precedence -->
      <section class="hiw-section" id="hiw-precedence">
        <div class="container">
          <div class="hiw-layout">
            <div class="hiw-narrative">
              <span class="hiw-step-label">Step 2</span>
              <h2>The problem: which operation goes first?</h2>
              <p>
                Now we have tokens, but we've hit a wall. Look at <code>1 + 2 * 3</code>. If we just
                go left to right (add first, then multiply), we get <strong>9</strong>. But the
                correct answer is <strong>7</strong>, because multiplication should happen before
                addition.
              </p>
              <p>
                A flat list of tokens doesn't capture this. The tokens just say "number, plus,
                number, times, number", and there's nothing in that list that tells us which operation
                to do first. We need a data structure that can represent <strong>priority</strong>.
                And that's exactly what a tree gives us.
              </p>
            </div>
            <div class="hiw-interactive-panel">
              <div class="hiw-precedence-panel">
                <div class="hiw-prec-comparison">
                  <div class="hiw-prec-wrong">
                    <span class="hiw-prec-badge hiw-prec-badge--wrong">Wrong</span>
                    <code class="hiw-prec-expr">(1 + 2) * 3 = 9</code>
                    <p class="hiw-prec-note">Left-to-right without precedence</p>
                  </div>
                  <div class="hiw-prec-right">
                    <span class="hiw-prec-badge hiw-prec-badge--right">Correct</span>
                    <code class="hiw-prec-expr">1 + (2 * 3) = 7</code>
                    <p class="hiw-prec-note">Multiplication binds tighter</p>
                  </div>
                </div>
                <table class="hiw-prec-table" aria-label="Operator precedence levels">
                  <thead>
                    <tr>
                      <th>Precedence</th>
                      <th>Operators</th>
                      <th>Associativity</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Highest</td>
                      <td><code>.</code> <code>?.</code> <code>[]</code> calls</td>
                      <td>Left</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td><code>!</code> <code>-</code> (prefix)</td>
                      <td>Right</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td><code>**</code></td>
                      <td>Right</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td><code>*</code> <code>/</code> <code>%</code></td>
                      <td>Left</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td><code>+</code> <code>-</code></td>
                      <td>Left</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td><code>&lt;</code> <code>&lt;=</code> <code>&gt;</code> <code>&gt;=</code> <code>in</code> <code>not in</code></td>
                      <td>Does not chain</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td><code>==</code> <code>!=</code></td>
                      <td>Does not chain</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td><code>&amp;&amp;</code></td>
                      <td>Left</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td><code>||</code></td>
                      <td>Left</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td><code>??</code></td>
                      <td>Left</td>
                    </tr>
                    <tr>
                      <td></td>
                      <td><code>?:</code> (ternary)</td>
                      <td>Right</td>
                    </tr>
                    <tr>
                      <td>Lowest</td>
                      <td><code>let x = e; body</code></td>
                      <td>Prefix</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section 4: Parsing / AST -->
      <section class="hiw-section" id="hiw-parsing">
        <div class="container">
          <div class="hiw-layout">
            <div class="hiw-narrative">
              <span class="hiw-step-label">Step 3</span>
              <h2>The tree: where it all clicks</h2>
              <p>
                Here's the key insight: <strong>in a tree, deeper nodes get computed first.</strong>
                If we put <code>2 * 3</code> deeper than <code>+ 1</code>, multiplication
                automatically happens before addition. We don't need special rules during evaluation
                because the structure itself <em>encodes</em> the order of operations.
              </p>
              <p>
                This is called an <strong>Abstract Syntax Tree (AST)</strong>. The parser's entire
                job is to read the flat token list and build this tree, placing higher-priority
                operations deeper. Once you have the tree, the hard problem of "what order?" is
                already solved. Try changing the expression below and notice how <code>*</code> and
                <code>/</code> always sit deeper than <code>+</code> and <code>-</code>.
              </p>
            </div>
            <div class="hiw-interactive-panel">
              <label for="tree-input" class="hiw-panel-label">Expression</label>
              <input
                id="tree-input"
                class="hiw-input"
                type="text"
                value="1 + 2 * 3"
                spellcheck="false"
                autocomplete="off"
              />
              <div class="hiw-tree-container">
                <svg
                  id="tree-svg"
                  class="hiw-tree-svg"
                  role="img"
                  aria-label="Abstract syntax tree visualization"
                ></svg>
              </div>
              <div id="tree-source" class="hiw-source-highlight" aria-live="polite"></div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section 5: Evaluation -->
      <section class="hiw-section" id="hiw-evaluation">
        <div class="container">
          <div class="hiw-layout">
            <div class="hiw-narrative">
              <span class="hiw-step-label">Step 4</span>
              <h2>Walking the tree to get an answer</h2>
              <p>
                Now comes the satisfying part. We have a tree; how do we get a number out of it?
                Start at the bottom. The leaves are just values: <code>1</code>, <code>2</code>,
                <code>3</code>. They're already "solved."
              </p>
              <p>
                Then work upward. Each operator node looks at the values its children produced and
                computes a result. <code>*</code> sees <code>2</code> and <code>3</code>, produces
                <code>6</code>. Then <code>+</code> sees <code>1</code> and <code>6</code>, produces
                <code>7</code>. The final answer bubbles up to the root. Hit play to watch it happen.
              </p>
            </div>
            <div class="hiw-interactive-panel">
              <div class="hiw-eval-toolbar">
                <div class="hiw-eval-toolbar-field" style="flex: 1">
                  <label for="eval-input" class="hiw-panel-label">Expression</label>
                  <input
                    id="eval-input"
                    class="hiw-input"
                    type="text"
                    value="1 + 2 * 3"
                    spellcheck="false"
                    autocomplete="off"
                  />
                </div>
                <div class="hiw-eval-toolbar-field">
                  <label for="eval-presets" class="hiw-panel-label">Presets</label>
                  <select id="eval-presets" class="hiw-select">
                    <option value="">-- choose --</option>
                    <option value="1 + 2 * 3">Operator precedence</option>
                    <option value="(1 + 2) * 3">Grouped addition</option>
                    <option value="10 - 3 - 2">Left-to-right subtraction</option>
                    <option value="2 ** 3 + 1">Exponentiation</option>
                    <option value='"hello" + " " + "world"'>String concatenation</option>
                    <option value="10 > 5 && 3 < 7">Boolean logic</option>
                    <option value='3 > 2 ? "yes" : "no"'>Ternary condition</option>
                    <option value="!(2 + 2 == 5)">Negation</option>
                    <option value="[1, 2, 3].map(. * 10).sum()">Function calls</option>
                  </select>
                </div>
              </div>
              <div class="hiw-tree-container">
                <svg
                  id="eval-tree-svg"
                  class="hiw-tree-svg"
                  role="img"
                  aria-label="Evaluation animation tree"
                ></svg>
              </div>
              <div class="hiw-eval-footer">
                <button id="eval-play-btn" class="hiw-play-btn" type="button">Play Evaluation</button>
                <div id="eval-result" class="hiw-eval-result" aria-live="polite"></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section 6: Real Expressions -->
      <section class="hiw-section" id="hiw-real-expressions">
        <div class="container">
          <div class="hiw-layout">
            <div class="hiw-narrative">
              <span class="hiw-step-label">Step 5</span>
              <h2>The same idea scales to everything</h2>
              <p>
                So far we've only seen numbers and arithmetic. But real expressions have variables,
                function calls, conditions, and lambdas like <code>items.filter(.active)</code>.
                Does the tree idea still work?
              </p>
              <p>
                It does. Every new feature just adds a new kind of node. A ternary
                <code>?:</code> becomes a node with three children. A method call
                <code>items.filter(...)</code> becomes a call node whose first child is the receiver, and
                <code>.active</code> becomes a lambda node wrapping the current item. The rule never changes:
                <strong>deeper nodes get computed first, and results bubble up.</strong> Hover over a
                node to see exactly which part of the expression it represents.
              </p>
            </div>
            <div class="hiw-interactive-panel">
              <label for="advanced-input" class="hiw-panel-label">Expression</label>
              <input
                id="advanced-input"
                class="hiw-input"
                type="text"
                value='user.score * 2 > threshold ? "pass" : "fail"'
                spellcheck="false"
                autocomplete="off"
              />
              <label for="advanced-presets" class="hiw-panel-label" style="margin-top: 10px"
                >Presets</label
              >
              <select id="advanced-presets" class="hiw-select">
                <option value="">-- choose a preset --</option>
                <option value='user.score * 2 > threshold ? "pass" : "fail"'>
                  Ternary condition
                </option>
                <option value="items.filter(.active).map(.name)">Lambdas</option>
                <option value="let total = price * qty; total > 100 ? total * 0.9 : total">let binding</option>
                <option value='user.profile?.name ?? "Anonymous"'>Null defaults</option>
                <option value="price * (1 - discount / 100)">Pricing rule</option>
                <option value='age >= 18 && country == "US"'>Access control</option>
              </select>
              <div class="hiw-tree-container">
                <svg
                  id="advanced-tree-svg"
                  class="hiw-tree-svg"
                  role="img"
                  aria-label="Advanced expression tree"
                ></svg>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section 7: Checking -->
      <section class="hiw-section" id="hiw-optimization">
        <div class="container">
          <div class="hiw-layout">
            <div class="hiw-narrative">
              <span class="hiw-step-label">Step 6</span>
              <h2>Check the tree before running it</h2>
              <p>
                A tree also lets us find mistakes without running anything. If we know the shape of
                the data (here <code>user</code> has a numeric <code>score</code> and a string
                <code>name</code>, and <code>items</code> is a list of <code>{ name, active }</code>),
                we can work out a <strong>type</strong> for every node, bottom-up, exactly the way
                evaluation works out values.
              </p>
              <p>
                A leaf <code>user.score</code> is a number; <code>user.score * 2</code> is a number;
                comparing it with <code>threshold</code> gives a boolean. When a node's children have
                types the node cannot accept, such as <code>user.name * 2</code>, or a property that
                does not exist, such as <code>user.scroe</code>, the checker reports it with the exact
                range, before the expression ever runs. Bonsai then compiles the checked tree into
                small JavaScript closures, once, so later evaluations skip all of this work.
              </p>
            </div>
            <div class="hiw-interactive-panel">
              <label for="opt-input" class="hiw-panel-label">Expression</label>
              <div class="hiw-opt-input-row">
                <input
                  id="opt-input"
                  class="hiw-input"
                  type="text"
                  value="user.score * 2 > threshold"
                  spellcheck="false"
                  autocomplete="off"
                />
                <button id="opt-run-btn" class="hiw-play-btn" type="button">Check</button>
              </div>
              <label for="opt-presets" class="hiw-panel-label" style="margin-top: 10px">Presets</label>
              <select id="opt-presets" class="hiw-select">
                <option value="">-- choose a preset --</option>
                <option value="user.score * 2 > threshold">Well typed</option>
                <option value="user.scroe > threshold">Typo</option>
                <option value="user.name * 2">Wrong type</option>
                <option value="items.filter(.active).map(.name)">Lambdas</option>
                <option value='items.find(.active).name.toUpperCase()'>Possibly null</option>
              </select>
              <div class="hiw-tree-container">
                <svg id="opt-tree-svg" class="hiw-tree-svg" role="img" aria-label="Checked tree"></svg>
              </div>
              <div id="opt-message" class="hiw-opt-message" aria-live="polite"></div>
            </div>
          </div>
        </div>
      </section>

      <!-- Section 8: CTA -->
      <section class="hiw-section hiw-cta" id="hiw-cta">
        <div class="container">
          <h2>Try it yourself</h2>
          <p class="hiw-subtitle">
            Characters become tokens. Tokens become a tree. The tree encodes priority. Walking the
            tree produces the answer, and walking it with types instead of values finds mistakes
            before anything runs. That is the whole pipeline, and it all runs live in the Playground.
          </p>
          <div class="hiw-cta-actions">
            <a href="/bonsai-js/playground" class="cta-btn">Open Playground</a>
            <a
              href="https://github.com/danfry1/bonsai-js"
              class="cta-btn secondary"
              target="_blank"
              rel="noopener"
              >GitHub</a
            >
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { bonsai, isBonsaiError, Duration, t, formatType } from 'bonsai-src'
import { tokenize } from 'bonsai-lexer'
import './how-it-works/how-it-works.css'

const root = ref<HTMLElement>()

// ─── Constants ───────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 200
const NODE_HEIGHT = 32
const NODE_PAD_X = 14
const NODE_GAP_X = 20
const LEVEL_HEIGHT = 80
const MAX_DEPTH = 8
const EVAL_STEP_MS = 600
const SVG_NS = 'http://www.w3.org/2000/svg'

// Loose AST node shape: the parser returns a discriminated union, but the
// walkthrough only reads structural fields by name, so a permissive record
// keeps the visualization code readable without exhaustive narrowing.
interface AstNode {
  type: string
  start?: number
  end?: number
  [key: string]: unknown
}


interface LayoutNode {
  id: number
  label: string
  category: string
  astNode: AstNode
  depth: number
  children: LayoutNode[]
  width: number
  x: number
  y: number
}

interface LayoutEdge {
  from: LayoutNode
  to: LayoutNode
}

interface TreeLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  root: LayoutNode
  totalWidth: number
  totalHeight: number
}

interface RenderOptions {
  animated?: boolean
  sourceEl?: HTMLElement | null
  sourceText?: string | null
}

interface EvalStep {
  node: AstNode
  /** Rendered value, or undefined when the node has no standalone value (a lambda, `.`). */
  value: string | undefined
}

onMounted(() => {
  const rootEl = root.value
  if (!rootEl) return

  // Scoped DOM lookups (never reach outside the component).
  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T | null =>
    rootEl.querySelector<T>(sel)

  // One open environment parses and evaluates everything on this page. The
  // checking section uses a second environment with a small declared schema.
  const env = bonsai()
  const checkEnv = bonsai({
    variables: {
      user: t.object({ name: t.string(), score: t.number() }),
      threshold: t.number(),
      items: t.list(t.object({ name: t.string(), active: t.boolean() })),
    },
    strict: true,
  })
  const parse = (source: string): AstNode => env.parse(source) as unknown as AstNode

  // ─── AST Helper Functions ──────────────────────────────────────────────────

  function nodeCategory(node: AstNode): string {
    switch (node.type) {
      case 'Literal':
      case 'Template':
      case 'List':
      case 'Map':
        return 'literal'
      case 'Binary':
      case 'Unary':
        return 'operator'
      case 'Variable':
      case 'Local':
        return 'identifier'
      case 'Call':
        return 'pipe'
      case 'Conditional':
      case 'Let':
      case 'Try':
      case 'Has':
        return 'control'
      case 'Member':
      case 'Index':
      case 'It':
      case 'Lambda':
        return 'member'
      default:
        return 'literal'
    }
  }

  function nodeLabel(node: AstNode): string {
    switch (node.type) {
      case 'Literal':
        return typeof node.value === 'string' ? JSON.stringify(node.value) : String(node.value)
      case 'Template':
        return '`...`'
      case 'Variable':
      case 'Local':
        return String(node.name)
      case 'It':
        return '.'
      case 'Binary':
      case 'Unary':
        return String(node.operator)
      case 'Conditional':
        return '? :'
      case 'Member':
        return `${node.optional ? '?.' : '.'}${String(node.name)}`
      case 'Index':
        return node.optional ? '?.[]' : '[]'
      case 'Call':
        return `${String(node.name)}()`
      case 'List':
        return '[...]'
      case 'Map':
        return '{...}'
      case 'Spread':
        return '...'
      case 'Lambda': {
        const params = node.params as string[]
        return node.implicit ? 'lambda .' : `(${params.join(', ')}) =>`
      }
      case 'Let':
        return `let ${String(node.name)}`
      case 'Has':
        return 'has()'
      case 'Try':
        return 'try()'
      default:
        return node.type
    }
  }

  function nodeChildren(node: AstNode): AstNode[] {
    const unspread = (item: AstNode) => (item.type === 'Spread' ? (item.argument as AstNode) : item)
    switch (node.type) {
      case 'Binary':
        return [node.left as AstNode, node.right as AstNode]
      case 'Unary':
        return [node.operand as AstNode]
      case 'Conditional':
        return [node.test as AstNode, node.then as AstNode, node.otherwise as AstNode]
      case 'Member':
        return [node.object as AstNode]
      case 'Index':
        return [node.object as AstNode, node.index as AstNode]
      case 'Call':
        return (node.args as AstNode[]).map(unspread)
      case 'List':
        return (node.items as AstNode[]).map(unspread)
      case 'Map':
        return (node.entries as AstNode[]).flatMap((entry) =>
          entry.type === 'Spread'
            ? [entry.argument as AstNode]
            : typeof entry.key === 'string'
              ? [entry.value as AstNode]
              : [entry.key as AstNode, entry.value as AstNode],
        )
      case 'Template':
        return (node.parts as (string | AstNode)[]).filter((part): part is AstNode => typeof part !== 'string')
      case 'Lambda':
        return [node.body as AstNode]
      case 'Let':
        return [node.value as AstNode, node.body as AstNode]
      case 'Has':
        return [node.target as AstNode]
      case 'Try':
        return [node.body as AstNode, node.fallback as AstNode]
      default:
        return []
    }
  }

  // ─── Tree Layout Algorithm ──────────────────────────────────────────────────

  function measureText(text: string): number {
    return text.length * 7.5 + NODE_PAD_X * 2
  }

  function layoutTree(ast: AstNode, maxDepth = MAX_DEPTH): TreeLayout {
    const nodes: LayoutNode[] = []
    const edges: LayoutEdge[] = []
    let idCounter = 0

    function buildLayout(node: AstNode, depth: number): LayoutNode {
      if (depth > maxDepth) {
        const truncNode: LayoutNode = {
          id: idCounter++,
          label: '...',
          category: 'literal',
          astNode: node,
          depth,
          children: [],
          width: measureText('...'),
          x: 0,
          y: 0,
        }
        nodes.push(truncNode)
        return truncNode
      }

      const label = nodeLabel(node)
      const category = nodeCategory(node)
      const childAstNodes = nodeChildren(node)

      const layoutNode: LayoutNode = {
        id: idCounter++,
        label,
        category,
        astNode: node,
        depth,
        children: [],
        width: measureText(label),
        x: 0,
        y: 0,
      }
      nodes.push(layoutNode)

      const childLayouts = childAstNodes.map((child) => buildLayout(child, depth + 1))
      layoutNode.children = childLayouts

      for (const child of childLayouts) {
        edges.push({ from: layoutNode, to: child })
      }

      // Width = max(own text width, sum of children widths + gaps)
      if (childLayouts.length > 0) {
        const childrenTotalWidth =
          childLayouts.reduce((sum, c) => sum + c.width, 0) +
          (childLayouts.length - 1) * NODE_GAP_X
        layoutNode.width = Math.max(layoutNode.width, childrenTotalWidth)
      }

      return layoutNode
    }

    function position(node: LayoutNode, xStart: number): void {
      node.y = node.depth * LEVEL_HEIGHT + 20

      if (node.children.length === 0) {
        node.x = xStart + node.width / 2
        return
      }

      // Position children left-to-right
      let childX = xStart
      for (const child of node.children) {
        // Each child's allocated space = child.width
        position(child, childX)
        childX += child.width + NODE_GAP_X
      }

      // Parent center = midpoint of first and last child centers
      const first = node.children[0]
      const last = node.children[node.children.length - 1]
      node.x = (first.x + last.x) / 2
    }

    const layoutRoot = buildLayout(ast, 0)
    position(layoutRoot, 0)

    const totalWidth = Math.max(layoutRoot.width, 200)
    const maxNodeDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0)
    const totalHeight = maxNodeDepth * LEVEL_HEIGHT + 20 + NODE_HEIGHT + 20

    return { nodes, edges, root: layoutRoot, totalWidth, totalHeight }
  }

  // ─── SVG Rendering ──────────────────────────────────────────────────────────

  function renderTree(svgEl: SVGElement, layout: TreeLayout, options: RenderOptions = {}): void {
    const { animated, sourceEl, sourceText } = options
    const { nodes, edges, totalWidth, totalHeight } = layout

    svgEl.setAttribute('viewBox', `0 0 ${totalWidth} ${totalHeight}`)
    svgEl.setAttribute('width', String(totalWidth))
    svgEl.setAttribute('height', String(totalHeight))
    svgEl.setAttribute('role', 'img')
    svgEl.setAttribute('aria-label', 'Abstract syntax tree visualization')

    svgEl.replaceChildren()

    // Draw edges first (behind nodes)
    for (const edge of edges) {
      const line = document.createElementNS(SVG_NS, 'line')
      line.setAttribute('x1', String(edge.from.x))
      line.setAttribute('y1', String(edge.from.y + NODE_HEIGHT / 2))
      line.setAttribute('x2', String(edge.to.x))
      line.setAttribute('y2', String(edge.to.y - NODE_HEIGHT / 2))
      line.setAttribute('class', 'hiw-edge')
      svgEl.appendChild(line)
    }

    // Draw nodes
    for (const node of nodes) {
      const g = document.createElementNS(SVG_NS, 'g')
      g.setAttribute('class', `hiw-node hiw-node-${node.category}`)
      g.setAttribute('data-node-id', String(node.id))
      g.setAttribute('role', 'img')
      g.setAttribute('aria-label', `${node.category} node: ${node.label}`)
      g.setAttribute('transform', `translate(${node.x - node.width / 2}, ${node.y - NODE_HEIGHT / 2})`)

      if (animated) {
        g.style.opacity = '0'
      }

      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('width', String(node.width))
      rect.setAttribute('height', String(NODE_HEIGHT))
      rect.setAttribute('rx', '6')
      g.appendChild(rect)

      const text = document.createElementNS(SVG_NS, 'text')
      text.setAttribute('x', String(node.width / 2))
      text.setAttribute('y', String(NODE_HEIGHT / 2))
      text.textContent = node.label
      g.appendChild(text)

      // Value overlay for evaluation animation
      const valueText = document.createElementNS(SVG_NS, 'text')
      valueText.setAttribute('class', 'hiw-node-value')
      valueText.setAttribute('x', String(node.width / 2))
      valueText.setAttribute('y', String(NODE_HEIGHT + 14))
      g.appendChild(valueText)

      // Source highlight interaction (hover on desktop, tap on mobile)
      if (sourceEl && sourceText != null && node.astNode) {
        const astNode = node.astNode
        if (typeof astNode.start === 'number' && typeof astNode.end === 'number') {
          const start = astNode.start
          const end = astNode.end
          g.addEventListener('mouseenter', () => {
            g.classList.add('highlighted')
            highlightSource(sourceEl, sourceText, start, end)
          })
          g.addEventListener('mouseleave', () => {
            g.classList.remove('highlighted')
            highlightSource(sourceEl, sourceText, -1, -1)
          })
          g.addEventListener('click', (e) => {
            e.stopPropagation()
            // Clear previous highlight
            const prev = svgEl.querySelector('.hiw-node.highlighted')
            if (prev && prev !== g) {
              prev.classList.remove('highlighted')
            }
            // Toggle this node
            const wasHighlighted = g.classList.toggle('highlighted')
            if (wasHighlighted) {
              highlightSource(sourceEl, sourceText, start, end)
            } else {
              highlightSource(sourceEl, sourceText, -1, -1)
            }
          })
        }
      }

      svgEl.appendChild(g)
    }

    // Tap outside a node to clear highlight (mobile)
    if (sourceEl && sourceText != null) {
      svgEl.addEventListener('click', () => {
        const prev = svgEl.querySelector('.hiw-node.highlighted')
        if (prev) {
          prev.classList.remove('highlighted')
          highlightSource(sourceEl, sourceText, -1, -1)
        }
      })
    }

    if (animated) {
      animateTreeIn(svgEl, layout)
    }
  }

  function highlightSource(el: HTMLElement, source: string, start: number, end: number): void {
    el.replaceChildren()

    if (start < 0 || end <= start) {
      el.textContent = source
      return
    }

    const before = source.slice(0, start)
    const highlighted = source.slice(start, end)
    const after = source.slice(end)

    if (before) {
      el.appendChild(document.createTextNode(before))
    }

    const span = document.createElement('span')
    span.className = 'hiw-hl'
    span.textContent = highlighted
    el.appendChild(span)

    if (after) {
      el.appendChild(document.createTextNode(after))
    }
  }

  function animateTreeIn(svgEl: SVGElement, layout: TreeLayout): void {
    const { nodes } = layout

    // Group nodes by depth
    const byDepth = new Map<number, LayoutNode[]>()
    for (const node of nodes) {
      const bucket = byDepth.get(node.depth)
      if (bucket) {
        bucket.push(node)
      } else {
        byDepth.set(node.depth, [node])
      }
    }

    const depths = [...byDepth.keys()].sort((a, b) => a - b)

    for (const depth of depths) {
      const delay = depth * 150
      setTimeout(() => {
        const depthNodes = byDepth.get(depth) ?? []
        for (const node of depthNodes) {
          const g = svgEl.querySelector<SVGGElement>(`[data-node-id="${node.id}"]`)
          if (g) g.style.opacity = '1'
        }
      }, delay)
    }
  }

  // ─── Tokenization Display ────────────────────────────────────────────────────

  const OPERATORS = new Set([
    '+', '-', '*', '/', '%', '**', '==', '!=', '<', '<=', '>', '>=', '&&', '||', '??', '!', '?', ':',
    '?.', '=>', '=', '...',
  ])

  function tokenTypeClass(kind: string, value: string): string {
    switch (kind) {
      case 'number':
        return 'hiw-token-type-number'
      case 'string':
      case 'template':
        return 'hiw-token-type-string'
      case 'name':
        return 'hiw-token-type-identifier'
      case 'keyword':
        return value === 'true' || value === 'false' || value === 'null'
          ? 'hiw-token-type-boolean'
          : 'hiw-token-type-operator'
      case 'punct':
        return OPERATORS.has(value) ? 'hiw-token-type-operator' : 'hiw-token-type-punctuation'
      default:
        return 'hiw-token-type-punctuation'
    }
  }

  const TOKEN_LABELS: Record<string, string> = {
    number: 'Number',
    string: 'String',
    template: 'Template',
    name: 'Name',
    keyword: 'Keyword',
  }

  function renderTokens(containerEl: HTMLElement, source: string): { error?: unknown } {
    containerEl.replaceChildren()

    let tokens: { kind: string; value: string; start: number; end: number }[]
    try {
      tokens = tokenize(source, { maxSourceLength: 10_000, maxTokens: 10_000 })
    } catch (err) {
      return { error: err }
    }

    const visible = tokens.filter((token) => token.kind !== 'eof')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    visible.forEach((token, i) => {
      const div = document.createElement('div')
      div.className = `hiw-token ${tokenTypeClass(token.kind, token.value)}`

      const valueSpan = document.createElement('span')
      valueSpan.className = 'hiw-token-value'
      valueSpan.textContent = source.slice(token.start, token.end)
      div.appendChild(valueSpan)

      const typeSpan = document.createElement('span')
      typeSpan.className = 'hiw-token-type'
      typeSpan.textContent =
        TOKEN_LABELS[token.kind] ?? (OPERATORS.has(token.value) ? 'Operator' : 'Punctuation')
      div.appendChild(typeSpan)

      if (!reduced) div.style.animationDelay = `${i * 80}ms`
      containerEl.appendChild(div)
    })

    containerEl.setAttribute(
      'aria-label',
      `${visible.length} token${visible.length !== 1 ? 's' : ''}: ${visible
        .map((token) => source.slice(token.start, token.end))
        .join(', ')}`,
    )

    return {}
  }

  // ─── Evaluation Stepper ──────────────────────────────────────────────────────

  function formatValue(value: unknown): string {
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'string') return JSON.stringify(value)
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Duration) return value.toString()
    if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`
    if (typeof value === 'object') {
      return `{ ${Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${formatValue(v)}`)
        .join(', ')} }`
    }
    return String(value)
  }

  // Every node's value is computed by evaluating that node's own source text
  // with the real evaluator, so the animation always agrees with Bonsai.
  // Nodes without a standalone value (a lambda, `.`) show nothing.
  function buildEvalSequence(ast: AstNode, source: string): EvalStep[] {
    const sequence: EvalStep[] = []
    const walk = (node: AstNode): void => {
      for (const child of nodeChildren(node)) walk(child)
      let value: string | undefined
      try {
        value = formatValue(env.evaluateSync(source.slice(node.start, node.end)))
      } catch (error) {
        value = isBonsaiError(error) && error.code !== 'SYNTAX' && error.code !== 'CHECK' ? error.code : undefined
      }
      sequence.push({ node, value })
    }
    walk(ast)
    return sequence
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────

  function debounce<A extends unknown[]>(
    fn: (...args: A) => void,
    ms: number,
  ): (...args: A) => void {
    let timer: ReturnType<typeof setTimeout> | undefined
    return (...args: A) => {
      clearTimeout(timer)
      timer = setTimeout(() => fn(...args), ms)
    }
  }

  // ─── Section: Tokenization ───────────────────────────────────────────────────

  function initTokenSection(): void {
    const input = $<HTMLInputElement>('#token-input')
    const display = $('#token-display')
    const errorEl = $('#token-error')

    if (!input || !display) return

    function update(): void {
      if (!input || !display) return
      const source = input.value

      if (errorEl) {
        errorEl.hidden = true
        errorEl.replaceChildren()
      }

      const result = renderTokens(display, source)
      if (result.error && errorEl) {
        const err = result.error
        errorEl.textContent = err instanceof Error ? err.message : String(err)
        errorEl.hidden = false
      }
    }

    input.addEventListener('input', debounce(update, DEBOUNCE_MS))
    update()
  }

  // ─── Section: AST Tree ───────────────────────────────────────────────────────

  function initTreeSection(): void {
    const input = $<HTMLInputElement>('#tree-input')
    const svgEl = $<HTMLElement>('#tree-svg') as SVGElement | null
    const sourceEl = $('#tree-source')

    if (!input || !svgEl) return

    function update(): void {
      if (!input || !svgEl) return
      const source = input.value.trim()
      if (!source) {
        svgEl.replaceChildren()
        if (sourceEl) sourceEl.replaceChildren()
        return
      }

      let ast: AstNode
      try {
        ast = parse(source)
      } catch {
        return
      }

      if (sourceEl) {
        sourceEl.textContent = source
      }

      const layout = layoutTree(ast)
      renderTree(svgEl, layout, {
        animated: true,
        sourceEl: sourceEl ?? null,
        sourceText: sourceEl ? source : null,
      })
    }

    input.addEventListener('input', debounce(update, DEBOUNCE_MS))
    update()
  }

  // ─── Section: Evaluation Stepper ─────────────────────────────────────────────

  function initEvalSection(): void {
    const input = $<HTMLInputElement>('#eval-input')
    const svgEl = $<HTMLElement>('#eval-tree-svg') as SVGElement | null
    const playBtn = $<HTMLButtonElement>('#eval-play-btn')
    const resultEl = $('#eval-result')
    const presets = $<HTMLSelectElement>('#eval-presets')

    if (!input || !svgEl || !playBtn) return

    let currentLayout: TreeLayout | null = null
    let currentAst: AstNode | null = null
    let currentSource = ''
    let evalInterval: ReturnType<typeof setInterval> | null = null

    function updateTree(): void {
      if (!input || !svgEl) return
      const source = input.value.trim()
      if (!source) {
        svgEl.replaceChildren()
        currentAst = null
        return
      }

      let ast: AstNode
      try {
        ast = parse(source)
      } catch {
        return
      }

      currentAst = ast
      currentSource = source
      currentLayout = layoutTree(ast)
      renderTree(svgEl, currentLayout, { animated: false })

      if (resultEl) {
        resultEl.replaceChildren()
      }
    }

    function runEvalAnimation(): void {
      if (!currentLayout || !currentAst || !svgEl || !playBtn) return

      // Re-render clean tree (uses same AST objects as currentLayout)
      renderTree(svgEl, currentLayout, { animated: false })
      if (resultEl) resultEl.replaceChildren()

      playBtn.disabled = true

      const sequence = buildEvalSequence(currentAst, currentSource)
      let stepIndex = 0

      // Map from AST node to layout node id
      function findNodeId(astNode: AstNode): number | null {
        if (!currentLayout) return null
        for (const n of currentLayout.nodes) {
          if (n.astNode === astNode) return n.id
        }
        return null
      }

      // Dim all nodes before starting
      const allNodeEls = svgEl.querySelectorAll('.hiw-node')
      for (const el of allNodeEls) {
        el.classList.add('eval-dimmed')
      }

      if (evalInterval) clearInterval(evalInterval)

      evalInterval = setInterval(() => {
        if (stepIndex >= sequence.length) {
          if (evalInterval) clearInterval(evalInterval)
          evalInterval = null
          playBtn.disabled = false

          // Show final result
          const lastStep = sequence[sequence.length - 1]
          if (lastStep && lastStep.value !== undefined && resultEl) {
            resultEl.textContent = `= ${lastStep.value}`
          }
          return
        }

        const step = sequence[stepIndex]
        stepIndex++

        const nodeId = findNodeId(step.node)
        if (nodeId === null) return

        const gEl = svgEl.querySelector(`[data-node-id="${nodeId}"]`)
        if (!gEl) return

        gEl.classList.remove('eval-dimmed')
        gEl.classList.add('evaluated')

        if (step.value !== undefined) {
          const valueText = gEl.querySelector('.hiw-node-value')
          if (valueText) {
            valueText.textContent = step.value
            valueText.classList.add('visible')
          }
        }
      }, EVAL_STEP_MS)
    }

    input.addEventListener('input', debounce(updateTree, DEBOUNCE_MS))
    playBtn.addEventListener('click', runEvalAnimation)

    if (presets) {
      presets.addEventListener('change', () => {
        if (presets.value) {
          input.value = presets.value
          updateTree()
          presets.value = ''
        }
      })
    }

    updateTree()
  }

  // ─── Section: Advanced (Real Expressions) ────────────────────────────────────

  function initAdvancedSection(): void {
    const input = $<HTMLInputElement>('#advanced-input')
    const presets = $<HTMLSelectElement>('#advanced-presets')
    const svgEl = $<HTMLElement>('#advanced-tree-svg') as SVGElement | null

    if (!input || !svgEl) return

    function update(): void {
      if (!input || !svgEl) return
      const source = input.value.trim()
      if (!source) {
        svgEl.replaceChildren()
        return
      }

      let ast: AstNode
      try {
        ast = parse(source)
      } catch {
        return
      }

      const layout = layoutTree(ast)
      renderTree(svgEl, layout, { animated: true })
    }

    input.addEventListener('input', debounce(update, DEBOUNCE_MS))

    if (presets) {
      presets.addEventListener('change', () => {
        if (presets.value) {
          input.value = presets.value
          update()
          // Reset dropdown
          presets.value = ''
        }
      })
    }

    update()
  }

  // ─── Section: Optimization ───────────────────────────────────────────────────

  function initOptSection(): void {
    const input = $<HTMLInputElement>('#opt-input')
    const runBtn = $<HTMLButtonElement>('#opt-run-btn')
    const presets = $<HTMLSelectElement>('#opt-presets')
    const svgEl = $<HTMLElement>('#opt-tree-svg') as SVGElement | null
    const messageEl = $('#opt-message')

    if (!input || !runBtn || !svgEl || !messageEl) return

    function run(): void {
      if (!input || !svgEl || !messageEl) return
      const source = input.value.trim()
      svgEl.replaceChildren()
      messageEl.replaceChildren()
      if (!source) return

      try {
        renderTree(svgEl, layoutTree(parse(source)), { animated: true })
      } catch {
        // syntax errors are reported below
      }

      const result = checkEnv.check(source)
      const lines: string[] = []
      if (result.ok && result.type) lines.push(`OK: the result type is ${formatType(result.type)}`)
      for (const d of result.diagnostics) {
        const excerpt = source.slice(d.start, d.end)
        lines.push(`${d.severity === 'error' ? 'Error' : 'Warning'} at "${excerpt}": ${d.message}`)
      }
      messageEl.textContent = lines.join('\n')
    }

    input.addEventListener('input', debounce(run, DEBOUNCE_MS))
    runBtn.addEventListener('click', run)
    if (presets) {
      presets.addEventListener('change', () => {
        if (presets.value) {
          input.value = presets.value
          run()
          presets.value = ''
        }
      })
    }
    run()
  }

  // ─── Scroll Reveal ───────────────────────────────────────────────────────────

  function initScrollReveal(): void {
    const sections = rootEl.querySelectorAll('.hiw-section')

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sections.forEach((section) => section.classList.add('visible'))
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible')
            observer.unobserve(entry.target)
          }
        }
      },
      { threshold: 0.15 },
    )

    sections.forEach((section) => observer.observe(section))
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  initScrollReveal()
  initTokenSection()
  initTreeSection()
  initEvalSection()
  initAdvancedSection()
  initOptSection()
})
</script>
