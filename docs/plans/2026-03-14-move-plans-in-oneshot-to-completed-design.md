# Move Plans to Completed Folder in 1-Shot Loop

## Overview

The ralph loop automatically moves plan files to `docs/plans/completed/` after successful completion (via frontend handler in `store.ts:307-345`). The 1-shot loop has frontend code that attempts the same (store.ts:427-469), but it doesn't work reliably because:

1. **Timing issue**: The oneshot runs in a git worktree. The plan file exists in the worktree, not the main repo. By the time the frontend's `one_shot_complete` handler fires `move_plan_to_completed`, the worktree may already be removed (for `MergeToMain` strategy) or the plan only exists on the branch (for `Branch` strategy).
2. **Wrong working directory**: The `move_plan_to_completed` Tauri command resolves the runtime using the parent repo, but the plan file lives in the worktree.

The fix is to move the plan to completed **in the Rust backend** (`OneShotRunner::run()`) inside the worktree, before the branch is pushed and the worktree is cleaned up. This mirrors what the ralph loop gets "for free" because it operates directly on the main repo.

## Tasks

### Task 1: Add plan move logic to `OneShotRunner::run()` in Rust

**Files to modify:**
- `src-tauri/src/oneshot.rs`

**Pattern reference:** `src-tauri/src/lib.rs:1435-1506` (`move_plan_to_completed_impl`) — the existing utility that creates the `completed/` dir, moves the file, git adds, commits, and pushes.

**Checklist:**
- [x] After implementation phase completes successfully (around line 920, before git finalize at line 936), call `move_plan_to_completed_impl` with:
  - `runtime` as the `RuntimeProvider`
  - `&wt_path` as the `working_dir` (the worktree, not the main repo)
  - `&self.config.plans_dir` as the `plans_dir`
  - The filename extracted from `plan_file_path` (just the basename, e.g., split on `/` and take last segment)
- [x] Only do this if `self.config.move_plans_to_completed` is true (new config field, see Task 2)
- [x] Log success/failure but don't fail the entire oneshot if the move fails — treat it as best-effort (log warning and continue)
- [x] Skip the git commit and push within `move_plan_to_completed_impl` for the worktree case since the branch will be pushed in the git finalize step anyway. This means we need a lighter version — just the `mkdir -p` + `mv` + `git add`. See Task 3.

### Task 2: Add `move_plans_to_completed` field to `OneShotConfig`

**Files to modify:**
- `src-tauri/src/oneshot.rs` — `OneShotConfig` struct
- `src-tauri/src/lib.rs` — where `OneShotConfig` is constructed from the Tauri command (`run_oneshot` / `resume_oneshot`)
- `src/store.ts` — pass the repo's `movePlansToCompleted` setting when launching a oneshot

**Pattern reference:** Look at how `plans_dir` is already passed through `OneShotConfig` (oneshot.rs line 28-45) and how `movePlansToCompleted` is read from the repo config in `store.ts:313`.

**Checklist:**
- [x] Add `move_plans_to_completed: bool` to `OneShotConfig` (default `true`)
- [x] Wire it through from the `run_oneshot` and `resume_oneshot` Tauri commands in `lib.rs`
- [x] Pass `repo.movePlansToCompleted ?? true` from the frontend when invoking `run_oneshot` / `resume_oneshot`

### Task 3: Create a lightweight plan-move helper for worktree context

**Files to modify:**
- `src-tauri/src/lib.rs` (or `src-tauri/src/oneshot.rs`)

**Pattern reference:** `move_plan_to_completed_impl` in `lib.rs:1435-1506`

**Checklist:**
- [x] ~~Create `move_plan_to_completed_in_worktree`~~ — chose alternative: added `commit: bool` parameter to existing `move_plan_to_completed_impl` to avoid code duplication
- [x] When `commit = false`, skips git commit and git push — only mkdir+mv and git add run
- [x] All existing call sites pass `commit = true` to preserve behavior

### Task 4: Remove redundant frontend plan-move for oneshots

**Files to modify:**
- `src/store.ts`

**Checklist:**
- [x] Remove or disable the `one_shot_complete` plan-move handler at lines 427-469, since the backend now handles it
- [x] Keep the `console.debug` for debugging but remove the `invoke("move_plan_to_completed", ...)` call
- [x] Alternatively, keep the frontend code as a fallback but add a guard to avoid double-moving (check if file already exists in completed). Simpler to just remove it.

### Task 5: Add tests

**Files to modify:**
- `src-tauri/src/oneshot.rs` (test module)

**Pattern reference:** Existing oneshot tests starting at line 1134. Look at how `MockRuntime` is used to verify commands.

**Checklist:**
- [ ] Add test: successful oneshot with `move_plans_to_completed: true` — verify the `mkdir -p` + `mv` + `git add` commands are issued against the worktree
- [ ] Add test: successful oneshot with `move_plans_to_completed: false` — verify no move commands are issued
- [ ] Add test: plan move failure doesn't fail the overall oneshot (best-effort)

## Implementation Order

1. Task 3 (lightweight helper) — foundation
2. Task 2 (config field) — plumbing
3. Task 1 (call from oneshot run) — core logic
4. Task 4 (remove frontend redundancy) — cleanup
5. Task 5 (tests) — verification

## Progress

| Task | Status | Notes |
|------|--------|-------|
| 1. Add plan move to OneShotRunner | **Done** | Calls `move_plan_to_completed_impl(commit=false)` after impl phase, with empty-filename guard and SSH-aware exists check |
| 2. Add config field | **Done** | Added `move_plans_to_completed: bool` to OneShotConfig, wired through run_oneshot/resume_oneshot and frontend |
| 3. Lightweight helper | **Done** | Added `commit: bool` param to `move_plan_to_completed_impl` |
| 4. Remove frontend handler | **Done** | Removed `invoke("move_plan_to_completed")` from oneshot handler, kept `console.debug` log, updated tests |
| 5. Tests | Not started | Verification |
