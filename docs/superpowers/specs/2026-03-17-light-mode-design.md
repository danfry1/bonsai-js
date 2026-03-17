# Light Mode Support for Bonsai Website

**Date:** 2026-03-17
**Status:** Approved
**Scope:** All pages (index, playground, docs, how-it-works)

## Motivation

User feedback reports that placeholder/hint text in the playground context fields uses dark grey (`#3a3a3a`, `#444`) on dark backgrounds (`#0a0a0f`), resulting in contrast ratios well below WCAG AA minimums (~1.5:1). Multiple users have requested light mode support. Adding a proper theme system also improves maintainability by replacing ~50+ hardcoded color values with semantic tokens.

## Approach

**CSS Custom Properties + Class Toggle (Approach A)**

- Define semantic CSS custom properties on `:root` (dark defaults)
- Override under `[data-theme="light"]` and `@media (prefers-color-scheme: light)` for light mode
- Replace all hardcoded color values in `styles.css` and `playground-page.css` with variables
- Add toggle button and theme logic to `nav.js`
- No new dependencies, no build step, no framework changes

## CSS Variable Token System

| Token | Dark Value | Light Value | Purpose |
|-------|-----------|-------------|---------|
| `--bg-page` | `#0a0a0f` | `#f8f8fa` | Page background |
| `--bg-surface` | `#14141f` | `#ffffff` | Cards, panels |
| `--bg-surface-alt` | `#0e0e16` | `#f0f0f5` | Sidebar, secondary surfaces |
| `--bg-input` | `#0a0a0f` | `#ffffff` | Input backgrounds |
| `--bg-hover` | `rgba(255,255,255,0.04)` | `rgba(0,0,0,0.04)` | Hover states |
| `--text-primary` | `#e8e4df` | `#1a1a2e` | Body text |
| `--text-secondary` | `#999` | `#555` | Secondary text |
| `--text-muted` | `#666` | `#888` | Tertiary/hint text |
| `--text-placeholder` | `#555` | `#767676` | Placeholder text (4.5:1 on white) |
| `--accent` | `#10b981` | `#059669` | Primary accent |
| `--accent-bright` | `#34d399` | `#10b981` | Hover/bright accent |
| `--accent-bg` | `rgba(16,185,129,0.08)` | `rgba(5,150,105,0.1)` | Accent backgrounds |
| `--border` | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.1)` | Borders |
| `--border-strong` | `rgba(255,255,255,0.12)` | `rgba(0,0,0,0.15)` | Emphasized borders |
| `--shadow` | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.1)` | Box shadows |
| `--error` | `#e06c6c` | `#dc3545` | Error text |
| `--error-bg` | `rgba(220,50,50,0.06)` | `rgba(220,50,50,0.06)` | Error backgrounds |
| `--syntax-string` | `#34d399` | `#059669` | Syntax: strings |
| `--syntax-number` | `#60a5fa` | `#2563eb` | Syntax: numbers |
| `--syntax-boolean` | `#c084fc` | `#7c3aed` | Syntax: booleans |
| `--syntax-key` | `#10b981` | `#047857` | Syntax: object keys |
| `--syntax-punctuation` | `#888` | `#666` | Syntax: brackets |
| `--bg-surface-raised` | `#16161e` | `#f5f5f8` | Autocomplete dropdown, elevated surfaces |
| `--bg-surface-deep` | `#0d0d14` | `#f2f2f7` | Deepest inset sections |
| `--bg-tooltip` | `#1a1a24` | `#ffffff` | Tooltips, popovers |
| `--text-dim` | `#3a3a3a` | `#767676` | Group labels, separators, hints |
| `--text-bright` | `#fff` | `#000` | Headings, high-emphasis text |
| `--text-link` | `#bbb` | `#444` | Nav links, secondary interactive text |
| `--warning` | `#fbbf24` | `#d97706` | Stale badge, warnings |
| `--warning-bg` | `rgba(251,191,36,0.08)` | `rgba(217,119,6,0.08)` | Warning backgrounds |
| `--error-border` | `rgba(220,50,50,0.2)` | `rgba(220,50,50,0.3)` | Error borders |

Additional tokens may be derived during implementation for one-off colors. The above table covers all distinct color values found in `styles.css`, `playground-page.css`, and `docs.js`.

## Theme Switching Logic

Located in `nav.js`, shared across all pages.

### Initialization (page load)
1. Check `localStorage.getItem('bonsai-theme')` for saved preference
2. If saved preference exists, set `document.documentElement.dataset.theme` to that value
3. If no saved preference, do NOT set `data-theme` — let the CSS `@media` rule handle OS preference automatically
4. Update `<meta name="theme-color">` content to match resolved theme

### CSS Precedence
```css
/* Dark is default */
:root {
  --bg-page: #0a0a0f;
  /* ... */
}

/* Light via explicit toggle */
[data-theme="light"] {
  --bg-page: #f8f8fa;
  /* ... */
}

/* Light via OS preference when no explicit choice */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg-page: #f8f8fa;
    /* ... */
  }
}
```

Dark by default. OS preference respected automatically. Explicit toggle wins over everything.

### OS Preference Listener
- Listen for `matchMedia` `change` events
- Only react if user hasn't set an explicit override (no `localStorage` value)

## Toggle Button UI

Added as the last `<li>` in `.nav-links` on all 4 HTML pages:

```html
<li>
  <button class="theme-toggle" aria-label="Switch to light mode" type="button">
    <svg class="theme-icon-sun"><!-- sun outline --></svg>
    <svg class="theme-icon-moon"><!-- moon outline --></svg>
  </button>
</li>
```

- In dark mode: show sun icon (click to switch to light)
- In light mode: show moon icon (click to switch to dark)
- Visibility toggled via CSS (`display: none` on the inactive icon)
- Styled to match nav link sizing — transparent background, same hover behavior
- Inline SVGs, 16px, no external dependency
- Appears in hamburger menu on mobile

## Files Modified

| File | Change |
|------|--------|
| `website/styles.css` | Add variable definitions at top; replace hardcoded colors with variables |
| `website/playground-page.css` | Replace hardcoded colors with variables |
| `website/nav.js` | Add theme init, toggle handler, OS preference listener (~30 lines) |
| `website/index.html` | Add toggle button `<li>` to nav |
| `website/playground.html` | Add toggle button `<li>` to nav |
| `website/docs.html` | Add toggle button `<li>` to nav; remove inline `style` color on active link |
| `website/docs.js` | Replace inline `style` color assignments on copy buttons with CSS class toggling |
| `website/how-it-works.html` | Add toggle button `<li>` to nav; remove inline `style` color on active link |

No new files. No new dependencies. No build step changes.

## Accessibility Notes

- Toggle button `aria-label` is dynamic: "Switch to light mode" / "Switch to dark mode" — updated by JS on toggle
- All text colors in both themes target WCAG AA contrast ratios (4.5:1 minimum for body text, 3:1 for large text)
- Placeholder text improved: dark theme `#555` on `#0a0a0f` (~3.1:1, meets WCAG AA for large text/UI components); light theme `#767676` on `#ffffff` (4.5:1, meets WCAG AA)
- Theme preference persisted across sessions via `localStorage`
- Respects `prefers-color-scheme` for users who haven't explicitly chosen
