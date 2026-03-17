# Light Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add light/dark theme switching to the Bonsai website with CSS custom properties and a nav bar toggle.

**Architecture:** Define semantic CSS variables on `:root` (dark defaults), override via `[data-theme="light"]` and `@media (prefers-color-scheme: light)`. A small JS module in `nav.js` handles toggle, persistence, and OS preference detection. Toggle button added to nav in all 4 HTML pages.

**Tech Stack:** Vanilla CSS custom properties, vanilla JS, localStorage

**Spec:** `docs/superpowers/specs/2026-03-17-light-mode-design.md`

---

## Chunk 1: CSS Variable System + Theme Toggle

### Task 1: Define CSS variables and light theme overrides in styles.css

This is the foundation task. Add CSS variable definitions at the top of `styles.css`, then define the light theme override. **No existing rules are changed yet** — that happens in later tasks.

**Files:**
- Modify: `website/styles.css:1-2` (insert after line 1, before the reset)

- [ ] **Step 1: Add CSS variable definitions to styles.css**

Insert after the `@import` line (line 1), before the reset block. This defines all semantic tokens used across the entire site.

```css
/* ── Theme tokens ─────────────────────────────────────────── */
:root {
  /* Backgrounds */
  --bg-page: #0a0a0f;
  --bg-surface: #14141f;
  --bg-surface-alt: #0e0e16;
  --bg-surface-raised: #16161e;
  --bg-surface-deep: #0d0d14;
  --bg-tooltip: #1a1a24;
  --bg-input: #0a0a0f;
  --bg-hover: rgba(255, 255, 255, 0.04);
  --bg-hover-strong: rgba(255, 255, 255, 0.06);
  --bg-code: #0a0a0f;
  --bg-overlay: rgba(10, 10, 15, 0.85);
  --bg-overlay-heavy: rgba(10, 10, 15, 0.97);

  /* Text */
  --text-primary: #e8e4df;
  --text-bright: #fff;
  --text-secondary: #999;
  --text-muted: #888;
  --text-dim: #3a3a3a;
  --text-placeholder: #555;
  --text-link: #bbb;
  --text-on-accent: #fff;

  /* Accents */
  --accent: #10b981;
  --accent-bright: #34d399;
  --accent-dark: #059669;
  --accent-darker: #047857;
  --accent-bg: rgba(16, 185, 129, 0.08);
  --accent-bg-strong: rgba(16, 185, 129, 0.12);
  --accent-bg-stronger: rgba(16, 185, 129, 0.15);
  --accent-border: rgba(16, 185, 129, 0.2);
  --accent-border-strong: rgba(16, 185, 129, 0.3);

  /* Borders */
  --border: rgba(255, 255, 255, 0.06);
  --border-mid: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.1);
  --border-stronger: rgba(255, 255, 255, 0.12);

  /* Shadows */
  --shadow: rgba(0, 0, 0, 0.5);
  --shadow-light: rgba(0, 0, 0, 0.35);

  /* Semantic */
  --error: #e06c6c;
  --error-bg: rgba(220, 50, 50, 0.06);
  --error-bg-strong: rgba(220, 50, 50, 0.08);
  --error-border: rgba(220, 50, 50, 0.2);
  --error-border-strong: rgba(220, 50, 50, 0.3);
  --warning: #fbbf24;
  --warning-bg: rgba(251, 191, 36, 0.08);

  /* Syntax */
  --syntax-string: #34d399;
  --syntax-number: #60a5fa;
  --syntax-boolean: #c084fc;
  --syntax-key: #10b981;
  --syntax-punctuation: #888;
  --syntax-null: #999;
  --syntax-comment: #888;
  --syntax-result: #61afef;
  --syntax-keyword: #c678dd;
  --syntax-function: #e5c07b;
  --syntax-operator: #10b981;
  --syntax-string-alt: #98c379;

  /* Scrollbar */
  --scrollbar-thumb: rgba(255, 255, 255, 0.1);
  --scrollbar-thumb-hover: rgba(255, 255, 255, 0.2);

  /* Selection */
  --selection-bg: #059669;
  --selection-text: #fff;

  /* Theme-color meta tag values */
  --theme-meta-color: #0a0a0f;
}

/* Light theme — explicit toggle */
[data-theme="light"] {
  --bg-page: #f8f8fa;
  --bg-surface: #ffffff;
  --bg-surface-alt: #f0f0f5;
  --bg-surface-raised: #f5f5f8;
  --bg-surface-deep: #f2f2f7;
  --bg-tooltip: #ffffff;
  --bg-input: #ffffff;
  --bg-hover: rgba(0, 0, 0, 0.04);
  --bg-hover-strong: rgba(0, 0, 0, 0.06);
  --bg-code: #f5f5f8;
  --bg-overlay: rgba(248, 248, 250, 0.88);
  --bg-overlay-heavy: rgba(248, 248, 250, 0.97);

  --text-primary: #1a1a2e;
  --text-bright: #000;
  --text-secondary: #555;
  --text-muted: #777;
  --text-dim: #767676;
  --text-placeholder: #767676;
  --text-link: #444;
  --text-on-accent: #fff;

  --accent: #059669;
  --accent-bright: #10b981;
  --accent-dark: #047857;
  --accent-darker: #065f46;
  --accent-bg: rgba(5, 150, 105, 0.08);
  --accent-bg-strong: rgba(5, 150, 105, 0.12);
  --accent-bg-stronger: rgba(5, 150, 105, 0.15);
  --accent-border: rgba(5, 150, 105, 0.2);
  --accent-border-strong: rgba(5, 150, 105, 0.3);

  --border: rgba(0, 0, 0, 0.08);
  --border-mid: rgba(0, 0, 0, 0.1);
  --border-strong: rgba(0, 0, 0, 0.12);
  --border-stronger: rgba(0, 0, 0, 0.15);

  --shadow: rgba(0, 0, 0, 0.1);
  --shadow-light: rgba(0, 0, 0, 0.06);

  --error: #dc3545;
  --error-bg: rgba(220, 50, 50, 0.06);
  --error-bg-strong: rgba(220, 50, 50, 0.08);
  --error-border: rgba(220, 50, 50, 0.2);
  --error-border-strong: rgba(220, 50, 50, 0.3);
  --warning: #d97706;
  --warning-bg: rgba(217, 119, 6, 0.08);

  --syntax-string: #059669;
  --syntax-number: #2563eb;
  --syntax-boolean: #7c3aed;
  --syntax-key: #047857;
  --syntax-punctuation: #666;
  --syntax-null: #888;
  --syntax-comment: #888;
  --syntax-result: #2563eb;
  --syntax-keyword: #7c3aed;
  --syntax-function: #b45309;
  --syntax-operator: #059669;
  --syntax-string-alt: #047857;

  --scrollbar-thumb: rgba(0, 0, 0, 0.15);
  --scrollbar-thumb-hover: rgba(0, 0, 0, 0.25);

  --selection-bg: #059669;
  --selection-text: #fff;

  --theme-meta-color: #f8f8fa;
}

/* Light theme — OS preference (no explicit choice) */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg-page: #f8f8fa;
    --bg-surface: #ffffff;
    --bg-surface-alt: #f0f0f5;
    --bg-surface-raised: #f5f5f8;
    --bg-surface-deep: #f2f2f7;
    --bg-tooltip: #ffffff;
    --bg-input: #ffffff;
    --bg-hover: rgba(0, 0, 0, 0.04);
    --bg-hover-strong: rgba(0, 0, 0, 0.06);
    --bg-code: #f5f5f8;
    --bg-overlay: rgba(248, 248, 250, 0.88);
    --bg-overlay-heavy: rgba(248, 248, 250, 0.97);

    --text-primary: #1a1a2e;
    --text-bright: #000;
    --text-secondary: #555;
    --text-muted: #777;
    --text-dim: #767676;
    --text-placeholder: #767676;
    --text-link: #444;
    --text-on-accent: #fff;

    --accent: #059669;
    --accent-bright: #10b981;
    --accent-dark: #047857;
    --accent-darker: #065f46;
    --accent-bg: rgba(5, 150, 105, 0.08);
    --accent-bg-strong: rgba(5, 150, 105, 0.12);
    --accent-bg-stronger: rgba(5, 150, 105, 0.15);
    --accent-border: rgba(5, 150, 105, 0.2);
    --accent-border-strong: rgba(5, 150, 105, 0.3);

    --border: rgba(0, 0, 0, 0.08);
    --border-mid: rgba(0, 0, 0, 0.1);
    --border-strong: rgba(0, 0, 0, 0.12);
    --border-stronger: rgba(0, 0, 0, 0.15);

    --shadow: rgba(0, 0, 0, 0.1);
    --shadow-light: rgba(0, 0, 0, 0.06);

    --error: #dc3545;
    --error-bg: rgba(220, 50, 50, 0.06);
    --error-bg-strong: rgba(220, 50, 50, 0.08);
    --error-border: rgba(220, 50, 50, 0.2);
    --error-border-strong: rgba(220, 50, 50, 0.3);
    --warning: #d97706;
    --warning-bg: rgba(217, 119, 6, 0.08);

    --syntax-string: #059669;
    --syntax-number: #2563eb;
    --syntax-boolean: #7c3aed;
    --syntax-key: #047857;
    --syntax-punctuation: #666;
    --syntax-null: #888;
    --syntax-comment: #888;
    --syntax-result: #2563eb;
    --syntax-keyword: #7c3aed;
    --syntax-function: #b45309;
    --syntax-operator: #059669;
    --syntax-string-alt: #047857;

    --scrollbar-thumb: rgba(0, 0, 0, 0.15);
    --scrollbar-thumb-hover: rgba(0, 0, 0, 0.25);

    --selection-bg: #059669;
    --selection-text: #fff;

    --theme-meta-color: #f8f8fa;
  }
}
```

Note: The `[data-theme="light"]` and the `@media` blocks contain identical values. This is intentional — the `@media` block handles OS-level preference when no explicit choice is stored, while `[data-theme="light"]` handles the explicit toggle. They must stay in sync.

- [ ] **Step 2: Verify the file loads correctly**

Open `website/index.html` in a browser and confirm:
- No CSS errors in devtools console
- Page still renders identically (all variables are defined but not yet used)

- [ ] **Step 3: Commit**

```bash
git add website/styles.css
git commit -m "feat(theme): add CSS custom property definitions for light/dark themes"
```

---

### Task 2: Add theme toggle JS to nav.js

**Files:**
- Modify: `website/nav.js`

- [ ] **Step 1: Add theme initialization and toggle logic**

Replace the entire contents of `website/nav.js` with:

```javascript
// ── Theme toggle ──────────────────────────────────────────
(function () {
  const root = document.documentElement
  const meta = document.querySelector('meta[name="theme-color"]')

  function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }

  function getEffectiveTheme() {
    return root.dataset.theme || getSystemTheme()
  }

  function updateMeta(theme) {
    if (meta) meta.content = theme === 'light' ? '#f8f8fa' : '#0a0a0f'
  }

  function updateToggleLabels(theme) {
    const label = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'
    for (const btn of document.querySelectorAll('.theme-toggle')) {
      btn.setAttribute('aria-label', label)
    }
  }

  function applyTheme(theme) {
    root.dataset.theme = theme
    updateMeta(theme)
    updateToggleLabels(theme)
  }

  // Initialize
  const saved = localStorage.getItem('bonsai-theme')
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved)
  } else {
    // No valid saved preference — let CSS @media handle variables.
    // Just update meta tag and toggle labels for current OS preference.
    const effective = getSystemTheme()
    updateMeta(effective)
    updateToggleLabels(effective)
  }

  // Toggle handler
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-toggle')
    if (!btn) return
    const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark'
    localStorage.setItem('bonsai-theme', next)
    applyTheme(next)
  })

  // Listen for OS preference changes (only when no explicit override)
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (!localStorage.getItem('bonsai-theme')) {
      // No saved pref — CSS @media handles the variables automatically.
      // Update meta tag and toggle labels for new OS preference.
      const effective = getSystemTheme()
      updateMeta(effective)
      updateToggleLabels(effective)
    }
  })
})()

// ── Mobile hamburger menu toggle ──────────────────────────
const hamburger = document.querySelector('.nav-hamburger')
const navLinks = document.querySelector('.nav-links')

if (hamburger && navLinks) {
  hamburger.addEventListener('click', () => {
    const expanded = hamburger.getAttribute('aria-expanded') === 'true'
    hamburger.setAttribute('aria-expanded', String(!expanded))
    navLinks.classList.toggle('open')
  })

  // Close menu when a link is tapped
  navLinks.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      hamburger.setAttribute('aria-expanded', 'false')
      navLinks.classList.remove('open')
    }
  })
}
```

- [ ] **Step 2: Verify the JS loads without errors**

Open any page in a browser. Confirm no errors in devtools console.

- [ ] **Step 3: Commit**

```bash
git add website/nav.js
git commit -m "feat(theme): add theme toggle logic with localStorage persistence and OS preference detection"
```

---

### Task 3: Add toggle button to all HTML pages

Add the theme toggle button as the last `<li>` inside `.nav-links` in all 4 HTML files. Also fix inline `style="color:#10b981;"` on active nav links in docs.html and how-it-works.html (replace with a CSS class).

**Files:**
- Modify: `website/index.html`
- Modify: `website/playground.html`
- Modify: `website/docs.html`
- Modify: `website/how-it-works.html`
- Modify: `website/styles.css` (add `.nav-links a.active` rule)

The toggle button HTML to insert before `</ul>` in each nav:

```html
        <li>
          <button class="theme-toggle" aria-label="Switch to light mode" type="button">
            <svg class="theme-icon-sun" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="4.22" x2="19.78" y2="5.64"/></svg>
            <svg class="theme-icon-moon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </button>
        </li>
```

- [ ] **Step 1: Add toggle button to index.html**

Insert the toggle button `<li>` before `</ul>` in the nav (after the npm `<li>`).

- [ ] **Step 2: Add toggle button to playground.html**

Same insertion point.

- [ ] **Step 3: Add toggle button to docs.html and fix inline active style**

Insert toggle button. Also change:
```html
<a href="./docs.html" style="color:#10b981;">Docs</a>
```
to:
```html
<a href="./docs.html" class="active">Docs</a>
```

- [ ] **Step 4: Add toggle button to how-it-works.html and fix inline active style**

Insert toggle button. Also change:
```html
<a href="./how-it-works.html" style="color:#10b981;">How It Works</a>
```
to:
```html
<a href="./how-it-works.html" class="active">How It Works</a>
```

- [ ] **Step 5: Add .nav-links a.active style and theme toggle styles to styles.css**

Add to styles.css after the `.nav-links a:hover` rule (around line 128):

```css
.nav-links a.active {
  color: var(--accent);
}
```

Add theme toggle button styles (after the nav section, before Hero):

```css
/* Theme toggle */
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: transparent;
  border: 1px solid var(--border-mid);
  border-radius: 8px;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease;
  padding: 0;
  line-height: 1;
}

.theme-toggle:hover {
  color: var(--accent);
  border-color: var(--accent-border-strong);
}

/* Show sun in dark mode, moon in light mode */
.theme-icon-moon { display: none; }

[data-theme="light"] .theme-icon-sun { display: none; }
[data-theme="light"] .theme-icon-moon { display: inline; }

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .theme-icon-sun { display: none; }
  :root:not([data-theme="dark"]) .theme-icon-moon { display: inline; }
}
```

- [ ] **Step 6: Verify toggle button appears and works**

Open any page. Confirm:
- Toggle button visible in nav bar
- Clicking it switches `data-theme` on `<html>`
- Icon changes between sun/moon
- Preference survives page reload

- [ ] **Step 7: Commit**

```bash
git add website/index.html website/playground.html website/docs.html website/how-it-works.html website/styles.css
git commit -m "feat(theme): add toggle button to nav bar on all pages"
```

---

## Chunk 2: Replace Hardcoded Colors in styles.css

### Task 4: Replace hardcoded colors in styles.css with CSS variables

This is the largest single task — systematically replace every hardcoded color in styles.css with the corresponding CSS variable. Work section by section through the file.

**Files:**
- Modify: `website/styles.css`

**Mapping reference** (hardcoded → variable):

| Hardcoded | Variable | Context |
|-----------|----------|---------|
| `#0a0a0f` (bg) | `var(--bg-page)` | body, section backgrounds, input backgrounds |
| `#14141f` (bg) | `var(--bg-surface)` | cards, panels, hero-code, install-box |
| `#0e0e16` (bg) | `var(--bg-surface-alt)` | sidebar backgrounds |
| `#0d0d14` (bg) | `var(--bg-surface-deep)` | quick-try, use-cases section |
| `#0f0f16` (bg) | `var(--bg-surface-alt)` | quick-try-context-wrap |
| `#e8e4df` (color) | `var(--text-primary)` | body text, input text, install-box |
| `#fff` / `#ffffff` (color) | `var(--text-bright)` | headings, nav brand, CTA buttons |
| `#999` (color) | `var(--text-secondary)` | subtitle, nav links, section-intro, feature-card p |
| `#888` (color) | `var(--text-muted)` | labels, comments, arrows, share-btn, footer |
| `#777` (color) | `var(--text-muted)` | quick-try-sub, ctx-add-btn |
| `#bbb` (color) | `var(--text-link)` | hero-proof li, quick-preset |
| `#ccc` (color) | `var(--text-link)` | td color |
| `#444` (color) | `var(--text-dim)` | ctx-row-sep, ctx-row-value placeholder, ctx-empty |
| `#3a3a3a` (color) | `var(--text-dim)` | (not in styles.css, mostly playground-page) |
| `#a6a6aa` (color) | `var(--text-secondary)` | use-case-card p, comparison-copy |
| `#8f95a3` (color) | `var(--text-secondary)` | quick-try-context |
| `#10b981` | `var(--accent)` | links, accents, cursor |
| `#34d399` | `var(--accent-bright)` | hover states |
| `#059669` | `var(--accent-dark)` | selection bg, CTA btn bg |
| `#047857` | `var(--accent-darker)` | CTA btn hover |
| `#e06c6c` | `var(--error)` | error text |
| `#61afef` | `var(--syntax-result)` | result colors, use-case-code |
| `#98c379` | `var(--syntax-string-alt)` | hero-code .string |
| `rgba(10, 10, 15, 0.85)` | `var(--bg-overlay)` | nav background |
| `rgba(10, 10, 15, 0.97)` | `var(--bg-overlay-heavy)` | mobile nav dropdown |
| `rgba(255, 255, 255, 0.06)` (border) | `var(--border)` | subtle borders |
| `rgba(255, 255, 255, 0.08)` (border) | `var(--border-mid)` | input borders |
| `rgba(255, 255, 255, 0.1)` (border) | `var(--border-strong)` | share-btn border |
| `rgba(255, 255, 255, 0.12)` (border) | `var(--border-stronger)` | secondary CTA border |
| `rgba(255, 255, 255, 0.04)` | `var(--border)` | very subtle borders (close enough) |
| `rgba(255, 255, 255, 0.03)` (bg) | `var(--bg-hover)` | subtle hover backgrounds |
| `rgba(255, 255, 255, 0.05)` (border) | `var(--border)` | subtle borders |
| `rgba(16, 185, 129, ...)` | `var(--accent-border)` / `var(--accent-bg)` etc. | accent-tinted borders/bgs |
| `rgba(0, 0, 0, 0.18)` (bg) | kept as-is | dark overlay on any theme works |
| `rgba(0, 0, 0, 0.5)` (shadow) | `var(--shadow)` | box shadows |
| `rgba(52, 211, 153, ...)` | `var(--accent-bright)` for text | accent-bright tinted |
| `rgba(220, 50, 50, ...)` | `var(--error-bg)` / `var(--error-border)` | error states |

**Gradient special cases:**
- `.hero` background gradient: `linear-gradient(135deg, var(--bg-page) 0%, var(--bg-surface) 50%, var(--bg-page) 100%)`
- `.use-cases` radial gradient: keep the green tint but use variable for base
- `.hero .gradient-text`: keep the green gradient (brand element, works on both themes)

**Colors to keep as-is (not theme-dependent):**
- `.ctx-type-*` badge colors (semantic: string=green, number=blue, etc.) — these use rgba backgrounds with high-contrast text, they work on both themes
- CTA button text `#fff` → `var(--text-on-accent)` (always white on green)
- Selection colors (always green bg + white text)

- [ ] **Step 1: Replace colors in body, typography, links (lines 14-54)**

Replace:
- `body { background: #0a0a0f; color: #e8e4df; }` → `background: var(--bg-page); color: var(--text-primary);`
- `::selection { background: #059669; color: #fff; }` → `background: var(--selection-bg); color: var(--selection-text);`
- `h1-h4 { color: #fff; }` → `color: var(--text-bright);`
- `a { color: #10b981; }` → `color: var(--accent);`
- `a:hover { color: #34d399; }` → `color: var(--accent-bright);`

- [ ] **Step 2: Replace colors in nav (lines 73-161)**

- `.nav { background: rgba(10, 10, 15, 0.85); border-bottom: 1px solid rgba(16, 185, 129, 0.1); }` → `background: var(--bg-overlay); border-bottom: 1px solid var(--accent-border);`
- `.nav-brand { color: #fff; }` → `color: var(--text-bright);`
- `.nav-links a { color: #999; }` → `color: var(--text-secondary);`
- `.nav-links a:hover { color: #10b981; }` → `color: var(--accent);`
- `.nav-hamburger span { background: #e8e4df; }` → `background: var(--text-primary);`
- Mobile `.nav-links a { color: #999; }` (line 1407) → `color: var(--text-secondary);`
- Mobile `.nav-links { background: rgba(10, 10, 15, 0.97); border-bottom: 1px solid rgba(16, 185, 129, 0.1); }` → `background: var(--bg-overlay-heavy); border-bottom: 1px solid var(--accent-border);`
- Mobile `.nav-links a:hover { background: rgba(16, 185, 129, 0.06); }` → `background: var(--accent-bg);`

- [ ] **Step 3: Replace colors in hero section (lines 163-330)**

- `.hero { background: linear-gradient(135deg, #0a0a0f 0%, #141420 50%, #0a0a0f 100%); }` → `background: linear-gradient(135deg, var(--bg-page) 0%, var(--bg-surface) 50%, var(--bg-page) 100%);`
- `.hero .subtitle { color: #999; }` → `color: var(--text-secondary);`
- `.hero .subtitle code { color: #10b981; }` → `color: var(--accent);`
- `.install-box { background: #14141f; border: 1px solid rgba(16, 185, 129, 0.2); color: #e8e4df; }` → `background: var(--bg-surface); border: 1px solid var(--accent-border); color: var(--text-primary);`
- `.install-box .prompt { color: #10b981; }` → `color: var(--accent);`
- `.copy-btn { color: #999; }` → `color: var(--text-secondary);`
- `.copy-btn:hover { color: #10b981; }` → `color: var(--accent);`
- `.cta-btn { background: #059669; color: #fff; }` → `background: var(--accent-dark); color: var(--text-on-accent);`
- `.cta-btn.secondary { background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.12); color: #e8e4df; }` → `background: var(--bg-hover); border: 1px solid var(--border-stronger); color: var(--text-primary);`
- `.cta-btn:hover { background: #047857; color: #fff; }` → `background: var(--accent-darker); color: var(--text-on-accent);`
- `.cta-btn.secondary:hover { color: #fff; border-color: rgba(16, 185, 129, 0.25); background: rgba(16, 185, 129, 0.08); }` → `color: var(--text-on-accent); border-color: var(--accent-border); background: var(--accent-bg);` (use `--text-on-accent` not `--text-bright` — this is a button hover, should stay white on both themes)
- `.hero-proof li { border: 1px solid rgba(255, 255, 255, 0.08); background: rgba(255, 255, 255, 0.03); color: #bbb; }` → `border: 1px solid var(--border-mid); background: var(--bg-hover); color: var(--text-link);`
- `.hero-code { background: #14141f; border: 1px solid rgba(16, 185, 129, 0.15); color: #e8e4df; }` → `background: var(--bg-surface); border: 1px solid var(--accent-border); color: var(--text-primary);`
- `.hero-code .comment { color: #888; }` → `color: var(--syntax-comment);`
- `.hero-code .string { color: #98c379; }` → `color: var(--syntax-string-alt);`
- `.hero-code .operator { color: #10b981; }` → `color: var(--syntax-operator);`
- `.hero-code .result { color: #61afef; }` → `color: var(--syntax-result);`

- [ ] **Step 4: Replace colors in features, use-cases, comparison sections (lines 332-455)**

- `.features { background: #0a0a0f; }` → `background: var(--bg-page);`
- `.section-intro { color: #999; }` → `color: var(--text-secondary);`
- `.feature-card { background: #14141f; border: 1px solid rgba(255, 255, 255, 0.06); }` → `background: var(--bg-surface); border: 1px solid var(--border);`
- `.feature-card:hover { border-color: rgba(16, 185, 129, 0.3); }` → `border-color: var(--accent-border-strong);`
- `.feature-card p { color: #999; }` → `color: var(--text-secondary);`
- `.use-cases { background: radial-gradient(circle at top center, rgba(16, 185, 129, 0.08), transparent 50%), #0d0d14; }` → `background: radial-gradient(circle at top center, var(--accent-bg), transparent 50%), var(--bg-surface-deep);`
- `.use-case-card { background: linear-gradient(180deg, rgba(20, 20, 31, 0.95), rgba(16, 16, 26, 0.95)); border: 1px solid rgba(255, 255, 255, 0.06); }` → `background: var(--bg-surface); border: 1px solid var(--border);`
- `.use-case-kicker { background: rgba(16, 185, 129, 0.1); color: #10b981; }` → `background: var(--accent-bg-strong); color: var(--accent);`
- `.use-case-card p { color: #a6a6aa; }` → `color: var(--text-secondary);`
- `.use-case-code { background: rgba(0, 0, 0, 0.18); border: 1px solid rgba(255, 255, 255, 0.05); color: #61afef; }` → `background: rgba(0, 0, 0, 0.08); border: 1px solid var(--border); color: var(--syntax-result);`
- `.production-grade { background: #0a0a0f; }` → `background: var(--bg-page);`
- `.comparison-card { background: #14141f; border: 1px solid rgba(255, 255, 255, 0.06); }` → `background: var(--bg-surface); border: 1px solid var(--border);`
- `.comparison-copy { color: #a6a6aa; }` → `color: var(--text-secondary);`

- [ ] **Step 5: Replace colors in quick-try section (lines 458-606)**

- `.quick-try { background: #0d0d14; }` → `background: var(--bg-surface-deep);`
- `.quick-try-sub { color: #777; }` → `color: var(--text-muted);`
- `.quick-preset { border: 1px solid rgba(16, 185, 129, 0.2); color: #bbb; }` → `border: 1px solid var(--accent-border); color: var(--text-link);`
- `.quick-preset:hover, .quick-preset.active { background: rgba(16, 185, 129, 0.12); color: #10b981; border-color: rgba(16, 185, 129, 0.35); }` → `background: var(--accent-bg-strong); color: var(--accent); border-color: var(--accent-border-strong);`
- `.quick-open-link { color: #10b981; }` → `color: var(--accent);`
- `.quick-try-panel { background: #14141f; border: 1px solid rgba(16, 185, 129, 0.15); }` → `background: var(--bg-surface); border: 1px solid var(--accent-border);`
- `.quick-try-editor textarea { background: #0a0a0f; border: 1px solid rgba(255, 255, 255, 0.08); color: #e8e4df; caret-color: #10b981; }` → `background: var(--bg-input); border: 1px solid var(--border-mid); color: var(--text-primary); caret-color: var(--accent);`
- `.quick-try-editor textarea:focus { border-color: rgba(16, 185, 129, 0.4); }` → `border-color: var(--accent-border-strong);`
- `.quick-try-arrow { color: #888; }` → `color: var(--text-muted);`
- `.quick-try-result { background: #0a0a0f; border: 1px solid rgba(255, 255, 255, 0.08); color: #34d399; }` → `background: var(--bg-input); border: 1px solid var(--border-mid); color: var(--accent-bright);`
- `.quick-try-result.quick-try-error { color: #e06c6c; }` → `color: var(--error);`
- `.quick-try-context-wrap { background: #0f0f16; border: 1px solid rgba(255, 255, 255, 0.06); }` → `background: var(--bg-surface-alt); border: 1px solid var(--border);`
- `.quick-try-context-label { color: #777; }` → `color: var(--text-muted);`
- `.quick-try-context { color: #8f95a3; }` → `color: var(--text-secondary);`

- [ ] **Step 6: Replace colors in playground inline section (lines 608-1038)**

- `.playground-panel { background: #14141f; border: 1px solid rgba(16, 185, 129, 0.15); }` → `background: var(--bg-surface); border: 1px solid var(--accent-border);`
- `.playground-toolbar { border-bottom: 1px solid rgba(255, 255, 255, 0.06); }` → `border-bottom: 1px solid var(--border);`
- `.example-pill { border: 1px solid rgba(16, 185, 129, 0.3); color: #10b981; }` → `border: 1px solid var(--accent-border-strong); color: var(--accent);`
- `.example-pill:hover, .example-pill.active { background: rgba(16, 185, 129, 0.15); color: #34d399; }` → `background: var(--accent-bg-stronger); color: var(--accent-bright);`
- `.share-btn { border: 1px solid rgba(255, 255, 255, 0.1); color: #888; }` → `border: 1px solid var(--border-strong); color: var(--text-muted);`
- `.share-btn:hover { color: #10b981; border-color: rgba(16, 185, 129, 0.3); }` → `color: var(--accent); border-color: var(--accent-border-strong);`
- `.share-btn.copied { color: #34d399; border-color: rgba(52, 211, 153, 0.3); }` → `color: var(--accent-bright); border-color: var(--accent-border-strong);`
- `.playground-input { border-right: 1px solid rgba(255, 255, 255, 0.06); }` → `border-right: 1px solid var(--border);`
- `.playground-col label { color: #888; }` → `color: var(--text-muted);`
- `.ctx-inline-add { color: #888; }` → `color: var(--text-muted);`
- `.ctx-inline-add:hover { color: #10b981; }` → `color: var(--accent);`
- `.expr-highlight .hl-var { background: rgba(16, 185, 129, 0.12); }` → `background: var(--accent-bg-strong);`
- `#expr-input { background: #0a0a0f; border: 1px solid rgba(255, 255, 255, 0.08); color: #e8e4df; caret-color: #10b981; }` → `background: var(--bg-input); border: 1px solid var(--border-mid); color: var(--text-primary); caret-color: var(--accent);`
- `#expr-input:focus { border-color: rgba(16, 185, 129, 0.4); }` → `border-color: var(--accent-border-strong);`
- `.ctx-header label` — already covered by `.playground-col label`
- `.ctx-add-btn { border: 1px solid rgba(255, 255, 255, 0.08); color: #777; }` → `border: 1px solid var(--border-mid); color: var(--text-muted);`
- `.ctx-add-btn:hover { color: #10b981; border-color: rgba(16, 185, 129, 0.3); }` → `color: var(--accent); border-color: var(--accent-border-strong);`
- `.ctx-row { background: #0a0a0f; border: 1px solid rgba(255, 255, 255, 0.06); }` → `background: var(--bg-input); border: 1px solid var(--border);`
- `.ctx-row:focus-within { border-color: rgba(16, 185, 129, 0.25); }` → `border-color: var(--accent-border);`
- `.ctx-row-name { color: #10b981; }` → `color: var(--accent);`
- `.ctx-row-name::placeholder { color: #888; }` → `color: var(--text-muted);`
- `.ctx-row-sep { color: #444; }` → `color: var(--text-dim);`
- `.ctx-row-value { color: #e8e4df; }` → `color: var(--text-primary);`
- `.ctx-row-value::placeholder { color: #444; }` → `color: var(--text-placeholder);`
- `.ctx-row-delete { color: #888; }` → `color: var(--text-muted);`
- `.ctx-row-delete:hover { color: #e06c6c; background: rgba(220, 50, 50, 0.1); }` → `color: var(--error); background: var(--error-bg);`
- `.ctx-empty { color: #444; }` → `color: var(--text-dim);`
- `.ctx-empty-add { color: #10b981; }` → `color: var(--accent);`
- `.ctx-empty-add:hover { color: #34d399; }` → `color: var(--accent-bright);`
- `.result-toggle { border: 1px solid rgba(255, 255, 255, 0.1); color: #999; }` → `border: 1px solid var(--border-strong); color: var(--text-secondary);`
- `.result-toggle.active { background: rgba(16, 185, 129, 0.15); color: #10b981; border-color: rgba(16, 185, 129, 0.3); }` → `background: var(--accent-bg-stronger); color: var(--accent); border-color: var(--accent-border-strong);`
- `#result-output { background: #0a0a0f; border: 1px solid rgba(255, 255, 255, 0.08); color: #e8e4df; }` → `background: var(--bg-input); border: 1px solid var(--border-mid); color: var(--text-primary);`
- `#result-output .r-string { color: #34d399; }` → `color: var(--syntax-string);`
- `#result-output .r-number { color: #60a5fa; }` → `color: var(--syntax-number);`
- `#result-output .r-boolean { color: #c084fc; }` → `color: var(--syntax-boolean);`
- `#result-output .r-null { color: #999; }` → `color: var(--syntax-null);`
- `#result-output .r-key { color: #10b981; }` → `color: var(--syntax-key);`
- `#result-output .r-bracket { color: #888; }` → `color: var(--syntax-punctuation);`
- `#result-output .r-punct { color: #888; }` → `color: var(--syntax-punctuation);`
- `#result-type { background: rgba(16, 185, 129, 0.1); color: #10b981; }` → `background: var(--accent-bg-strong); color: var(--accent);`
- `#error-output { background: rgba(220, 50, 50, 0.08); border: 1px solid rgba(220, 50, 50, 0.3); color: #e06c6c; }` → `background: var(--error-bg-strong); border: 1px solid var(--error-border-strong); color: var(--error);`

- [ ] **Step 7: Replace colors in syntax-ref/api-docs, details, tables, pre, footer (lines 1040-1213)**

- `.syntax-ref, .api-docs, .stdlib-docs { background: #0a0a0f; }` → `background: var(--bg-page);`
- `details { background: #14141f; border: 1px solid rgba(255, 255, 255, 0.06); }` → `background: var(--bg-surface); border: 1px solid var(--border);`
- `details[open] { border-color: rgba(16, 185, 129, 0.2); }` → `border-color: var(--accent-border);`
- `summary { color: #fff; }` → `color: var(--text-bright);`
- `summary::before { color: #10b981; }` → `color: var(--accent);`
- `summary:hover { color: #10b981; }` → `color: var(--accent);`
- `th { border-bottom: 1px solid rgba(16, 185, 129, 0.2); color: #10b981; }` → `border-bottom: 1px solid var(--accent-border); color: var(--accent);`
- `td { border-bottom: 1px solid rgba(255, 255, 255, 0.04); color: #ccc; }` → `border-bottom: 1px solid var(--border); color: var(--text-link);`
- `td code { background: #0a0a0f; color: #e8e4df; }` → `background: var(--bg-code); color: var(--text-primary);`
- `pre { background: #14141f; border: 1px solid rgba(255, 255, 255, 0.06); }` → `background: var(--bg-surface); border: 1px solid var(--border);`
- `.api-section p { color: #999; }` → `color: var(--text-secondary);`
- `.stdlib-group h3 { color: #10b981; }` → `color: var(--accent);`
- `td .example-result { color: #61afef; }` → `color: var(--syntax-result);`
- `.api-example { background: #0a0a0f; border: 1px solid rgba(255, 255, 255, 0.06); color: #e8e4df; }` → `background: var(--bg-code); border: 1px solid var(--border); color: var(--text-primary);`
- `.api-example .comment { color: #888; }` → `color: var(--syntax-comment);`
- `.api-example .result { color: #61afef; }` → `color: var(--syntax-result);`
- `.footer { border-top: 1px solid rgba(255, 255, 255, 0.06); color: #888; }` → `border-top: 1px solid var(--border); color: var(--text-muted);`

- [ ] **Step 8: Replace colors in responsive media queries (lines 1242-1492)**

- Mobile `.playground-input { border-bottom: 1px solid rgba(255, 255, 255, 0.06); }` → `border-bottom: 1px solid var(--border);`
- Mobile `.nav-links { background: rgba(10, 10, 15, 0.97); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(16, 185, 129, 0.1); }` → `background: var(--bg-overlay-heavy); border-bottom: 1px solid var(--accent-border);`
- Mobile `.nav-links a { color: #999; }` → `color: var(--text-secondary);`
- Mobile `.nav-links a:hover { background: rgba(16, 185, 129, 0.06); }` → `background: var(--accent-bg);`

- [ ] **Step 9: Verify dark theme still looks identical**

Open every page in the browser. Visually compare with the original. Dark theme should be pixel-identical since we're just replacing hardcoded values with variables that resolve to the same values.

- [ ] **Step 10: Verify light theme**

Add `data-theme="light"` to `<html>` manually in devtools. Confirm all colors have switched appropriately on the homepage.

- [ ] **Step 11: Commit**

```bash
git add website/styles.css
git commit -m "feat(theme): replace hardcoded colors with CSS variables in styles.css"
```

---

## Chunk 3: Replace Hardcoded Colors in Page-Specific CSS

### Task 5: Replace hardcoded colors in playground-page.css

**Files:**
- Modify: `website/playground-page.css`

Apply the same variable substitution pattern. Key replacements:

- [ ] **Step 1: Replace scrollbar, sidebar, and example list colors (lines 1-126)**

- `.playground-page *::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); }` → `background: var(--scrollbar-thumb);`
- `:hover` thumb → `var(--scrollbar-thumb-hover)`
- Firefox `scrollbar-color: rgba(255, 255, 255, 0.1) transparent;` → `scrollbar-color: var(--scrollbar-thumb) transparent;`
- `.pg-sidebar { background: #0e0e16; border-right: 1px solid rgba(255, 255, 255, 0.06); }` → `background: var(--bg-surface-alt); border-right: 1px solid var(--border);`
- `.pg-sidebar-header { color: #888; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }` → `color: var(--text-muted); border-bottom: 1px solid var(--border);`
- `.pg-group-label { color: #3a3a3a; }` → `color: var(--text-dim);`
- `.pg-group-label:not(:first-child) { border-top: 1px solid rgba(255, 255, 255, 0.03); }` → `border-top: 1px solid var(--border);`
- `.pg-example:hover { background: rgba(255, 255, 255, 0.03); }` → `background: var(--bg-hover);`
- `.pg-example.active { background: rgba(16, 185, 129, 0.08); }` → `background: var(--accent-bg);`
- `.pg-example-title { color: #ccc; }` → `color: var(--text-link);`
- `.pg-example.active .pg-example-title { color: #10b981; }` → `color: var(--accent);`
- `.pg-example-code { color: #888; }` → `color: var(--text-muted);`

- [ ] **Step 2: Replace topbar, live badge colors (lines 128-227)**

- `.pg-topbar { border-bottom: 1px solid rgba(255, 255, 255, 0.06); background: #0e0e16; }` → `border-bottom: 1px solid var(--border); background: var(--bg-surface-alt);`
- `.pg-live-badge { background: rgba(52, 211, 153, 0.08); color: #34d399; }` → `background: var(--accent-bg); color: var(--accent-bright);`
- `.pg-live-dot { background: #34d399; }` → `background: var(--accent-bright);`
- `.pg-live-badge.is-stale { background: rgba(251, 191, 36, 0.08); color: #fbbf24; }` → `background: var(--warning-bg); color: var(--warning);`
- `.pg-live-badge.is-stale .pg-live-dot { background: #fbbf24; }` → `background: var(--warning);`
- `.pg-eval-time { color: #888; }` → `color: var(--text-muted);`
- `.pg-topbar-btn { border: 1px solid rgba(255, 255, 255, 0.08); color: #777; }` → `border: 1px solid var(--border-mid); color: var(--text-muted);`
- `.pg-topbar-btn:hover { color: #10b981; border-color: rgba(16, 185, 129, 0.3); }` → `color: var(--accent); border-color: var(--accent-border-strong);`
- `.pg-topbar-btn.copied { color: #34d399; border-color: rgba(52, 211, 153, 0.3); }` → `color: var(--accent-bright); border-color: var(--accent-border-strong);`

- [ ] **Step 3: Replace editor grid, pane, expression, and tooltip colors (lines 229-406)**

- `.pg-editor-left { border-right: 1px solid rgba(255, 255, 255, 0.06); }` → `border-right: 1px solid var(--border);`
- `.pg-pane-header { border-bottom: 1px solid rgba(255, 255, 255, 0.04); }` → `border-bottom: 1px solid var(--border);`
- `.pg-pane-label { color: #888; }` → `color: var(--text-muted);`
- `.pg-pane-hint { color: #3a3a3a; }` → `color: var(--text-dim);`
- `.pg-expr-highlight .hl-var { background: rgba(16, 185, 129, 0.12); }` → `background: var(--accent-bg-strong);`
- `.pg-expr-highlight .hl-transform { background: rgba(96, 165, 250, 0.10); border-bottom: 1px dashed rgba(96, 165, 250, 0.3); }` — keep as-is (blue tint, works on both themes)
- `.pg-transform-tooltip { background: #1a1a24; border: 1px solid rgba(96, 165, 250, 0.2); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }` → `background: var(--bg-tooltip); border: 1px solid rgba(96, 165, 250, 0.2); box-shadow: 0 8px 24px var(--shadow);`
- `.pg-tt-name { color: #60a5fa; }` → `color: var(--syntax-number);` (blue accent, close enough)
- `.pg-tt-module { background: rgba(96, 165, 250, 0.1); color: #60a5fa; }` — keep as-is (blue badge)
- `.pg-tt-desc { color: #999; }` → `color: var(--text-secondary);`
- `.pg-tt-var-name { color: #10b981; }` → `color: var(--accent);`
- `.pg-tt-var-type { background: rgba(16, 185, 129, 0.1); color: #10b981; }` → `background: var(--accent-bg-strong); color: var(--accent);`
- `.pg-tt-var-val { color: #888; }` → `color: var(--text-muted);`
- `#expr-input { color: #e8e4df; caret-color: #10b981; }` → `color: var(--text-primary); caret-color: var(--accent);`

- [ ] **Step 4: Replace context pane, result pane, autocomplete, and error colors (lines 408-656)**

- `.pg-ctx-pane { border-top: 1px solid rgba(255, 255, 255, 0.06); }` → `border-top: 1px solid var(--border);`
- `.pg-ctx-add { border: 1px solid rgba(255, 255, 255, 0.06); color: #999; }` → `border: 1px solid var(--border); color: var(--text-secondary);`
- `.pg-ctx-add:hover { color: #10b981; border-color: rgba(16, 185, 129, 0.3); }` → `color: var(--accent); border-color: var(--accent-border-strong);`
- `.pg-ctx-row { background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.04); }` → `background: var(--bg-hover); border: 1px solid var(--border);`
- `.pg-ctx-row:focus-within { border-color: rgba(16, 185, 129, 0.2); }` → `border-color: var(--accent-border);`
- `.pg-ctx-row-name { color: #10b981; }` → `color: var(--accent);`
- `.pg-ctx-row-name::placeholder { color: #444; }` → `color: var(--text-placeholder);`
- `.pg-ctx-row-sep { color: #3a3a3a; }` → `color: var(--text-dim);`
- `.pg-ctx-row-value { background: rgba(0, 0, 0, 0.15); border: 1px solid rgba(255, 255, 255, 0.03); color: #e8e4df; }` → `background: rgba(0, 0, 0, 0.06); border: 1px solid var(--border); color: var(--text-primary);`
- `.pg-ctx-row-value::placeholder { color: #3a3a3a; }` → `color: var(--text-placeholder);`
- `.pg-ctx-row-delete { color: #444; }` → `color: var(--text-dim);`
- `.pg-ctx-row-delete:hover { color: #e06c6c; background: rgba(220, 50, 50, 0.1); }` → `color: var(--error); background: var(--error-bg);`
- `.pg-ctx-empty { color: #3a3a3a; }` → `color: var(--text-dim);`
- `.pg-ctx-empty-add { color: #10b981; }` → `color: var(--accent);`
- `.pg-ctx-empty-add:hover { color: #34d399; }` → `color: var(--accent-bright);`
- `.pg-result-tab { border: 1px solid rgba(255, 255, 255, 0.06); color: #888; }` → `border: 1px solid var(--border); color: var(--text-muted);`
- `.pg-result-tab.active { background: rgba(16, 185, 129, 0.12); color: #10b981; border-color: rgba(16, 185, 129, 0.25); }` → `background: var(--accent-bg-strong); color: var(--accent); border-color: var(--accent-border);`
- `.pg-result-type { background: rgba(16, 185, 129, 0.08); color: #10b981; }` → `background: var(--accent-bg); color: var(--accent);`
- `.pg-result-body { color: #e8e4df; }` → `color: var(--text-primary);`
- `.pg-result-body .r-string { color: #34d399; }` → `color: var(--syntax-string);`
- `.pg-result-body .r-number { color: #60a5fa; }` → `color: var(--syntax-number);`
- `.pg-result-body .r-boolean { color: #c084fc; }` → `color: var(--syntax-boolean);`
- `.pg-result-body .r-null { color: #888; }` → `color: var(--syntax-null);`
- `.pg-result-body .r-key { color: #10b981; }` → `color: var(--syntax-key);`
- `.pg-result-body .r-bracket { color: #888; }` → `color: var(--syntax-punctuation);`
- `.pg-result-body .r-punct { color: #444; }` → `color: var(--text-dim);`
- `.pg-error { background: rgba(220, 50, 50, 0.06); border: 1px solid rgba(220, 50, 50, 0.2); color: #e06c6c; }` → `background: var(--error-bg); border: 1px solid var(--error-border); color: var(--error);`
- `.pg-autocomplete { background: #16161e; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5); }` → `background: var(--bg-surface-raised); border: 1px solid var(--border-mid); box-shadow: 0 12px 40px var(--shadow);`
- `.pg-ac-item:hover, .pg-ac-item.active { background: rgba(16, 185, 129, 0.08); }` → `background: var(--accent-bg);`
- `.pg-ac-name { color: #e8e4df; }` → `color: var(--text-primary);`
- `.pg-ac-item.active .pg-ac-name { color: #10b981; }` → `color: var(--accent);`
- `.pg-ac-name strong { color: #10b981; }` → `color: var(--accent);`
- `.pg-ac-module { background: rgba(255, 255, 255, 0.04); color: #888; }` → `background: var(--bg-hover); color: var(--text-muted);`
- `.pg-ac-item.active .pg-ac-module { background: rgba(96, 165, 250, 0.1); color: #60a5fa; }` — keep as-is (blue badge)
- `.pg-ac-desc { color: #444; }` → `color: var(--text-dim);`
- `.pg-ac-item.active .pg-ac-desc { color: #999; }` → `color: var(--text-secondary);`

- [ ] **Step 5: Replace colors in responsive sections (lines 729-793)**

- Mobile `.pg-editor-left { border-bottom: 1px solid rgba(255, 255, 255, 0.06); }` → `border-bottom: 1px solid var(--border);`

- [ ] **Step 6: Replace duplicated type badge colors (lines 637-643)**

The `.ctx-type-*` badges in playground-page.css duplicate those in styles.css. These use rgba backgrounds that work on both themes. Leave as-is.

- [ ] **Step 7: Verify playground visually in both themes**

- [ ] **Step 8: Commit**

```bash
git add website/playground-page.css
git commit -m "feat(theme): replace hardcoded colors with CSS variables in playground-page.css"
```

---

### Task 6: Replace hardcoded colors in docs.css

**Files:**
- Modify: `website/docs.css`

Same pattern. Key replacements (not exhaustively listed — follow the same mapping as Tasks 4-5):

- [ ] **Step 1: Replace sidebar, search, content colors**

All `#0d0d14`, `#0a0a0f` backgrounds → `var(--bg-surface-deep)`, `var(--bg-page)`
All `#14141f` backgrounds → `var(--bg-surface)`
All `#12121c` backgrounds → `var(--bg-surface)` (close enough)
All `#10101a` backgrounds → `var(--bg-surface-deep)` (ex-group)
All `#e8e4df` text → `var(--text-primary)`
All `#fff` text → `var(--text-bright)`
All `#999` text → `var(--text-secondary)`
All `#888` text → `var(--text-muted)`
All `#777` text → `var(--text-muted)`
All `#bbb` text → `var(--text-link)`
All `#ccc` text → `var(--text-link)`
All `#a6a6aa`, `#a7a7b0` text → `var(--text-secondary)`
All `#10b981` accent → `var(--accent)`
All `#34d399` accent → `var(--accent-bright)`
All `#61afef` result → `var(--syntax-result)`
All `#98c379` string → `var(--syntax-string-alt)`
All `#c678dd` keyword → `var(--syntax-keyword)`
All `#e5c07b` function → `var(--syntax-function)`
All `#d19a66` number → `var(--syntax-function)` (close enough in dark, maps differently in light)
All `rgba(255, 255, 255, 0.0X)` borders → appropriate `var(--border*)` token
All `rgba(16, 185, 129, ...)` → appropriate accent variable
`.docs-hero-link.primary { background: #10b981; color: #0a0a0f; }` → `background: var(--accent); color: var(--bg-page);`
`.docs-quick-nav { background: #0a0a0f; }` → `background: var(--bg-page);`
`.docs-quick-link { background: rgba(13, 13, 20, 0.88); color: #a6a6aa; }` → `background: var(--bg-overlay); color: var(--text-secondary);`
`.docs-backtotop { background: rgba(13, 13, 20, 0.92); color: #10b981; }` → `background: var(--bg-overlay); color: var(--accent);`
`.hamburger-btn { background: #14141f; border: 1px solid rgba(255, 255, 255, 0.1); color: #e8e4df; }` → `background: var(--bg-surface); border: 1px solid var(--border-strong); color: var(--text-primary);`
`.sidebar-overlay { background: rgba(0, 0, 0, 0.5); }` → `background: var(--shadow);`
`.sidebar-link { color: #777; }` → `color: var(--text-muted);`
`.sidebar-link:hover { color: #e8e4df; }` → `color: var(--text-primary);`
`.sidebar-link.active { color: #10b981; border-left-color: #10b981; }` → `color: var(--accent); border-left-color: var(--accent);`
`.bench-num { color: #61afef; }` → `color: var(--syntax-result);`
`.bench-table th { color: #888; }` → `color: var(--text-muted);`
`.bench-table td { color: #bbb; }` → `color: var(--text-link);`
Scrollbar thumbs → `var(--scrollbar-thumb)`

- [ ] **Step 2: Verify docs page in both themes**

- [ ] **Step 3: Commit**

```bash
git add website/docs.css
git commit -m "feat(theme): replace hardcoded colors with CSS variables in docs.css"
```

---

### Task 7: Replace hardcoded colors in how-it-works.css

**Files:**
- Modify: `website/how-it-works.css`

- [ ] **Step 1: Replace all hardcoded colors**

Follow the same mapping. Key ones:
- `.hiw-hero-section { background: linear-gradient(135deg, #0a0a0f 0%, #141420 50%, #0a0a0f 100%); }` → `background: linear-gradient(135deg, var(--bg-page) 0%, var(--bg-surface) 50%, var(--bg-page) 100%);`
- `.hiw-section { border-bottom: 1px solid rgba(255, 255, 255, 0.04); }` → `border-bottom: 1px solid var(--border);`
- `.hiw-subtitle { color: #999; }` → `color: var(--text-secondary);`
- `.hiw-subtitle code { color: #10b981; }` → `color: var(--accent);`
- `.hiw-narrative p { color: #a6a6aa; }` → `color: var(--text-secondary);`
- `.hiw-narrative p code { color: #10b981; background: rgba(16, 185, 129, 0.08); }` → `color: var(--accent); background: var(--accent-bg);`
- `.hiw-narrative strong { color: #e8e4df; }` → `color: var(--text-primary);`
- `.hiw-step-label { color: #10b981; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); }` → `color: var(--accent); background: var(--accent-bg-strong); border: 1px solid var(--accent-border);`
- `.hiw-interactive-panel { background: #14141f; border: 1px solid rgba(255, 255, 255, 0.07); }` → `background: var(--bg-surface); border: 1px solid var(--border-mid);`
- `.hiw-panel-label { color: #999; }` → `color: var(--text-secondary);`
- `.hiw-input { background: #0a0a0f; border: 1px solid rgba(255, 255, 255, 0.1); color: #e8e4df; }` → `background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-primary);`
- `.hiw-input:focus { border-color: rgba(16, 185, 129, 0.4); box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.08); }` → `border-color: var(--accent-border-strong); box-shadow: 0 0 0 3px var(--accent-bg);`
- `.hiw-select { background: #0a0a0f; border: 1px solid rgba(255, 255, 255, 0.1); color: #e8e4df; }` → `background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-primary);`
- `.hiw-select:focus { border-color: rgba(16, 185, 129, 0.4); }` → `border-color: var(--accent-border-strong);`
- `.hiw-token-type { color: #999; }` → `color: var(--text-secondary);`
- Token type colors (`.hiw-token-type-number`, etc.) — keep as-is (they use unique rgba palettes per type, work on both themes)
- `.hiw-prec-wrong, .hiw-prec-right { background: #0a0a0f; }` → `background: var(--bg-input);`
- `.hiw-prec-expr { color: #e8e4df; }` → `color: var(--text-primary);`
- `.hiw-prec-note { color: #999; }` → `color: var(--text-secondary);`
- `.hiw-prec-table th { color: #999; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }` → `color: var(--text-secondary); border-bottom: 1px solid var(--border);`
- `.hiw-prec-table td { color: #a6a6aa; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }` → `color: var(--text-secondary); border-bottom: 1px solid var(--border);`
- `.hiw-prec-table td code { color: #10b981; }` → `color: var(--accent);`
- `.hiw-tree-container { background: #0a0a0f; border: 1px solid rgba(255, 255, 255, 0.07); }` → `background: var(--bg-input); border: 1px solid var(--border-mid);`
- `.hiw-node text { fill: #e8e4df; }` → `fill: var(--text-primary);`
- `.hiw-edge { stroke: rgba(255, 255, 255, 0.15); }` → `stroke: var(--border-stronger);`
- `.hiw-node-value { fill: #10b981; }` → `fill: var(--accent);`
- `.hiw-play-btn { background: #059669; color: #fff; }` → `background: var(--accent-dark); color: var(--text-on-accent);`
- `.hiw-play-btn:hover { background: #047857; }` → `background: var(--accent-darker);`
- `.hiw-eval-result { color: #10b981; }` → `color: var(--accent);`
- `.hiw-source-highlight { color: #a6a6aa; background: #0a0a0f; border: 1px solid rgba(255, 255, 255, 0.06); }` → `color: var(--text-secondary); background: var(--bg-input); border: 1px solid var(--border);`
- `.hiw-hl { color: #10b981; background: rgba(16, 185, 129, 0.12); }` → `color: var(--accent); background: var(--accent-bg-strong);`
- `.hiw-opt-label { color: #999; }` → `color: var(--text-secondary);`
- `.hiw-opt-message { color: #7ee787; }` — keep as-is (semantic success color)
- `.hiw-cta { background: linear-gradient(135deg, #0a0a0f 0%, #141420 50%, #0a0a0f 100%); }` → `background: linear-gradient(135deg, var(--bg-page) 0%, var(--bg-surface) 50%, var(--bg-page) 100%);`
- `.hiw-error { color: #ff6b6b; background: rgba(255, 107, 107, 0.08); border: 1px solid rgba(255, 107, 107, 0.2); }` — keep as-is (error semantic colors)

- [ ] **Step 2: Verify how-it-works page in both themes**

- [ ] **Step 3: Commit**

```bash
git add website/how-it-works.css
git commit -m "feat(theme): replace hardcoded colors with CSS variables in how-it-works.css"
```

---

## Chunk 4: Fix JS Inline Styles + Final Verification

### Task 8: Fix docs.js inline color assignments

**Files:**
- Modify: `website/docs.js`
- Modify: `website/docs.css` (add copy button state classes)

The copy buttons in docs.js set colors via `element.style` which overrides CSS variables. Convert to CSS class toggling.

- [ ] **Step 1: Add copy button CSS classes to docs.css**

Add to docs.css (after `.doc-code` block, around line 384):

```css
/* Copy button in code blocks */
.doc-code .copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  background: var(--bg-hover-strong);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: 0.75rem;
  transition: all 0.2s ease;
}

.doc-code .copy-btn:hover {
  color: var(--accent);
  border-color: var(--accent-border-strong);
}

.doc-code .copy-btn.copied {
  color: var(--syntax-string-alt);
}
```

- [ ] **Step 2: Update docs.js to use CSS classes instead of inline styles**

Replace the copy button creation code (lines 213-247) with:

```javascript
  for (const block of document.querySelectorAll('.doc-code')) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '\u2398';
    btn.title = 'Copy to clipboard';

    btn.addEventListener('click', () => {
      const text = block.textContent
        .replace(btn.textContent, '')
        .trim();
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '\u2713';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '\u2398';
          btn.classList.remove('copied');
        }, 1500);
      });
    });

    block.style.position = 'relative';
    block.appendChild(btn);
  }
```

This removes all `btn.style.cssText`, `btn.style.color`, and `btn.style.borderColor` assignments, replacing them with CSS class-based styling that respects theme variables.

- [ ] **Step 3: Verify copy buttons work and look correct in both themes**

- [ ] **Step 4: Commit**

```bash
git add website/docs.js website/docs.css
git commit -m "fix(theme): replace inline style colors in docs.js with CSS classes"
```

---

### Task 9: Full visual verification

No code changes — this is a manual QA pass.

- [ ] **Step 1: Dark mode verification (all pages)**

Open each page (index, playground, docs, how-it-works) with dark mode. Confirm:
- All colors match the original design
- No white flashes or unstyled elements
- Toggle button shows sun icon
- Autocomplete dropdown in playground is themed
- Copy buttons in docs work
- Mobile hamburger menu is themed

- [ ] **Step 2: Light mode verification (all pages)**

Click the toggle to switch to light mode. Confirm on each page:
- Backgrounds are light (not white-on-white or unreadable)
- Text is dark and readable
- Accent green is slightly darker (still green, good contrast)
- Placeholder text is readable (this was the original complaint)
- Syntax highlighting is readable
- No elements still showing dark-theme colors
- Error states visible
- Interactive panels on how-it-works page work

- [ ] **Step 3: OS preference verification**

Clear localStorage (`localStorage.removeItem('bonsai-theme')`), remove `data-theme` attribute. Set OS to light mode. Confirm site follows OS preference. Toggle manually, confirm override persists.

- [ ] **Step 4: Mobile verification**

Test on a narrow viewport (< 640px):
- Toggle button appears in hamburger menu
- All pages are themed correctly
- No overflow or layout issues

- [ ] **Step 5: Commit all remaining changes (if any fixups needed)**

```bash
git add -A
git commit -m "fix(theme): visual polish from QA pass"
```
