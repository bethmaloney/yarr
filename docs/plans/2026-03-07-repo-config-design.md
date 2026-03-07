# Repo Config & Multi-Repo Support

**Date**: 2026-03-07
**Status**: Approved

## Overview

Add persistent repo configuration so users can register multiple repositories, each with its own settings. The home page displays all repos as cards; clicking one opens a detail view to configure and launch sessions. Multiple sessions can run concurrently across different repos.

## Data Model

A `RepoConfig` represents a saved repo:

```typescript
type RepoConfig = {
  id: string;              // UUID, generated on add
  path: string;            // absolute path, e.g. "/home/beth/repos/yarr"
  name: string;            // derived from path basename, e.g. "yarr"
  model: string;           // default "opus"
  maxIterations: number;   // default 40
  completionSignal: string; // default "ALL TODO ITEMS COMPLETE"
}
```

Stored via Tauri plugin-store in `repos.json` — a single key `"repos"` containing an array of `RepoConfig`. Config is managed entirely in the frontend; the backend receives values per invocation.

## UI Flow

### Home View
- Grid of repo cards, each showing name, path, and live status (idle / running / completed / failed)
- "Add repo" button opens native directory picker, creates a `RepoConfig` with defaults, saves to store
- Clicking a card navigates to the repo detail view

### Repo Detail View
- Back button to return home
- Repo name + path at top
- Settings section: editable fields for model, max iterations, completion signal (with Save)
- Plan file picker (input + browse + recents — same as today)
- Run / Mock buttons
- Events stream + result display, scoped to this repo

### Navigation
Simple Svelte state, no router library:
```typescript
let currentView: { kind: "home" } | { kind: "repo", repoId: string }
```

### Session State
A reactive map tracks running sessions, keyed by `repoId`:
```typescript
let sessions: Map<string, {
  running: boolean;
  events: SessionEvent[];
  trace: SessionTrace | null;
  error: string | null;
}>
```

The home view reads this map to show per-repo status indicators.

## Backend Changes

### `run_session` command

Accepts config values instead of hardcoding them:

```rust
async fn run_session(
    app: tauri::AppHandle,
    repo_id: String,
    repo_path: String,
    plan_file: String,
    model: String,
    max_iterations: u32,
    completion_signal: String,
) -> Result<SessionTrace, String>
```

### Event multiplexing

Events are wrapped with `repo_id` so the frontend routes them to the correct session:

```rust
#[derive(Serialize, Clone)]
struct TaggedSessionEvent {
    repo_id: String,
    event: SessionEvent,
}
```

`app_handle.emit("session-event", ...)` emits `TaggedSessionEvent` instead of bare `SessionEvent`.

### Concurrency

Multiple `run_session` calls run concurrently — Tauri dispatches them on separate async tasks. No mutex or semaphore needed; each session is independent.

## Component Structure

```
src/
  App.svelte          - view router (home vs repo detail)
  HomeView.svelte     - repo grid + add button
  RepoCard.svelte     - single card (name, path, status indicator)
  RepoDetail.svelte   - settings form, plan picker, run button, events stream
  EventsList.svelte   - extracted events stream + scroll logic
  repos.ts            - CRUD helpers (load/save/add/update/remove via plugin-store)
  recents.ts          - stays as-is
```

Session state map lives in `App.svelte`, passed down as props. No global store framework.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config storage | Tauri plugin-store | Already in use, simple, swappable later |
| Per-repo settings | model, maxIterations, completionSignal | Most impactful; other settings stay as defaults |
| Concurrent sessions | Yes | Core value prop of the tool |
| Run history | Latest run only | Traces saved to disk; history UI can layer on later |
| Add repo flow | Browse only, defaults applied | Minimal friction; edit settings from detail view |
| Navigation | Svelte state, no router | Simple enough for two views |

## Implementation Plan

### Task 1: `repos.ts` — RepoConfig type + CRUD helpers

Create the data layer for repo configuration, following the same pattern as `recents.ts`.

**Files to create:** `src/repos.ts`
**Pattern reference:** `src/recents.ts` — LazyStore usage, async get/set/save pattern

**Details:**
- Define `RepoConfig` type (id, path, name, model, maxIterations, completionSignal)
- Use `LazyStore("repos.json")` with a single `"repos"` key containing `RepoConfig[]`
- `loadRepos()` — returns the array (or empty)
- `addRepo(path: string)` — generates UUID via `crypto.randomUUID()`, derives name from path basename, applies defaults (model: "opus", maxIterations: 40, completionSignal: "ALL TODO ITEMS COMPLETE"), appends to array, saves
- `updateRepo(repo: RepoConfig)` — finds by id, replaces, saves
- `removeRepo(id: string)` — filters out by id, saves
- Export the `RepoConfig` type

**Checklist:**
- [x] Create `src/repos.ts` with type and all CRUD functions
- [x] Verify: `npx tsc --noEmit` passes

---

### Task 2: `repos.ts` tests

Unit tests for the repo CRUD helpers.

**Files to create:** `src/repos.test.ts`
**Pattern reference:** `src/recents.test.ts` — LazyStore mock pattern, `vi.hoisted` + `vi.mock`

**Details:**
- Mock `@tauri-apps/plugin-store` using the same `vi.hoisted` + `mockData` Map pattern
- Test `loadRepos` returns empty array when no data
- Test `addRepo` generates id, derives name from basename, applies defaults
- Test `addRepo` appends to existing repos
- Test `updateRepo` replaces matching repo by id
- Test `removeRepo` filters out by id
- Test `loadRepos` returns stored repos

**Checklist:**
- [x] Create `src/repos.test.ts` with tests for all CRUD functions
- [x] Verify: `npx vitest run` passes

---

### Task 3: Backend — parameterize `run_session` and tag events

Update `run_session` to accept config values and wrap events with `repo_id`.

**Files to modify:** `src-tauri/src/lib.rs`
**Pattern reference:** `src-tauri/src/lib.rs:39-83` — existing `run_session` command

**Details:**
- Add `repo_id: String` parameter to `run_session`
- Replace hardcoded `model: Some("opus")` with `model` parameter
- Replace hardcoded `max_iterations: 40` with `max_iterations` parameter
- Replace hardcoded `completion_signal` with `completion_signal` parameter
- Define `TaggedSessionEvent { repo_id: String, event: SessionEvent }` with `Serialize, Clone`
- Update the `on_event` closure to wrap events: `app_handle.emit("session-event", TaggedSessionEvent { repo_id, event })`
- Update `run_mock_session` similarly: add `repo_id: String` parameter, wrap events with tag

**Checklist:**
- [x] Add `TaggedSessionEvent` struct
- [x] Update `run_session` signature and body
- [x] Update `run_mock_session` signature and body
- [x] Verify: `cd src-tauri && cargo check` passes

---

### Task 4: `EventsList.svelte` — extract events component

Extract the events stream UI from `App.svelte` into a reusable component.

**Files to create:** `src/EventsList.svelte`
**Pattern reference:** `src/App.svelte:233-253` — events section markup; `src/App.svelte:125-171` — helper functions and scroll logic

**Details:**
- Props: `events: SessionEvent[]` (the array to display)
- Move into this component: `eventEmoji()`, `eventLabel()`, `formatTime()`, scroll logic (`autoScroll`, `eventsContainer`, `handleEventsScroll`, `jumpToBottom`), and all events markup + styles
- The parent passes `events` as a prop; scroll state is internal to this component
- Move only the events-related styles (`.events`, `.events-header`, `.events-scroll`, `.event`, `.event-emoji`, `.event-text`, `.event-time`, `.jump-bottom`, `ul`, plus the per-kind color classes)

**Checklist:**
- [x] Create `src/EventsList.svelte` with props, logic, markup, and styles
- [x] Verify: `npx tsc --noEmit` passes

---

### Task 5: `RepoCard.svelte` — single repo card

A card component for the home grid.

**Files to create:** `src/RepoCard.svelte`
**Pattern reference:** `src/App.svelte:280-566` — existing style conventions (colors, fonts, spacing)

**Details:**
- Props: `repo: RepoConfig`, `status: "idle" | "running" | "completed" | "failed"`, `onclick: () => void`
- Displays: repo name (large), repo path (small, muted), status dot/badge
- Status colors: idle=gray, running=yellow(pulsing), completed=green, failed=red
- Clickable card with hover effect
- Uses the project's existing color scheme (#1a1a2e background, #e8d44d accent, etc.)

**Checklist:**
- [ ] Create `src/RepoCard.svelte` with props, markup, and styles
- [ ] Verify: `npx tsc --noEmit` passes

---

### Task 6: `HomeView.svelte` — home page with repo grid

The main landing page showing all repos and an add button.

**Files to create:** `src/HomeView.svelte`
**Pattern reference:** `src/App.svelte:174-231` — layout patterns, form/button styles

**Details:**
- Props: `repos: RepoConfig[]`, `sessions: Map<string, SessionState>`, `onSelectRepo: (id: string) => void`, `onAddRepo: () => void`
- Renders header ("Yarr" + subtitle) at top
- "Add repo" button triggers `onAddRepo` (parent handles the directory picker + `addRepo()` call)
- Grid of `RepoCard` components, one per repo
- Derives status per card from `sessions` map (default "idle" if no entry)
- Empty state message when no repos configured

**Checklist:**
- [ ] Create `src/HomeView.svelte` with props, grid layout, and add button
- [ ] Verify: `npx tsc --noEmit` passes

---

### Task 7: `RepoDetail.svelte` — repo workspace view

The detail view for a single repo: settings, plan picker, run controls, events.

**Files to create:** `src/RepoDetail.svelte`
**Pattern reference:** `src/App.svelte:178-277` — form layout, input styles, result display

**Details:**
- Props: `repo: RepoConfig`, `session: { running, events, trace, error }`, `onBack: () => void`, `onRun: (planFile: string) => void`, `onMockRun: () => void`, `onUpdateRepo: (repo: RepoConfig) => void`
- Back button at top
- Repo name + path header
- Settings section: inputs for model, maxIterations, completionSignal bound to local state, "Save" button calls `onUpdateRepo`
- Plan file picker: input + browse + recents dropdown (reuse existing pattern from App.svelte)
- Run / Mock buttons (disabled when `session.running`)
- `EventsList` component, passing `session.events`
- Error and trace/result display sections (same markup as current App.svelte)
- Reuses styles from current App.svelte (inputs, buttons, dl/dt/dd, error pre)

**Checklist:**
- [ ] Create `src/RepoDetail.svelte` with all sections
- [ ] Verify: `npx tsc --noEmit` passes

---

### Task 8: `App.svelte` refactor — view router + session state

Rewrite App.svelte as the orchestrator: view routing, session state map, event listener, invoke calls.

**Files to modify:** `src/App.svelte`
**Pattern reference:** `src/App.svelte` (current file — rewrite in place)

**Details:**
- State: `currentView` (`{kind:"home"}` or `{kind:"repo", repoId}`), `repos: RepoConfig[]`, `sessions: Map<string, {running, events, trace, error}>`
- `onMount`: load repos via `loadRepos()`, set up `listen("session-event")` that reads `repo_id` from `TaggedSessionEvent` payload and routes to the correct session entry
- `addRepo()`: open directory picker, call `addRepo()` from repos.ts, refresh repos list
- `selectRepo(id)`: set `currentView = {kind:"repo", repoId: id}`
- `goHome()`: set `currentView = {kind:"home"}`
- `runSession(repoId, planFile)`: initialize session entry (running=true, events=[], etc.), call `invoke("run_session", { repoId, repoPath, planFile, model, maxIterations, completionSignal })`, on completion set trace/error/running=false, save recents
- `runMockSession(repoId)`: same pattern with `invoke("run_mock_session", { repoId })`
- `updateRepo(repo)`: call `updateRepo()` from repos.ts, refresh repos list
- Template: conditional render `HomeView` or `RepoDetail` based on `currentView.kind`
- Remove all old markup, styles, and logic that moved to child components
- Keep only global styles (body, main container)

**Checklist:**
- [ ] Rewrite `src/App.svelte` as view router with session state management
- [ ] Verify: `npx tsc --noEmit` passes

---

### Task 9: Integration verification

Verify everything compiles and works together.

**Files:** none (verification only)

**Checklist:**
- [ ] `npx tsc --noEmit` passes (frontend types)
- [ ] `cd src-tauri && cargo check` passes (backend)
- [ ] `npx vitest run` passes (tests)
- [ ] `npx tauri dev` launches, shows home view, can add a repo, navigate to detail, and run a mock session

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | `repos.ts` — RepoConfig type + CRUD helpers | Done |
| 2 | `repos.test.ts` — unit tests for CRUD | Done |
| 3 | Backend — parameterize `run_session`, tag events | Done |
| 4 | `EventsList.svelte` — extract events component | Done |
| 5 | `RepoCard.svelte` — single repo card | Not Started |
| 6 | `HomeView.svelte` — home page with repo grid | Not Started |
| 7 | `RepoDetail.svelte` — repo workspace view | Not Started |
| 8 | `App.svelte` refactor — view router + session state | Not Started |
| 9 | Integration verification | Not Started |

## Out of Scope (for now)

- Run history / trace browser
- Repo-local config files (`.yarr.json`)
- Global rate limit semaphore across sessions
- Delete/reorder repos
- Per-repo plan file recents (currently global)
