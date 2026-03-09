# SSH Connection Visibility

Improve SSH connection feedback in two areas: pre-session connection testing and disconnect error messages during sessions.

## Pre-Session Connection Test

### Backend: Stepped Connection Test

New Tauri command `test_ssh_connection_steps` replaces the current `test_ssh_connection`. Emits events via Tauri's event system as each step completes for real-time frontend updates.

Steps run sequentially, stopping on first failure:

1. **SSH reachable** — `ssh -o BatchMode=yes host 'echo OK'`
2. **tmux available** — `ssh host 'command -v tmux'`
3. **claude available** — `ssh host 'command -v claude'`
4. **Remote path exists** — `ssh host 'test -d <remotePath> && echo OK'`

Each step emits an `ssh-test-step` event:
```rust
{ step: String, status: "pass" | "fail", error: Option<String> }
```

A final `ssh-test-complete` event signals the test is done.

Sequential SSH commands (rather than one combined command) allow pinpointing exactly which step fails. The `remotePath` check is new — the current health check doesn't verify the path exists.

### Frontend: Checklist UI

State tracked as a reactive variable on RepoDetail:

```typescript
type ConnectionTest = {
  running: boolean;
  steps: { name: string; status: "pending" | "running" | "pass" | "fail"; error?: string }[];
};
```

Behavior:
- Click "Test Connection" → initializes all 4 steps as "pending", first as "running"
- As each `ssh-test-step` event arrives, update that step and set next to "running"
- On `ssh-test-complete`, set `running: false`
- Button disabled while running

Display: A list below the `settings-actions` div inside the Settings accordion. Each step shows:
- Spinner (running) / checkmark (pass) / X (fail) + step name
- If failed: error message in muted red below that step
- Steps after a failure are grayed out

Checklist stays visible after completion for review. Resets on next click.

## Better Disconnect Feedback During Sessions

The `Disconnected` session event gets an optional `reason` field. When the SSH tail process dies, stderr and exit code are captured to produce a human-readable reason:

- Exit code 255 + "Connection refused" → `"SSH connection refused — is the host running?"`
- Exit code 255 + "No route to host" → `"Network unreachable — check your connection"`
- Exit code 255 + "Connection timed out" → `"SSH connection timed out"`
- Exit code 255 + other stderr → `"SSH disconnected: <stderr>"`
- Other exit codes → `"Remote process exited unexpectedly (code <N>)"`

The disconnect banner displays the reason:
```
Connection lost: SSH connection timed out
The remote session may still be running.
[Reconnect]
```

Same reconnect flow, same manual button — just better messaging.

---

## Implementation Plan

### Task 1: Backend — `test_ssh_connection_steps` Tauri command

Replace `test_ssh_connection` with a new command that runs each check step sequentially, emitting events as each completes.

**Files to modify:**
- `src-tauri/src/lib.rs`
- `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** `src-tauri/src/lib.rs:93-97` — event emission via `app_handle.emit()`

**Details:**
- Add a new Tauri command `test_ssh_connection_steps(app: tauri::AppHandle, ssh_host: String, remote_path: String)`
- Run 4 sequential checks using `ssh_command()` from `runtime::ssh`:
  1. SSH reachable: `ssh host 'echo OK'`
  2. tmux available: `ssh host 'command -v tmux'`
  3. claude available: `ssh host 'command -v claude'`
  4. Remote path exists: `ssh host 'test -d <path> && echo OK'`
- After each step, emit `app.emit("ssh-test-step", { step, status, error })` — stop on first failure
- Emit `app.emit("ssh-test-complete", {})` when done
- Remove old `test_ssh_connection` command, update `generate_handler!` macro
- The command should return `Result<(), String>` (results are communicated via events)

**Checklist:**
- [x] Add `test_ssh_connection_steps` command to `lib.rs`
- [x] Remove old `test_ssh_connection` command
- [x] Update `generate_handler!` registration
- [x] Verify with `cd src-tauri && cargo check`

---

### Task 2: Frontend — Wire up Test Connection button with checklist UI

Add connection test state, event listeners, and checklist display to RepoDetail.

**Files to modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** `src/App.svelte:112-143` — `listen()` for Tauri events; `src/RepoDetail.svelte:388` — existing Test Connection button

**Details:**
- Add `connectionTest` state: `{ running: boolean; steps: { name: string; status: "pending" | "running" | "pass" | "fail"; error?: string }[] }`
- Import `listen` from `@tauri-apps/api/event` and `invoke` (already imported)
- On "Test Connection" click: call `invoke("test_ssh_connection_steps", { sshHost: repo.sshHost, remotePath: repo.remotePath })`, initialize steps, listen for `ssh-test-step` and `ssh-test-complete` events
- Update step statuses as events arrive; set next pending step to "running" on pass
- On `ssh-test-complete`, set `running: false` and unlisten
- Render checklist below `settings-actions` div: spinner/checkmark/X + step name, error message on failure
- Disable button while `connectionTest.running`
- Clean up listener on component destroy if test is still running

**Checklist:**
- [x] Add `connectionTest` state variable
- [x] Add `testConnection()` async function with event listeners
- [x] Wire onclick to Test Connection button
- [x] Add checklist HTML below settings-actions
- [x] Add CSS for checklist (pass=green, fail=red, pending=gray, spinner animation)
- [x] Verify with `npx tsc --noEmit`

---

### Task 3: Backend — Add reason to Disconnected event

Capture stderr/exit code from the tail process and include a human-readable reason in the `Disconnected` event.

**Files to modify:**
- `src-tauri/src/session.rs`
- `src-tauri/src/ssh_orchestrator.rs`

**Pattern reference:** `src-tauri/src/ssh_orchestrator.rs:150-208` — `consume_events` method where disconnect is detected; `src-tauri/src/runtime/mod.rs:52-57` — `ProcessExit` struct with `exit_code` and `stderr`

**Details:**
- Add `reason: Option<String>` to `SessionEvent::Disconnected` variant in `session.rs`
- In `consume_events`, capture the `ProcessExit` on line 202 instead of discarding it
- Return the `ProcessExit` info alongside `ConsumeResult::Disconnected` (change enum to `Disconnected(ProcessExit)`)
- Add a `fn classify_disconnect(exit: &ProcessExit) -> String` helper that maps exit code + stderr patterns to human-readable messages:
  - Exit 255 + "Connection refused" → `"SSH connection refused — is the host running?"`
  - Exit 255 + "No route to host" → `"Network unreachable — check your connection"`
  - Exit 255 + "Connection timed out" → `"SSH connection timed out"`
  - Exit 255 + other → `"SSH disconnected: <stderr trimmed>"`
  - Other codes → `"Remote process exited unexpectedly (code N)"`
- Where `Disconnected` is emitted (line 326), use the new variant to populate the reason
- Update the second `ConsumeResult::Disconnected` match (line 351) similarly

**Checklist:**
- [x] Add `reason: Option<String>` to `Disconnected` variant in `session.rs`
- [x] Change `ConsumeResult::Disconnected` to carry `ProcessExit`
- [x] Update `consume_events` to capture and return `ProcessExit`
- [x] Add `classify_disconnect` helper function
- [x] Update both match arms for `ConsumeResult::Disconnected` in `run()`
- [x] Verify with `cd src-tauri && cargo check`

---

### Task 4: Frontend — Display disconnect reason in banner

Show the disconnect reason in the banner and event state.

**Files to modify:**
- `src/App.svelte`
- `src/RepoDetail.svelte`
- `src/types.ts`

**Pattern reference:** `src/RepoDetail.svelte:557-561` — existing disconnect banner; `src/App.svelte:126-129` — disconnect event handling

**Details:**
- Add `disconnectReason?: string` to `SessionState` in `types.ts`
- In `App.svelte`, when handling `disconnected` event kind, capture `event.reason` into `updates.disconnectReason`
- Clear `disconnectReason` when reconnecting or session completes
- In `RepoDetail.svelte`, update the disconnect banner to show the reason:
  - `"Connection lost: {reason}"` if reason exists, else `"Connection lost"` as fallback
  - Keep the existing "the remote session may still be running" line
- The `reason` field already exists on `SessionEvent` type (line 41 of types.ts), so no change needed there

**Checklist:**
- [x] Add `disconnectReason` to `SessionState` in `types.ts`
- [x] Update disconnect handling in `App.svelte` to capture reason
- [x] Clear `disconnectReason` on reconnect/complete
- [x] Update disconnect banner in `RepoDetail.svelte` to display reason
- [x] Verify with `npx tsc --noEmit`

---

### Task 5: Tests — Backend Rust tests

Add tests for the new `classify_disconnect` function and verify the `Disconnected` event includes a reason.

**Files to modify:**
- `src-tauri/src/ssh_orchestrator.rs` (test module)

**Pattern reference:** `src-tauri/src/ssh_orchestrator.rs:1074-1090` — existing `test_health_check_failure` test

**Details:**
- Test `classify_disconnect` with various exit code + stderr combos
- Test that `ConsumeResult::Disconnected` variant now carries `ProcessExit`
- Update any existing tests that match on `ConsumeResult::Disconnected` to handle the new shape

**Checklist:**
- [x] Add unit tests for `classify_disconnect` (5+ cases) — done in Task 3 TDD
- [x] Update existing tests that reference `ConsumeResult::Disconnected` — done in Task 3 TDD
- [x] Verify with `cd src-tauri && cargo test`

---

### Task 6: Tests — E2E tests for connection test checklist

Add E2E tests for the Test Connection checklist flow.

**Files to modify:**
- `e2e/ssh-repo.test.ts`

**Pattern reference:** `e2e/ssh-repo.test.ts:215-239` — existing `emitSessionEvent` helper and disconnect test

**Details:**
- Test: click Test Connection → checklist appears with steps
- Mock `test_ssh_connection_steps` invoke → emit `ssh-test-step` events → verify UI updates
- Test all-pass scenario: all steps show checkmarks
- Test failure scenario: failed step shows X with error message, subsequent steps grayed
- Test that disconnect banner now shows reason text

**Checklist:**
- [ ] Add test for successful connection test flow
- [ ] Add test for failed connection test flow with error message
- [x] Add test for disconnect banner showing reason — done in Task 4 TDD
- [ ] Verify with `npm run test:e2e`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Backend — `test_ssh_connection_steps` command | Done |
| 2 | Frontend — Test Connection checklist UI | Done |
| 3 | Backend — Add reason to Disconnected event | Done |
| 4 | Frontend — Display disconnect reason in banner | Done |
| 5 | Tests — Backend Rust tests | Done |
| 6 | Tests — E2E tests for connection checklist | Not Started |

**Notes:**
- SSH commands in `ssh_command()` have no `ConnectTimeout` — if a host silently drops packets, the test step will hang indefinitely. Consider adding `-o ConnectTimeout=10` as a follow-up improvement.
