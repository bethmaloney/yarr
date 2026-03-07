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

**D. Replace emojis with CSS icons** — Colored dots or short text labels instead of emoji (which render as boxes on some systems). Pure CSS.

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
- [ ] Create `src/types.ts` with all shared types
- [ ] Update `App.svelte` — remove local types, add import
- [ ] Update `HomeView.svelte` — remove local types, add import
- [ ] Update `RepoDetail.svelte` — remove local types, add import
- [ ] Update `RunDetail.svelte` — remove local types, add import
- [ ] Update `EventsList.svelte` — remove local types, add import
- [ ] Update `HistoryView.svelte` — remove local types, add import
- [ ] Verify: `npx tsc --noEmit`

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
- [ ] Create `Breadcrumbs.svelte`
- [ ] Integrate into `HomeView.svelte`
- [ ] Integrate into `RepoDetail.svelte`
- [ ] Integrate into `HistoryView.svelte`
- [ ] Integrate into `RunDetail.svelte`
- [ ] Remove old `.back-btn` styles from all views
- [ ] Verify: `npx tsc --noEmit`

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
- [ ] Wrap settings in `<details>` element with summary line
- [ ] Style the `<details>` / `<summary>` to match existing dark theme
- [ ] Remove recents dropdown, state, and `loadRecents` import
- [ ] Rename "Mock" to "Test Run"
- [ ] Add conditional hint text below Run button
- [ ] Verify: `npx tsc --noEmit`

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
- [ ] Add `read_file_preview` command function
- [ ] Register in Tauri command list
- [ ] Verify: `cd src-tauri && cargo check`

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
- [ ] Add preview state and `$effect` to fetch preview on planFile change
- [ ] Render preview `<pre>` block below the plan input row
- [ ] Style preview box to match dark theme
- [ ] Verify: `npx tsc --noEmit`

---

### Task 6: Home page — toolbar alignment

Move title and buttons onto the same row.

**Files to modify:**
- `src/HomeView.svelte`

**Details:**
- Wrap header + toolbar in a single flex container: title/subtitle left, buttons right, `align-items: baseline`
- Remove separate `<header>` and `.toolbar` divs, merge into one

**Checklist:**
- [ ] Restructure HTML to single header row
- [ ] Update CSS for flex layout
- [ ] Verify visual alignment with Playwright screenshot
- [ ] Verify: `npx tsc --noEmit`

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
- [ ] Add `list_latest_traces` command function
- [ ] Register in Tauri command list
- [ ] Verify: `cd src-tauri && cargo check`

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
- [ ] Add `list_latest_traces` call in `App.svelte` onMount
- [ ] Pass latest traces map through to `HomeView` and `RepoCard`
- [ ] Add `lastTrace` optional prop to `RepoCard`
- [ ] Render last run summary line with plan, cost, time ago
- [ ] Add relative time helper
- [ ] Verify: `npx tsc --noEmit`

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
- [ ] Add header row HTML
- [ ] Style to match trace row widths
- [ ] Verify: `npx tsc --noEmit`

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
- [ ] Add prompt span to trace rows
- [ ] Style with ellipsis overflow
- [ ] Verify: `npx tsc --noEmit`

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
- [ ] Add sort state variables
- [ ] Make header labels clickable buttons
- [ ] Add `$derived` sorted traces computation
- [ ] Render sort direction arrow on active column
- [ ] Style header buttons (no visible button chrome, just cursor pointer)
- [ ] Verify: `npx tsc --noEmit`

---

### Task 12: Run Detail — replace emojis with CSS icons

Replace emoji indicators with styled CSS elements.

**Files to modify:**
- `src/EventsList.svelte`

**Details:**
- Replace `eventEmoji()` with a function returning `{ symbol: string, color: string }`
- Symbols: session_started="S", iteration_started="I", tool_use="T", assistant_text=">", iteration_complete="ok", session_complete="fin"
- Render as small inline badge: colored background circle/pill with the letter
- Remove the `.event-emoji` font-family override

**Checklist:**
- [ ] Replace `eventEmoji()` with `eventIcon()` returning symbol + color
- [ ] Update template to render CSS badge instead of emoji span
- [ ] Add badge styles (small pill, colored per event type)
- [ ] Remove emoji font-family style
- [ ] Verify visually with Playwright screenshot
- [ ] Verify: `npx tsc --noEmit`

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
| 1 | Extract shared types into `src/types.ts` | Not Started |
| 2 | Add Breadcrumbs component | Not Started |
| 3 | Repo Detail -- collapse Settings, remove recents, rename Mock | Not Started |
| 4 | Add `read_file_preview` Tauri command | Not Started |
| 5 | Repo Detail -- plan file preview | Not Started |
| 6 | Home page -- toolbar alignment | Not Started |
| 7 | Add `list_latest_traces` Tauri command | Not Started |
| 8 | Home page -- repo cards with last run summary | Not Started |
| 9 | History view -- column headers | Not Started |
| 10 | History view -- show prompt text | Not Started |
| 11 | History view -- sortable columns | Not Started |
| 12 | Run Detail -- replace emojis with CSS icons | Not Started |
| 13 | Run Detail -- session ID click-to-copy | Not Started |
| 14 | Run Detail -- collapsible iteration groups | Not Started |
| 15 | Run Detail -- context window progress bar | Not Started |
| 16 | Browser mock -- enrich sample data | Not Started |
| 17 | Update E2E tests | Not Started |
