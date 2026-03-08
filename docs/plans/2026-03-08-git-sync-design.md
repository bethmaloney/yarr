# Git Sync

## Summary

Add optional automatic git pull/push after every iteration of a Ralph loop. When enabled per-repo, Yarr pushes commits to the remote after each iteration (and on session exit). If the push is rejected, it pulls with rebase and spawns Claude to resolve merge conflicts automatically.

## Motivation

The `run_ralph.sh` script in rust-sqlpackage pushes after every iteration with a sophisticated conflict resolution flow (push, pull-rebase, Claude-driven merge conflict resolution, retry). This keeps branches in sync and reduces conflict surface area. Yarr should support this natively with per-repo configuration.

## Data Model

### GitSyncConfig

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct GitSyncConfig {
    enabled: bool,                     // default: false
    conflict_prompt: Option<String>,   // custom conflict resolution prompt (default used if None)
    model: Option<String>,             // defaults to "sonnet" at call site
    max_push_retries: u32,             // default: 3
}
```

TypeScript equivalent:

```typescript
type GitSyncConfig = {
  enabled: boolean;
  conflictPrompt?: string;
  model?: string;
  maxPushRetries: number;
};
```

### Config Integration

- `RepoConfig` gains `gitSync?: GitSyncConfig` (both `LocalRepoConfig` and `SshRepoConfig`)
- `SessionConfig` gains `git_sync: Option<GitSyncConfig>`, passed through from the frontend via the `run_session` Tauri command
- When `gitSync` is absent or `enabled: false`, the feature is completely inert -- no git commands run

## Execution Flow

A new `git_sync` method on `SessionRunner`. The flow mirrors the bash script.

### Step 1: Detect branch

Run `git branch --show-current` once at sync start. All subsequent commands use this branch name.

### Step 2: Push attempt

```
git push origin {branch}
```

If this succeeds, done. Emit `GitSyncPushSucceeded`.

### Step 3: Push with upstream (first time)

```
git push -u origin {branch}
```

If this succeeds, done. Emit `GitSyncPushSucceeded`.

### Step 4: Pull-rebase loop (up to `max_push_retries` attempts)

Each attempt:

1. `git fetch origin {branch}`
2. `git pull --rebase origin {branch}`
3. If rebase succeeds cleanly -> retry push from Step 2
4. If merge conflicts detected (`git status` shows unmerged paths):
   a. Gather conflicting file list via `git diff --name-only --diff-filter=U`
   b. Emit `GitSyncConflict` with the file list
   c. Emit `GitSyncConflictResolveStarted`
   d. Spawn Claude with the conflict resolution prompt (custom or default), using the configured model (default: sonnet), with `--dangerously-skip-permissions`
   e. After Claude finishes, check if rebase is still in progress via `git status`
   f. If rebase still in progress -> `git rebase --abort`, emit `GitSyncConflictResolveComplete { success: false }`, count as failed attempt
   g. If rebase completed -> emit `GitSyncConflictResolveComplete { success: true }`, retry push
5. If rebase fails for non-conflict reasons -> `git rebase --abort`, count as failed attempt

### Step 5: Exhausted retries

Emit `GitSyncFailed`. Log a warning and continue the session. Don't fail the session over a sync failure -- the work is committed locally and can be pushed manually.

All git commands go through `runtime.run_command()` from the post-loop checks design, so WSL and SSH repos work automatically.

## Call Sites & Ordering

### After each successful iteration (+ after post-iteration checks)

```
Claude iteration
  -> run_checks(EachIteration)     // from post-loop checks design
  -> git_sync()                    // NEW
  -> inter-iteration delay
```

Check-fix commits are included in the push.

### After completion signal detected (+ after post-completion checks)

```
Completion signal found
  -> run_checks(PostCompletion)    // from post-loop checks design
  -> git_sync()                    // NEW
  -> break
```

### On session exit (failed, max iterations, cancelled)

After the main loop ends but before trace finalization:

```
Loop ends (any reason)
  -> if outcome is Failed | MaxIterations | Cancelled:
      git_sync()                   // push partial progress
  -> finalize trace
```

## Cancellation

`git_sync` checks `cancel_token` before starting. If sync is already in progress when cancel is requested, it finishes the current push attempt (don't leave git in a half-rebased state). The conflict-resolution Claude spawn does respect cancellation -- if cancelled mid-fix, it aborts the rebase and skips the sync.

## Session Events

New event variants for frontend visibility:

```rust
GitSyncStarted { iteration: u32 },
GitSyncPushSucceeded { iteration: u32 },
GitSyncConflict { iteration: u32, files: Vec<String> },
GitSyncConflictResolveStarted { iteration: u32, attempt: u32 },
GitSyncConflictResolveComplete { iteration: u32, attempt: u32, success: bool },
GitSyncFailed { iteration: u32, error: String },
```

For the session-exit sync (after the loop), `iteration` is set to the last iteration number.

## Default Conflict Resolution Prompt

When no custom prompt is set:

```
Resolve merge conflicts. We are rebasing our local commits onto the updated remote.

IMPORTANT: In rebase conflicts, HEAD/ours = remote changes, incoming/theirs = our local work.

Conflicting files:
{conflict_files}

For each file:
1. Read the file to see the conflict markers
2. Understand what BOTH sides are trying to do
3. Merge intelligently - combine both changes so nothing is lost
4. Remove all conflict markers
5. Run `git add <file>`

After all conflicts resolved: `git rebase --continue`
```

When a custom `conflictPrompt` is provided, the conflict file list is still appended automatically:

```
{custom_prompt}

Conflicting files:
{conflict_files}
```

## Frontend UI

### Settings Section

In `RepoDetail.svelte`, a new `<details>` section (between Settings and the Checks section from the post-loop checks design):

```
> Git Sync -- disabled
```

When expanded:
- **Enable toggle** -- checkbox, flips `enabled`
- **Model** -- text input, placeholder "sonnet" (leave empty for default)
- **Max push retries** -- number input, default 3
- **Conflict resolution prompt** -- textarea, placeholder shows first line of default prompt, optional

All fields disabled while a session is running. When the checkbox is unchecked, the other fields are visually dimmed.

Save works through the existing `saveSettings` flow.

### EventsList Treatment

- `git_sync_started` -- sync icon, "Git sync"
- `git_sync_push_succeeded` -- green check, "Pushed to remote"
- `git_sync_conflict` -- orange warning, "Merge conflicts: {files.length} files"
- `git_sync_conflict_resolve_started` -- wrench icon, "Resolving conflicts (attempt {attempt})"
- `git_sync_conflict_resolve_complete` -- green/red based on `success`
- `git_sync_failed` -- red, "Git sync failed: {error}" (expandable for full error)

## Dependency on Post-Loop Checks Design

The post-loop checks feature has landed. `RuntimeProvider::run_command` is available on all runtimes (Local, WSL, SSH, Mock). The `run_checks` call sites are in place at `session.rs:443` (EachIteration) and `session.rs:453` (PostCompletion). Our `git_sync` calls go immediately after each of these.

Note: `ClaudeInvocation` now requires an `env_vars: HashMap<String, String>` field. The conflict-resolution Claude spawn should pass an empty map (no special env vars needed).

## Decisions

- **Sync after every iteration** -- minimizes conflict surface, proven in the bash script
- **Push on all session exits** -- ensures partial progress isn't stranded locally
- **Retry then continue** -- if sync fails after all retries, the session continues. Work is committed locally.
- **Default model is sonnet** -- conflict resolution is straightforward; no need for opus
- **run_command reuse** -- git commands go through `RuntimeProvider::run_command` for WSL/SSH portability
- **Feature is opt-in** -- disabled by default, enabled per-repo

---

## Implementation Plan

### Task 1: Add GitSyncConfig data model (Rust)

Add the `GitSyncConfig` struct to the Rust backend.

**Files to create/modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `SessionConfig` at `src-tauri/src/session.rs:36-50`, `Check` struct at `src-tauri/src/session.rs:21-32`

**Details:**
- Add `GitSyncConfig` struct with fields: `enabled` (bool), `conflict_prompt` (Option<String>), `model` (Option<String>), `max_push_retries` (u32)
- Derive `Debug, Clone, serde::Serialize, serde::Deserialize`
- Add `Default` impl: `enabled: false`, `conflict_prompt: None`, `model: None`, `max_push_retries: 3`
- Add `git_sync: Option<GitSyncConfig>` field to `SessionConfig`
- Update `SessionConfig::default()` to include `git_sync: None`

**Checklist:**
- [x] Add `GitSyncConfig` struct with Default impl
- [x] Add `git_sync` field to `SessionConfig`
- [x] Update `SessionConfig::default()`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 2: Add git-sync SessionEvent variants

Add event types so the frontend can display git sync progress.

**Files to create/modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `SessionEvent` enum at `src-tauri/src/session.rs:84-117` (includes existing check event variants as examples)

**Details:**
- Add variants: `GitSyncStarted { iteration: u32 }`, `GitSyncPushSucceeded { iteration: u32 }`, `GitSyncConflict { iteration: u32, files: Vec<String> }`, `GitSyncConflictResolveStarted { iteration: u32, attempt: u32 }`, `GitSyncConflictResolveComplete { iteration: u32, attempt: u32, success: bool }`, `GitSyncFailed { iteration: u32, error: String }`
- These serialize via the existing `rename_all = "snake_case"` serde config

**Checklist:**
- [x] Add all six git sync event variants to `SessionEvent`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 3: Add default conflict resolution prompt constant

**Files to create/modify:**
- `src-tauri/src/prompt.rs`

**Pattern reference:** `IMPLEMENTATION_PROMPT` at `src-tauri/src/prompt.rs:3-132`

**Details:**
- Add `pub const DEFAULT_CONFLICT_PROMPT: &str` with the conflict resolution prompt from the design doc (the template with `{conflict_files}` placeholder)
- Add `pub fn build_conflict_prompt(custom_prompt: Option<&str>, conflict_files: &str) -> String` that uses the custom prompt if provided (appending conflict files), or the default template with the placeholder replaced

**Checklist:**
- [x] Add `DEFAULT_CONFLICT_PROMPT` constant
- [x] Add `build_conflict_prompt` function
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 4: Add git_sync method to SessionRunner

Core logic for the push-rebase-resolve flow.

**Files to create/modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `SessionRunner::run_iteration` at `src-tauri/src/session.rs:560-610`, `SessionRunner::run_checks` at `src-tauri/src/session.rs:204-354`, `push_with_rebase` in `../rust-sqlpackage/run_ralph.sh:14-87`

**Details:**
- Add `async fn git_sync(&self, runtime: &dyn RuntimeProvider, iteration: u32)` method on `SessionRunner`
- Early return if `self.config.git_sync` is `None` or `enabled == false`
- Early return if `cancel_token.is_cancelled()`
- Emit `GitSyncStarted`
- Detect branch: `runtime.run_command("git branch --show-current", ...)`
- Try push: `git push origin {branch}` -- if succeeds, emit `GitSyncPushSucceeded`, return
- Try push with upstream: `git push -u origin {branch}` -- if succeeds, emit `GitSyncPushSucceeded`, return
- Pull-rebase loop up to `max_push_retries`:
  - `git fetch origin {branch}`
  - `git pull --rebase origin {branch}`
  - If succeeds, retry push
  - If conflicts (check `git status` for "Unmerged paths" or "both modified"):
    - Get conflict files via `git diff --name-only --diff-filter=U`
    - Emit `GitSyncConflict`
    - Emit `GitSyncConflictResolveStarted`
    - Build conflict prompt via `prompt::build_conflict_prompt`
    - Build `ClaudeInvocation` with conflict prompt, model (from git_sync config, default "sonnet"), `--dangerously-skip-permissions`, and `env_vars: HashMap::new()`
    - Spawn Claude via `runtime.spawn_claude(...)`, consume events (use same pattern as `run_checks` fix agent at session.rs:289-340), wait for completion
    - Check if rebase still in progress (`git status` contains "rebase in progress")
    - If still in progress: `git rebase --abort`, emit `GitSyncConflictResolveComplete { success: false }`
    - If resolved: emit `GitSyncConflictResolveComplete { success: true }`, retry push
  - If non-conflict rebase error: `git rebase --abort`, continue to next attempt
- If all retries exhausted: emit `GitSyncFailed`, return (don't fail session)
- Cancellation: check token before starting, respect it during Claude spawn (abort rebase if cancelled mid-fix)
- Use `Duration::from_secs(120)` as timeout for git commands (generous for large repos)

**Checklist:**
- [x] Add `git_sync` method
- [x] Implement push attempt
- [x] Implement push-with-upstream attempt
- [x] Implement pull-rebase loop
- [x] Implement conflict detection and Claude resolution
- [x] Handle rebase abort on failure
- [x] Handle cancellation
- [x] Emit all appropriate events
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 5: Integrate git_sync into the session loop

Wire `git_sync` into the three call sites in `SessionRunner::run`.

**Files to create/modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `SessionRunner::run` loop at `src-tauri/src/session.rs:355-558`

**Details:**
- **After each successful iteration** (after `run_checks(EachIteration)` at line 443, before the cancellation check at line 445): call `self.git_sync(runtime, iteration).await`
- **After completion signal** (after `run_checks(PostCompletion)` at line 453, before `state = SessionState::Completed` at line 454): call `self.git_sync(runtime, iteration).await`
- **On session exit** (after the main loop ends at line 520, for Failed/MaxIterations/Cancelled states, before trace finalization at line 532): call `self.git_sync(runtime, last_iteration).await`
- Track `last_iteration` variable through the loop so it's available after the loop ends

**Checklist:**
- [x] Add git_sync call after each successful iteration
- [x] Add git_sync call after completion signal
- [x] Add git_sync call on session exit (Failed/MaxIterations/Cancelled)
- [x] Track last_iteration for session-exit sync (extracted from SessionState instead of separate variable)
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 6: Pass GitSyncConfig through the Tauri command

Wire git sync config from the frontend IPC call through to `SessionConfig`.

**Files to create/modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `run_session` command at `src-tauri/src/lib.rs:88-222` (note: `env_vars` parameter at line 97, `checks` at lines 138/182 show the pattern for adding optional config params)

**Details:**
- Add `git_sync: Option<session::GitSyncConfig>` parameter to `run_session` command
- Pass it into `SessionConfig { git_sync, .. }`
- The `run_mock_session` command passes `git_sync: None` (no sync for mock runs)
- `GitSyncConfig` is already deserializable from frontend JSON via serde derives

**Checklist:**
- [x] Add `git_sync` parameter to `run_session`
- [x] Wire into `SessionConfig`
- [x] Add `rename_all = "camelCase"` to `GitSyncConfig` serde attribute for frontend compatibility
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 7: Add GitSyncConfig type to frontend and update RepoConfig

**Files to create/modify:**
- `src/types.ts`
- `src/repos.ts`

**Pattern reference:** `RepoConfig` types at `src/repos.ts:5-27` (note `envVars?: Record<string, string>` at lines 13/25 as pattern for optional config), `SessionEvent` at `src/types.ts:1-11`

**Details:**
- In `types.ts`: add `GitSyncConfig` type with fields: `enabled: boolean`, `conflictPrompt?: string`, `model?: string`, `maxPushRetries: number`
- In `types.ts`: add new optional fields to `SessionEvent` for git sync events: `files?: string[]`, `attempt?: number`, `success?: boolean`, `error?: string` (some overlap with check events -- reuse where possible)
- In `repos.ts`: add `gitSync?: GitSyncConfig` to both `LocalRepoConfig` and `SshRepoConfig`
- In `repos.ts`: no migration needed -- absent field means feature is disabled

**Checklist:**
- [x] Add `GitSyncConfig` type to `types.ts`
- [x] Add git-sync-related fields to `SessionEvent`
- [x] Add `gitSync` field to both repo config types
- [x] Verify: `npx tsc --noEmit`

---

### Task 8: Add Git Sync settings UI to RepoDetail

**Files to create/modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** Settings `<details>` block at `src/RepoDetail.svelte:125-201` (note env vars `<fieldset>` at lines 159-188 as pattern for a sub-section with add/remove UI)

**Details:**
- Add a new `<details class="git-sync">` section after the existing settings details
- Summary shows "Git Sync -- enabled" or "Git Sync -- disabled" based on toggle state
- Fields: enable checkbox, model (text input, placeholder "sonnet"), max push retries (number input, default 3), conflict resolution prompt (textarea, optional, placeholder showing first line of default prompt)
- All fields disabled while `session.running`; non-checkbox fields visually dimmed when unchecked
- Initialize local state from `repo.gitSync` (defaulting to `{ enabled: false, maxPushRetries: 3 }` if absent)
- Wire into `saveSettings` -- include `gitSync` in the `onUpdateRepo` call

**Checklist:**
- [x] Add local `gitSync` state initialized from repo
- [x] Add Git Sync `<details>` section with enable toggle
- [x] Add model, max retries, and prompt fields
- [x] Dim fields when disabled
- [x] Wire into `saveSettings`
- [x] Disable all fields when running
- [x] Verify: `npx tsc --noEmit`

---

### Task 9: Pass gitSync from App.svelte to run_session invoke

**Files to create/modify:**
- `src/App.svelte`

**Pattern reference:** `handleRunSession` at `src/App.svelte:157-198` (note `envVars` passed at line 186 as pattern)

**Details:**
- Read `gitSync` from the repo config
- Pass `gitSync` in the invoke parameters object alongside `envVars`: `invoke("run_session", { ..., envVars: repo.envVars ?? {}, gitSync: repo.gitSync })`
- Tauri deserializes camelCase frontend fields to snake_case Rust fields via serde `rename_all`

**Checklist:**
- [x] Add `gitSync` to the invoke parameters
- [x] Ensure field naming matches between frontend and Rust serde
- [x] Verify: `npx tsc --noEmit`

---

### Task 10: Display git sync events in EventsList

**Files to create/modify:**
- `src/EventsList.svelte`
- `src/event-format.ts` (new — extracted eventEmoji, toolSummary, eventLabel)
- `src/IterationGroup.svelte` (updated to import from event-format instead of props)

**Pattern reference:** `eventEmoji` at `src/EventsList.svelte:69-86`, `eventLabel` at `src/EventsList.svelte:108-125`

**Details:**
- Add cases to `eventEmoji`: `git_sync_started` -> sync/arrows icon, `git_sync_push_succeeded` -> green check, `git_sync_conflict` -> orange warning, `git_sync_conflict_resolve_started` -> wrench, `git_sync_conflict_resolve_complete` -> green/red based on success, `git_sync_failed` -> red X
- Add cases to `eventLabel`: show descriptive text (e.g. "Pushed to remote", "Merge conflicts: N files", "Resolving conflicts (attempt N)")
- Add CSS color classes for git sync events
- For `git_sync_failed` events with `error`, support expansion (same pattern as tool_input)

**Checklist:**
- [x] Add emoji mappings for all 6 git sync event kinds
- [x] Add label formatting for all 6 git sync event kinds
- [x] Add CSS color classes
- [x] Verify: `npx tsc --noEmit`

---

### Task 11: Rust tests for git_sync

**Files to create/modify:**
- `src-tauri/src/session.rs` (add tests to existing `#[cfg(test)]` module)

**Pattern reference:** existing check tests in `src-tauri/src/session.rs` (search for `#[cfg(test)]`), `MockRuntime` with configurable `command_results` at `src-tauri/src/runtime/mock.rs`

**Details:**
- Test `git_sync` with `git_sync: None` -- no events emitted, no commands run
- Test `git_sync` with `enabled: false` -- no events emitted
- Test `build_conflict_prompt` with default prompt (no custom)
- Test `build_conflict_prompt` with custom prompt
- Test successful push flow using `MockRuntime` with `run_command` returning exit code 0 -- verify `GitSyncStarted` + `GitSyncPushSucceeded` events
- Test push failure + successful rebase flow using `MockRuntime` with sequenced `command_results`

**Checklist:**
- [ ] Test git_sync skipped when None
- [ ] Test git_sync skipped when disabled
- [ ] Test build_conflict_prompt default
- [ ] Test build_conflict_prompt custom
- [ ] Test successful push emits correct events
- [ ] Test push-fail + rebase flow
- [ ] Verify: `cd src-tauri && cargo test`

---

### Task 12: Frontend unit tests for GitSyncConfig

**Files to create/modify:**
- `src/repos.test.ts`

**Pattern reference:** Existing vitest test files in `src/*.test.ts`

**Details:**
- Test that `RepoConfig` with `gitSync` field round-trips correctly
- Test that `RepoConfig` without `gitSync` field loads fine (undefined is acceptable)

**Checklist:**
- [ ] Add GitSyncConfig shape tests
- [ ] Add absent-field compatibility test
- [ ] Verify: `npm test`

---

### Task 13: E2E tests for git sync settings UI

**Files to create/modify:**
- `e2e/git-sync.test.ts` (new file)

**Pattern reference:** existing E2E test files in `e2e/`

**Details:**
- Test that Git Sync section appears in RepoDetail
- Test enabling/disabling the toggle
- Test that fields are dimmed when toggle is off
- Test that fields are disabled while a session is running

**Checklist:**
- [ ] Test Git Sync section renders
- [ ] Test toggle interaction
- [ ] Test field dimming when disabled
- [ ] Test disabled state during run
- [ ] Verify: `npm run test:e2e`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | GitSyncConfig data model (Rust) | Done |
| 2 | Git sync SessionEvent variants | Done |
| 3 | Default conflict resolution prompt | Done |
| 4 | git_sync method on SessionRunner | Done |
| 5 | Integrate git_sync into session loop | Done |
| 6 | Pass GitSyncConfig through Tauri command | Done |
| 7 | Frontend GitSyncConfig type + RepoConfig update | Done |
| 8 | Git Sync settings UI in RepoDetail | Done |
| 9 | Pass gitSync from App.svelte to invoke | Done |
| 10 | Display git sync events in EventsList | Done |
| 11 | Rust tests for git_sync | Not Started |
| 12 | Frontend unit tests for GitSyncConfig | Not Started |
| 13 | E2E tests for git sync settings UI | Not Started |
