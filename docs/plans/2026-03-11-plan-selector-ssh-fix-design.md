# Plan Selector SSH Fix + UX Improvements

## Problem

The plan selector dropdown doesn't work for SSH repos. `SshRuntime::run_command()` is a stub that always returns an error, and both `list_plans` and `move_plan_to_completed` depend on it. The frontend silently swallows the error (`catch { setPlans([]) }`), so it appears as if there are simply no plans.

Additionally, the plan selector has no loading feedback, no error display, and no distinction between "no plans found" and "failed to load plans".

## Design

### Backend: Implement `SshRuntime::run_command`

In `src-tauri/src/runtime/ssh.rs`, replace the stub with a real implementation:

- Wrap the command with `cd <working_dir> && <cmd>` for consistency with the local runtime
- Use the existing `ssh_command()` helper (handles WSL wrapping automatically)
- Pipe stdout and stderr
- Enforce the timeout parameter — kill the child process and return an error on timeout
- Return `CommandOutput { exit_code, stdout, stderr }`

This unblocks `list_plans` and `move_plan_to_completed` for SSH repos with no changes to those functions.

### Frontend: Loading, Error, and Empty States

In `src/pages/RepoDetail.tsx`:

**New state:**
- `plansLoading: boolean` — true while `fetchPlans` is in-flight
- `plansError: string | null` — error message from the last fetch attempt

**`fetchPlans` changes:**
- Set `plansLoading = true` on entry, `false` on completion
- On error: set `plansError` with the message, call `toast.error()` with the detailed error
- On success: clear `plansError`, set plans as before

**Dropdown UI changes:**
- While loading: show "Loading..." in the command list
- On error: show "Failed to load plans" in the empty slot
- Empty success: keep current "No plans found"
- Disable the trigger button while loading (`disabled={session.running || plansLoading}`)

## Files Changed

| File | Change |
|------|--------|
| `src-tauri/src/runtime/ssh.rs` | Implement `run_command` with SSH exec, `cd` wrapping, timeout |
| `src/pages/RepoDetail.tsx` | Add loading/error state, update `fetchPlans`, update dropdown UI, toast on error |

## Implementation Plan

### Task 1: Implement `SshRuntime::run_command`

Replace the stub in `src-tauri/src/runtime/ssh.rs` with a working implementation.

**Files to modify:** `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** `src-tauri/src/runtime/local.rs` lines 138-166 (`LocalRuntime::run_command`)

**Details:**
- Wrap command with `cd <working_dir> && <cmd>` using `shell_escape` for the directory path
- Use `ssh_command()` helper to build the SSH command (handles WSL wrapping)
- Pipe stdout and stderr, set `kill_on_drop(true)`
- Use `tokio::time::timeout` to enforce the timeout
- On timeout: bail with descriptive message (child killed via `kill_on_drop`)
- On success: return `CommandOutput { exit_code, stdout, stderr }`

**Checklist:**
- [x] Replace stub `run_command` with SSH implementation
- [x] Verify: `cd src-tauri && cargo check`
- [x] Verify: `cd src-tauri && cargo test`

---

### Task 2: Add loading/error state to plan selector

Update `fetchPlans` and the dropdown UI in `RepoDetail.tsx`.

**Files to modify:** `src/pages/RepoDetail.tsx`

**Pattern reference:** `src/pages/RepoDetail.tsx` lines 469-488 (existing `fetchPlans`), lines 1072-1119 (existing dropdown UI)

**Details:**
- Add `plansLoading` (boolean) and `plansError` (string | null) state
- In `fetchPlans`: set `plansLoading = true` at start, `false` in finally block
- On error: set `plansError` with the error string, call `toast.error(...)` with it
- On success: clear `plansError`, set plans as before
- In dropdown trigger: add `disabled={session.running || plansLoading}`
- In `CommandList`: if `plansLoading`, show "Loading..." item instead of plan items
- In `CommandEmpty`: show "Failed to load plans" if `plansError` is set, otherwise "No plans found"

**Checklist:**
- [x] Add `plansLoading` and `plansError` state variables
- [x] Update `fetchPlans` with loading/error handling and toast
- [x] Update dropdown trigger disabled state
- [x] Update `CommandList` with loading state
- [x] Update `CommandEmpty` with error vs empty distinction
- [x] Verify: `npx tsc --noEmit`

---

### Task 3: Tests

**Files to modify:** `src-tauri/src/lib.rs` (Rust tests), `src/pages/RepoDetail.test.tsx` (React tests)

**Pattern reference:** `src-tauri/src/lib.rs` lines 1528-1627 (existing `list_plans_impl` tests), `src/pages/RepoDetail.test.tsx` (existing toast tests around lines 441-537)

**Details:**
- Rust: Add a test that calls `list_plans_impl` with `SshRuntime` via mock or integration test if feasible
- React: Test that `fetchPlans` error shows toast and "Failed to load plans" in dropdown
- React: Test that loading state shows "Loading..." in dropdown

**Checklist:**
- [ ] Add Rust test for SSH `run_command` (if feasible without real SSH)
- [ ] Add React test for error state (toast + dropdown message)
- [ ] Add React test for loading state
- [ ] Verify: `cd src-tauri && cargo test`
- [ ] Verify: `npm test`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Implement `SshRuntime::run_command` | Done |
| 2 | Add loading/error state to plan selector UI | Done |
| 3 | Tests | Not Started |
