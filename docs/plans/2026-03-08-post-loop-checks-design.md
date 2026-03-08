# Post-Loop Checks

## Summary

Add configurable checks (linters, formatters, tests) that run after loop iterations. When a check fails, Yarr spawns a fix agent to resolve the issue automatically. Checks are configured per-repo in the store.

## Motivation

The `run_ralph.sh` script in rust-sqlpackage runs `cargo clippy` after every iteration and spawns a Claude agent to fix failures. This pattern is valuable but currently hardcoded. Different repos need different checks (clippy for Rust, ESLint for JS, pytest for Python, etc.). Yarr should support this generically.

## Data Model

### Check

```rust
struct Check {
    name: String,            // e.g. "clippy", "e2e tests"
    command: String,          // e.g. "cargo clippy --all-targets -- -D warnings"
    when: CheckWhen,          // EachIteration | PostCompletion
    prompt: Option<String>,   // custom fix prompt (command output appended automatically)
    model: Option<String>,    // defaults to parent session model
    timeout_secs: u32,        // default: 1200 (20 minutes)
    max_retries: u32,         // default: 3
}

enum CheckWhen {
    EachIteration,
    PostCompletion,
}
```

TypeScript equivalent:

```typescript
type Check = {
  name: string;
  command: string;
  when: "each_iteration" | "post_completion";
  prompt?: string;
  model?: string;
  timeoutSecs: number;
  maxRetries: number;
};
```

### Config Integration

`RepoConfig` gains a `checks: Check[]` field (default empty). `SessionConfig` gains a `checks: Vec<Check>` field, passed through from the frontend via the `run_session` Tauri command.

## Runtime Extension

`RuntimeProvider` gets a new method for running arbitrary shell commands:

```rust
async fn run_command(
    &self,
    command: &str,
    working_dir: &Path,
    timeout: Duration,
) -> Result<CommandOutput>;

struct CommandOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}
```

Implementations:
- **LocalRuntime** — `bash -c "{command}"` in the working directory
- **WslRuntime** — `wsl bash -c "cd {path} && {command}"`
- **SshRuntime** — stub for now, to be implemented when SSH runtime lands
- **MockRuntime** — configurable success/failure for tests

Timeout is enforced at this level. If the command exceeds the timeout, the process is killed and a timeout error is returned.

## Session Events

New event variants for frontend visibility:

```rust
CheckStarted {
    iteration: u32,
    check_name: String,
},
CheckPassed {
    iteration: u32,
    check_name: String,
},
CheckFailed {
    iteration: u32,
    check_name: String,
    output: String,
},
CheckFixStarted {
    iteration: u32,
    check_name: String,
    attempt: u32,
},
CheckFixComplete {
    iteration: u32,
    check_name: String,
    attempt: u32,
    success: bool,
},
```

These integrate into the existing `EventsList` component on the frontend.

## Session Runner Integration

A new method on `SessionRunner`:

```rust
async fn run_checks(
    &self,
    runtime: &dyn RuntimeProvider,
    iteration: u32,
    when: CheckWhen,
    checks: &[Check],
) -> Vec<CheckResult>
```

Called at two points in the loop:

1. **After each successful iteration** (before the inter-iteration delay) — runs checks where `when == EachIteration`
2. **After the loop completes with a completion signal** — runs checks where `when == PostCompletion`

### Check Execution Flow

For each matching check:

1. Emit `CheckStarted`
2. Call `runtime.run_command(check.command, ...)` with the check's timeout
3. If exit code 0 — emit `CheckPassed`, done
4. If non-zero — emit `CheckFailed` with combined stdout+stderr
5. Retry loop (up to `max_retries`):
   a. Build fix prompt (custom or default template, with command output appended)
   b. Emit `CheckFixStarted`
   c. Spawn Claude fix agent via `runtime.spawn_claude(...)` using the check's model (or parent session model), with `--dangerously-skip-permissions`
   d. Emit `CheckFixComplete`
   e. Re-run the check command
   f. If passes — emit `CheckPassed`, break
6. If all retries exhausted — log and **continue** (do not fail the session)

Checks do not count toward the iteration limit.

## Default Fix Prompt

When no custom prompt is set:

```
The following check failed after a loop iteration.

**Check:** {name}
**Command:** {command}

**Output:**
```
{stdout+stderr}
```

Fix the issues shown above. After fixing, run `{command}` to verify your fixes pass. Commit any changes with an appropriate message.
```

When a custom prompt is provided, the command output is appended:

```
{custom_prompt}

**Check output:**
```
{stdout+stderr}
```
```

## Frontend UI

The `RepoDetail.svelte` settings section gains a "Checks" subsection:

- List of configured checks, each shown as a collapsible entry
- "Add Check" button creates a new entry with defaults
- Each entry has fields: name, command, when (dropdown), prompt (textarea, optional), model (optional), timeout, max retries
- Remove button per check
- Disabled while a session is running

## Decisions

- **Retry then continue** — if a check still fails after all retries, the session continues. The main loop agent may fix the issue naturally.
- **Store-based config** — checks live in the per-repo config store. YAML/JSON file-based config is a future enhancement.
- **Fix agent model** — defaults to the parent session's model, overridable per-check.
- **Check commands go through RuntimeProvider** — necessary for WSL/SSH support. They don't run as local shell commands directly.

---

## Implementation Plan

### Task 1: Add Check data model (Rust)

Add the `Check` struct and `CheckWhen` enum to the Rust backend.

**Files to create/modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `SessionConfig` at `src-tauri/src/session.rs:11-23`

**Details:**
- Add `CheckWhen` enum with `EachIteration` and `PostCompletion` variants, serde-tagged as `"each_iteration"` / `"post_completion"`
- Add `Check` struct with fields: `name`, `command`, `when`, `prompt` (Option), `model` (Option), `timeout_secs` (u32, default 1200), `max_retries` (u32, default 3)
- Derive `Debug, Clone, serde::Serialize, serde::Deserialize` on both
- Add `Default` impl for `Check` with sensible defaults for timeout and retries

**Checklist:**
- [x] Add `CheckWhen` enum
- [x] Add `Check` struct
- [x] Add `checks: Vec<Check>` field to `SessionConfig`
- [x] Update `SessionConfig::default()` to include `checks: Vec::new()`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 2: Add CommandOutput and run_command to RuntimeProvider trait

Extend the runtime abstraction with a method for running arbitrary shell commands.

**Files to create/modify:**
- `src-tauri/src/runtime/mod.rs`

**Pattern reference:** `RuntimeProvider::spawn_claude` at `src-tauri/src/runtime/mod.rs:71-82`

**Details:**
- Add `CommandOutput` struct with `exit_code: i32`, `stdout: String`, `stderr: String`
- Add `async fn run_command(&self, command: &str, working_dir: &Path, timeout: Duration) -> Result<CommandOutput>` to the `RuntimeProvider` trait
- Use `std::time::Duration` for the timeout parameter
- Derive `Debug, Clone` on `CommandOutput`

**Checklist:**
- [x] Add `CommandOutput` struct
- [x] Add `run_command` method to `RuntimeProvider` trait
- [x] Verify: `cd src-tauri && cargo check` (will fail until implementations added — that's expected, just confirm the trait compiles)

---

### Task 3: Implement run_command for LocalRuntime

**Files to create/modify:**
- `src-tauri/src/runtime/local.rs`

**Pattern reference:** `LocalRuntime::spawn_claude` at `src-tauri/src/runtime/local.rs:28-120`

**Details:**
- Spawn `bash -c "{command}"` with `current_dir` set to `working_dir`
- Capture stdout and stderr
- Use `tokio::time::timeout` to enforce the timeout; if exceeded, kill the child and return an error
- Return `CommandOutput` with exit code, stdout, stderr

**Checklist:**
- [x] Implement `run_command` for `LocalRuntime`
- [x] Handle timeout with process kill
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 4: Implement run_command for WslRuntime

**Files to create/modify:**
- `src-tauri/src/runtime/wsl.rs`

**Pattern reference:** `WslRuntime::spawn_claude` at `src-tauri/src/runtime/wsl.rs:82-176`

**Details:**
- Build command as `wsl -e bash -lc "cd {path} && {command}"` using the existing `to_wsl_path` and `shell_escape` helpers
- Capture stdout and stderr
- Enforce timeout the same way as LocalRuntime
- Return `CommandOutput`

**Checklist:**
- [x] Implement `run_command` for `WslRuntime`
- [x] Reuse existing `to_wsl_path` and `shell_escape` helpers
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 5: Implement run_command for MockRuntime

**Files to create/modify:**
- `src-tauri/src/runtime/mock.rs`

**Pattern reference:** `MockRuntime::completing_after` at `src-tauri/src/runtime/mock.rs:24-44`

**Details:**
- Add a configurable field to MockRuntime: `command_results: Vec<CommandOutput>` (or similar)
- Default to returning success (exit code 0, empty stdout/stderr) when no results configured
- Add a builder method like `with_command_results(results: Vec<CommandOutput>)` for tests to configure failure/success sequences
- Use an `AtomicUsize` counter (like `call_count`) to cycle through results

**Checklist:**
- [x] Add `command_results` field and counter to `MockRuntime`
- [x] Add builder method for configuring command results
- [x] Implement `run_command` for `MockRuntime`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 6: Add check-related SessionEvent variants

Add event types so the frontend can display check progress.

**Files to create/modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `SessionEvent` enum at `src-tauri/src/session.rs:53-72`

**Details:**
- Add variants: `CheckStarted { iteration: u32, check_name: String }`, `CheckPassed { iteration: u32, check_name: String }`, `CheckFailed { iteration: u32, check_name: String, output: String }`, `CheckFixStarted { iteration: u32, check_name: String, attempt: u32 }`, `CheckFixComplete { iteration: u32, check_name: String, attempt: u32, success: bool }`
- These serialize as `check_started`, `check_passed`, etc. via the existing `rename_all = "snake_case"` serde config

**Checklist:**
- [x] Add all five check event variants to `SessionEvent`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 7: Add run_checks method to SessionRunner

Core logic for executing checks and spawning fix agents.

**Files to create/modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `SessionRunner::run_iteration` at `src-tauri/src/session.rs:316-403`

**Details:**
- Add `async fn run_checks(&self, runtime: &dyn RuntimeProvider, iteration: u32, when: CheckWhen, checks: &[Check])` method
- Filter checks by `when` field
- For each matching check:
  1. Emit `CheckStarted`
  2. Call `runtime.run_command(check.command, self.config.repo_path, Duration::from_secs(check.timeout_secs))`
  3. If exit code 0 → emit `CheckPassed`, continue to next check
  4. If non-zero → emit `CheckFailed` with combined stdout+stderr
  5. Retry loop up to `max_retries`:
     - Build fix prompt (default template or custom + output appended)
     - Emit `CheckFixStarted`
     - Build a `ClaudeInvocation` with the fix prompt, check's model (or fall back to `self.config.model`), and `--dangerously-skip-permissions`
     - Call `runtime.spawn_claude(...)` and wait for completion
     - Emit `CheckFixComplete`
     - Re-run the check command
     - If passes → emit `CheckPassed`, break
  6. If all retries exhausted → log warning, continue (don't fail session)
- Add a helper `fn build_fix_prompt(check: &Check, output: &str) -> String` that builds the prompt per the design doc template

**Checklist:**
- [x] Add `build_fix_prompt` helper
- [x] Add `run_checks` method
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 8: Integrate run_checks into the session loop

Wire `run_checks` into the two call sites in `SessionRunner::run`.

**Files to create/modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `SessionRunner::run` loop at `src-tauri/src/session.rs:149-275`

**Details:**
- **After each successful iteration** (after `IterationComplete` emit, before inter-iteration delay at line 225): call `self.run_checks(runtime, iteration, CheckWhen::EachIteration, &self.config.checks).await`
- **After the loop completes with Completed state** (after `state = SessionState::Completed` at line 209, before the main loop `break`): call `self.run_checks(runtime, iteration, CheckWhen::PostCompletion, &self.config.checks).await`
- Checks should respect cancellation — if cancelled, skip remaining checks

**Checklist:**
- [x] Add EachIteration check call after iteration success
- [x] Add PostCompletion check call after completion signal detected
- [x] Ensure cancellation is respected during checks
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 9: Pass checks through the Tauri command

Wire checks from the frontend IPC call through to `SessionConfig`.

**Files to create/modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `run_session` command at `src-tauri/src/lib.rs:76-143`

**Details:**
- Add `checks: Vec<session::Check>` parameter to `run_session` command
- Pass it into `SessionConfig { checks, .. }`
- The `run_mock_session` command should pass `checks: Vec::new()` (no checks for mock runs)
- `Check` needs to be deserializable from the frontend JSON (already handled by serde derives)

**Checklist:**
- [x] Add `checks` parameter to `run_session`
- [x] Wire checks into `SessionConfig`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 10: Add Check type to frontend and update RepoConfig

**Files to create/modify:**
- `src/types.ts`
- `src/repos.ts`

**Pattern reference:** `RepoConfig` types at `src/repos.ts:5-26`, `SessionEvent` at `src/types.ts:1-11`

**Details:**
- In `types.ts`: add `Check` type with fields: `name: string`, `command: string`, `when: "each_iteration" | "post_completion"`, `prompt?: string`, `model?: string`, `timeoutSecs: number`, `maxRetries: number`
- In `types.ts`: add new optional fields to `SessionEvent` for check events: `check_name?: string`, `output?: string`, `attempt?: number`, `success?: boolean`
- In `repos.ts`: add `checks: Check[]` to both `LocalRepoConfig` and `SshRepoConfig`
- In `repos.ts`: update `addLocalRepo` and `addSshRepo` to include `checks: []` in defaults
- In `repos.ts`: handle migration in `loadRepos` — if a repo has no `checks` field, default to `[]`

**Checklist:**
- [x] Add `Check` type to `types.ts`
- [x] Add check-related fields to `SessionEvent`
- [x] Add `checks` field to both repo config types
- [x] Update `addLocalRepo` and `addSshRepo` defaults
- [x] Add migration fallback in `loadRepos`
- [x] Verify: `npx tsc --noEmit`

---

### Task 11: Add Checks settings UI to RepoDetail

Add the "Checks" subsection to the repo settings panel.

**Files to create/modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** Settings `<details>` block at `src/RepoDetail.svelte:86-132`

**Details:**
- Add a new `<details class="checks">` section after the existing settings details
- Summary shows "Checks — N configured"
- List each check as a collapsible entry with fields: name (text input), command (text input), when (select dropdown: "each_iteration" / "post_completion"), prompt (textarea, optional), model (text input, optional), timeout (number input, default 1200), max retries (number input, default 3)
- "Add Check" button appends a new check with defaults
- Remove button (X) per check
- All fields disabled while `session.running`
- On changes, update the local `checks` state; save via `saveSettings` alongside other config
- Wire `checks` into the `onRun` flow — pass through `onUpdateRepo` so they're in the repo config

**Checklist:**
- [x] Add local `checks` state initialized from `repo.checks`
- [x] Add Checks `<details>` section with list of check entries
- [x] Add "Add Check" button
- [x] Add remove button per check
- [x] Add form fields for each check property
- [x] Wire into `saveSettings`
- [x] Disable all fields when running
- [x] Verify: `npx tsc --noEmit`

---

### Task 12: Pass checks from App.svelte to run_session invoke

Wire the checks from repo config through the Tauri IPC call.

**Files to create/modify:**
- `src/App.svelte`

**Pattern reference:** `handleRunSession` in `src/App.svelte` (the `invoke("run_session", ...)` call)

**Details:**
- Read `checks` from the repo config
- Convert from frontend format (`timeoutSecs`, `maxRetries`) to the Rust serde format (`timeout_secs`, `max_retries`) — these should match since Rust uses `rename_all = "camelCase"` or snake_case; verify which serde naming the Check struct uses and align
- Pass `checks` as a parameter to the `invoke("run_session", { ..., checks })` call

**Checklist:**
- [x] Add `checks` to the invoke parameters
- [x] Ensure field naming matches between frontend and Rust serde
- [x] Verify: `npx tsc --noEmit`

---

### Task 13: Display check events in EventsList

Add visual treatment for check-related events.

**Files to create/modify:**
- `src/EventsList.svelte`

**Pattern reference:** `eventEmoji` and `eventLabel` functions at `src/EventsList.svelte:12-68`

**Details:**
- Add cases to `eventEmoji`: `check_started` → clipboard/magnifying glass, `check_passed` → green check, `check_failed` → red X, `check_fix_started` → wrench, `check_fix_complete` → appropriate icon
- Add cases to `eventLabel`: show check name, output preview for failures, attempt number for fix events
- Add CSS color classes for the new event kinds (green for passed, red for failed, orange for fix)
- For `check_failed` events with `output`, show the output in an expandable detail (similar to `tool_input` expansion)

**Checklist:**
- [x] Add emoji mappings for all 5 check event kinds
- [x] Add label formatting for all 5 check event kinds
- [x] Add CSS color classes for check events
- [x] Add expandable output detail for `check_failed` events
- [x] Verify: `npx tsc --noEmit`

---

### Task 14: Rust tests for run_command and run_checks

**Files to create/modify:**
- `src-tauri/src/session.rs` (add tests to existing `#[cfg(test)]` module)
- `src-tauri/src/runtime/mock.rs` (add tests if needed)

**Pattern reference:** `run_accumulates_events_to_disk` test at `src-tauri/src/session.rs:413-477`

**Details:**
- Test `MockRuntime::run_command` returns configured results
- Test `run_checks` with a passing check — emits `CheckStarted` + `CheckPassed`
- Test `run_checks` with a failing check that gets fixed on retry — emits `CheckStarted` + `CheckFailed` + `CheckFixStarted` + `CheckFixComplete` + `CheckPassed`
- Test `run_checks` with a failing check that exhausts retries — emits failure events, session continues
- Test `run_checks` filters by `CheckWhen` correctly
- Test `build_fix_prompt` with default and custom prompts

**Checklist:**
- [x] Test MockRuntime run_command
- [x] Test passing check flow
- [x] Test failing check with successful retry
- [x] Test failing check exhausting retries
- [x] Test CheckWhen filtering
- [x] Test build_fix_prompt
- [x] Verify: `cd src-tauri && cargo test`

---

### Task 15: Frontend unit tests for Check types

**Files to create/modify:**
- `src/types.test.ts` or `src/repos.test.ts` (whichever exists, or add to existing)

**Pattern reference:** Existing vitest test files in `src/*.test.ts`

**Details:**
- Test that `Check` type has expected shape
- Test that `RepoConfig` with `checks` field serializes/deserializes correctly
- Test `loadRepos` migration — a repo without `checks` field gets `checks: []`

**Checklist:**
- [x] Add Check type shape tests
- [x] Add migration fallback test
- [x] Verify: `npm test`

---

### Task 16: E2E tests for check configuration UI

**Files to create/modify:**
- `e2e/checks.test.ts` (new file)

**Pattern reference:** `e2e/home.test.ts` and `e2e/fixtures.ts`

**Details:**
- Test that Checks section appears in RepoDetail
- Test adding a new check via the "Add Check" button
- Test removing a check
- Test that check fields are disabled while a session is running
- Test that check events appear in the EventsList during a mock run (may need to extend mock fixtures to emit check events)

**Checklist:**
- [x] Test Checks section renders
- [x] Test add check interaction
- [x] Test remove check interaction
- [x] Test disabled state during run
- [x] Verify: `npm run test:e2e`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Check data model (Rust) | Done |
| 2 | CommandOutput + run_command trait method | Done |
| 3 | LocalRuntime run_command | Done |
| 4 | WslRuntime run_command | Done |
| 5 | MockRuntime run_command | Done |
| 6 | Check SessionEvent variants | Done |
| 7 | run_checks method on SessionRunner | Done |
| 8 | Integrate run_checks into session loop | Done |
| 9 | Pass checks through Tauri command | Done |
| 10 | Frontend Check type + RepoConfig update | Done |
| 11 | Checks settings UI in RepoDetail | Done |
| 12 | Pass checks from App.svelte to invoke | Done |
| 13 | Display check events in EventsList | Done |
| 14 | Rust tests for run_command and run_checks | Done |
| 15 | Frontend unit tests for Check types | Done |
| 16 | E2E tests for check configuration UI | Done |
