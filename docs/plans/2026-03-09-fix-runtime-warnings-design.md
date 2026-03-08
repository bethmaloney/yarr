# Fix Svelte 5 Runtime Warnings

## Overview

The Vite dev server emits several Svelte 5 compiler warnings at startup. These fall into four categories:

1. **`non_reactive_update`** — A variable is reassigned but not declared with `$state(...)`, so reassignment won't trigger updates.
2. **`state_referenced_locally`** — A `$props()` value is captured at init time (e.g., `let x = $state(prop.field)`), only capturing the initial value rather than tracking reactivity.
3. **No scopable elements** — A `<style>` block contains only `:global()` rules with no scoped selectors.
4. **`a11y_autofocus`** — Use of `autofocus` attribute (accessibility concern).

All fixes are straightforward and localized to the affected Svelte components.

---

## Task 1: Fix `sessions` non-reactive update in App.svelte

**File:** `src/App.svelte`

**Warning:** `src/App.svelte:30:6` — `sessions` is updated but not declared with `$state(...)`.

**Root cause:** Line 30 declares `let sessions = new SvelteMap<...>()` without `$state()`. While `SvelteMap` handles internal mutation reactivity (`.set()`, `.delete()`), the variable is also *reassigned* on line 64 (`sessions = new SvelteMap(sessions)`), which won't be tracked without `$state()`.

**Fix:**

- [x] Add `$state()` wrapper to the `sessions` declaration on line 30:
  ```ts
  let sessions: SvelteMap<string, SessionState> = $state(new SvelteMap());
  ```
  This makes both `.set()` mutations AND reassignment reactive. (The explicit type annotation is needed because `$state()` return type is a proxy.)

---

## Task 2: Move global styles out of App.svelte

**File:** `src/App.svelte` (style block, line 367+), new file `src/global.css`, `src/main.ts`

**Warning:** `src/App.svelte:376:1` — No scopable elements found in template.

**Root cause:** The `<style>` block in App.svelte contains only `:global(body) { ... }` — no scoped selectors exist. Svelte recommends moving pure-global styles to an external stylesheet.

**Pattern:** Standard Vite/Svelte pattern — import CSS in `main.ts`.

**Fix:**

- [x] Create `src/global.css` with the body styles currently in App.svelte's `<style>` block:
  ```css
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
  }
  ```
- [x] Import `./global.css` in `src/main.ts`
- [x] Remove the entire `<style>` block from `src/App.svelte`

---

## Task 3: Fix `repo` prop capture in OneShotView.svelte

**File:** `src/OneShotView.svelte`

**Warning:** `src/OneShotView.svelte:27:21` — This reference only captures the initial value of `repo`.

**Root cause:** Line 27 initializes `let model = $state(repo.model)` — this evaluates `repo.model` once at component init. The `$effect` on lines 30-32 re-syncs it when `repo` changes, but the initial capture still triggers the warning.

**Fix:**

- [x] Change the initialization on line 27 to use a default value instead of capturing from the prop:
  ```ts
  let model = $state("");
  ```
  The existing `$effect` (lines 30-32) already handles both initial and subsequent sync:
  ```ts
  $effect(() => {
    model = repo.model;
  });
  ```
  The `$effect` runs synchronously before the first paint, so the empty string default is never visible.

---

## Task 4: Fix `repo` prop captures in RepoDetail.svelte

**File:** `src/RepoDetail.svelte`

**Warnings:** Lines 32-44 — multiple `state_referenced_locally` warnings for `repo` prop references.

**Root cause:** Lines 32-44 initialize multiple `$state` variables from `repo` props:
```ts
let model = $state(repo.model);                          // line 32
let maxIterations = $state(repo.maxIterations);           // line 33
let completionSignal = $state(repo.completionSignal);     // line 34
let envVars = $state(Object.entries(repo.envVars ?? {})...); // line 35
let checks = $state(repo.checks ?? []);                   // line 38
let gitSyncEnabled = $state(repo.gitSync?.enabled ?? false); // line 40
let gitSyncModel = $state(repo.gitSync?.model ?? "");     // line 41
let gitSyncMaxRetries = $state(repo.gitSync?.maxPushRetries ?? 3); // line 42
let gitSyncPrompt = $state(repo.gitSync?.conflictPrompt ?? ""); // line 43
```

The `$effect` on lines 44-57 re-syncs all of these, but the initial captures trigger warnings.

**Fix:**

- [x] Replace all prop-derived initializations with defaults:
  ```ts
  let model = $state("");
  let maxIterations = $state(1);
  let completionSignal = $state("");
  let envVars: { key: string; value: string }[] = $state([]);
  let checks: Check[] = $state([]);
  let gitSyncEnabled = $state(false);
  let gitSyncModel = $state("");
  let gitSyncMaxRetries = $state(3);
  let gitSyncPrompt = $state("");
  ```
  The existing `$effect` block (lines 44-57) already handles initial + subsequent sync.

---

## Task 5: Fix `a11y_autofocus` warning in RepoDetail.svelte

**File:** `src/RepoDetail.svelte`

**Warning:** `src/RepoDetail.svelte:168:8` — Avoid using autofocus.

**Root cause:** An `autofocus` attribute exists on an input element. This warning may come from a version where `autofocus` was present. The current file at line 168 does not show `autofocus`, so this may already be resolved.

**Fix:**

- [x] Verify whether `autofocus` exists anywhere in the file. If found, remove it. If not found, confirm the warning no longer appears after other fixes.

---

## Task 6: Fix `repo` prop captures in RepoCard.svelte

**File:** `src/RepoCard.svelte`

**Warnings:** Lines 20-22 — `state_referenced_locally` for `repo`.

**Root cause:** The `const` declarations on lines 18 and 26 use `typeof status` in the TypeScript type annotation (`Record<typeof status, string>`). Svelte's compiler may interpret `typeof status` as a runtime reference to the `status` prop, even though TypeScript erases it. The warnings reference `repo` — the line numbers may have shifted from when warnings were captured.

**Fix:**

- [x] Replace `typeof status` with the explicit union type `RepoStatus` in the type annotations:
  ```ts
  const statusColors: Record<RepoStatus, string> = { ... };
  const statusLabels: Record<RepoStatus, string> = { ... };
  ```
  `RepoStatus` is already imported from `./types`. This eliminates any prop reference in the const declarations.

- [x] If the warning persists, verify the exact line numbers in the dev server output and check whether any other `repo` or `status` references exist in non-reactive positions. The template references (`{repo.name}`, `{repo.path}`, etc.) are inherently reactive and should not cause warnings.

---

## Task 7: Verify all warnings are resolved

- [ ] Run `npx tauri dev` (or just `npx vite dev`) and confirm zero Svelte warnings in the console output
- [ ] Run `npx tsc --noEmit` to ensure no TypeScript errors were introduced
- [ ] Run `npm test` to verify existing unit tests still pass

---

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Fix `sessions` non-reactive update | Done | Added `$state()` wrapper |
| 2. Move global styles to external CSS | Done | Created `global.css`, imported in `main.ts` |
| 3. Fix `repo` capture in OneShotView | Done | Default init + $effect |
| 4. Fix `repo` captures in RepoDetail | Done | Default inits, 9 variables |
| 5. Fix autofocus a11y warning | Done | Already resolved — no `autofocus` in file |
| 6. Fix prop captures in RepoCard | Done | Used explicit `RepoStatus` type |
| 7. Verify all warnings resolved | Not started | Dev server + tsc + tests |
