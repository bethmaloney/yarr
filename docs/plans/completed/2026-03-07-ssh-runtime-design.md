# SSH Runtime Design

## Overview

A new `SshRuntime` backend that runs ralph loops on remote machines over SSH, using tmux for session persistence across connection drops and VM restarts.

## Data Model

Repos become a discriminated union:

```typescript
type Repo =
  | { type: "local"; id: string; name: string; path: string }
  | { type: "ssh"; id: string; name: string; sshHost: string; remotePath: string }
```

Rust equivalent:

```rust
enum RepoConfig {
    Local { path: PathBuf },
    Ssh { ssh_host: String, remote_path: String },
}
```

- `sshHost` — a hostname, `user@host`, or SSH config alias
- `remotePath` — absolute path to the repo on the remote machine
- Remote session logs stored at `~/.yarr/logs/yarr-{session_id}.log` on the remote

When adding a repo, the user chooses Local or SSH. The form fields change accordingly.

## Remote Execution Model

### Starting a session

1. Create log directory: `ssh host "mkdir -p ~/.yarr/logs"`
2. Start tmux session running claude with output teed to log:
   ```
   ssh host "tmux new-session -d -s yarr-{session_id} \
     'cd /repo/path && claude -p --output-format stream-json --verbose ... \
     2>/tmp/yarr-{session_id}.stderr \
     | tee ~/.yarr/logs/yarr-{session_id}.log'"
   ```
3. Tail the log to stream events back: `ssh host "tail -f ~/.yarr/logs/yarr-{session_id}.log"`

The `tail -f` process is what Yarr reads events from — a regular child process producing stream-json lines on stdout, just like LocalRuntime.

### On disconnect

- The local `tail -f` process exits with a non-zero code
- The remote tmux session keeps running — claude continues working
- Yarr transitions the session to `Disconnected` instead of `Failed`

### On reconnect

- Yarr checks remote state (see below)
- Reads the log file from where it left off to recover missed events
- If still running, resumes `tail -f` from current position

### Platform handling

On Windows, all `ssh` commands are wrapped through `wsl -e bash -lc "ssh ..."` using the same platform detection as the existing `default_runtime()`.

## Reconnection & State Recovery

### 1. Check if the process is still alive

```
ssh host "tmux has-session -t yarr-{session_id} 2>/dev/null && echo ALIVE || echo DEAD"
```

### 2. Replay missed events

Yarr tracks the last line number it successfully processed. On reconnect:

```
ssh host "tail -n +{last_line} ~/.yarr/logs/yarr-{session_id}.log"
```

Missed stream-json events are processed through the same parsing pipeline, updating the iteration trace with recovered cost/token data.

### 3. Determine state and act

| Tmux alive? | Log has Result event? | State | Action |
|---|---|---|---|
| Yes | No | Still running | Resume `tail -f` from current position |
| No | Yes | Completed | Process final result, clean up remote |
| No | No | Crashed/killed | Report error, clean up remote |

### 4. Clean up after retrieval

```
ssh host "rm ~/.yarr/logs/yarr-{session_id}.log /tmp/yarr-{session_id}.stderr"
```

### Stderr handling

Claude's stderr is redirected to `/tmp/yarr-{session_id}.stderr` on the remote. On completion or error, Yarr retrieves it via `ssh host "cat /tmp/yarr-{session_id}.stderr"`.

### Log persistence

Logs are stored in `~/.yarr/logs/` on the remote (not `/tmp`), so they survive VM reboots. Yarr deletes them after successful retrieval.

## Architecture & Integration

### SshRuntime struct

```rust
pub struct SshRuntime {
    ssh_host: String,
    remote_path: String,
}
```

Implements `RuntimeProvider`. The `spawn_claude()` method performs the start sequence (create tmux, start tailing) and returns a `RunningProcess` where:
- `events` channel receives parsed stream-json lines from the `tail -f` stdout
- `completion` handle resolves when tail exits (either claude finished or connection dropped)
- `abort_handle` kills the local tail process

### Methods beyond the trait

The SSH runtime has additional capabilities not covered by `RuntimeProvider`:
- `check_remote_state(session_id)` — is tmux alive? does log have a Result?
- `recover_events(session_id, from_line)` — replay missed log lines
- `resume_tail(session_id)` — start a new `tail -f` from current position
- `cleanup_remote(session_id)` — delete log and stderr files

### SessionRunner integration

`SessionRunner` stays unchanged. A new `SshSessionOrchestrator` wraps it and manages the connect/disconnect/reconnect cycle, delegating to `SessionRunner` for event processing.

## Session States & Frontend

### New session state variants

```rust
pub enum SessionState {
    // ... existing variants ...
    Disconnected { iteration: u32 },
    Reconnecting { iteration: u32 },
}
```

### Frontend behavior

- **Disconnected** — Shows "Connection lost" indicator with a "Reconnect" button. No automatic retry (the VM might be shut down).
- **Reconnecting** — Shows a spinner while Yarr checks remote state and recovers events.
- **After reconnect** — Transitions to `Running`, `Completed`, or `Failed` based on remote state.

### Multi-iteration reconnection

If Yarr disconnects during iteration 3 and reconnects after iteration 5 has finished, the log file contains all stream-json output from iterations 3 through 5. Yarr replays all of it, reconstructing each iteration's trace as if the connection never dropped.

### Repo configuration UI

When adding a repo, a toggle or tab switches between Local and SSH. SSH shows two fields:
- **SSH Host** — e.g. `beth@dev-box` or an SSH config alias
- **Remote Path** — e.g. `/home/beth/repos/myproject`

A "Test Connection" button runs `ssh host "command -v tmux && command -v claude && echo OK"` to verify connectivity and tool availability.

## Error Handling

### Connection failures during start

SSH command fails to connect — session transitions to `Failed` with the SSH error message (e.g. "Connection refused", "Host key verification failed").

### Health check

```
ssh host "command -v tmux && command -v claude && echo OK"
```

Verifies both tmux and claude CLI are available on the remote. Run when adding an SSH repo (via "Test Connection") and before each session start.

### Connection drops mid-session

- Local `tail -f` process exits with non-zero code
- `SshSessionOrchestrator` catches this and transitions to `Disconnected` instead of `Failed`
- User can click "Reconnect" when ready

### Reconnection failures

- SSH fails to connect on reconnect — stay in `Disconnected`, show error, user can retry later
- Tmux dead + no log file — session is lost, transition to `Failed`

### Remote process crashes

- Tmux dead + log exists but no Result event — `Failed` state
- Yarr retrieves stderr from the remote temp file for diagnostics

### Stale sessions

Unique session IDs prevent collisions with existing tmux sessions.

---

## Implementation Plan

### Task 1: Update RepoConfig to discriminated union (Rust)

Refactor the Rust side to support both local and SSH repo types. Currently `run_session` takes a flat `repo_path: String` parameter.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs:68-131` (existing `run_session` command)

**Details:**
- Add a `RepoType` enum or serde-tagged struct that the frontend sends: `{ "type": "local", "path": "..." }` or `{ "type": "ssh", "sshHost": "...", "remotePath": "..." }`
- Update `run_session` to accept the new shape and branch on repo type when selecting the runtime
- For now, SSH branch can return an error ("SSH runtime not yet implemented") — later tasks will fill it in

**Checklist:**
- [x] Define `RepoType` serde enum in `lib.rs` (or a shared types module)
- [x] Update `run_session` command signature to accept `RepoType` instead of `repo_path: String`
- [x] Branch on repo type: local uses `default_runtime()`, SSH is a placeholder
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 2: Update RepoConfig to discriminated union (Frontend)

Update the frontend repo model and storage to support the new discriminated union.

**Files to modify:**
- `src/repos.ts`

**Pattern reference:** `src/repos.ts:5-12` (existing `RepoConfig` type)

**Details:**
- Change `RepoConfig` to a discriminated union with `type: "local" | "ssh"`
- Local repos keep `path`, SSH repos have `sshHost` and `remotePath`
- Shared fields (`id`, `name`, `model`, `maxIterations`, `completionSignal`) stay on both variants
- `addRepo` becomes `addLocalRepo` and `addSshRepo` (or a single function taking a union)
- Handle migration: existing stored repos without a `type` field should default to `"local"`

**Checklist:**
- [x] Define discriminated union `RepoConfig` type
- [x] Update `addRepo` to handle both local and SSH
- [x] Add migration logic in `loadRepos` for existing repos (default to `"local"`)
- [x] Verify: `npx tsc --noEmit`

---

### Task 3: Update App.svelte to pass repo type to backend

Wire the new repo type through the run handler to the updated Tauri command.

**Files to modify:**
- `src/App.svelte`

**Pattern reference:** `src/App.svelte:96-123` (existing `handleRunSession`)

**Details:**
- `handleRunSession` currently passes `repoPath: repo.path` to the `run_session` invoke
- Update to pass the repo type object instead, matching the new Rust command signature
- For SSH repos, pass `sshHost` and `remotePath` instead of `path`

**Checklist:**
- [x] Update `handleRunSession` to construct the correct invoke payload per repo type
- [x] Verify: `npx tsc --noEmit`

---

### Task 4: Update repo configuration UI for SSH

Add the ability to add and configure SSH repos in the frontend.

**Files to modify:**
- `src/RepoDetail.svelte`
- Any "add repo" UI component (likely in `src/App.svelte` or a dedicated component)

**Pattern reference:** `src/RepoDetail.svelte:27-82` (existing repo settings form)

**Details:**
- When adding a repo, provide a Local/SSH toggle
- Local shows the existing file picker for `path`
- SSH shows text inputs for "SSH Host" and "Remote Path"
- RepoDetail settings section should show the SSH host and remote path (read-only or editable) for SSH repos
- Add a "Test Connection" button that invokes a new Tauri command

**Checklist:**
- [x] Add Local/SSH selector to the "add repo" flow
- [x] Add SSH-specific input fields (host, remote path)
- [x] Update RepoDetail to display SSH config for SSH repos
- [x] Add "Test Connection" button (wired up in a later task)
- [x] Verify: `npx tsc --noEmit`

---

### Task 5: SSH command helper module

Create the foundation for running SSH commands, handling platform detection (direct vs WSL-wrapped).

**Files to create:**
- `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** `src-tauri/src/runtime/wsl.rs:155-172` (shell escaping and path helpers)

**Details:**
- Create helper functions for building SSH command invocations
- `ssh_command(host, remote_cmd) -> tokio::process::Command`: builds the SSH command, wrapping through WSL on Windows using the same `cfg!(target_os = "windows")` check
- `shell_escape()`: reuse or share the existing function from `wsl.rs`
- These helpers are the building blocks for the runtime and orchestrator

**Checklist:**
- [x] Create `ssh.rs` module
- [x] Implement `ssh_command()` helper with platform-aware wrapping
- [x] Implement or reuse `shell_escape()`
- [x] Register module in `src-tauri/src/runtime/mod.rs`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 6: RuntimeProvider — add `run_command` method

Add a general-purpose `run_command` method to `RuntimeProvider` for executing arbitrary shell commands in the repo's working directory. This is needed by the post-loop checks feature (see `2026-03-08-post-loop-checks-design.md`) — checks like linters and tests need to run through the runtime so they work on local, WSL, and SSH repos.

**Files to modify:**
- `src-tauri/src/runtime/mod.rs`
- `src-tauri/src/runtime/local.rs`
- `src-tauri/src/runtime/wsl.rs`
- `src-tauri/src/runtime/ssh.rs`
- `src-tauri/src/runtime/mock.rs`

**Pattern reference:** `src-tauri/src/runtime/local.rs:28-53` (LocalRuntime spawn_claude for process spawning patterns)

**Details:**
- Add to the `RuntimeProvider` trait:
  ```rust
  async fn run_command(
      &self,
      command: &str,
      working_dir: &Path,
      timeout: Duration,
  ) -> Result<CommandOutput>;
  ```
- Add `CommandOutput` struct: `{ exit_code: i32, stdout: String, stderr: String }`
- **LocalRuntime**: `bash -c "{command}"` with `current_dir(working_dir)`, kill on timeout
- **WslRuntime**: `wsl bash -c "cd {wsl_path} && {command}"`, kill on timeout
- **SshRuntime**: `ssh host "cd {remote_path} && {command}"` using existing `ssh_command()` helper, kill on timeout
- **MockRuntime**: return configurable success/failure for tests
- Timeout enforced by `tokio::time::timeout` wrapping the child process wait, killing the process if exceeded

**Checklist:**
- [ ] Define `CommandOutput` struct in `runtime/mod.rs`
- [ ] Add `run_command` to `RuntimeProvider` trait
- [ ] Implement for `LocalRuntime`
- [ ] Implement for `WslRuntime`
- [ ] Implement for `SshRuntime` (using `ssh_command()` helper)
- [ ] Implement for `MockRuntime`
- [ ] Add unit tests for `MockRuntime::run_command`
- [ ] Verify: `cd src-tauri && cargo check && cargo test`

---

### Task 7: SshRuntime — RuntimeProvider implementation

Implement the core `SshRuntime` struct that implements `RuntimeProvider`.

**Files to modify:**
- `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** `src-tauri/src/runtime/wsl.rs:57-152` (WslRuntime spawn_claude and health_check)

**Details:**
- `SshRuntime { ssh_host, remote_path }` struct
- `spawn_claude()`:
  1. `ssh host "mkdir -p ~/.yarr/logs"`
  2. `ssh host "tmux new-session -d -s yarr-{session_id} 'cd ... && claude ... 2>/tmp/yarr-{id}.stderr | tee ~/.yarr/logs/yarr-{id}.log'"`
  3. Spawn `ssh host "tail -f ~/.yarr/logs/yarr-{id}.log"` as the local child process
  4. Parse stdout lines as `StreamEvent`, send to mpsc channel (same pattern as WslRuntime)
  5. Return `RunningProcess` with events, completion handle, abort handle
- `health_check()`: `ssh host "command -v tmux && command -v claude && echo OK"`
- Session ID generation: use the session ID from the invocation or generate a UUID

**Checklist:**
- [x] Implement `SshRuntime` struct with `new(host, remote_path)`
- [x] Implement `spawn_claude()` with tmux + tee + tail-f pattern
- [x] Implement `health_check()` checking for tmux and claude
- [x] Export from `runtime/mod.rs`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 8: SshRuntime — reconnection methods

Add the methods beyond `RuntimeProvider` that handle disconnect recovery.

**Files to modify:**
- `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** `src-tauri/src/runtime/wsl.rs:57-137` (process spawning patterns)

**Details:**
- `check_remote_state(session_id) -> RemoteState { Alive, CompletedOk, Dead }`:
  - Run `ssh host "tmux has-session -t yarr-{id} 2>/dev/null && echo ALIVE || echo DEAD"`
  - Run `ssh host "tail -1 ~/.yarr/logs/yarr-{id}.log"` and check for Result event
  - Combine into state enum
- `recover_events(session_id, from_line) -> Vec<StreamEvent>`:
  - Run `ssh host "tail -n +{from_line} ~/.yarr/logs/yarr-{id}.log"`
  - Parse each line as StreamEvent
- `resume_tail(session_id) -> RunningProcess`:
  - Spawn `ssh host "tail -f -n +{from_line} ~/.yarr/logs/yarr-{id}.log"`
  - Same mpsc pattern as spawn_claude
- `cleanup_remote(session_id)`:
  - Run `ssh host "rm -f ~/.yarr/logs/yarr-{id}.log /tmp/yarr-{id}.stderr"`
- `get_stderr(session_id) -> String`:
  - Run `ssh host "cat /tmp/yarr-{id}.stderr 2>/dev/null"`

**Checklist:**
- [x] Define `RemoteState` enum
- [x] Implement `check_remote_state()`
- [x] Implement `recover_events()`
- [x] Implement `resume_tail()`
- [x] Implement `cleanup_remote()`
- [x] Implement `get_stderr()`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 9: SshSessionOrchestrator

Create the orchestrator that wraps `SessionRunner` with disconnect/reconnect logic.

**Files to create:**
- `src-tauri/src/ssh_orchestrator.rs`

**Pattern reference:** `src-tauri/src/session.rs:115-150` (SessionRunner::run loop), `src-tauri/src/lib.rs:68-131` (how run_session uses SessionRunner)

**Details:**
- `SshSessionOrchestrator` owns an `SshRuntime`, `SessionConfig`, and reconnection state (line count)
- Wraps the session run loop:
  1. Start session via `SshRuntime::spawn_claude()`
  2. Consume events, tracking line count
  3. On disconnect (completion handle returns with non-zero exit / error):
     - Emit `Disconnected` session event
     - Store line count for later recovery
     - Wait for explicit reconnect signal
  4. On reconnect:
     - Emit `Reconnecting` event
     - Call `check_remote_state()`
     - Call `recover_events()` to replay missed events
     - If still running, `resume_tail()` and continue the loop
     - If completed, process final result and clean up
     - If crashed, retrieve stderr and report failure
- Exposes a `reconnect()` method that can be called from a Tauri command

**Checklist:**
- [x] Create `SshSessionOrchestrator` struct
- [x] Implement start flow (delegates to SshRuntime)
- [x] Implement disconnect detection (distinguish from normal completion)
- [x] Implement reconnect flow with event recovery
- [x] Implement line-count tracking for resume position
- [x] Register module in `src-tauri/src/lib.rs`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 10: Tauri commands for SSH sessions

Add the Tauri command handlers for SSH-specific operations: test connection, reconnect.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs:68-131` (existing `run_session` command)

**Details:**
- `test_ssh_connection(ssh_host: String)`: runs health check and returns success/error message
- `reconnect_session(repo_id: String)`: triggers the orchestrator's reconnect flow
- Update `run_session` to use `SshSessionOrchestrator` when repo type is SSH
- Store active SSH orchestrators in app state (similar to how cancel tokens are stored)

**Checklist:**
- [x] Add `test_ssh_connection` Tauri command
- [x] Add `reconnect_session` Tauri command
- [x] Update `run_session` to create `SshSessionOrchestrator` for SSH repos
- [x] Store orchestrators in Tauri managed state for reconnection
- [x] Register new commands in Tauri builder
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 11: Frontend session state — Disconnected and Reconnecting

Add disconnect/reconnect UI states and wire up the reconnect action.

**Files to modify:**
- `src/App.svelte`
- `src/RepoDetail.svelte`

**Pattern reference:** `src/App.svelte:31-36` (SessionState type), `src/RepoDetail.svelte` (session status display)

**Details:**
- Extend `SessionState` with `disconnected: boolean` and `reconnecting: boolean` flags
- Listen for new `Disconnected` and `Reconnecting` session event types
- In RepoDetail, when disconnected: show "Connection lost" status and a "Reconnect" button
- When reconnecting: show a spinner
- "Reconnect" button calls `invoke("reconnect_session", { repoId })`
- After reconnect resolves, session transitions back to running/completed/failed

**Checklist:**
- [x] Add `disconnected` and `reconnecting` to `SessionState`
- [x] Handle new event types in the session event listener
- [x] Add "Reconnect" button to RepoDetail for disconnected state
- [x] Add reconnecting spinner
- [x] Wire button to `reconnect_session` Tauri command
- [x] Verify: `npx tsc --noEmit`

---

### Task 12: SSH runtime unit tests (Rust)

Test the SSH runtime components in isolation.

**Files to create:**
- `src-tauri/src/runtime/ssh_test.rs` (or tests within `ssh.rs`)

**Pattern reference:** `src-tauri/src/runtime/mock.rs` (mock patterns for testing)

**Details:**
- Test `shell_escape()` with edge cases (quotes, spaces, special chars)
- Test SSH command building (verify correct args for both Linux and Windows paths)
- Test `check_remote_state()` parsing of ALIVE/DEAD responses
- Test stream event parsing from log lines (reuse existing `StreamEvent::parse_line`)
- Consider a mock SSH helper for integration-style tests (or test against localhost if available)

**Checklist:**
- [x] Test shell_escape edge cases
- [x] Test SSH command construction
- [x] Test remote state parsing
- [x] Test event recovery from log lines
- [x] Verify: `cd src-tauri && cargo test`

---

### Task 13: Frontend tests for SSH repo flow

Test the frontend handling of SSH repos and disconnect/reconnect states.

**Files to modify/create:**
- `src/repos.test.ts` (extend existing tests)
- `e2e/*.test.ts` (extend E2E tests)

**Pattern reference:** Existing test files in `src/*.test.ts` and `e2e/*.test.ts`

**Details:**
- Unit tests for `repos.ts`: adding SSH repos, migration of legacy repos, loading SSH config
- Unit tests for session state transitions: running → disconnected → reconnecting → completed
- E2E tests: add SSH repo flow, verify form fields change, test connection button

**Checklist:**
- [x] Add unit tests for SSH repo CRUD in repos.test.ts
- [x] Add unit tests for legacy repo migration
- [x] Add tests for disconnect/reconnect state transitions
- [x] Add E2E test for SSH repo add flow
- [x] Verify: `npm test && npm run test:e2e`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Update RepoConfig to discriminated union (Rust) | Done |
| 2 | Update RepoConfig to discriminated union (Frontend) | Done |
| 3 | Update App.svelte to pass repo type to backend | Done |
| 4 | Update repo configuration UI for SSH | Done |
| 5 | SSH command helper module | Done |
| 6 | RuntimeProvider — add `run_command` method | Not Started |
| 7 | SshRuntime — RuntimeProvider implementation | Done |
| 8 | SshRuntime — reconnection methods | Done |
| 9 | SshSessionOrchestrator | Done |
| 10 | Tauri commands for SSH sessions | Done |
| 11 | Frontend session state — Disconnected and Reconnecting | Done |
| 12 | SSH runtime unit tests (Rust) | Done |
| 13 | Frontend tests for SSH repo flow | Done |
