# 1-Shot Feature Design

## Overview

A 1-shot is a fully autonomous, single-pass implementation mode. The user provides a title, prompt, and merge strategy. Yarr creates an isolated git worktree, runs a design phase (codebase analysis + plan generation), then an implementation phase (execute the plan), and finally pushes the result — either merged to main or as a new branch.

## User Inputs

- **Title** — text input, used for branch name and worktree directory naming
- **Prompt** — textarea for the task description
- **Model** — single model used for both design and implementation phases (defaults from repo config)
- **Merge strategy** — radio: "Merge to main" or "Create branch"

## Execution Flow

1. Create worktree at `~/.yarr/worktrees/<repo-id>-oneshot-<short-id>/` on a new branch `oneshot/<slugified-title>-<short-id>`
2. **Design phase**: Run Claude session with a design prompt — reads codebase, produces design + implementation plan, writes it to `docs/plans/` in the worktree. No clarifying questions — full autonomy.
3. **Implementation phase**: Run Claude session with the existing implementation prompt, referencing the plan file produced in step 2
4. **Finalize**: Based on merge strategy:
   - **Merge to main**: Merge worktree branch into main, push main, delete branch
   - **Create branch**: Push branch to remote
5. **Cleanup**: Delete the worktree directory (both strategies)

Results appear in the shared History view tagged as "1-shot".

## Backend — Rust Architecture

### New Types

**`OneShotConfig`** in a new `oneshot.rs` module:
```rust
pub struct OneShotConfig {
    pub repo_id: String,
    pub repo_path: PathBuf,
    pub title: String,
    pub prompt: String,
    pub model: String,
    pub merge_strategy: MergeStrategy,
    pub env_vars: HashMap<String, String>,
}

pub enum MergeStrategy {
    MergeToMain,
    Branch,
}
```

**`OneShotRunner`**: Manages the full lifecycle. Uses existing `RuntimeProvider` trait for spawning Claude and running git commands.

### New Session Events

```rust
OneShotStarted { title: String, merge_strategy: String }
DesignPhaseStarted
DesignPhaseComplete { plan_file: String }
ImplementationPhaseStarted
ImplementationPhaseComplete
GitFinalizeStarted { strategy: String }
GitFinalizeComplete
OneShotComplete
OneShotFailed { reason: String }
```

These are added as variants to the existing `SessionEvent` enum in `session.rs`.

### New Tauri Commands

- `run_oneshot(repo_id, repo, title, prompt, model, merge_strategy, env_vars)` — launches the 1-shot
- `stop_oneshot(repo_id)` — cancels in-progress 1-shot (reuses `CancellationToken` pattern)

### Worktree Management

Git operations run via `runtime.run_command()` — same mechanism post-loop checks use. No new git library dependency.

- `git worktree add <path> -b <branch>` — create worktree
- `git worktree remove <path>` — cleanup
- `git merge <branch>` — merge to main
- `git push` / `git push -u origin <branch>` — push
- `git branch -d <branch>` — delete branch after merge

### Tracing

Reuse `TraceCollector` and `SessionTrace`. Add a `session_type` field (`"ralph_loop"` | `"oneshot"`) to `SessionTrace` so history can distinguish them.

## Design Phase Prompt

A non-interactive version of the brainstorming skill. The prompt instructs Claude to:

1. Read the codebase structure, key files, and conventions
2. Understand the task from the user's prompt
3. Produce a design + implementation plan
4. Write it to `docs/plans/<date>-<slug>-design.md` in the worktree
5. Follow the standard plan format: task headings, files to create/modify, pattern references, checklists, progress tracking table
6. Output `<promise>COMPLETE</promise>` when done

## Git Operations — Detailed Flow

### Setup
1. Ensure `~/.yarr/worktrees/` directory exists
2. From the repo path: `git worktree add ~/.yarr/worktrees/<repo-id>-oneshot-<short-id> -b oneshot/<slug>-<short-id>`
3. Worktree created on new branch based on current HEAD of main

### Merge-to-Main Flow
1. From main repo: `git merge oneshot/<slug>-<short-id>`
2. `git push`
3. `git branch -d oneshot/<slug>-<short-id>`
4. `git worktree remove <worktree-path>`

### Branch Flow
1. From worktree: `git push -u origin oneshot/<slug>-<short-id>`
2. `git worktree remove <worktree-path>`

### Error Handling
- Merge conflicts → mark 1-shot as failed, leave worktree for manual resolution, log error
- Push failure → retry once, then fail, leave worktree
- Phase failure → clean up worktree unless uncommitted changes

### Cancellation
Kill Claude process, remove worktree, delete branch.

## Frontend — UI

### New View: `OneShotView.svelte`

Form with:
- **Title** — text input
- **Prompt** — textarea
- **Model** — input (pre-filled from repo config)
- **Merge strategy** — radio buttons
- **Run button**

Once running, transitions to progress display with phase indicators (Design → Implementation → Finalizing). Cancel button available.

### Navigation
New "1-Shot" entry in repo detail navigation, alongside existing run/history views.

### History Integration
`HistoryView.svelte` gets a "Type" column showing "Ralph Loop" or "1-Shot". Clicking a 1-shot entry opens the same `RunDetail.svelte` event timeline.

---

## Implementation Plan

### Task 1: Add `session_type` to SessionTrace

Add a `session_type` field to distinguish Ralph loops from 1-shot sessions in traces and history.

**Files to modify:**
- `src-tauri/src/trace.rs`
- `src/types.ts`

**Pattern reference:** `src-tauri/src/trace.rs` — existing `SessionTrace` struct with `#[serde(default)]` for backward compat

**Details:**
- Add `session_type: String` field to `SessionTrace` with `#[serde(default = "default_session_type")]` where default returns `"ralph_loop"`
- Add `session_type` to the frontend `SessionTrace` type in `types.ts`
- Existing traces missing the field will deserialize as `"ralph_loop"` via serde default

**Checklist:**
- [x] Add `session_type` field to `SessionTrace` in `trace.rs` with serde default
- [x] Add `default_session_type()` helper function returning `"ralph_loop"`
- [x] Set `session_type: "ralph_loop".to_string()` in `TraceCollector::new()` or wherever traces are initialized
- [x] Add `session_type` to `SessionTrace` in `src/types.ts`
- [x] Verify: `cd src-tauri && cargo test`

---

### Task 2: Add 1-shot SessionEvent variants

Add the new event variants to `SessionEvent` for tracking 1-shot progress.

**Files to modify:**
- `src-tauri/src/session.rs`
- `src/types.ts`

**Pattern reference:** `src-tauri/src/session.rs` — existing `SessionEvent` enum variants like `CheckStarted`, `CheckPassed`

**Details:**
- Add variants: `OneShotStarted`, `DesignPhaseStarted`, `DesignPhaseComplete`, `ImplementationPhaseStarted`, `ImplementationPhaseComplete`, `GitFinalizeStarted`, `GitFinalizeComplete`, `OneShotComplete`, `OneShotFailed`
- Follow existing serde rename_all = "snake_case" pattern
- Update frontend `SessionEvent` kind union type

**Checklist:**
- [x] Add 9 new variants to `SessionEvent` enum in `session.rs`
- [x] Update `SessionEvent` kind type in `src/types.ts` to include new event kinds
- [x] Add any new fields to the frontend `SessionEvent` type (title, merge_strategy, plan_file, strategy, reason)
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 3: Add design phase prompt

Create the non-interactive design prompt that produces a plan without asking clarifying questions.

**Files to modify:**
- `src-tauri/src/prompt.rs`

**Pattern reference:** `src-tauri/src/prompt.rs` — `IMPLEMENTATION_PROMPT` constant and `build_prompt()` function

**Details:**
- Add `DESIGN_PROMPT` constant — instructs Claude to read the codebase, understand the task, produce design + implementation plan, write to `docs/plans/<date>-<slug>-design.md`
- Add `build_design_prompt(user_prompt: &str, title: &str) -> String` function that combines the design prompt with the user's task description
- Plan format should match brainstorming skill conventions: task headings, files, pattern references, checklists, progress table
- Must include `<promise>COMPLETE</promise>` as completion signal
- Prompt should instruct Claude not to ask clarifying questions — make its own decisions

**Checklist:**
- [x] Add `DESIGN_PROMPT` constant to `prompt.rs`
- [x] Add `build_design_prompt(user_prompt: &str, title: &str) -> String` function
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 4: Add OneShotRunner

Create the core runner that orchestrates the full 1-shot lifecycle.

**Files to create:**
- `src-tauri/src/oneshot.rs`

**Files to modify:**
- `src-tauri/src/main.rs` (or `lib.rs` — add `mod oneshot`)

**Pattern reference:** `src-tauri/src/session.rs` — `SessionRunner` struct, event callback pattern, cancellation token usage, `RuntimeProvider` integration

**Details:**
- `OneShotConfig` struct: repo_id, repo_path, title, prompt, model, merge_strategy, env_vars
- `MergeStrategy` enum: MergeToMain, Branch
- `OneShotRunner` struct with `run()` method that:
  1. Creates worktree via `runtime.run_command("git worktree add ...")`
  2. Runs design phase: spawns Claude with `build_design_prompt()`, streams output, collects plan file path
  3. Runs implementation phase: spawns Claude with `build_prompt(plan_file)`, streams output
  4. Runs git finalize based on merge strategy
  5. Cleans up worktree
- Uses `on_event` callback pattern same as SessionRunner
- Supports `CancellationToken` for cancellation at phase boundaries
- Slugify title for branch name: lowercase, replace non-alphanumeric with hyphens, truncate
- Short ID: first 6 chars of a UUID
- Worktree path: `~/.yarr/worktrees/<repo-id>-oneshot-<short-id>`
- Branch name: `oneshot/<slug>-<short-id>`

**Checklist:**
- [x] Create `src-tauri/src/oneshot.rs` with `OneShotConfig`, `MergeStrategy`, `OneShotRunner`
- [x] Implement worktree creation (git worktree add)
- [x] Implement design phase (spawn Claude, stream, find plan file)
- [x] Implement implementation phase (spawn Claude with plan, stream)
- [x] Implement merge-to-main finalize (merge, push, delete branch, remove worktree)
- [x] Implement branch finalize (push branch, remove worktree)
- [x] Implement cancellation cleanup (kill process, remove worktree, delete branch)
- [x] Implement error handling (leave worktree on merge conflict/push failure)
- [x] Add `mod oneshot` to lib.rs
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 5: Add Tauri commands for 1-shot

Wire up the `run_oneshot` and `stop_oneshot` Tauri commands.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs` — `run_session` command, `ActiveSessions` state, `TaggedSessionEvent` emission

**Details:**
- `run_oneshot` command: accepts repo_id, repo (RepoType), title, prompt, model, merge_strategy, env_vars
- Creates OneShotRunner, sets up event callback to emit TaggedSessionEvent
- Stores CancellationToken in ActiveSessions (reuse same map — 1-shot and Ralph loop can't run on same repo simultaneously)
- Sets up TraceCollector with `session_type: "oneshot"`
- Spawns tokio task, cleans up token on completion
- `stop_oneshot` can reuse `stop_session` — same cancellation mechanism
- Register commands in tauri::Builder handler list

**Checklist:**
- [x] Add `run_oneshot` Tauri command
- [x] Set up OneShotRunner with event callback and trace collector
- [x] Store cancellation token in ActiveSessions
- [x] Spawn tokio task for async execution
- [x] Register `run_oneshot` in tauri::Builder invoke_handler
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 6: Add OneShotView frontend component

Create the 1-shot launch form and progress display.

**Files to create:**
- `src/OneShotView.svelte`

**Pattern reference:** `src/RepoDetail.svelte` — form layout, settings inputs, run controls, $state/$effect patterns

**Details:**
- Props: repo (RepoConfig), session (SessionState | undefined), onBack(), onUpdateRepo()
- Form state: title, prompt, model (defaulted from repo.model), mergeStrategy ("main" | "branch")
- Run button: invokes `run_oneshot` Tauri command
- Once running: show progress with phase indicators based on event kinds (design_phase_started, implementation_phase_started, git_finalize_started)
- Show streamed events using existing EventsList component
- Cancel button: invokes `stop_session`
- Style: consistent with existing views (dark theme, monospace inputs, form layout)

**Checklist:**
- [x] Create `src/OneShotView.svelte` with form and progress display
- [x] Implement form with title, prompt, model, merge strategy inputs
- [x] Implement run button calling `run_oneshot`
- [x] Implement progress display with phase indicators
- [x] Implement cancel button
- [x] Verify: `npx tsc --noEmit`

---

### Task 7: Integrate OneShotView into App navigation

Wire up the 1-shot view in App.svelte navigation and event handling.

**Files to modify:**
- `src/App.svelte`
- `src/RepoDetail.svelte`

**Pattern reference:** `src/App.svelte` — `currentView` routing, event listener, session state management

**Details:**
- Add `oneshot` to `currentView` kind union: `{ kind: "oneshot"; repoId: string }`
- Add navigation trigger in RepoDetail: "1-Shot" button/tab alongside existing controls
- Add conditional rendering for oneshot view in App.svelte template
- 1-shot events flow through same `session-event` listener — same repo_id keying
- OneShotView receives same SessionState from sessions map

**Checklist:**
- [x] Add `oneshot` kind to currentView type in App.svelte
- [x] Add "1-Shot" navigation button in RepoDetail.svelte
- [x] Add OneShotView rendering block in App.svelte template
- [x] Wire up onBack callback to return to repo view
- [x] Verify: `npx tsc --noEmit`

---

### Task 8: Add "Type" column to HistoryView

Display session type in history to distinguish Ralph loops from 1-shots.

**Files to modify:**
- `src/HistoryView.svelte`

**Pattern reference:** `src/HistoryView.svelte` — existing sortable columns, trace row rendering

**Details:**
- Add "Type" column showing `trace.session_type === "oneshot" ? "1-Shot" : "Ralph Loop"`
- Make it sortable (add to sortField union type)
- Default display for traces missing session_type: "Ralph Loop"

**Checklist:**
- [x] Add "Type" column header with sort button
- [x] Add session_type to sortField union
- [x] Add type cell to trace rows
- [x] Handle missing session_type (default to "Ralph Loop")
- [x] Verify: `npx tsc --noEmit`

---

### Task 9: Tests for OneShotRunner

Add Rust tests for the 1-shot runner.

**Files to modify:**
- `src-tauri/src/oneshot.rs` (add test module)

**Pattern reference:** `src-tauri/src/session.rs` — existing `#[cfg(test)]` module patterns

**Details:**
- Test slugify function (various title inputs)
- Test worktree path generation
- Test branch name generation
- Test OneShotRunner with MockRuntime:
  - Successful design + implementation + merge-to-main flow (mock git commands)
  - Successful branch flow
  - Cancellation during design phase
  - Design phase failure
- Use `tempfile::TempDir` for worktree paths in tests

**Checklist:**
- [x] Add unit tests for slugify and name generation helpers
- [x] Add integration test for merge-to-main flow with MockRuntime
- [x] Add integration test for branch flow with MockRuntime
- [x] Add test for cancellation
- [x] Add test for failure handling
- [x] Verify: `cd src-tauri && cargo test`

---

### Task 10: Frontend tests for OneShotView

Add Vitest unit tests and Playwright E2E tests for the 1-shot UI.

**Files to create:**
- `src/OneShotView.test.ts`
- `e2e/oneshot.test.ts`

**Pattern reference:** `src/HistoryView.test.ts` or existing `*.test.ts` — Vitest patterns; `e2e/*.test.ts` — Playwright patterns with `window.__TAURI_INTERNALS__` mocking

**Details:**
- Unit tests: form renders, inputs update state, run button calls invoke, progress display shows phases
- E2E tests: navigate to 1-shot view, fill form, mock run_oneshot response, verify progress events display

**Checklist:**
- [x] Create unit tests for OneShotView form rendering and interaction
- [x] Create E2E test for 1-shot launch flow
- [x] Verify: `npm test` and `npm run test:e2e`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add session_type to SessionTrace | Done |
| 2 | Add 1-shot SessionEvent variants | Done |
| 3 | Add design phase prompt | Done |
| 4 | Add OneShotRunner | Done |
| 5 | Add Tauri commands for 1-shot | Done |
| 6 | Add OneShotView frontend component | Done |
| 7 | Integrate OneShotView into App navigation | Done |
| 8 | Add Type column to HistoryView | Done |
| 9 | Tests for OneShotRunner | Done |
| 10 | Frontend tests for OneShotView | Done |
