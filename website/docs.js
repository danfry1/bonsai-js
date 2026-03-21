// Docs page interactivity: search, navigation, copy buttons, and reading aids

(function () {
  const sidebar = document.querySelector('.docs-sidebar');
  if (!sidebar) return;

  const links = Array.from(sidebar.querySelectorAll('.sidebar-link'));
  const sections = Array.from(document.querySelectorAll('.doc-section'));
  const groups = Array.from(sidebar.querySelectorAll('.sidebar-group'));
  const searchInput = document.getElementById('docs-search');
  const searchCount = document.getElementById('docs-search-count');
  const searchEmpty = document.getElementById('docs-search-empty');
  const expandAllBtn = document.getElementById('docs-expand-all');
  const collapseAllBtn = document.getElementById('docs-collapse-all');
  const quickLinks = Array.from(document.querySelectorAll('.docs-quick-link'));
  const progressBar = document.getElementById('docs-progress-bar');
  const backToTop = document.getElementById('docs-backtotop');
  const hamburger = document.querySelector('.hamburger-btn') || document.querySelector('.nav-hamburger');
  const overlay = document.querySelector('.sidebar-overlay');

  const sectionIndexById = new Map(sections.map((section, index) => [section.id, index]));
  let activeSectionId = location.hash ? location.hash.slice(1) : (sections[0]?.id ?? '');

  function setSidebarOpen(open) {
    sidebar.classList.toggle('open', open);
    overlay?.classList.toggle('visible', open);
  }

  function smoothScrollTo(hash) {
    const target = document.querySelector(hash);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setAllGroupsCollapsed(collapsed) {
    for (const group of groups) {
      group.classList.toggle('collapsed', collapsed);
    }
  }

  function updateSearchState() {
    const query = searchInput?.value.trim().toLowerCase() ?? '';
    let totalMatches = 0;

    for (const group of groups) {
      let matchCount = 0;

      for (const link of group.querySelectorAll('.sidebar-link')) {
        const text = `${link.textContent} ${link.getAttribute('href') ?? ''}`.toLowerCase();
        const matches = query === '' || text.includes(query);
        link.style.display = matches ? '' : 'none';
        if (matches) {
          matchCount++;
          totalMatches++;
        }
      }

      group.style.display = matchCount > 0 ? '' : 'none';
      if (query !== '' && matchCount > 0) {
        group.classList.remove('collapsed');
      }
    }

    if (searchCount) {
      searchCount.textContent = query === ''
        ? `${links.length} sections`
        : `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`;
    }

    if (searchEmpty) {
      searchEmpty.hidden = query === '' || totalMatches > 0;
    }
  }

  function updateQuickLinks(id) {
    const activeIndex = sectionIndexById.get(id) ?? 0;

    for (let index = 0; index < quickLinks.length; index++) {
      const link = quickLinks[index];
      const startId = link.dataset.quickTarget ?? '';
      const nextId = quickLinks[index + 1]?.dataset.quickTarget ?? '';
      const startIndex = sectionIndexById.get(startId) ?? 0;
      const nextIndex = nextId ? (sectionIndexById.get(nextId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
      link.classList.toggle('active', activeIndex >= startIndex && activeIndex < nextIndex);
    }
  }

  function updateActiveSection(id) {
    activeSectionId = id;

    for (const link of links) {
      link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
    }

    updateQuickLinks(id);

    const group = links.find((link) => link.getAttribute('href') === `#${id}`)?.closest('.sidebar-group');
    if (group) {
      group.classList.remove('collapsed');
    }

    history.replaceState(null, '', `#${id}`);
  }

  function updateProgress() {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const progress = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
    if (progressBar) {
      progressBar.style.transform = `scaleX(${progress})`;
    }
    if (backToTop) {
      backToTop.classList.toggle('visible', window.scrollY > 640);
    }
  }

  if (searchInput) {
    searchInput.addEventListener('input', updateSearchState);
  }

  document.addEventListener('keydown', (event) => {
    if (!searchInput) return;

    const active = document.activeElement;
    const isTyping =
      active instanceof HTMLElement &&
      (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));

    const isSearchShortcut =
      (!isTyping && event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) ||
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k');

    if (isSearchShortcut) {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }

    if (event.key === 'Escape' && document.activeElement === searchInput) {
      if (searchInput.value) {
        searchInput.value = '';
        updateSearchState();
      } else {
        searchInput.blur();
      }
    }
  });

  expandAllBtn?.addEventListener('click', () => {
    setAllGroupsCollapsed(false);
  });

  collapseAllBtn?.addEventListener('click', () => {
    setAllGroupsCollapsed(true);
  });

  for (const group of groups) {
    const title = group.querySelector('.sidebar-group-title');
    title?.addEventListener('click', () => {
      group.classList.toggle('collapsed');
    });
  }

  for (const link of [...links, ...quickLinks]) {
    link.addEventListener('click', (event) => {
      const href = link.getAttribute('href');
      if (!href?.startsWith('#')) return;
      event.preventDefault();
      smoothScrollTo(href);
      setSidebarOpen(false);
    });
  }

  const sectionObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

      if (visible.length === 0) return;
      const nextId = visible[0].target.id;
      if (nextId && nextId !== activeSectionId) {
        updateActiveSection(nextId);
      }
    },
    { rootMargin: '-96px 0px -55% 0px', threshold: [0, 1] },
  );

  for (const section of sections) {
    sectionObserver.observe(section);
  }

  hamburger?.addEventListener('click', () => {
    setSidebarOpen(!sidebar.classList.contains('open'));
  });

  overlay?.addEventListener('click', () => {
    setSidebarOpen(false);
  });

  backToTop?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  for (const table of document.querySelectorAll('.doc-section table')) {
    if (table.parentElement?.classList.contains('docs-table-wrap')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'docs-table-wrap';
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }

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

  function prettyCtx(raw) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
        .replace(/\[\n\s+/g, '[').replace(/\n\s+\]/g, ']')
        .replace(/\{\n\s+/g, '{ ').replace(/\n\s+\}/g, ' }')
        .replace(/,\n\s+/g, ', ');
    } catch {
      return raw;
    }
  }

  const groupCtxShown = new Map();

  for (const ex of document.querySelectorAll('.ex[data-ctx]')) {
    const raw = ex.dataset.ctx;
    if (!raw || raw === '{}') continue;

    const existing = ex.querySelector('.ctx');
    if (existing && existing.textContent.trim().startsWith('{')) continue;

    const group = ex.closest('.ex-group');
    if (group) {
      const shown = groupCtxShown.get(group);
      if (shown === raw) continue;
      groupCtxShown.set(group, raw);
    }

    const ctx = document.createElement('span');
    ctx.className = 'ctx';
    ctx.textContent = prettyCtx(raw);
    ex.appendChild(ctx);
  }

  for (const ctx of document.querySelectorAll('.ex .ctx')) {
    const text = ctx.textContent.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) {
      ctx.classList.add('is-note');
    }
  }

  for (const block of document.querySelectorAll('[data-expr]')) {
    const exprVal = block.dataset.expr;
    if (!exprVal || block.querySelector('.try-btn')) continue;
    const ctxVal = block.dataset.ctx || '{}';
    const link = document.createElement('a');
    link.className = 'try-btn';
    link.href = `./playground?expr=${encodeURIComponent(exprVal)}&ctx=${encodeURIComponent(ctxVal)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '\u25B6 Try it';
    block.style.position = 'relative';
    block.appendChild(link);
  }

  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', updateProgress);

  updateSearchState();
  if (activeSectionId && sectionIndexById.has(activeSectionId)) {
    updateActiveSection(activeSectionId);
  } else if (sections[0]) {
    updateActiveSection(sections[0].id);
  }
  updateProgress();

  if (location.hash) {
    const target = document.querySelector(location.hash);
    if (target) {
      setTimeout(() => target.scrollIntoView({ block: 'start' }), 100);
    }
  }
})();
