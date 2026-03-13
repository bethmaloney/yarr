# Allow Launching 1-Shots from Repos with Running Ralph Loops

## Overview

One-shots already run in isolated git worktrees (`~/.yarr/worktrees/<repo_id>-oneshot-<short_id>`), so they don't touch the main repo's working directory. Despite this isolation, the UI currently **disables the 1-Shot button** when a ralph loop is running on the repo. This plan removes that restriction and ensures the worktree branches off `main`/`master` explicitly (not HEAD, which could be an in-progress ralph loop branch).

## Why This Is Safe

- **Worktrees are fully isolated**: The one-shot runs in a separate directory with its own branch. It never reads or writes the main repo's working tree.
- **Active sessions are keyed by `oneshot_id`**: One-shots use `oneshot-XXXXXX` as their key in `ActiveSessions`, not `repo_id`, so there's no collision with the ralph loop's session entry.
- **Git operations are independent**: The one-shot's `git worktree add` operates on the `.git` directory (shared), but git worktrees are designed for concurrent use.

## Task 1: Remove UI Guard on 1-Shot Button

The 1-Shot button and form are gated on `!session.running`. Remove these guards so the button is always clickable and the form always renders.

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** The button already works correctly when no session is running — we're just removing the conditional disable.

**Checklist:**
- [x] Line 1392: Remove `disabled={session.running}` from the 1-Shot `<Button>` (leave other disabled logic if any)
- [x] Line 1404: Change `{oneShotOpen && !session.running && (` to `{oneShotOpen && (` so the form renders regardless of session state
- [x] Verify: The "Stop" button for the ralph loop and the 1-Shot form should be visible simultaneously when a session is running

## Task 2: Ensure Worktree Branches Off `main`/`master` Explicitly

Currently `git worktree add <path> -b <branch>` (oneshot.rs:439) branches off HEAD. If a ralph loop is running and has checked out a different branch or made uncommitted changes, this could create the one-shot branch from the wrong starting point. We need to explicitly specify `origin/main` (or `origin/master`) as the start-point.

**Files to modify:**
- `src-tauri/src/oneshot.rs`

**Pattern reference:** The git finalize phase already uses `origin/main` for rebase (oneshot.rs:763-765). We need a similar detection for the worktree creation.

**Checklist:**
- [x] Add a helper function `detect_default_branch(runtime, repo_path) -> String` that runs `git symbolic-ref refs/remotes/origin/HEAD` (or falls back to checking if `origin/main` or `origin/master` exists) to determine the default branch name
- [x] Before worktree creation (around line 437), call this helper to get the default branch ref (e.g., `origin/main`)
- [x] Change the worktree add command from:
  ```
  git worktree add {path} -b {branch}
  ```
  to:
  ```
  git worktree add {path} -b {branch} {default_branch_ref}
  ```
  This ensures the new branch starts from `origin/main` regardless of what HEAD points to
- [x] Update the git finalize `MergeToMain` logic to use the detected branch name instead of hardcoding `main` (lines 763-765). Store the detected default branch name in `OneShotConfig` or pass it through
- [x] Add a `fetch origin` before worktree creation to ensure `origin/main` is up to date:
  ```
  git fetch origin {default_branch} --quiet
  ```

## Task 3: Update Frontend Tests

**Files to modify:**
- `src/pages/RepoDetail.test.tsx`

**Pattern reference:** Existing test structure in the same file.

**Checklist:**
- [x] Update or remove any test that asserts the 1-Shot button is disabled when a session is running
- [x] Add a test that verifies the 1-Shot button is **enabled** when a session is running
- [x] Add a test that verifies the 1-Shot form renders when `oneShotOpen` is true and a session is running

## Task 4: Add Rust Tests for Default Branch Detection

**Files to modify:**
- `src-tauri/src/oneshot.rs` (test module at the bottom)

**Pattern reference:** Existing `#[cfg(test)]` module in oneshot.rs.

**Checklist:**
- [x] Add test for `detect_default_branch` returning `origin/main` when `symbolic-ref` works
- [x] Add test for fallback when `symbolic-ref` fails (check `origin/main` then `origin/master`)
- [x] Add test that worktree add command includes the start-point argument

## Task 5: Add Logging for Concurrent One-Shot Launch

**Files to modify:**
- `src-tauri/src/lib.rs` (in `run_oneshot` handler)

**Pattern reference:** Existing `tracing::info!` calls in the same function (lib.rs:433).

**Checklist:**
- [x] After inserting the oneshot into `ActiveSessions`, check if a ralph loop session exists for the same `repo_id` and log an info message: `"launching oneshot while ralph loop is active for repo"`
- [x] Include structured fields: `oneshot_id`, `repo_id`, `existing_session_id`

---

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Remove UI guard on 1-Shot button | Done | Removed disabled prop and session.running guard |
| 2. Worktree branches off main/master | Done | detect_default_branch + worktree start-point + dynamic finalize |
| 3. Update frontend tests | Done | Replaced guard test with two new assertions |
| 4. Add Rust tests for branch detection | Done | 7 new tests + MockRuntime captured_commands |
| 5. Add concurrent launch logging | Done | Log when oneshot launches alongside active ralph loop |
