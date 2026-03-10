# 1-Shot Redesign

## Overview

Fix the 1-shot feature and give each run its own identity. Currently 1-shots share the parent repo's session state (causing stale events, wrong iteration numbers), emit different events than Ralph loops (preventing expandable rows), and hide the prompt while running. This redesign makes 1-shots first-class entities with their own cards on the Home view, reuses the Ralph loop's `SessionRunner` for the implementation phase, and fixes all reported issues.

## Problems

1. **Incorrect iteration display** — `phase_output` events lack iteration numbers; `groupEventsByIteration` creates synthetic groups with wrong numbers
2. **Inherits previous run output** — Session state keyed by `repoId` is never cleared before a new 1-shot run
3. **Can't expand event rows** — 1-shot emits `PhaseOutput` instead of `ToolUse`/`AssistantText`/`IterationComplete`, so iteration grouping and expand logic don't apply
4. **No separate identity** — 1-shots share the parent repo's session slot; can't run multiple 1-shots or a 1-shot alongside a Ralph loop
5. **Prompt hidden while running** — Form conditionally hidden when `session.running` is true

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| 1-shot identity | Unique `oneshot_id` per run | Enables concurrent runs, separate cards, independent session state |
| Implementation phase | Reuse `SessionRunner` | Same mechanics as Ralph loop (iterations, completion signal, checks, git sync) — no duplication |
| Design phase | `SessionRunner` with `max_iterations: 1`, no completion signal | Design runs once; success = plan file exists in output |
| Event model | Remove `PhaseOutput`, emit real iteration events | Enables existing iteration grouping, expandable rows, cost tracking |
| Home view | 1-shot cards mixed with repo cards | Simple, unified view; visual badge distinguishes them |
| Retention | Active: always shown, completed: last 5, failed: until dismissed | Completed runs don't clutter; failures persist for investigation |
| Concurrency | Multiple 1-shots + Ralph loop can run simultaneously | Each keyed by unique ID in `ActiveSessions` |

## Backend Changes

### `session.rs` — Make `SessionRunner` Reusable

- Accept an optional `working_dir: PathBuf` override (for worktree path). When set, Claude runs in that directory instead of the repo path.
- Decouple trace lifecycle: add a mode where the caller manages `TraceCollector` start/finalize, so `OneShotRunner` can wrap two runner traces into one overall trace.
- No changes to event emission — `SessionRunner` already emits `IterationStarted`, `ToolUse`, `AssistantText`, `IterationComplete`, checks, and git sync events.

### `oneshot.rs` — Refactor to Use `SessionRunner`

**Remove:**
- `run_phase()` / `run_claude_phase()` methods (replaced by `SessionRunner` calls)
- `PhaseOutput` event variant
- Manual `StreamEvent` processing loop (now handled by `SessionRunner`)

**Add:**
- Generate unique `oneshot_id` (e.g. `oneshot-<6-char-uuid>`) at the start of each run
- `OneShotStarted` event gains `parent_repo_id` and `prompt` fields

**Revised flow:**
1. Generate `oneshot_id`
2. Create worktree + branch
3. Emit `OneShotStarted { parent_repo_id, title, prompt, merge_strategy }`
4. Emit `DesignPhaseStarted`
5. Run `SessionRunner` with: `max_iterations: 1`, `completion_signal: ""` (disabled), no checks, no git_sync, working dir = worktree path, design prompt
6. Check if plan file was produced (extract from tool_use events or text output). If not found → emit `OneShotFailed`, clean up, return.
7. Emit `DesignPhaseComplete { plan_file }`
8. Emit `ImplementationPhaseStarted`
9. Run `SessionRunner` with: full config from parent repo (max_iterations, completion_signal, checks, git_sync), working dir = worktree path, plan file as prompt
10. Emit `ImplementationPhaseComplete`
11. Git finalize (merge to main or push branch)
12. Emit `OneShotComplete` or `OneShotFailed`

### `lib.rs` — Updated `run_oneshot` Command

**Accepts additional parameters** (forwarded to implementation-phase `SessionRunner`):
- `max_iterations: u32`
- `completion_signal: String`
- `checks: Vec<Check>`
- `git_sync: Option<GitSyncConfig>`

**Returns** `oneshot_id: String` (in addition to `SessionTrace`).

**Keys `ActiveSessions` by `oneshot_id`** instead of `repo_id`. Events emitted with `TaggedSessionEvent { repo_id: oneshot_id, event }`.

### Events — Remove `PhaseOutput`

Delete `SessionEvent::PhaseOutput` variant. The design and implementation phases now emit standard iteration events (`IterationStarted`, `ToolUse`, `AssistantText`, `IterationComplete`) via their `SessionRunner` instances. The 1-shot lifecycle events remain as standalone markers:

- `OneShotStarted { title, parent_repo_id, prompt, merge_strategy }`
- `DesignPhaseStarted`
- `DesignPhaseComplete { plan_file }`
- `ImplementationPhaseStarted`
- `ImplementationPhaseComplete`
- `GitFinalizeStarted { strategy }`
- `GitFinalizeComplete`
- `OneShotComplete`
- `OneShotFailed { reason }`

## Frontend Changes

### `types.ts` — New `OneShotEntry` Type

```typescript
type OneShotEntry = {
  id: string;              // oneshot-<short_id>
  parentRepoId: string;
  parentRepoName: string;
  title: string;
  prompt: string;
  model: string;
  mergeStrategy: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
};
```

### `store.ts` — 1-Shot State Management

**New state:**
- `oneShotEntries: Map<string, OneShotEntry>` — keyed by oneshot ID

**New actions:**
- `runOneShot(repoId, title, prompt, model, mergeStrategy)` — creates `OneShotEntry`, calls `run_oneshot` Tauri command, stores `oneshot_id`
- `dismissOneShot(oneshotId)` — removes failed entry
- `loadOneShotEntries()` — loads from Tauri store on init
- `saveOneShotEntries()` — persists to Tauri store

**Event listener changes:**
- The existing `session-event` listener already handles events keyed by any string ID. Events keyed by `oneshot_id` naturally create separate `SessionState` entries in the `sessions` map — no listener changes needed.
- On `one_shot_complete` event: update corresponding `OneShotEntry.status` to `"completed"`, prune to keep last 5 completed (by `startedAt`)
- On `one_shot_failed` event: update corresponding `OneShotEntry.status` to `"failed"`

**Persistence:**
- `oneShotEntries` saved to Tauri store (`oneshot-entries` key)
- On app load: load entries, prune completed to last 5, reconcile `running` entries with `ActiveSessions`

### `App.tsx` — New Route

```tsx
<Route path="/oneshot/:oneshotId" element={<OneShotDetail />} />
```

The old `/repo/:repoId/oneshot` route is removed. 1-shot launching stays on `RepoDetail` page; on submit, navigate to `/oneshot/:oneshotId`.

### `pages/Home.tsx` — Mixed Cards

Render 1-shot cards alongside repo cards. Each `OneShotEntry` renders as a card with:
- "1-Shot" badge (small pill)
- Title
- Parent repo name in smaller text
- Phase status derived from session events
- Prompt text truncated to ~2 lines
- Timestamp
- Failed cards: dismiss/X button

Ordering: all cards sorted by status priority (running first) then by timestamp.

### `components/OneShotCard.tsx` — New Component

Similar to `RepoCard` but for 1-shot entries:
- Badge indicating "1-Shot"
- Title instead of repo name
- "from {parentRepoName}" subtitle
- Phase indicator instead of branch name
- Prompt preview (2-line truncation)
- Dismiss button for failed entries
- Click navigates to `/oneshot/:oneshotId`

### `pages/OneShot.tsx` → `pages/OneShotDetail.tsx` — Redesigned

**Two modes based on status:**

**Active (running):**
- Header: title, parent repo name, "1-Shot" badge
- Prompt displayed in a read-only block (always visible)
- Phase indicator bar (Design → Implementation → Finalizing)
- Events list with full iteration groups — identical to Ralph loop display
- Stop button

**Completed/Failed (read-only):**
- Same header and prompt display
- Phase indicator showing final state
- Events list (fully browsable)
- Trace summary (outcome, iterations, cost, session ID)
- For failed: failure reason displayed prominently
- No form, no run button

### `pages/RepoDetail.tsx` — 1-Shot Launch Form

The "1-Shot" button opens an inline form section (or keeps the current navigation pattern but submits and redirects). On submit:
1. Call `store.runOneShot(repoId, title, prompt, model, mergeStrategy)`
2. Store returns `oneshotId`
3. Navigate to `/oneshot/:oneshotId`

The form includes: title, prompt, model, merge strategy (same fields as current `OneShot.tsx`). Additionally, the implementation phase inherits the repo's config (max_iterations, completion_signal, checks, git_sync).

### `oneshot-helpers.ts` — Simplify

- Remove `PhaseOutput`-based phase detection
- `getPhaseFromEvents()` derives phase from lifecycle events only (`design_phase_started`, `implementation_phase_started`, etc.)
- Remove `buildOneShotArgs()` (moved into store action)

### `event-format.ts` — Remove `phase_output`

- Remove `phase_output` emoji and label cases
- Keep all 1-shot lifecycle event formatting unchanged

### `iteration-groups.ts` — No Changes

1-shot events now use standard iteration events, so existing grouping logic works. The 1-shot lifecycle events are already handled as standalone "before"/"after" events.

### `components/EventsList.tsx` — No Changes

Already supports iteration groups with expandable rows. 1-shot sessions will display identically to Ralph loop sessions, with lifecycle events as standalone markers.

## File Changes Summary

### Backend

| File | Change |
|------|--------|
| `src-tauri/src/session.rs` | Add `working_dir` override to `SessionRunner`; decouple trace lifecycle |
| `src-tauri/src/oneshot.rs` | Refactor to use `SessionRunner` for both phases; generate `oneshot_id`; remove `run_phase()`; remove `PhaseOutput` |
| `src-tauri/src/lib.rs` | Update `run_oneshot` command: accept impl config, return `oneshot_id`, key by `oneshot_id` |

### Frontend

| File | Change |
|------|--------|
| `src/types.ts` | Add `OneShotEntry` type; remove `phase_output` fields |
| `src/store.ts` | Add `oneShotEntries` state, `runOneShot`/`dismissOneShot` actions, persistence |
| `src/App.tsx` | Add `/oneshot/:oneshotId` route; remove `/repo/:repoId/oneshot` route |
| `src/pages/Home.tsx` | Render `OneShotCard`s mixed with `RepoCard`s |
| `src/components/OneShotCard.tsx` | **New** — card component for 1-shot entries |
| `src/pages/OneShot.tsx` → `src/pages/OneShotDetail.tsx` | Rename; redesign with active/read-only modes; always show prompt |
| `src/pages/RepoDetail.tsx` | Inline 1-shot launch form; call `store.runOneShot()` and navigate |
| `src/oneshot-helpers.ts` | Remove `PhaseOutput` handling and `buildOneShotArgs` |
| `src/event-format.ts` | Remove `phase_output` cases |
| `src/iteration-groups.ts` | No changes |
| `src/components/EventsList.tsx` | No changes |

### Deleted

| Item | Reason |
|------|--------|
| `SessionEvent::PhaseOutput` (backend) | Replaced by standard iteration events |
| `phase_output` event handling (frontend) | No longer emitted |
| `run_phase()` / `run_claude_phase()` in `oneshot.rs` | Replaced by `SessionRunner` calls |
| `/repo/:repoId/oneshot` route | Replaced by `/oneshot/:oneshotId` |

## Implementation Plan

### Task 1: Make `SessionRunner` accept working directory override

Add an optional `working_dir` field to `SessionConfig` (or a builder method on `SessionRunner`). When set, the Claude invocation uses this path as `cwd` instead of `repo_path`. This is needed so the 1-shot can run Claude inside the worktree.

**Files to create/modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `src-tauri/src/session.rs` — existing `SessionRunner::new()` builder pattern

**Details:**
- Add `working_dir: Option<PathBuf>` to `SessionConfig`
- In `run()`, when building `ClaudeInvocation`, use `working_dir.unwrap_or(repo_path)` as the cwd
- No changes to event emission or iteration logic

**Checklist:**
- [x] Add `working_dir` field to `SessionConfig`
- [x] Use it in `ClaudeInvocation` construction
- [x] Add unit test: `SessionConfig` with `working_dir = Some(path)` uses that path in invocation
- [x] `cargo check` passes
- [x] Existing `cargo test` passes (no behavioral change for `None`)

---

### Task 2: Decouple `SessionRunner` trace lifecycle

Allow callers to manage `TraceCollector` externally so `OneShotRunner` can wrap two `SessionRunner` traces into one overall trace.

**Files to create/modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `src-tauri/src/session.rs` — existing `SessionRunner` builder

**Details:**
- Add a mode where `SessionRunner::run()` does not call `collector.start()` / `collector.finalize()` — the caller handles those
- Could be a builder method like `.external_trace(true)` or simply have `run()` return intermediate results that the caller aggregates
- The `OneShotRunner` will create one `TraceCollector`, call `start()`, run design runner, run implementation runner, then call `finalize()` with aggregated stats

**Checklist:**
- [x] Add mechanism to skip internal trace start/finalize
- [x] Ensure iteration events and cost tracking still work
- [x] Add unit test: runner with external trace does not call start/finalize internally
- [x] `cargo check` passes
- [x] `cargo test` passes

---

### Task 3: Refactor `OneShotRunner` to use `SessionRunner`

Replace the manual `run_phase()` / `run_claude_phase()` with `SessionRunner` calls. Remove `PhaseOutput` event variant.

**Files to create/modify:**
- `src-tauri/src/oneshot.rs`
- `src-tauri/src/session.rs` (remove `PhaseOutput` from `SessionEvent` enum)

**Pattern reference:** `src-tauri/src/session.rs` — `SessionRunner::run()` method

**Details:**
- Generate `oneshot_id` at start of run
- Design phase: create `SessionRunner` with `max_iterations: 1`, empty `completion_signal`, no checks, no git_sync, `working_dir` = worktree path
- After design runner completes, extract plan file from accumulated events (look for `ToolUse` events with `Write`/`Edit` to `docs/plans/*.md`, or fall back to text extraction)
- Implementation phase: create `SessionRunner` with full config (max_iterations, completion_signal, checks, git_sync), `working_dir` = worktree path, plan file as prompt
- Forward events from both `SessionRunner`s through the `OneShotRunner`'s event callback
- Remove `PhaseOutput` from `SessionEvent` enum
- Remove `run_phase()`, `run_claude_phase()`, `ClaudePhaseResult`
- Add `parent_repo_id` and `prompt` to `OneShotStarted` event

**Checklist:**
- [x] Remove `PhaseOutput` event variant
- [x] Remove `run_phase()` and `run_claude_phase()`
- [x] Design phase uses `SessionRunner` with `max_iterations: 1`
- [x] Plan file extraction from `ToolUse` events works
- [x] Implementation phase uses `SessionRunner` with full config
- [x] Lifecycle events (`DesignPhaseStarted`, etc.) still emitted around runner calls
- [x] `OneShotStarted` includes `parent_repo_id` and `prompt`
- [x] Update existing oneshot tests: mock expectations for new event structure (real iteration events instead of `PhaseOutput`)
- [x] Add test: `oneshot_id` generation produces unique IDs
- [x] Add test: plan file extraction from `ToolUse` events
- [x] `cargo check` passes
- [x] `cargo test` passes

---

### Task 4: Update `run_oneshot` Tauri command

Accept implementation config and return `oneshot_id`. Key `ActiveSessions` and events by `oneshot_id`.

**Files to create/modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs` — existing `run_session` command handler

**Details:**
- Add parameters: `max_iterations`, `completion_signal`, `checks`, `git_sync`
- Generate `oneshot_id` and return it (change return type to include it alongside `SessionTrace`)
- Insert `oneshot_id` (not `repo_id`) into `ActiveSessions`
- Emit `TaggedSessionEvent` with `repo_id: oneshot_id`
- Clean up `oneshot_id` from `ActiveSessions` when done

**Checklist:**
- [x] Add new parameters to command signature
- [x] Generate and return `oneshot_id`
- [x] Key `ActiveSessions` by `oneshot_id`
- [x] Events tagged with `oneshot_id`
- [x] `cargo check` passes
- [x] `cargo test` passes

---

### Task 5: Clean up `oneshot-helpers.ts` and `event-format.ts`

Remove `PhaseOutput` handling from frontend helpers. This is done early because later tasks depend on the cleaned-up helpers.

**Files to create/modify:**
- `src/oneshot-helpers.ts`
- `src/oneshot-helpers.test.ts`
- `src/event-format.ts`
- `src/event-format.test.ts`

**Pattern reference:** `src/event-format.ts` — existing event kind switch statements

**Details:**
- `oneshot-helpers.ts`: remove `PhaseOutput` from `getPhaseFromEvents()` — derive phase from lifecycle events only; remove `buildOneShotArgs()` (logic moved to store)
- `event-format.ts`: remove `phase_output` case from `eventEmoji()` and `eventLabel()`

**Checklist:**
- [ ] `phase_output` references removed
- [ ] `buildOneShotArgs` removed
- [ ] `getPhaseFromEvents` works with lifecycle events only
- [ ] Update `oneshot-helpers.test.ts`: remove `PhaseOutput` test cases, remove `buildOneShotArgs` tests, add tests for lifecycle-only phase derivation
- [ ] Update `event-format.test.ts`: remove `phase_output` test cases
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes

---

### Task 6: Add `OneShotEntry` type and store state

Add the new type and Zustand store actions for managing 1-shot entries.

**Files to create/modify:**
- `src/types.ts`
- `src/types.test.ts`
- `src/store.ts`
- `src/store.test.ts`

**Pattern reference:** `src/store.ts` — existing `runSession` action pattern

**Details:**
- Add `OneShotEntry` type to `types.ts`
- Add `oneShotEntries: Map<string, OneShotEntry>` to store state
- Add `runOneShot(repoId, title, prompt, model, mergeStrategy)` action: creates entry, calls `invoke("run_oneshot")`, stores returned `oneshot_id`
- Add `dismissOneShot(oneshotId)` action: removes entry from map and persists
- Event listener: on `one_shot_complete` / `one_shot_failed`, update corresponding entry status; prune completed to last 5
- Persistence: save/load `oneShotEntries` via Tauri store (`oneshot-entries` key)
- On init: load entries, prune, reconcile running with `ActiveSessions`

**Checklist:**
- [ ] `OneShotEntry` type added
- [ ] Store state and actions added
- [ ] Event listener handles 1-shot status updates
- [ ] Persistence to Tauri store works
- [ ] Pruning logic: keep last 5 completed, all failed, all running
- [ ] Add store tests: `runOneShot` creates entry and calls invoke
- [ ] Add store tests: `dismissOneShot` removes entry
- [ ] Add store tests: event listener updates entry status on `one_shot_complete`/`one_shot_failed`
- [ ] Add store tests: pruning keeps last 5 completed, all failed
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes

---

### Task 7: Create `OneShotCard` component

Card component for the Home view.

**Files to create/modify:**
- `src/components/OneShotCard.tsx` (new)
- `src/components/OneShotCard.test.tsx` (new)

**Pattern reference:** `src/components/RepoCard.tsx`, `src/components/RepoCard.test.tsx`

**Details:**
- Props: `entry: OneShotEntry`, `phase: string`, `onClick`, `onDismiss?`
- "1-Shot" badge (small pill)
- Title as main text
- "from {parentRepoName}" subtitle
- Phase status with color coding
- Prompt preview (2-line truncation via `line-clamp-2`)
- Timestamp via `timeAgo()`
- Dismiss button (X) for failed entries, calls `onDismiss`

**Checklist:**
- [ ] Component created
- [ ] Visual distinction from `RepoCard` (badge, layout)
- [ ] Dismiss button for failed entries
- [ ] Add tests: renders title, parent repo name, badge, prompt preview
- [ ] Add tests: dismiss button shown for failed, hidden for running/completed
- [ ] Add tests: onClick fires when card clicked
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes

---

### Task 8: Add `/oneshot/:oneshotId` route and `OneShotDetail` page

Create the new detail page with active/read-only modes.

**Files to create/modify:**
- `src/pages/OneShotDetail.tsx` (new)
- `src/pages/OneShotDetail.test.tsx` (new)
- `src/App.tsx`

**Pattern reference:** `src/pages/OneShot.tsx` (current page, to be replaced); `src/pages/RunDetail.tsx` (read-only pattern)

**Details:**
- Route: `/oneshot/:oneshotId`
- Reads `OneShotEntry` from store by `oneshotId`
- Reads `SessionState` from `sessions.get(oneshotId)`
- Active mode: header + prompt block + phase indicator + `EventsList` + stop button
- Read-only mode: header + prompt block + phase indicator + `EventsList` + trace summary
- Prompt always visible in a styled read-only block
- Phase derived from `getPhaseFromEvents()` (updated to remove `PhaseOutput` dependency)
- Remove old `/repo/:repoId/oneshot` route from `App.tsx`

**Checklist:**
- [ ] `OneShotDetail.tsx` created with both modes
- [ ] Route added to `App.tsx`
- [ ] Old route removed
- [ ] Prompt always displayed
- [ ] Phase indicator works with lifecycle events
- [ ] Add tests: active mode shows stop button, hides trace summary
- [ ] Add tests: read-only mode shows trace summary, hides stop button
- [ ] Add tests: prompt displayed in both modes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes

---

### Task 9: Update Home page to show 1-shot cards

Mix `OneShotCard`s with `RepoCard`s on the Home view.

**Files to create/modify:**
- `src/pages/Home.tsx`
- `src/pages/Home.test.tsx`

**Pattern reference:** `src/pages/Home.tsx` — existing repo card grid

**Details:**
- Read `oneShotEntries` from store
- Derive phase for each entry from its session events
- Render `OneShotCard` components alongside `RepoCard` components
- Sort all cards: running first, then by timestamp (newest first)
- Dismiss handler calls `store.dismissOneShot(id)`

**Checklist:**
- [ ] 1-shot cards rendered in grid
- [ ] Sorting works across both card types
- [ ] Dismiss functionality works
- [ ] Add tests: 1-shot cards appear alongside repo cards
- [ ] Add tests: dismiss removes card
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes

---

### Task 10: Update `RepoDetail` to launch 1-shots with full config

Replace the simple "1-Shot" navigation button with an inline form that submits and navigates.

**Files to create/modify:**
- `src/pages/RepoDetail.tsx`
- `src/pages/RepoDetail.test.tsx`

**Pattern reference:** `src/pages/RepoDetail.tsx` — existing settings/form patterns

**Details:**
- Replace the "1-Shot" button with a collapsible form section
- Form fields: title, prompt, model, merge strategy
- On submit: call `store.runOneShot()` which passes repo's max_iterations, completion_signal, checks, git_sync to the backend
- On success: navigate to `/oneshot/:oneshotId`
- Disable form while any 1-shot from this repo is starting

**Checklist:**
- [ ] Inline form added
- [ ] Submit calls `store.runOneShot()` with full config
- [ ] Navigates to new detail page after launch
- [ ] Add tests: form renders with required fields
- [ ] Add tests: submit calls store action and navigates
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes

---

### Task 11: Delete old `OneShot.tsx` page

Remove the old page file and its test file.

**Files to create/modify:**
- Delete `src/pages/OneShot.tsx`
- Delete `src/pages/OneShot.test.tsx`

**Checklist:**
- [ ] Files deleted
- [ ] No remaining imports reference the old file
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes

---

### Task 12: Update E2E tests

Update Playwright E2E tests for the new 1-shot flow and routing.

**Files to create/modify:**
- `e2e/oneshot.test.ts`

**Pattern reference:** Existing E2E test files in `e2e/`

**Details:**
- Update for new routing (`/oneshot/:oneshotId` instead of `/repo/:repoId/oneshot`)
- Test launching a 1-shot from RepoDetail form
- Test 1-shot card appears on Home view
- Test navigating to OneShotDetail from card
- Test dismiss functionality for failed entries
- Test active vs read-only modes

**Checklist:**
- [ ] E2E tests updated for new routing and flow
- [ ] `npm run test:e2e` passes

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | SessionRunner working directory override | Done |
| 2 | Decouple SessionRunner trace lifecycle | Done |
| 3 | Refactor OneShotRunner to use SessionRunner | Done |
| 4 | Update run_oneshot Tauri command | Done |
| 5 | Clean up oneshot-helpers and event-format | Not Started |
| 6 | Add OneShotEntry type and store state | Not Started |
| 7 | OneShotCard component | Not Started |
| 8 | OneShotDetail page with active/read-only modes | Not Started |
| 9 | Home page mixed cards | Not Started |
| 10 | RepoDetail 1-shot launch form | Not Started |
| 11 | Delete old OneShot page | Not Started |
| 12 | Update E2E tests | Not Started |
