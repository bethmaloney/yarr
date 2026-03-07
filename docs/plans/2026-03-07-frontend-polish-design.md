# Frontend Polish — Design

Comprehensive UI improvements across all views: code health, run page workflow, home dashboard, history usability, run detail iteration grouping, and breadcrumb navigation.

## 1. Code Health — Extract Shared Types

**New file: `src/types.ts`**

Single source of truth for all shared frontend types:
- `SessionEvent`, `SessionTrace`, `SessionState`, `RepoStatus`, `TaggedSessionEvent`

All components (`App.svelte`, `HomeView`, `RepoDetail`, `RunDetail`, `EventsList`, `HistoryView`) import from `types.ts` instead of redeclaring locally.

Pure refactor — no behavior changes.

## 2. Repo Detail Page (Run Page)

**A. Collapse Settings** — Wrap Settings section in a native `<details>` element, closed by default. `<summary>` shows "Settings — opus, 40 iters" (one-line summary of current config). Plan + Run move up as primary content.

**B. Disabled Run button hint** — When `planFile` is empty, show a small hint span below the actions row: "Select a prompt file to start a run". Disappears once a file is selected.

**C. Prompt file preview** — After a planFile is selected, show a read-only preview box (first 5 lines, grayed monospace). New Tauri command `read_file_preview` returns first N lines. Browser-mock returns stub content.

**D. Rename Mock to "Test Run"** — Label change.

**E. Remove recents dropdown** — Remove the `<select>` for recent prompt files and the `loadRecents()` call.

## 3. Home Page Dashboard

**A. Repo cards show last run summary** — Second row on each card: plan filename, cost, time ago (e.g. "fix-login.md . $0.45 . 2h ago"). New Tauri command `list_latest_traces` returns one trace per repo. Browser-mock wires up sample data.

**B. Toolbar alignment** — Title and buttons on the same flex row. Title left, buttons right.

## 4. History View

**A. Column headers** — Header row above trace list: Date, Plan, Prompt, Status, Iters, Cost, Duration. Same flex layout as trace rows, muted uppercase labels.

**B. Show prompt text** — Truncated prompt column between Plan and Status. Uses existing `trace.prompt`. Ellipsis-overflow, max ~20rem.

**C. Sortable columns** — Click header to sort. Default: date descending. Arrow indicator on active column. Local `sortField` + `sortDir` state, `$derived` sorted array.

## 5. Run Detail Page

**A. Iteration grouping** — Replace flat event list with collapsible iteration sections. Header: "Iteration 2 — 4 events . $0.18 . 12,500 in / 3,200 out . 30s". Completed runs: all collapsed. Live runs: latest expanded. New `IterationGroup.svelte` component.

**B. Context window indicator** — Progress bar in iteration header: `input_tokens / context_window`. From `modelUsage` in iteration_complete result. Green <50%, yellow 50-80%, red >80%.

**C. Session ID click-to-copy** — Copy button next to session ID. `navigator.clipboard.writeText()`.

## 6. Breadcrumb Navigation

**New component: `Breadcrumbs.svelte`** — Takes `{ label: string, onclick?: () => void }[]`. Renders "Home / my-project / History / Run sess-abc" with clickable segments. Last segment is non-clickable (current page).

Each view builds its breadcrumb array:
- HomeView: `[Home]`
- RepoDetail: `[Home, {repo.name}]`
- HistoryView: `[Home, {repo.name}?, History]`
- RunDetail: `[Home, History, Run {sessionId}]`

Existing `onBack` / `goHome` / `goHistory` callbacks used for click handlers.

## 7. Browser Mock Updates

**A. Enrich iteration_complete events** — Add `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `context_window`, `model_token_usage` to each iteration_complete result. Realistic values showing context growing.

**B. `read_file_preview` handler** — Return stub markdown (3-5 lines).

**C. `list_latest_traces` handler** — Return most recent trace per repo.

**D. Remove recents from store** — Drop `"recents"` entry.

**E. E2E fixtures** — Same updates to `e2e/fixtures.ts` default handlers.

---

## Implementation Plan

### Task 1: Extract shared types into `src/types.ts`

Create `src/types.ts` with all shared type definitions. Update all components to import from it.

**Files to create:**
- `src/types.ts`

**Files to modify:**
- `src/App.svelte`
- `src/HomeView.svelte`
- `src/RepoDetail.svelte`
- `src/RunDetail.svelte`
- `src/EventsList.svelte`
- `src/HistoryView.svelte`

**Pattern reference:** `src/repos.ts` (existing shared module with types + functions)

**Details:**
- Types to extract: `SessionEvent`, `SessionTrace` (both the lightweight App.svelte version and the full RunDetail version), `SessionState`, `RepoStatus`, `TaggedSessionEvent`
- The `SessionTrace` type differs between App.svelte (lightweight) and RunDetail/HistoryView (full with token counts). Use the full version as the canonical type — the lightweight fields are a subset.
- Keep `RepoConfig` in `repos.ts` where it already lives

**Checklist:**
- [x] Create `src/types.ts` with all shared types
- [x] Update `App.svelte` — remove local types, add import
- [x] Update `HomeView.svelte` — remove local types, add import
- [x] Update `RepoDetail.svelte` — remove local types, add import
- [x] Update `RunDetail.svelte` — remove local types, add import
- [x] Update `EventsList.svelte` — remove local types, add import
- [x] Update `HistoryView.svelte` — remove local types, add import
- [x] Verify: `npx tsc --noEmit`

---

### Task 2: Add Breadcrumbs component

Create `Breadcrumbs.svelte` and integrate into all views, replacing standalone Back buttons.

**Files to create:**
- `src/Breadcrumbs.svelte`

**Files to modify:**
- `src/HomeView.svelte`
- `src/RepoDetail.svelte`
- `src/HistoryView.svelte`
- `src/RunDetail.svelte`

**Pattern reference:** `src/RepoCard.svelte` (small component with props, scoped styles)

**Details:**
- Props: `crumbs: { label: string, onclick?: () => void }[]`
- Render as horizontal flex row, segments separated by " / " text
- All segments clickable except the last (current page)
- Styled: small font, muted color, monospace for session IDs
- Remove existing `.back-btn` buttons and their styles from each view
- Each view passes its own crumbs array, using existing navigation callbacks

**Checklist:**
- [x] Create `Breadcrumbs.svelte`
- [x] Integrate into `HomeView.svelte`
- [x] Integrate into `RepoDetail.svelte`
- [x] Integrate into `HistoryView.svelte`
- [x] Integrate into `RunDetail.svelte`
- [x] Remove old `.back-btn` styles from all views
- [x] Verify: `npx tsc --noEmit`

---

### Task 3: Repo Detail — collapse Settings, remove recents, rename Mock

Restructure the repo detail page to prioritize the Plan + Run workflow.

**Files to modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** `src/RepoDetail.svelte` (modifying in-place)

**Details:**
- Wrap settings section in `<details><summary>Settings -- {model}, {maxIterations} iters</summary>...</details>`
- Remove the `<select>` recents dropdown and the `recentPromptFiles` state + `loadRecents()` import/call
- Rename "Mock" button label to "Test Run"
- Add hint text below actions: "Select a prompt file to start a run" — only visible when `planFile` is empty and not running

**Checklist:**
- [x] Wrap settings in `<details>` element with summary line
- [x] Style the `<details>` / `<summary>` to match existing dark theme
- [x] Remove recents dropdown, state, and `loadRecents` import
- [x] Rename "Mock" to "Test Run"
- [x] Add conditional hint text below Run button
- [x] Verify: `npx tsc --noEmit`

---

### Task 4: Add `read_file_preview` Tauri command

Backend command to read first N lines of a file for the plan preview.

**Files to modify:**
- `src-tauri/src/main.rs` (or wherever commands are registered)

**Pattern reference:** `src-tauri/src/main.rs` — existing command registration pattern

**Details:**
- Command: `read_file_preview(path: String, max_lines: Option<u32>) -> Result<String, String>`
- Default `max_lines` to 5
- Read the file, take first N lines, return as string
- Return error if file doesn't exist or isn't readable

**Checklist:**
- [x] Add `read_file_preview` command function
- [x] Register in Tauri command list
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 5: Repo Detail — plan file preview

Show a preview of the selected plan file below the file input.

**Files to modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** `src/RunDetail.svelte` (async data loading with loading/error states)

**Details:**
- When `planFile` changes (and is non-empty), call `invoke("read_file_preview", { path: planFile })`
- Show result in a `<pre>` box: read-only, monospace, muted color, max 5 lines, background `#12122a`
- Show "Loading..." while fetching, show nothing if planFile is empty
- Debounce or use `$effect` to react to planFile changes

**Checklist:**
- [x] Add preview state and `$effect` to fetch preview on planFile change
- [x] Render preview `<pre>` block below the plan input row
- [x] Style preview box to match dark theme
- [x] Verify: `npx tsc --noEmit`

---

### Task 6: Home page — toolbar alignment

Move title and buttons onto the same row.

**Files to modify:**
- `src/HomeView.svelte`

**Details:**
- Wrap header + toolbar in a single flex container: title/subtitle left, buttons right, `align-items: baseline`
- Remove separate `<header>` and `.toolbar` divs, merge into one

**Checklist:**
- [x] Restructure HTML to single header row
- [x] Update CSS for flex layout
- [x] Verify visual alignment with Playwright screenshot
- [x] Verify: `npx tsc --noEmit`

---

### Task 7: Add `list_latest_traces` Tauri command

Backend command to return the most recent trace per repo.

**Files to modify:**
- `src-tauri/src/main.rs` (or wherever commands are registered)

**Pattern reference:** Existing `list_traces` command

**Details:**
- Command: `list_latest_traces() -> Result<Vec<SessionTrace>, String>`
- Read all traces across all repo dirs, group by repo_id, take the one with the latest `start_time` per group
- Return as a vec

**Checklist:**
- [x] Add `list_latest_traces` command function
- [x] Register in Tauri command list
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 8: Home page — repo cards with last run summary

Show last run info on each repo card.

**Files to modify:**
- `src/App.svelte`
- `src/HomeView.svelte`
- `src/RepoCard.svelte`

**Pattern reference:** `src/RepoCard.svelte` (extending existing component)

**Details:**
- `App.svelte`: on mount, call `list_latest_traces()`, store as `Map<string, SessionTrace>`
- Pass `latestTrace` prop to `HomeView`, which passes per-repo trace to `RepoCard`
- `RepoCard` shows second line: plan filename, cost, relative time ("2h ago")
- Relative time: simple helper function (minutes/hours/days ago)
- If no trace exists for a repo, show nothing extra

**Checklist:**
- [x] Add `list_latest_traces` call in `App.svelte` onMount
- [x] Pass latest traces map through to `HomeView` and `RepoCard`
- [x] Add `lastTrace` optional prop to `RepoCard`
- [x] Render last run summary line with plan, cost, time ago
- [x] Add relative time helper
- [x] Verify: `npx tsc --noEmit`

---

### Task 9: History view — column headers

Add a header row to the trace list.

**Files to modify:**
- `src/HistoryView.svelte`

**Details:**
- Add a `.trace-header` div above `.trace-list` with same flex layout as `.trace-row`
- Labels: Date, Plan, Prompt, Status, Iters, Cost, Duration
- Styled: muted uppercase, small font, matching existing `h2` section header style
- Same `min-width` / `flex` values as the corresponding trace-row spans

**Checklist:**
- [x] Add header row HTML
- [x] Style to match trace row widths
- [x] Verify: `npx tsc --noEmit`

---

### Task 10: History view — show prompt text

Add truncated prompt column to history rows.

**Files to modify:**
- `src/HistoryView.svelte`

**Details:**
- Add `.trace-prompt` span between plan and badge in each `.trace-row`
- Shows `trace.prompt`, truncated with ellipsis, `max-width: 20rem`
- Also add "Prompt" to the column headers from Task 9

**Checklist:**
- [x] Add prompt span to trace rows
- [x] Style with ellipsis overflow
- [x] Verify: `npx tsc --noEmit`

---

### Task 11: History view — sortable columns

Make column headers clickable for sorting.

**Files to modify:**
- `src/HistoryView.svelte`

**Details:**
- Add state: `sortField: string = "start_time"`, `sortDir: "asc" | "desc" = "desc"`
- Header labels become `<button>` elements, clicking toggles sort
- Use `$derived` to produce `sortedTraces` from `traces`
- Sort fields: start_time, plan_file, prompt, outcome, total_iterations, total_cost_usd, duration (computed)
- Arrow indicator: up/down unicode arrow next to active column

**Checklist:**
- [x] Add sort state variables
- [x] Make header labels clickable buttons
- [x] Add `$derived` sorted traces computation
- [x] Render sort direction arrow on active column
- [x] Style header buttons (no visible button chrome, just cursor pointer)
- [x] Verify: `npx tsc --noEmit`

---

### Task 13: Run Detail — session ID click-to-copy

Add a copy button next to the session ID.

**Files to modify:**
- `src/RunDetail.svelte`

**Details:**
- Add a small "Copy" button next to the session ID `<dd>`
- On click: `navigator.clipboard.writeText(trace.session_id)`
- Brief visual feedback: button text changes to "Copied!" for 1.5 seconds
- Style: small, inline, secondary button style

**Checklist:**
- [ ] Add copy button next to session ID
- [ ] Implement clipboard write with feedback state
- [ ] Style button inline with the dd element
- [ ] Verify: `npx tsc --noEmit`

---

### Task 14: Run Detail — collapsible iteration groups

Refactor EventsList to group events by iteration with collapsible sections.

**Files to create:**
- `src/IterationGroup.svelte`

**Files to modify:**
- `src/EventsList.svelte`

**Pattern reference:** `src/EventsList.svelte` (existing expand/collapse pattern for individual events)

**Details:**
- `EventsList` groups events by iteration number (events between `iteration_started` and the next `iteration_started` or `session_complete`)
- Events without an iteration (session_started, session_complete) render as standalone rows
- Each iteration group rendered via `IterationGroup.svelte`
- `IterationGroup` props: `iteration: number`, `events: SessionEvent[]`, `expanded: boolean`, `onToggle: () => void`
- Header shows: "Iteration {n} -- {events.length} events . ${cost} . {in_tokens} in / {out_tokens} out . {duration}"
- Token/cost info extracted from the `iteration_complete` event's `result` field
- Expanded state managed in `EventsList` — map of `iteration -> boolean`
- Default: all collapsed for historical views, latest expanded for live

**Checklist:**
- [ ] Create `IterationGroup.svelte` with header + collapsible event list
- [ ] Refactor `EventsList.svelte` to group events by iteration
- [ ] Render standalone events (session_started, session_complete) outside groups
- [ ] Manage expanded state per iteration
- [ ] Style iteration header: bold, with summary stats
- [ ] Verify: `npx tsc --noEmit`

---

### Task 15: Run Detail — context window progress bar

Add context window usage indicator to iteration group headers.

**Files to modify:**
- `src/IterationGroup.svelte`

**Details:**
- Extract `context_window` and `input_tokens` from `iteration_complete` event's `result.model_token_usage` or `result.usage`
- Render a thin progress bar (4px height) below the iteration header text
- Width = `(input_tokens / context_window) * 100%`
- Color: green (`#34d399`) <50%, yellow (`#fbbf24`) 50-80%, red (`#f87171`) >80%
- Text label right-aligned: "62k / 200k (31%)"
- If no context_window data available, hide the bar

**Checklist:**
- [ ] Extract token usage from iteration_complete result
- [ ] Render progress bar with percentage width
- [ ] Apply color thresholds
- [ ] Add text label
- [ ] Handle missing data gracefully
- [ ] Verify: `npx tsc --noEmit`

---

### Task 16: Browser mock — enrich sample data

Update browser-mock and E2E fixtures with data needed for new features.

**Files to modify:**
- `src/browser-mock.ts`
- `e2e/fixtures.ts`

**Pattern reference:** `src/browser-mock.ts` (existing sample data patterns)

**Details:**
- Enrich `iteration_complete` events with `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `model_token_usage` (including `context_window: 200000`)
- Show context growing: iter 1 ~30k, iter 2 ~60k, iter 3 ~90k tokens
- Add `read_file_preview` handler returning stub markdown
- Add `list_latest_traces` handler returning most recent trace per repo
- Remove `"recents"` from mock store data
- Add `prompt` field display to trace rows (already in SAMPLE_TRACES)
- Mirror changes in `e2e/fixtures.ts` default handlers

**Checklist:**
- [ ] Enrich iteration_complete events with token data
- [ ] Add `read_file_preview` invoke handler
- [ ] Add `list_latest_traces` invoke handler
- [ ] Remove recents from store
- [ ] Update `e2e/fixtures.ts` with same handlers
- [ ] Verify: `npx tsc --noEmit`

---

### Task 17: Update E2E tests

Update existing E2E tests for the new UI structure and add coverage for new features.

**Files to modify:**
- `e2e/home.test.ts`

**Pattern reference:** `e2e/home.test.ts` (existing test patterns)

**Details:**
- Update selectors: Back buttons replaced by breadcrumbs
- Add test: home page shows last run summary on repo cards
- Add test: repo detail settings collapsed by default
- Add test: history view has column headers
- Add test: run detail shows iteration groups
- Existing tests should still pass with selector updates

**Checklist:**
- [ ] Update existing tests for breadcrumb navigation
- [ ] Add home page last run summary test
- [ ] Add settings accordion test
- [ ] Add history column headers test
- [ ] Add iteration grouping test
- [ ] Verify: `npm run test:e2e`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Extract shared types into `src/types.ts` | Done |
| 2 | Add Breadcrumbs component | Done |
| 3 | Repo Detail -- collapse Settings, remove recents, rename Mock | Done |
| 4 | Add `read_file_preview` Tauri command | Done |
| 5 | Repo Detail -- plan file preview | Done |
| 6 | Home page -- toolbar alignment | Done |
| 7 | Add `list_latest_traces` Tauri command | Done |
| 8 | Home page -- repo cards with last run summary | Done |
| 9 | History view -- column headers | Done |
| 10 | History view -- show prompt text | Done |
| 11 | History view -- sortable columns | Done |
| 13 | Run Detail -- session ID click-to-copy | Not Started |
| 14 | Run Detail -- collapsible iteration groups | Not Started |
| 15 | Run Detail -- context window progress bar | Not Started |
| 16 | Browser mock -- enrich sample data | Not Started |
| 17 | Update E2E tests | Not Started |
