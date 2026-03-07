# Run History — Design

Review prior session runs with full event replay. Traces and events are persisted to disk, browsable from both a global history view and per-repo history.

## Storage

All traces live in the Tauri app data directory, organized by repo ID:

```
~/.local/share/yarr/
  traces/
    <repo-id>/
      trace_<session-id>.json      # SessionTrace summary
      events_<session-id>.json     # Vec<SessionEvent> stream
```

`TraceCollector` changes:
- `output_dir` becomes repo-scoped: `app_data_dir/traces/{repo_id}`
- Writes both `trace_*.json` and `events_*.json` at finalize time
- Accepts the Tauri `app_data_dir` as its base path

`SessionTrace` gains: `plan_file: Option<String>` — set from the `plan_file` arg on real runs, `None` for mock runs.

## Event Persistence

`SessionRunner::run()` accumulates a `Vec<SessionEvent>` as events flow through. Every `self.emit(event)` also pushes to this vec. At finalize, the vec is passed to `TraceCollector::finalize()` which writes `events_<session-id>.json`.

`SessionEvent` and its contained types (`ResultEvent`, etc.) need `Deserialize` added alongside existing `Serialize`.

## Backend Commands

Three new Tauri commands:

- **`list_traces(repo_id: Option<String>) -> Vec<SessionTrace>`** — reads `trace_*.json` files. If `repo_id` is `Some`, scoped to that repo dir. If `None`, reads across all repo subdirs. Sorted by `start_time` descending.
- **`get_trace(repo_id: String, session_id: String) -> SessionTrace`** — reads a single trace summary.
- **`get_trace_events(repo_id: String, session_id: String) -> Vec<SessionEvent>`** — reads the events file for replay.

## Frontend Navigation

Extends the existing `currentView` discriminator in App.svelte:

```ts
type View =
  | { kind: "home" }
  | { kind: "repo"; repoId: string }
  | { kind: "history"; repoId?: string }
  | { kind: "run"; repoId: string; sessionId: string }
```

## Frontend Views

### HomeView changes
- Add a "History" button that navigates to `{ kind: "history" }`

### RepoDetail changes
- Add a "History" button that navigates to `{ kind: "history", repoId: repo.id }`

### New: HistoryView.svelte
- Calls `list_traces(repoId)` on mount
- Renders rows: date, repo name/folder (global mode only), plan filename, outcome badge, iteration count, cost, duration
- Click row -> `{ kind: "run", repoId, sessionId }`
- Back button -> previous view

### New: RunDetail.svelte
- Calls `get_trace()` and `get_trace_events()` on mount
- Header: date, repo name, plan file, outcome, cost, iterations, duration
- Body: reuses existing `EventsList` component with loaded events
- Back button -> history view

---

## Implementation Plan

### Task 1: Add `plan_file` to SessionTrace and Deserialize to event types

Add `plan_file: Option<String>` to `SessionTrace`. Add `Deserialize` to `SessionEvent`, `SessionOutcome`, and any types that need it for reading traces back from disk.

**Files to modify:**
- `src-tauri/src/trace.rs`
- `src-tauri/src/session.rs`
- `src-tauri/src/output.rs`

**Pattern reference:** `src-tauri/src/output.rs:135` — `ResultEvent` already derives both `Serialize` and `Deserialize`

**Details:**
- `SessionTrace`: add `pub plan_file: Option<String>`, add `Deserialize` derive
- `SessionOutcome`: add `Deserialize` derive (already has `Serialize`)
- `SessionEvent`: add `Deserialize` derive (currently only `Serialize`)
- `IterationSpan`, `SpanAttributes`, `SpanStatus`: add `Deserialize` derive (needed for `SessionTrace` deserialization)
- `TokenUsage`, `ModelTokenUsage`: check if they already have `Deserialize`, add if missing
- Update `TraceCollector::start_session()` to accept `plan_file: Option<&str>` and set it on the trace

**Checklist:**
- [x] Add `plan_file: Option<String>` to `SessionTrace`
- [x] Add `Deserialize` to `SessionTrace`, `IterationSpan`, `SpanAttributes`, `SpanStatus`, `SessionOutcome`
- [x] Add `Deserialize` to `SessionEvent`
- [x] Add `Deserialize` to any output.rs types missing it (`TokenUsage`, `ModelTokenUsage`)
- [x] Update `start_session()` signature to accept plan_file
- [x] Update call sites in `lib.rs` to pass plan_file
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 2: Update TraceCollector to use app data dir and write events

Change `TraceCollector` to write to `app_data_dir/traces/{repo_id}/` and write both trace + events files at finalize time.

**Files to modify:**
- `src-tauri/src/trace.rs`
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/trace.rs:143` — existing `finalize()` method

**Details:**
- Change `TraceCollector::new()` to accept a base dir (app data dir) and repo_id
- `output_dir` becomes `base_dir/traces/{repo_id}/`
- Update `finalize()` to also accept `&[SessionEvent]` and write `events_{session_id}.json`
- Use `session_id` (not the truncated prefix) in filenames for reliable lookup: `trace_{session_id}.json`, `events_{session_id}.json`
- Add `list_traces()` method: reads all `trace_*.json` in a dir, deserializes, returns sorted vec
- Add `list_all_traces()` method: iterates repo subdirs, collects all traces
- Add `read_trace()` and `read_events()` methods for single-item lookup
- Update `TraceCollector::new()` call sites in `lib.rs` to pass `app.path().app_data_dir()`

**Checklist:**
- [x] Refactor `TraceCollector::new()` to accept base_dir + repo_id
- [x] Update filename format to use full session_id
- [x] Update `finalize()` to write events file alongside trace
- [x] Add `list_traces()`, `list_all_traces()`, `read_trace()`, `read_events()` methods
- [x] Update call sites in `lib.rs`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 3: Accumulate events in SessionRunner

Have `SessionRunner::run()` collect all emitted events into a vec and return them alongside the trace.

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `src-tauri/src/session.rs:93` — existing `emit()` method

**Details:**
- Add `events: Vec<SessionEvent>` to the `run()` method's local state
- In `emit()`, clone the event and push to the vec (emit already takes owned `SessionEvent`)
- Change `run()` return type to `Result<(SessionTrace, Vec<SessionEvent>)>` or pass events to collector
- Pass accumulated events to `collector.finalize()` so it writes the events file
- Update call sites in `lib.rs` to handle the new return

**Checklist:**
- [x] Add events vec in `run()`
- [x] Push events in `emit()` (refactor emit to also accumulate)
- [x] Pass events to `collector.finalize()`
- [x] Update `lib.rs` call sites for new finalize signature
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 4: Add Tauri commands for listing and reading traces

Add `list_traces`, `get_trace`, and `get_trace_events` Tauri commands.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs:29` — existing `run_mock_session` command structure

**Details:**
- `list_traces(app, repo_id: Option<String>)`: instantiate `TraceCollector` with app data dir, call `list_traces()` or `list_all_traces()`
- `get_trace(app, repo_id, session_id)`: call `read_trace()`
- `get_trace_events(app, repo_id, session_id)`: call `read_events()`
- Register all three in `invoke_handler`
- Use `app.path().app_data_dir()` to resolve the base path

**Checklist:**
- [x] Add `list_traces` command
- [x] Add `get_trace` command
- [x] Add `get_trace_events` command
- [x] Register in `generate_handler![]`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 5: Extend frontend navigation with new view types

Update `currentView` in App.svelte to support history and run detail views, add navigation functions.

**Files to modify:**
- `src/App.svelte`

**Pattern reference:** `src/App.svelte:41` — existing `currentView` state and `src/App.svelte:73` — view switching functions

**Details:**
- Expand `currentView` type to include `history` and `run` kinds
- Add `goHistory(repoId?: string)` and `goRun(repoId, sessionId)` navigation functions
- Add conditional rendering blocks for the new view kinds
- Pass navigation callbacks to child components

**Checklist:**
- [x] Update `currentView` type union
- [x] Add navigation functions
- [x] Add `{:else if}` blocks for history and run views
- [x] Wire up props and callbacks to new components (placeholder imports for now)
- [x] Verify: `npx tsc --noEmit`

---

### Task 6: Add History button to HomeView

Add a "History" button to HomeView that navigates to global history.

**Files to modify:**
- `src/HomeView.svelte`

**Pattern reference:** `src/HomeView.svelte:32` — existing props and `src/HomeView.svelte:55` — toolbar layout

**Details:**
- Add `onHistory: () => void` prop
- Add "History" button in the toolbar next to "Add repo"
- Style consistently with existing secondary buttons

**Checklist:**
- [x] Add `onHistory` prop
- [x] Add History button in toolbar
- [x] Update App.svelte to pass `onHistory` callback
- [x] Verify: `npx tsc --noEmit`

---

### Task 7: Add History button to RepoDetail

Add a "History" button to RepoDetail that navigates to per-repo history.

**Files to modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** `src/RepoDetail.svelte:93` — header area with back button

**Details:**
- Add `onHistory: () => void` prop
- Add "History" button in the header area
- Style consistently with existing secondary buttons

**Checklist:**
- [x] Add `onHistory` prop
- [x] Add History button
- [x] Update App.svelte to pass `onHistory` callback
- [x] Verify: `npx tsc --noEmit`

---

### Task 8: Create HistoryView.svelte

New component that lists prior runs with summary info.

**Files to create:**
- `src/HistoryView.svelte`

**Pattern reference:** `src/RepoDetail.svelte:51` — onMount async loading pattern, `src/HomeView.svelte:49` — list layout with grid

**Details:**
- Props: `repoId: string | undefined`, `repos: RepoConfig[]`, `onBack: () => void`, `onSelectRun: (repoId: string, sessionId: string) => void`
- On mount, call `invoke<SessionTrace[]>("list_traces", { repoId })` to load traces
- Render header: "History" (global) or "History — {repoName}" (per-repo)
- Render list of rows, each showing: date, repo name (global only), plan filename, outcome badge, iteration count, cost, duration
- Click row calls `onSelectRun(trace.repo_id, trace.session_id)` — note: need `repo_id` on the trace for global mode, which is derivable from the directory structure
- Loading state while fetching
- Empty state if no runs
- Back button

**Checklist:**
- [x] Create component with props
- [x] Invoke `list_traces` on mount
- [x] Render run list with all summary fields
- [x] Handle loading and empty states
- [x] Wire click to `onSelectRun`
- [x] Style consistently with existing views
- [x] Verify: `npx tsc --noEmit`

---

### Task 9: Create RunDetail.svelte

New component that shows a single run's trace summary and replays events.

**Files to create:**
- `src/RunDetail.svelte`

**Pattern reference:** `src/RepoDetail.svelte:171` — trace summary rendering, `src/EventsList.svelte` — event list component

**Details:**
- Props: `repoId: string`, `sessionId: string`, `onBack: () => void`
- On mount, call `get_trace` and `get_trace_events` in parallel
- Header section: date, repo name, plan file, outcome badge, iteration count, cost, duration
- Body: pass loaded events to `EventsList`
- Loading state while fetching
- Error state if trace not found

**Checklist:**
- [x] Create component with props
- [x] Invoke `get_trace` and `get_trace_events` on mount
- [x] Render trace summary header
- [x] Render EventsList with loaded events
- [x] Handle loading and error states
- [x] Style consistently with existing views
- [x] Verify: `npx tsc --noEmit`

---

### Task 10: Tests for trace persistence and listing

Add Rust tests for the new TraceCollector methods and event serialization round-trip.

**Files to modify:**
- `src-tauri/src/trace.rs` (add test module)

**Pattern reference:** `src-tauri/src/lib.rs:154` — existing test module pattern

**Details:**
- Test `SessionEvent` round-trip: serialize to JSON, deserialize back, assert equality
- Test `TraceCollector::finalize()` writes both trace and events files
- Test `list_traces()` returns traces sorted by start_time desc
- Test `read_trace()` and `read_events()` return correct data
- Use `tempdir` for test output directories

**Checklist:**
- [ ] Add serde round-trip test for `SessionEvent`
- [ ] Add finalize test (writes both files)
- [ ] Add list_traces test (sorting)
- [ ] Add read_trace / read_events tests
- [ ] Verify: `cd src-tauri && cargo test`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add `plan_file` + Deserialize to trace/event types | Done |
| 2 | Update TraceCollector for app data dir + events file | Done |
| 3 | Accumulate events in SessionRunner | Done |
| 4 | Add Tauri commands for listing/reading traces | Done |
| 5 | Extend frontend navigation with new views | Done |
| 6 | Add History button to HomeView | Done |
| 7 | Add History button to RepoDetail | Done |
| 8 | Create HistoryView.svelte | Done |
| 9 | Create RunDetail.svelte | Done |
| 10 | Tests for trace persistence and listing | Not Started |
