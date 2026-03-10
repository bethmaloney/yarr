# Add Search to Branch Select Dropdown

## Overview

The branch selector dropdown in `RepoDetail.svelte` currently lists all local branches in a flat scrollable list. For repos with many branches, finding the right one is tedious. This plan adds a search/filter input at the top of the dropdown — similar to VS Code's branch picker — so users can type to narrow the list instantly, then select a branch.

No backend changes are needed. This is a purely frontend change to `RepoDetail.svelte` plus corresponding E2E tests.

## Design Decisions

- **Client-side filtering only** — branches are already fully loaded via `list_local_branches`. No need for a backend search command; simple case-insensitive substring match on the existing `branches` array is sufficient.
- **Search input inside the dropdown** — a text input appears at the top of `.branch-dropdown`, above the fast-forward button and branch list. It auto-focuses when the dropdown opens.
- **Keyboard navigation** — Enter selects the first visible match, Escape closes the dropdown. No arrow-key navigation for now (keep it simple).
- **Clear on close** — the search term resets when the dropdown closes so it's fresh next time.
- **Empty state** — when no branches match, show a "No matching branches" message instead of an empty list.

---

## Task 1: Add search input and filtering logic to RepoDetail.svelte

**Files to modify:** `src/RepoDetail.svelte`

**Pattern references:**
- Existing branch dropdown template: `src/RepoDetail.svelte:287-303`
- Existing branch state and handlers: `src/RepoDetail.svelte:158-241`
- Dropdown styles: `src/RepoDetail.svelte:1103-1155`

### Script changes (lines ~158-241)

- [x] Add a `branchSearch` state variable: `let branchSearch = $state("")`
- [x] Add a `filteredBranches` derived value using `$derived`:
  ```ts
  let filteredBranches = $derived(
    branchSearch
      ? branches.filter(b => b.toLowerCase().includes(branchSearch.toLowerCase()))
      : branches
  );
  ```
- [x] Reset `branchSearch` to `""` whenever the dropdown closes:
  - In `handleSwitchBranch` (already sets `branchDropdownOpen = false`) — add `branchSearch = ""`
  - In `handleFastForward` (already sets `branchDropdownOpen = false`) — add `branchSearch = ""`
  - In `handleClickOutside` (already sets `branchDropdownOpen = false`) — add `branchSearch = ""`
- [x] Add a `handleSearchKeydown` function:
  ```ts
  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      branchDropdownOpen = false;
      branchSearch = "";
    } else if (event.key === "Enter" && filteredBranches.length > 0) {
      handleSwitchBranch(filteredBranches[0]);
    }
  }
  ```

### Template changes (lines ~287-303)

- [x] Add a search input as the first child of `.branch-dropdown`, before the fast-forward button:
  ```svelte
  <input
    class="branch-search"
    type="text"
    placeholder="Search branches..."
    bind:value={branchSearch}
    onkeydown={handleSearchKeydown}
  />
  ```
- [x] Auto-focus the input when the dropdown opens — use a Svelte action or a `use:` directive that calls `el.focus()`:
  ```svelte
  use:autofocus
  ```
  Where `autofocus` is a simple action:
  ```ts
  function autofocus(node: HTMLElement) {
    node.focus();
  }
  ```
- [x] Change `{#each branches as branch}` to `{#each filteredBranches as branch}`
- [x] Add an empty-state message after the `{#each}` block:
  ```svelte
  {#if filteredBranches.length === 0}
    <div class="branch-empty">No matching branches</div>
  {/if}
  ```

### Style changes (after line ~1155)

- [x] Add `.branch-search` styles:
  ```css
  .branch-search {
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    font-family: "SF Mono", "Fira Code", monospace;
    background: #12121e;
    color: #ccc;
    border: none;
    border-bottom: 1px solid #333;
    outline: none;
  }

  .branch-search::placeholder {
    color: #666;
  }
  ```
- [x] Add `.branch-empty` styles:
  ```css
  .branch-empty {
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    color: #666;
    font-style: italic;
  }
  ```

---

## Task 2: Add E2E tests for branch search

**Files to modify:** `e2e/branch-display.test.ts`

**Pattern references:**
- Existing dropdown tests: `e2e/branch-display.test.ts:124-155` (open dropdown, verify items)
- Helper `navigateToRepo`: `e2e/branch-display.test.ts:14-27`
- Invoke handlers pattern: `e2e/branch-display.test.ts:128-131`

### Tests to add (inside the existing `test.describe("Branch display chip", ...)`)

- [x] **"search input appears and auto-focuses when dropdown opens"**
  - Navigate to repo with branches mock
  - Click chip to open dropdown
  - Assert `input.branch-search` is visible
  - Assert it is focused (`await expect(input).toBeFocused()`)

- [x] **"search filters branches by substring"**
  - Open dropdown with branches: `["main", "feature/login", "feature/signup", "develop", "fix/bug-123"]`
  - Type "feature" into the search input
  - Assert only `feature/login` and `feature/signup` branch items are visible
  - Clear input, type "main"
  - Assert only `main` is visible

- [x] **"search is case-insensitive"**
  - Open dropdown with branches: `["main", "Feature/Login"]`
  - Type "feature" (lowercase)
  - Assert `Feature/Login` is visible

- [x] **"shows empty state when no branches match"**
  - Open dropdown, type "nonexistent"
  - Assert `.branch-empty` with "No matching branches" text is visible
  - Assert no `.branch-item` buttons are visible

- [x] **"Enter selects first matching branch"**
  - Open dropdown with branches mock and `switch_branch` handler
  - Type "feat" to filter to feature branches
  - Press Enter
  - Assert `switch_branch` was called with the first matching branch
  - Assert dropdown closes

- [x] **"Escape closes dropdown and clears search"**
  - Open dropdown, type "feat"
  - Press Escape
  - Assert dropdown is not visible
  - Re-open dropdown
  - Assert search input is empty (search was cleared)

- [x] **"search resets when branch is selected by click"**
  - Open dropdown, type "dev"
  - Click the matching branch item
  - Re-open dropdown
  - Assert search input is empty

---

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Search input + filtering in RepoDetail.svelte | Complete | Frontend-only, no backend changes |
| 2. E2E tests for branch search | Complete | 7 tests added to existing describe block |
