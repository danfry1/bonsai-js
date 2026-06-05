<template>
  <div ref="root" class="pg-layout">
    <!-- Sidebar: examples -->
    <aside class="pg-sidebar">
      <div class="pg-sidebar-header">Examples</div>
      <div class="pg-example-list" id="example-list">
        <div class="pg-group-label">Basics</div>
        <button class="pg-example active" data-example="hello">
          <span class="pg-example-title">Hello World</span>
          <span class="pg-example-code">"hello" |&gt; upper</span>
        </button>
        <button class="pg-example" data-example="templates">
          <span class="pg-example-title">Template Literals</span>
          <span class="pg-example-code">`Hello ${name}!`</span>
        </button>
        <button class="pg-example" data-example="ternary">
          <span class="pg-example-title">Conditionals</span>
          <span class="pg-example-code">age &gt;= 18 ? "adult" : "minor"</span>
        </button>
        <button class="pg-example" data-example="in-operator">
          <span class="pg-example-title">In Operator</span>
          <span class="pg-example-code">role in ["admin", "editor"]</span>
        </button>

        <div class="pg-group-label">Strings</div>
        <button class="pg-example" data-example="methods">
          <span class="pg-example-title">Method Calls</span>
          <span class="pg-example-code">"hello world".slice(0, 5)</span>
        </button>
        <button class="pg-example" data-example="string-format">
          <span class="pg-example-title">String Formatting</span>
          <span class="pg-example-code">`${name |&gt; upper} scored…`</span>
        </button>

        <div class="pg-group-label">Arrays</div>
        <button class="pg-example" data-example="filtering">
          <span class="pg-example-title">Filtering</span>
          <span class="pg-example-code">users |&gt; filter(.age &gt;= 18)</span>
        </button>
        <button class="pg-example" data-example="chaining">
          <span class="pg-example-title">Chained Pipes</span>
          <span class="pg-example-code">scores |&gt; sort |&gt; reverse |&gt; first</span>
        </button>
        <button class="pg-example" data-example="unique-tags">
          <span class="pg-example-title">Flatten &amp; Unique</span>
          <span class="pg-example-code">posts |&gt; map(.tags) |&gt; flatten</span>
        </button>
        <button class="pg-example" data-example="search">
          <span class="pg-example-title">Search &amp; Filter</span>
          <span class="pg-example-code">items |&gt; filter(.name.includes(…))</span>
        </button>

        <div class="pg-group-label">Math</div>
        <button class="pg-example" data-example="math">
          <span class="pg-example-title">Sum Pipeline</span>
          <span class="pg-example-code">[10, 20, 30] |&gt; sum</span>
        </button>
        <button class="pg-example" data-example="grade-calc">
          <span class="pg-example-title">Grade Calculator</span>
          <span class="pg-example-code">scores |&gt; avg |&gt; clamp |&gt; round</span>
        </button>

        <div class="pg-group-label">Objects</div>
        <button class="pg-example" data-example="null-safety">
          <span class="pg-example-title">Null Safety</span>
          <span class="pg-example-code">user?.profile?.avatar ?? …</span>
        </button>
        <button class="pg-example" data-example="nested-data">
          <span class="pg-example-title">Nested Access</span>
          <span class="pg-example-code">company.departments |&gt; map |&gt; join</span>
        </button>
        <button class="pg-example" data-example="data-transform">
          <span class="pg-example-title">Data Pipeline</span>
          <span class="pg-example-code">orders |&gt; filter |&gt; avg |&gt; round</span>
        </button>
      </div>
    </aside>

    <!-- Main playground area -->
    <main class="pg-main">
      <!-- Top bar -->
      <div class="pg-topbar">
        <div class="pg-topbar-left">
          <span class="pg-live-badge" id="live-badge">
            <span class="pg-live-dot"></span>
            Live
          </span>
          <span class="pg-eval-time" id="eval-time"></span>
        </div>
        <div class="pg-topbar-right">
          <button class="pg-topbar-btn" id="share-btn" title="Copy shareable link">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            <span class="pg-btn-label">Share</span>
          </button>
          <button class="pg-topbar-btn" id="reset-btn" title="Reset">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            Reset
          </button>
        </div>
      </div>

      <!-- Editor grid -->
      <div class="pg-editor-grid">
        <!-- Left: expression + context -->
        <div class="pg-editor-left">
          <div class="pg-pane pg-expr-pane">
            <div class="pg-pane-header">
              <span class="pg-pane-label">Expression</span>
              <span class="pg-pane-hint" id="expr-hint">auto-evaluates as you type</span>
            </div>
            <div class="pg-expr-editor">
              <div class="pg-expr-highlight" id="expr-highlight" aria-hidden="true"></div>
              <textarea class="pg-expr-input" id="expr-input" spellcheck="false" placeholder="Type an expression...">"hello" |> upper</textarea>
            </div>
          </div>

          <div class="pg-pane pg-ctx-pane" id="ctx-pane">
            <div class="pg-pane-header">
              <span class="pg-pane-label">Context</span>
              <button class="pg-ctx-add" id="ctx-add" title="Add variable">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add
              </button>
            </div>
            <div class="pg-ctx-vars" id="ctx-vars"></div>
            <div class="pg-ctx-empty" id="ctx-empty">
              No context variables. <button class="pg-ctx-empty-add" id="ctx-empty-add">Add one</button>
            </div>
          </div>
        </div>

        <!-- Right: result -->
        <div class="pg-editor-right">
          <div class="pg-pane pg-result-pane">
            <div class="pg-pane-header">
              <div class="pg-result-tabs">
                <button class="pg-result-tab active" data-mode="result">Result</button>
                <button class="pg-result-tab" data-mode="ast">AST</button>
              </div>
              <span class="pg-result-type" id="result-type"></span>
            </div>
            <div class="pg-result-body" id="result-output"></div>
            <div class="pg-error" id="error-output"></div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { bonsai } from 'bonsai-src'
import { strings, arrays, math, types, dates } from 'bonsai-stdlib'
import { createAutocomplete } from 'bonsai-autocomplete'

const root = ref<HTMLElement>()

onMounted(() => {
  // Logic ported in Task 18.
  void bonsai
  void strings
  void arrays
  void math
  void types
  void dates
  void createAutocomplete
})
</script>
