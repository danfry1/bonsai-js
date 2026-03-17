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
