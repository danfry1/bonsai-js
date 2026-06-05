---
layout: home
title: Bonsai — Safe Expressions for Rules, Filters, and Templates
titleTemplate: false
hero:
  name: Bonsai
  text: Safe expressions for rules, filters, and templates.
  tagline: A constrained expression language for pricing rules, search filters, workflow conditions, and user-authored logic. Replace fragile eval()-style glue with typed errors, cacheable compilation, and real sandbox controls.
  image:
    src: /logo.svg
    alt: Bonsai
  actions:
    - theme: brand
      text: Open Playground
      link: /playground
    - theme: alt
      text: Read the Guide
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/danfry1/bonsai-js
features:
  - title: Zero runtime dependencies
    details: Ships nothing into your dependency tree. Runs in Node 22+, Bun, and the browser.
  - title: Typed API and rich errors
    details: Structured, discriminated error types with security codes and type guards — not thrown strings.
  - title: Safe by construction
    details: Property allowlists, depth limits, and timeout guards. Built for expressions that come from config or end users.
  - title: Cacheable compilation
    details: Compile once, evaluate on hot paths. Pluggable transforms and functions extend the language without unsafe escape hatches.
---

<HomeShowcase />
