# Fix Runtime Warnings

## Overview

Fix remaining Svelte 5 compiler warnings emitted at dev time from `RepoDetail.svelte` and `RepoCard.svelte`. Two warning types:

1. **`state_referenced_locally`** — reactive `$props()` values captured in `$state()` initializers or plain `const` declarations, which only snapshot the initial value.
2. **`a11y_autofocus`** — the HTML `autofocus` attribute triggers an a11y warning.

---

## Task 1: Fix `state_referenced_locally` in RepoCard.svelte

**File:** `src/RepoCard.svelte`

**Warnings (4):**
- `src/RepoCard.svelte:22:4` — `repo.type`
- `src/RepoCard.svelte:23:8` — `repo.path`
- `src/RepoCard.svelte:24:11` — `repo.sshHost`
- `src/RepoCard.svelte:24:27` — `repo.remotePath`

**Problem:** Lines 21–24 define `repoFullPath` as a plain `const` derived from `repo` (a reactive prop). This captures only the initial value and won't update if `repo` changes.

```ts
// Current (line 21-24)
const repoFullPath =
  repo.type === "local"
    ? repo.path
    : `${repo.sshHost}:${repo.remotePath}`;
```

**Fix:** Change `const` to `let` with `$derived()`:

```ts
let repoFullPath = $derived(
  repo.type === "local"
    ? repo.path
    : `${repo.sshHost}:${repo.remotePath}`
);
```

**Checklist:**
- [x] Replace `const repoFullPath = ...` with `let repoFullPath = $derived(...)` (lines 21-24)

---

## Task 2: Fix `state_referenced_locally` in RepoDetail.svelte

**File:** `src/RepoDetail.svelte`

**Warning:**
- `src/RepoDetail.svelte:41:28` — `repo` referenced in `$state()` initializer

**Problem:** Lines 31–39 initialize `$state()` variables from `repo.*` prop values:

```ts
let nameInput = $state(repo.name);           // line 31
let model = $state(repo.model);              // line 32
let maxIterations = $state(repo.maxIterations); // line 33
let completionSignal = $state(repo.completionSignal); // line 34
let envVars = $state(Object.entries(repo.envVars ?? {})...); // lines 35-37
let checks = $state(repo.checks ?? []);      // line 38
let createBranch = $state(repo.createBranch ?? true); // line 39
```

The `$effect` at lines 47–63 already re-syncs all of these when `repo` changes, so the initializer values are redundant. The compiler warns because `repo` is reactive but `$state()` only captures its value once at init.

**Fix:** Initialize `$state()` with safe defaults and let the `$effect` handle both initial and subsequent sync:

```ts
let nameInput = $state("");
let model = $state("");
let maxIterations = $state(0);
let completionSignal = $state("");
let envVars: { key: string; value: string }[] = $state([]);
let checks: Check[] = $state([]);
let createBranch = $state(true);
```

The `$effect` runs synchronously before the first paint, so the empty defaults are never visible.

**Checklist:**
- [x] `let nameInput = $state(repo.name)` → `$state("")`
- [x] `let model = $state(repo.model)` → `$state("")`
- [x] `let maxIterations = $state(repo.maxIterations)` → `$state(0)`
- [x] `let completionSignal = $state(repo.completionSignal)` → `$state("")`
- [x] `let envVars = $state(Object.entries(repo.envVars ?? {})...)` → `$state([])`
- [x] `let checks = $state(repo.checks ?? [])` → `$state([])`
- [x] `let createBranch = $state(repo.createBranch ?? true)` → `$state(true)`

---

## Task 3: Fix `a11y_autofocus` in RepoDetail.svelte

**File:** `src/RepoDetail.svelte`

**Warning:**
- `src/RepoDetail.svelte:257:8` — Avoid using autofocus

**Problem:** Line 278 uses the HTML `autofocus` attribute on the name-editing input:

```svelte
<input
  class="name-input"
  type="text"
  bind:value={nameInput}
  onblur={saveName}
  onkeydown={handleNameKeydown}
  autofocus          <!-- THIS triggers the warning -->
/>
```

**Fix:** The component already defines a `use:autofocus` action at line 221–223 that calls `node.focus()`. Remove the HTML `autofocus` attribute and use the action instead:

```svelte
<input
  class="name-input"
  type="text"
  bind:value={nameInput}
  onblur={saveName}
  onkeydown={handleNameKeydown}
  use:autofocus
/>
```

**Checklist:**
- [x] Replace `autofocus` HTML attribute with `use:autofocus` on the name input (line 278)

---

## Task 4: Verify all warnings are resolved

- [ ] Run `npx vite dev` and confirm the six warnings no longer appear
- [ ] Run `npx tsc --noEmit` to ensure no TypeScript errors were introduced
- [ ] Run `npm test` to verify existing unit tests still pass

---

## Progress

| Task | Status | Notes |
|------|--------|-------|
| 1. Fix `state_referenced_locally` in RepoCard | Done | `const` → `$derived` |
| 2. Fix `state_referenced_locally` in RepoDetail | Done | `$state(repo.x)` → `$state(default)` |
| 3. Fix `a11y_autofocus` in RepoDetail | Done | `autofocus` → `use:autofocus` |
| 4. Verify all warnings resolved | Done | Obsolete — Svelte replaced by React migration |
