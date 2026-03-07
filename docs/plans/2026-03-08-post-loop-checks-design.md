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
