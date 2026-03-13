# SSH 1-Shot Support

## Overview

Add support for running 1-shot autonomous sessions on SSH repositories. Currently, 1-shot is local-only — SSH repos get an explicit error. This feature extends the existing `OneShotRunner` to work with `SshRuntime` and `SshSessionOrchestrator`, running the entire lifecycle (worktree creation, design phase, implementation phase, git finalization) on the remote machine.

## Architecture

The core `OneShotRunner` orchestration logic stays largely unchanged. It already uses `runtime.run_command()` for all git operations (worktree create, merge, push, cleanup), which means `SshRuntime` handles remote execution transparently — the same way `WslRuntime` handles WSL execution.

The key change is in the Claude execution phases (design + implementation). Locally, these use `SessionRunner` which spawns a local `claude -p` process. For SSH, each phase uses `SshSessionOrchestrator`, which:

1. Starts a tmux session on the remote running `claude -p`
2. Tails the log file back to the local app for event streaming
3. Handles disconnection/reconnection automatically

### Component Flow

```
run_oneshot (lib.rs)
  ├─ SSH repo detected
  ├─ Create SshRuntime (same as regular SSH sessions)
  ├─ Create OneShotConfig with ssh_host field set
  ├─ Create OneShotRunner
  ├─ Store reconnect notify in ActiveSshSessions
  └─ Spawn background task
      └─ OneShotRunner::run(ssh_runtime)
          ├─ runtime.run_command("mkdir -p ...") — remote via SSH
          ├─ runtime.run_command("git worktree add ...") — remote via SSH
          ├─ Design phase → SshSessionOrchestrator (tmux + tail)
          ├─ Implementation phase → SshSessionOrchestrator (tmux + tail)
          └─ Git finalize → runtime.run_command("git merge/push ...") — remote via SSH
```

## Design Decisions

### Everything runs on the remote
Since the repo lives on the remote machine, all operations (git, Claude, filesystem) happen there. The local app's role is orchestration and event streaming.

### Remote worktree path
Uses `~/.yarr/worktrees/{repo_id}-oneshot-{short_id}` on the remote machine, same convention as local. The `~/.yarr/` directory is already established on remote machines for logs.

### Reuse SshSessionOrchestrator for each phase
Each Claude phase (design, implementation) creates its own `SshSessionOrchestrator` instance. This reuses the proven tmux lifecycle, log tailing, and reconnection logic. Git operations between phases use `runtime.run_command()`.

### Resume/reconnection support
Within a phase, `SshSessionOrchestrator` handles reconnection automatically (same as regular SSH sessions). Between phases, `OneShotRunner`'s existing `resume_state` mechanism handles app restarts.

### Full merge strategy support
Both `MergeToMain` and `Branch` strategies are supported on remote, using `run_command()` for git operations. Merge conflict fallback works the same as local.

### Frontend changes are minimal
The 1-Shot button is already available for SSH repos. The only frontend change is optionally prefixing the worktree path with the SSH host for clarity in `OneShotDetail.tsx`.

## Backend Changes

### `OneShotConfig` (oneshot.rs)
Add `ssh_host: Option<String>` field. When set, indicates this is an SSH oneshot and affects:
- Worktree path generation (uses remote home dir instead of local)
- Phase execution (uses `SshSessionOrchestrator` instead of `SessionRunner`)

### `OneShotRunner::run()` (oneshot.rs)
The design and implementation phase blocks need to branch based on `ssh_host`:
- **Local**: Use `SessionRunner` (unchanged)
- **SSH**: Create `SshSessionOrchestrator` with a `SessionConfig` for the phase, run it, and process events

A helper method like `run_phase_ssh()` encapsulates creating the orchestrator, running it, and returning accumulated events for plan file extraction.

### `worktree_path()` (oneshot.rs)
When `ssh_host` is set, resolve the remote home directory via `runtime.run_command("echo $HOME", ...)` instead of using the local home directory.

### `run_oneshot` command (lib.rs)
The `RepoType::Ssh` match arm replaces the error with:
1. Create `SshRuntime` (same pattern as `run_session`)
2. Pre-warm env cache
3. Build `OneShotConfig` with `ssh_host` set
4. Create `OneShotRunner` with event forwarding
5. Store reconnect notify in `ActiveSshSessions`
6. Spawn background task with cleanup guard

### Stop/cancel
Stopping an SSH 1-shot kills the remote tmux session. The cancel token propagates to `SshSessionOrchestrator` which handles cleanup.

## Frontend Changes

### `OneShotDetail.tsx`
Display the worktree path prefixed with the SSH host (e.g., `myhost:~/.yarr/worktrees/...`) so users know it's a remote path.

## Testing

### Rust unit tests
- Test `OneShotRunner` with a mock runtime that simulates SSH behavior
- Test remote worktree path generation
- Test stop/cancellation

### E2E tests
- Add SSH oneshot variants to existing E2E test suite using mocked Tauri IPC

### Manual testing
- SSH 1-shot happy path: design → implementation → merge to main
- SSH 1-shot with branch strategy
- Disconnect/reconnect mid-phase
- Stop mid-phase
- Resume after app restart

---

## Implementation Plan

### Task 1: Add `ssh_host` to `OneShotConfig` and update worktree path generation

Add the `ssh_host: Option<String>` field to `OneShotConfig` and update `worktree_path()` to resolve the remote home directory when SSH is active.

**Files to modify:**
- `src-tauri/src/oneshot.rs`

**Pattern reference:** `src-tauri/src/runtime/ssh.rs` (lines 103-130) — `SshRuntime` struct with host field

**Details:**
- Add `ssh_host: Option<String>` to `OneShotConfig`
- Create a new `worktree_path_remote()` async function that takes a `&dyn RuntimeProvider` and resolves `$HOME` on the remote via `run_command("echo $HOME", ...)`
- Update the `run()` method to call the appropriate worktree path function based on `ssh_host`
- Update all `OneShotConfig` construction sites to pass `ssh_host: None` for local

**Checklist:**
- [x] Add `ssh_host` field to `OneShotConfig`
- [x] Add `worktree_path_remote()` function
- [x] Update `run()` to use remote path when SSH
- [x] Update local `OneShotConfig` construction in `lib.rs` to pass `ssh_host: None`
- [x] `cargo check` passes

---

### Task 2: Extract phase execution into a helper that supports both local and SSH

Refactor the design and implementation phase execution in `OneShotRunner::run()` so it can use either `SessionRunner` (local) or `SshSessionOrchestrator` (SSH).

**Files to modify:**
- `src-tauri/src/oneshot.rs`

**Pattern reference:** `src-tauri/src/lib.rs` (lines 314-344) — SSH session orchestrator setup in `run_session`

**Details:**
- Create a helper method `run_phase()` on `OneShotRunner` that takes the `SessionConfig`, `TraceCollector`, event callback, and `&mut SessionTrace`
- When `ssh_host` is `None`: create and run `SessionRunner` (existing code, extracted)
- When `ssh_host` is `Some(host)`: create `SshRuntime`, create `SshSessionOrchestrator`, run it, and return the trace
- The helper returns accumulated events so the caller can extract plan files
- Both paths should support the abort registry and cancel token

**Checklist:**
- [x] Extract phase execution into `run_phase()` helper
- [x] Add SSH branch that creates `SshSessionOrchestrator`
- [x] Verify local path still works (existing behavior preserved)
- [x] `cargo check` passes

---

### Task 3: Wire up SSH oneshot in `run_oneshot` Tauri command

Replace the SSH error path in `run_oneshot` with the full SSH oneshot setup, mirroring the pattern from `run_session`'s SSH branch.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs` (lines 265-398) — SSH branch of `run_session`

**Details:**
- Create `SshRuntime` with host, remote_path, and env cache
- Pre-warm env cache and emit warning if snapshot failed
- Build `OneShotConfig` with `ssh_host: Some(ssh_host)`
- Create `OneShotRunner` with event forwarding (emit `session-event` with oneshot_id as repo_id)
- Store reconnect notify in `ActiveSshSessions`
- Spawn background task with cleanup guard (clean up both `ActiveSessions` and `ActiveSshSessions`)
- Return `OneShotResult { oneshot_id, session_id }`

**Checklist:**
- [x] Replace SSH error arm with full setup
- [x] Create SshRuntime and pre-warm env cache
- [x] Build OneShotConfig with ssh_host
- [x] Set up event forwarding
- [x] Register in ActiveSshSessions for reconnection
- [x] Spawn background task with cleanup guard
- [x] `cargo check` passes

---

### Task 4: Handle reconnect notify for SSH oneshots

Ensure the reconnect notification mechanism works for SSH oneshots, so the frontend can trigger reconnection after network drops.

**Files to modify:**
- `src-tauri/src/lib.rs`
- `src-tauri/src/oneshot.rs`

**Pattern reference:** `src-tauri/src/lib.rs` (lines 322-328) — reconnect notify registration for regular SSH sessions

**Details:**
- `OneShotRunner` needs to expose the `reconnect_notify` from each `SshSessionOrchestrator` it creates
- Since orchestrators are created per-phase, the reconnect notify handle needs to be updatable
- Option: store a shared `Arc<Notify>` on `OneShotRunner` that gets passed to each `SshSessionOrchestrator`
- The existing `reconnect_ssh` Tauri command should work with oneshot IDs stored in `ActiveSshSessions`

**Checklist:**
- [ ] Add shared reconnect notify to `OneShotRunner`
- [ ] Pass it to each `SshSessionOrchestrator` per phase
- [ ] Register in `ActiveSshSessions` in `run_oneshot`
- [ ] Verify `reconnect_ssh` command works with oneshot IDs
- [ ] `cargo check` passes

---

### Task 5: Update `OneShotDetail.tsx` to show SSH host prefix on worktree path

Display the SSH host alongside the remote worktree path so users know it's a remote path.

**Files to modify:**
- `src/pages/OneShotDetail.tsx`

**Pattern reference:** `src/pages/RepoDetail.tsx` — how SSH repo details are displayed

**Details:**
- Look up the parent repo's SSH host from the repo config
- If the parent repo is SSH, prefix the worktree path display with `host:`
- Keep the existing display for local repos unchanged

**Checklist:**
- [ ] Add SSH host lookup for parent repo
- [ ] Prefix worktree path with host when SSH
- [ ] Verify local oneshot display is unchanged
- [ ] `npx tsc --noEmit` passes

---

### Task 6: Rust unit tests for SSH oneshot

Add unit tests covering the SSH oneshot path using mock runtimes.

**Files to modify:**
- `src-tauri/src/oneshot.rs` (test module)

**Pattern reference:** `src-tauri/src/ssh_orchestrator.rs` (test module) — mock `SshOps` implementation

**Details:**
- Test remote worktree path generation (resolves `$HOME` via run_command)
- Test that `run_phase()` uses `SshSessionOrchestrator` when `ssh_host` is set
- Test cancellation during SSH phase
- Test cleanup on failure

**Checklist:**
- [ ] Test remote worktree path generation
- [ ] Test SSH phase execution with mock
- [ ] Test cancellation
- [ ] Test cleanup on failure
- [ ] `cargo test` passes

---

### Task 7: E2E tests for SSH oneshot

Add E2E test variants for SSH oneshot using mocked Tauri IPC.

**Files to modify:**
- `e2e/oneshot.test.ts`

**Pattern reference:** `e2e/oneshot.test.ts` — existing oneshot E2E tests

**Details:**
- Add test cases that pass SSH repo config to `run_oneshot`
- Verify the same lifecycle events are emitted (OneShotStarted, DesignPhaseStarted, etc.)
- Verify worktree path and branch are included in events
- Verify stop functionality works

**Checklist:**
- [ ] Add SSH oneshot happy path E2E test
- [ ] Add SSH oneshot stop E2E test
- [ ] `npm run test:e2e` passes

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add ssh_host to OneShotConfig and update worktree path | Done |
| 2 | Extract phase execution helper (local vs SSH) | Done |
| 3 | Wire up SSH oneshot in run_oneshot command | Done |
| 4 | Handle reconnect notify for SSH oneshots | Not Started |
| 5 | Update OneShotDetail.tsx for SSH host prefix | Not Started |
| 6 | Rust unit tests for SSH oneshot | Not Started |
| 7 | E2E tests for SSH oneshot | Not Started |
