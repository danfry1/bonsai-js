---
layout: home
title: 'Bonsai: safe, typed expressions for rules, filters, and templates'
titleTemplate: false
hero:
  name: Bonsai
  text: Safe, typed expressions for rules, filters, and templates.
  tagline: A small expression language for pricing rules, saved filters, formula fields, and user-authored logic. JavaScript syntax, checked against your data types before it runs, and bounded when it does.
  image:
    src: /logo.png
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
  - title: Familiar syntax
    details: JavaScript operators and names. Every function is also a method, so sum(xs) and xs.sum() are the same call.
  - title: Checked before it runs
    details: Declare your data with t and get errors for typos, wrong types, and possible nulls, with exact ranges and suggestions.
  - title: Safe by construction
    details: No globals, prototypes, conversion hooks, or mutation. Every evaluation terminates within a step budget and size limits.
  - title: Editor support and zero dependencies
    details: Completions, hover, and diagnostics from bonsai-js/service. Runs in Node.js, Bun, and modern browsers.
---

<HomeShowcase />
