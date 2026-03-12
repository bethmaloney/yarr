# Commit and Push Completed Plans

## Overview

When a plan is moved to the `completed/` folder (via `move_plan_to_completed`), the change is only local — the file move is not committed or pushed to git. This means the user has to manually commit and push completed plans.

This plan adds an automatic git commit + push step after `move_plan_to_completed` succeeds. The new logic runs in the Rust backend, right after the `mv` command, so it works for both Ralph loop completions and 1-shot completions without any frontend changes.

## Design Decisions

**Backend-only approach**: The commit+push logic belongs in `move_plan_to_completed_impl` in `lib.rs` rather than as a separate Tauri command or frontend-triggered step. Rationale:
- The move and commit are logically atomic — if the move succeeds, the commit should always follow
- Keeps the frontend simple (fire-and-forget `invoke("move_plan_to_completed", ...)` stays unchanged)
- Works identically for both session-complete and oneshot-complete paths without duplicating logic

**Simple git commands, not `git_merge_push`**: The completed plans commit doesn't need the full merge-push retry loop with conflict resolution. A plan file moving to `completed/` is unlikely to conflict. A simple `git add + commit + push` is sufficient. If push fails, log a warning but don't block — the plan is still moved locally.

**Working directory**: The commands run in the repo's working directory (not the worktree), since by the time the plan move is triggered from the frontend, the oneshot worktree may already be cleaned up. The frontend already resolves the repo path when calling `move_plan_to_completed`.

## Tasks

### Task 1: Add git commit and push after plan move in `move_plan_to_completed_impl`

**Files to modify:**
- `src-tauri/src/lib.rs` — `move_plan_to_completed_impl` function (lines 879–904)

**Pattern reference:**
- The existing shell command pattern in `move_plan_to_completed_impl` (lines 886–896) — uses `rt.run_command()` with `ssh_shell_escape` for cross-platform safety
- The `list_plans_impl` function (lines 815–834) for another example of `run_command` usage in `lib.rs`

**Checklist:**
- [x] After the successful `mv` command (line 902), add a `git add` command for the moved file:
  - Stage the removal of the old path: `git add {plans_dir}/{filename}` (records the deletion)
  - Stage the addition at the new path: `git add {plans_dir}/completed/{filename}`
  - Use `ssh_shell_escape` on the paths, consistent with existing code
- [x] Add a `git commit` command with a descriptive message like `"move plan to completed: {filename}"`
  - Use `--no-verify` to avoid pre-commit hooks running on a simple file move
  - Use `--author` or just rely on the repo's default git config
- [x] Add a `git push` command after the commit
  - Simple `git push` (push current branch to its upstream)
  - If push fails, log a warning via `tracing::warn!` but **do not** return an error — the file move itself succeeded and that's the primary operation
- [x] Each git command should use the same `rt.run_command()` pattern with the existing 30-second timeout
- [x] Log success/failure of each git step via `tracing::info!` / `tracing::warn!`

**Implementation detail:**

```rust
// After the successful mv (line 902), add:

// Git add both old (deleted) and new (added) paths
let add_cmd = format!(
    "git add {escaped_plans_dir}/{escaped_filename} {escaped_plans_dir}/completed/{escaped_filename}"
);
let add_output = rt.run_command(&add_cmd, working_dir, timeout).await;
if let Ok(output) = &add_output {
    if output.exit_code != 0 {
        tracing::warn!(stderr = %output.stderr, "git add for completed plan failed");
        return Ok(()); // Move succeeded, git commit is best-effort
    }
} else {
    tracing::warn!("git add command failed for completed plan");
    return Ok(());
}

// Commit
let commit_msg = ssh_shell_escape(&format!("move plan to completed: {}", filename));
let commit_cmd = format!("git commit -m {commit_msg} --no-verify");
let commit_output = rt.run_command(&commit_cmd, working_dir, timeout).await;
if let Ok(output) = &commit_output {
    if output.exit_code != 0 {
        tracing::warn!(stderr = %output.stderr, "git commit for completed plan failed");
        return Ok(());
    }
} else {
    tracing::warn!("git commit command failed for completed plan");
    return Ok(());
}

tracing::info!(filename = %filename, "committed completed plan");

// Push (best-effort)
let push_output = rt.run_command("git push", working_dir, timeout).await;
match push_output {
    Ok(output) if output.exit_code == 0 => {
        tracing::info!(filename = %filename, "pushed completed plan");
    }
    Ok(output) => {
        tracing::warn!(stderr = %output.stderr, filename = %filename, "git push for completed plan failed (will need manual push)");
    }
    Err(e) => {
        tracing::warn!(error = %e, filename = %filename, "git push command failed for completed plan");
    }
}
```

### Task 2: Add tests for the new git commit+push behavior

**Files to modify:**
- `src-tauri/src/lib.rs` — add test(s) in the existing test module, or create a focused test near the implementation

**Pattern reference:**
- `src-tauri/src/git_merge.rs` tests (lines 367–908) — uses `MockRuntime` with `command_results` to simulate shell command sequences
- The existing `move_plan_to_completed_impl` tests (if any) or the `list_plans` tests

**Checklist:**
- [x] Test: successful move + commit + push — mock all commands succeeding, verify `move_plan_to_completed_impl` returns `Ok(())`
- [x] Test: move succeeds but git add fails — verify function still returns `Ok(())` (best-effort git)
- [x] Test: move succeeds, commit succeeds, push fails — verify function still returns `Ok(())` and the move is not rolled back
- [x] Test: move itself fails — verify function returns `Err` (existing behavior, ensure not broken)

**Implementation notes:**
- Use `MockRuntime` to queue up expected `CommandOutput` results in order
- The mock needs to handle: `mkdir -p && mv` (move), `git add` (stage), `git commit` (commit), `git push` (push)
- Since `move_plan_to_completed_impl` takes `&dyn RuntimeProvider`, it's straightforward to test with `MockRuntime`

### Task 3: Verify frontend behavior is unchanged

**Files to verify (no changes expected):**
- `src/store.ts` — the `invoke("move_plan_to_completed", ...)` calls at lines 208–212 and 309–313
- `src/store.test.ts` — existing tests for plan auto-move

**Checklist:**
- [x] Confirm the frontend `invoke` calls don't need changes — they already fire-and-forget with `.catch()`
- [x] Run existing frontend tests (`npm test`) to verify no regressions
- [x] Run existing Rust tests (`cd src-tauri && cargo test`) to verify no regressions

## Progress

| Task | Status | Notes |
|------|--------|-------|
| Task 1: Add git commit+push to `move_plan_to_completed_impl` | Done | git add + commit + push added as best-effort after mv |
| Task 2: Add Rust tests | Done | 4 MockRuntime-based tests covering all paths |
| Task 3: Verify frontend unchanged | Done | 825 frontend + 463 Rust tests pass, no changes needed |
