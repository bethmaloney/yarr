# Add Ralph Loop Merge Logic to 1-Shot

## Problem

The 1-shot's `git_finalize` phase uses a naive approach for both `MergeToMain` and `Branch` strategies: it attempts a single `git rebase` / `git push` and immediately fails if conflicts occur or the push is rejected. This forces users to manually `cd` into the worktree, resolve conflicts, rebase, and push — defeating the purpose of autonomous operation.

Meanwhile, the Ralph loop's `git_sync` method (`session.rs:459-844`) already has robust merge logic:
1. Try simple push
2. Try push with `-u` (upstream not set)
3. Retry loop (up to `max_push_retries`): fetch → `git pull --rebase` → detect conflicts → spawn Claude to resolve → push
4. Emit granular events for each step (conflict detected, resolve started/completed, push succeeded/failed)

The 1-shot should reuse this same conflict-resolution logic in its finalize phase instead of failing on the first rebase conflict.

## Solution

Extract the core merge-with-retry logic from `SessionRunner::git_sync` into a shared function that both the Ralph loop and the 1-shot finalize phase can call. The 1-shot's `MergeToMain` and `Branch` strategies will both benefit:

- **MergeToMain**: fetch origin/main → rebase with conflict resolution retry → push `branch:main`
- **Branch**: push with retry → fetch/rebase same branch with conflict resolution → push

The shared function needs:
- A `RuntimeProvider` reference for running git commands and spawning Claude
- Working directory (worktree path)
- Branch name and target ref (for fetch/rebase)
- `GitSyncConfig` (max retries, conflict prompt, model)
- `CancellationToken`
- An event emitter callback (to emit `GitSync*` events)

## Implementation Plan

### Task 1: Extract Shared Merge Logic from `SessionRunner::git_sync`

**Files to modify:** `src-tauri/src/session.rs`

**Pattern reference:** The existing `git_sync` method at `session.rs:459-844`.

The goal is to extract the retry loop (fetch → rebase → detect conflicts → spawn Claude → push) into a standalone async function that can be called from both `SessionRunner::git_sync` and `OneShotRunner::run`.

**Checklist:**
- [x] Create a new struct `GitMergeConfig` (renamed from plan's `GitMergeContext` — better name since it holds config, not runtime state) in `src-tauri/src/git_merge.rs` with configurable push/fetch/rebase commands, conflict resolution settings, cancel token, and env vars. Runtime is passed as a separate function parameter.
- [x] Create a new enum `GitMergeEvent` for callbacks from the merge function:
  ```rust
  pub enum GitMergeEvent {
      PushSucceeded,
      ConflictDetected { files: Vec<String> },
      ConflictResolveStarted { attempt: u32 },
      ConflictResolveComplete { attempt: u32, success: bool },
      Failed { error: String },
  }
  ```
- [x] Create `pub async fn git_merge_push(runtime, config, on_event)` that implements the core retry loop: try push → optional push -u fallback → retry loop (fetch/rebase/conflict-resolution/push). 7 tests covering all paths.
- [x] The push command is configurable via `push_command` and `push_u_command` fields — `MergeToMain` can use `git push origin {branch}:main`, `Branch`/`git_sync` can use `git push origin {branch}`
- [ ] Refactor `SessionRunner::git_sync` to call `git_merge_push` internally, translating `GitMergeEvent` callbacks into `SessionEvent` emissions (preserving the `iteration` field)
- [ ] Ensure all existing `SessionEvent::GitSync*` events are still emitted correctly after the refactor
- [x] Run `cargo test` in `src-tauri` — all 425 tests pass

### Task 2: Add Merge Logic to 1-Shot `MergeToMain` Strategy

**Files to modify:** `src-tauri/src/oneshot.rs`

**Pattern reference:** Current `MergeToMain` flow at `oneshot.rs:591-687`, and the shared merge function from Task 1.

Replace the naive rebase-then-push with the shared merge logic.

**Checklist:**
- [ ] In the `MergeToMain` arm of `git_finalize`, replace the single fetch → rebase → push sequence with a call to `git_merge_push`
- [ ] The `MergeToMain` flow should:
  1. Fetch `origin/main`
  2. Attempt `git rebase origin/main` with conflict resolution retries (via `git_merge_push` or direct calls to the shared logic)
  3. On success, push `{branch}:main`
  4. Clean up worktree and branch
- [ ] Use the `GitSyncConfig` from `self.config.git_sync` (defaulting to `GitSyncConfig { enabled: true, max_push_retries: 3, .. }` if none configured, since finalize always wants merge logic)
- [ ] Emit `GitSync*` session events during the merge process so the frontend can show conflict resolution progress
- [ ] On final failure (all retries exhausted), preserve the worktree and branch as today, with a helpful error message
- [ ] Handle cancellation during conflict resolution: abort rebase and return early

### Task 3: Add Merge Logic to 1-Shot `Branch` Strategy

**Files to modify:** `src-tauri/src/oneshot.rs`

**Pattern reference:** Current `Branch` flow at `oneshot.rs:688-721`, and the shared merge function from Task 1.

The `Branch` strategy currently does a single `git push -u origin {branch}`. If that fails (e.g., because the implementation phase's `git_sync` pushed some iterations but the final push was rejected due to a race), it should retry with the same fetch/rebase/push logic.

**Checklist:**
- [ ] In the `Branch` arm of `git_finalize`, replace the single push with a call to `git_merge_push`
- [ ] The `Branch` flow should:
  1. Try `git push -u origin {branch}`
  2. If that fails, enter the retry loop: fetch `origin/{branch}` → rebase → resolve conflicts → push
  3. On success, clean up worktree
- [ ] Use the same `GitSyncConfig` default as `MergeToMain` (Task 2)
- [ ] Emit `GitSync*` session events during the merge process
- [ ] On final failure, preserve the worktree as today with a helpful error message

### Task 4: Frontend — Display Merge Progress During Finalize

**Files to modify:** `src/oneshot-helpers.ts`, `src/pages/OneShotDetail.tsx`

**Pattern reference:** Existing `getPhaseFromEvents` in `oneshot-helpers.ts:15-33`, and how `EventsList` / `IterationGroup` display `git_sync_*` events.

The frontend already knows how to display `git_sync_*` events in the Ralph loop's iteration view. Since the 1-shot finalize will now emit these same events, we just need to ensure they're visible during the finalize phase.

**Checklist:**
- [ ] Verify that `git_sync_*` events emitted during finalize are already captured in the session's event list (they should be, since the 1-shot's `emit()` already pushes all events to `accumulated_events` and forwards to the frontend)
- [ ] In `OneShotDetail.tsx`, ensure that git sync events during the finalize phase are displayed — the `EventsList` component should already show them since they'll be in the events array, but verify this works
- [ ] In `oneshot-helpers.ts`, consider adding a more specific phase like `"finalizing_conflict"` when `git_finalize_started` is present AND `git_sync_conflict` events are present, so the phase badge can show "Resolving Conflicts..." instead of generic "Finalizing..."
- [ ] Add the new phase label to `PHASE_LABELS` if adding a new phase string

### Task 5: Tests

**Files to modify:** `src-tauri/src/session.rs` (tests), `src-tauri/src/oneshot.rs` (tests), `src/oneshot-helpers.test.ts`

**Pattern reference:**
- Existing `git_sync` tests in `session.rs` (search for `#[tokio::test]` + `git_sync`)
- Existing oneshot tests at `oneshot.rs:737+`
- Existing `oneshot-helpers.test.ts`

**Checklist:**
- [ ] **Shared merge function tests** (in `session.rs` or a new `src-tauri/src/git_merge.rs` test module):
  - Test successful push on first try
  - Test push fails, push -u succeeds
  - Test push fails, rebase succeeds, push succeeds
  - Test rebase with conflicts, Claude resolves, push succeeds
  - Test rebase with conflicts, Claude fails to resolve (rebase still in progress), abort, retry
  - Test all retries exhausted → returns error
  - Test cancellation during conflict resolution
- [ ] **1-shot MergeToMain tests** (in `oneshot.rs`):
  - Test merge-to-main with conflict during rebase that Claude resolves successfully
  - Test merge-to-main where all retries fail → preserves worktree with error message
  - Existing `test_oneshot_merge_to_main_flow` should still pass (no conflicts = no retries needed)
- [ ] **1-shot Branch tests** (in `oneshot.rs`):
  - Test branch push failure → retry with rebase succeeds
  - Existing branch tests should still pass
- [ ] **Frontend tests** (in `oneshot-helpers.test.ts`):
  - Test `getPhaseFromEvents` returns correct phase when `git_sync_conflict` events are present during finalize
- [ ] Run full test suite: `cd src-tauri && cargo test` and `npm test`

## Design Decisions

1. **Shared function vs. trait method**: A standalone function is simpler and avoids coupling the merge logic to `SessionRunner`. Both `SessionRunner` and `OneShotRunner` can call it independently.

2. **Event callback pattern**: Using a closure callback (`impl Fn(GitMergeEvent)`) rather than requiring an `OnSessionEvent` lets the caller translate events into whatever format they need. `SessionRunner` wraps them in `SessionEvent::GitSync*` with iteration numbers; `OneShotRunner` can do the same or use a synthetic iteration number (e.g., `u32::MAX` or the last implementation iteration).

3. **Default GitSyncConfig for finalize**: The 1-shot finalize should always attempt retries even if the user didn't explicitly configure `git_sync`. This is different from the Ralph loop where `git_sync` is opt-in per iteration. In finalize, failing to push means the whole 1-shot's work is stranded in a worktree.

4. **Push command parameterization**: The shared function accepts a "push command" string or uses a builder pattern, because `MergeToMain` pushes to `origin {branch}:main` while `Branch` pushes to `origin {branch}`. The rebase target also differs: `origin/main` vs `origin/{branch}`.

5. **Worktree preservation on failure**: Unchanged — on final failure the worktree is preserved with instructions for manual resolution. The improvement is that this should now rarely happen since Claude will attempt conflict resolution first.

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| Task 1: Extract shared merge logic | In Progress | `git_merge.rs` created with `GitMergeConfig`, `GitMergeEvent`, `git_merge_push` + 7 tests. Still need to refactor `session.rs:git_sync` to call it. |
| Task 2: MergeToMain with retries | Pending | Depends on Task 1 |
| Task 3: Branch with retries | Pending | Depends on Task 1 |
| Task 4: Frontend merge progress | Pending | Depends on Tasks 2-3 |
| Task 5: Tests | Pending | Depends on Tasks 1-4 |
