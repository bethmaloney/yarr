# Fix Plans Not Being Moved to Completed Folder

## Overview

Plans are not being moved to the `completed/` subdirectory after a successful Ralph loop or 1-shot session completes. The root cause is that the Rust backend's `SessionComplete` event only carries the `outcome` field, but never includes the `plan_file` path. The frontend listener in `store.ts` checks for `sessionEvent.plan_file` on the `session_complete` event, finds it `undefined`, and skips the `move_plan_to_completed` invocation entirely.

Additionally, the 1-shot flow never emits a `SessionComplete` event at all — it uses `OneShotComplete`/`OneShotFailed` instead — so even if `SessionComplete` carried `plan_file`, 1-shot plans would still not be moved.

This fix also needs to ensure correct path handling when running under Windows + WSL, where `move_plan_to_completed_impl` runs shell commands through `wsl -e bash -c` and Windows-style paths must be converted to WSL paths. Appropriate logging will be added throughout.

## Root Cause Analysis

### Ralph Loop (`session.rs:875`)

```rust
// Current — plan_file is NOT included:
self.emit(SessionEvent::SessionComplete { outcome });
```

The trace has `plan_file` set (line 855–856 via `start_session`), but it's never passed into `SessionComplete`.

### 1-Shot (`oneshot.rs:727`)

The 1-shot runner emits `OneShotComplete` (not `SessionComplete`), and the frontend only checks `session_complete` events for plan moves. Even though the design phase emits `DesignPhaseComplete { plan_file }`, that event is never used to trigger a plan move.

### Frontend (`store.ts:170–205`)

```typescript
if (sessionEvent.kind === "session_complete") {
  if (sessionEvent.outcome === "completed" && sessionEvent.plan_file) {
    // ... invoke move_plan_to_completed
  }
}
```

This code is correct in structure but:
1. `SessionComplete` never has `plan_file` set (Rust bug)
2. `OneShotComplete` is not handled here at all

## Tasks

### Task 1: Add `plan_file` to `SessionComplete` event variant

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** The `DesignPhaseComplete { plan_file: String }` variant at line 160 already carries a plan file path.

**Checklist:**
- [x] Change `SessionComplete` variant from `SessionComplete { outcome: SessionOutcome }` to `SessionComplete { outcome: SessionOutcome, plan_file: Option<String> }` (line 140)
- [x] Update `run()` method to pass plan file when emitting `SessionComplete` (line 875):
  ```rust
  let plan_file = trace.plan_file.clone();
  self.emit(SessionEvent::SessionComplete { outcome, plan_file });
  ```
- [x] Add `tracing::info!` log when emitting `SessionComplete` that includes the outcome and plan_file:
  ```rust
  tracing::info!(outcome = ?outcome, plan_file = ?plan_file, "session complete, emitting SessionComplete");
  ```
- [x] Update all existing test assertions that destructure `SessionComplete` to include the new `plan_file` field (search for `SessionComplete {` in session.rs tests)

### Task 2: Handle plan move for 1-shot completions in the frontend

**Files to modify:**
- `src/store.ts`

**Pattern reference:** The existing `session_complete` handler at lines 170–205. The 1-shot status update handler at lines 217–239 already handles `one_shot_complete`.

**Checklist:**
- [x] In the `session_complete` handler, the `plan_file` field will now be populated from the backend — no frontend changes needed for Ralph loop sessions
- [x] Add plan move logic to the `one_shot_complete` handling section (lines 217–239). When `sessionEvent.kind === "one_shot_complete"`:
  - Look up the `OneShotEntry` to get the `parentRepoId`
  - Look up the parent repo to get `plansDir`
  - Look through the session events for a `DesignPhaseComplete` event to extract the `plan_file`
  - Invoke `move_plan_to_completed` with the parent repo's runtime info and plansDir
  - Fire-and-forget with `.catch()` logging, same pattern as the existing session_complete handler
- [x] Add `console.log` when plan move is triggered (both session_complete and one_shot_complete) including repo_id, filename, and plansDir
- [x] Add `console.log` when plan move is skipped (no plan_file found, or non-completed outcome) including the reason

### Task 3: Add logging to `move_plan_to_completed_impl` in the Rust backend

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** The `list_plans_impl` function at line 661 and `move_plan_to_completed` command at line 706 for the existing pattern.

**Checklist:**
- [x] Add `tracing::info!` at the start of `move_plan_to_completed_impl` logging the `plans_dir` and `filename` parameters
- [x] Add `tracing::info!` on success ("plan moved to completed")
- [x] Add `tracing::error!` on failure with the command output (stderr)
- [x] Add `tracing::info!` at the start of the `move_plan_to_completed` Tauri command logging the repo type, plans_dir, and filename
- [x] Add `tracing::warn!` when input validation fails (path traversal rejection)

### Task 4: Ensure WSL path handling works for `move_plan_to_completed`

**Files to modify:**
- `src-tauri/src/lib.rs`
- `src-tauri/src/runtime/wsl.rs` (verify, may not need changes)

**Pattern reference:** `WslRuntime::run_command` at `wsl.rs:210` which already converts paths via `to_wsl_path`.

**Checklist:**
- [x] Verify that `resolve_runtime()` in `lib.rs` (line ~490) returns a `WslRuntime` for `RepoType::Local` when running on Windows. Currently `default_runtime()` handles this — confirm the `move_plan_to_completed` command uses the same logic via `resolve_runtime(&repo)` (line 713). **This is already correct** — `resolve_runtime` calls `default_runtime()` for Local repos.
- [x] Verify that `WslRuntime::run_command` converts `working_dir` via `to_wsl_path`. This is confirmed at `wsl.rs:217`.
- [x] The `plans_dir` in the shell command (`mkdir -p {plans_dir}/completed && mv ...`) is a relative path (e.g., `docs/plans/`), so it doesn't need path conversion — it's relative to the `cd` target. **This should work correctly already.**
- [x] Add a `tracing::debug!` in `WslRuntime::run_command` that logs the converted WSL path and the command being run (if not already present)
- [ ] Test manually: run a Ralph loop with a plan file on a WSL-backed repo, confirm the plan moves to `completed/`

### Task 5: Update frontend TypeScript types

**Files to modify:**
- `src/types.ts`

**Pattern reference:** The existing `SessionEvent` type at line 24.

**Checklist:**
- [ ] The `SessionEvent` type already has `plan_file?: string` at line 39 — no changes needed, but verify this is correct and matches what the backend now sends
- [ ] Verify `SessionOutcome` type covers all Rust variants (line 80 in trace.rs)

### Task 6: Update tests

**Files to modify:**
- `src-tauri/src/session.rs` (Rust tests)
- `src/store.test.ts` (frontend tests)

**Pattern reference:** Existing `SessionComplete` test assertions in `session.rs` tests. Existing plan move tests in `store.test.ts` (lines 438–539).

**Checklist:**

#### Rust tests (`session.rs`):
- [ ] Update `test_session_runner_basic_loop` to verify `SessionComplete` now carries `plan_file` from config
- [ ] Update all `SessionComplete` pattern matches in tests to use `SessionComplete { outcome, plan_file }` or `SessionComplete { outcome, .. }`
- [ ] Add a test that verifies `SessionComplete` has `plan_file: None` when `SessionConfig.plan_file` is `None`
- [ ] Add a test that verifies `SessionComplete` has `plan_file: Some(...)` when `SessionConfig.plan_file` is set

#### Rust tests (serialization in `lib.rs`):
- [ ] Update `SessionComplete` serialization test to include `plan_file` and verify it serializes to `"plan_file": "some/path.md"` in JSON

#### Frontend tests (`store.test.ts`):
- [ ] Existing tests for `session_complete` plan move should continue passing (they already set `plan_file` on the event)
- [ ] Add test for `one_shot_complete` triggering plan move:
  - Set up `oneShotEntries` map with an entry that has a `parentRepoId`
  - Set up `repos` with the parent repo
  - Set up `sessions` with events that include `DesignPhaseComplete { plan_file: "docs/plans/my-plan.md" }`
  - Fire `one_shot_complete` event
  - Assert `move_plan_to_completed` was invoked with correct repo, plansDir, and filename
- [ ] Add test for `one_shot_complete` NOT triggering plan move when no `DesignPhaseComplete` event exists

### Task 7: Add logging to `WslRuntime::run_command`

**Files to modify:**
- `src-tauri/src/runtime/wsl.rs`

**Pattern reference:** The existing `tracing::info!` in `WslAbortHandle::abort` and `spawn_claude`.

**Checklist:**
- [x] Add `tracing::debug!` at the start of `run_command` logging the original working_dir, converted WSL path, and the command
- [x] Add `tracing::debug!` on command success with exit code
- [x] Add `tracing::warn!` on command failure (non-zero exit or timeout) with stderr output

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Add `plan_file` to `SessionComplete` | **Done** | Core Rust fix. Also updated ssh_orchestrator.rs emission site and trace.rs tests. |
| 2. Handle plan move for 1-shot in frontend | **Done** | Added plan move on one_shot_complete via design_phase_complete event lookup. Added console.log for triggered/skipped in both session_complete and one_shot_complete paths. 7 new tests. |
| 3. Add logging to `move_plan_to_completed_impl` | **Done** | Added tracing::info/error/warn to both move_plan_to_completed_impl and the Tauri command wrapper. |
| 4. Verify WSL path handling | **Done** | Verified resolve_runtime, to_wsl_path, and relative plans_dir all correct. Added debug/warn logging to WslRuntime::run_command. Manual test pending. |
| 5. Update frontend TypeScript types | Not started | Type verification |
| 6. Update tests | Not started | Rust + frontend tests |
| 7. Add logging to `WslRuntime::run_command` | **Done** | Added debug at start (working_dir, wsl_dir, command), debug on success, warn on failure/timeout. |
