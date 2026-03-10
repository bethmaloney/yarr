# Fix SSH Remote Path Not Found

## Overview

When the user sets a remote SSH path (e.g., `/root/repos/yarr`) and runs the connection test, the **"Remote path exists"** step fails even though the directory exists on the remote machine.

### Root Cause Analysis

The recent `$SHELL -lc` login shell wrapping fix (added to `ssh_command()` in the "fix finding claude in SSH session" change) wraps **all** remote commands — including the `test -d` path check — in a login shell invocation. This introduces two potential failure modes:

1. **Login shell configuration errors**: The remote user's shell startup files (`.zshrc`, `.zprofile`, `.bash_profile`, etc.) may contain commands that fail or exit early. When `$SHELL -lc 'test -d ...'` runs, the login shell sources all startup files before executing the command. If any startup file calls `set -e` and a subsequent init step fails, or if a startup file exits early, the entire command fails even though `test -d` would succeed in a plain shell.

2. **Unnecessary complexity**: The `test -d` command only needs the `test` builtin (available in all POSIX shells without any PATH setup). Wrapping it in a login shell adds an extra shell invocation and startup file processing that can only introduce failures, never fix them. The login shell wrapper was specifically designed for commands like `command -v claude` that need the user's PATH — it's not needed for basic filesystem checks.

A secondary contributing factor may be **missing error diagnostics**: when `test -d` fails (exit code 1), the `test` command produces no stderr output, so the user sees only the unhelpful fallback message "Check failed" with no information about *why* the path check failed (permissions? doesn't exist? not a directory?).

### Solution

1. Add an `ssh_command_raw()` function that executes remote commands **without** the `$SHELL -lc` login shell wrapper — for commands that don't need the user's custom PATH.
2. Use `ssh_command_raw` for the "SSH reachable" and "Remote path exists" connection test steps, which only use builtins/standard binaries (`echo`, `test`).
3. Add diagnostic information when the path check fails, so the user sees *why* it failed (not just "Check failed").
4. Trim whitespace from the remote path before testing.

---

## Task 1: Add `ssh_command_raw()` function

**Files to modify:** `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** The existing `ssh_command()` at `ssh.rs:42-62`

### Checklist

- [x] Add a new `ssh_command_raw(host: &str, remote_cmd: &str) -> Command` function adjacent to `ssh_command()` (after line 62)
  - Unix branch: same as `ssh_command` but passes `remote_cmd` directly via `cmd.arg(remote_cmd)` — no `$SHELL -lc` wrapping
  - Windows branch: same but the `ssh_str` format uses `remote_cmd` directly (no `\\$SHELL -lc` wrapping, no `shell_escape(remote_cmd)`)
  - Add a doc comment explaining this variant is for commands that don't need the user's login shell PATH (builtins, standard `/usr/bin` commands)
- [x] Export `ssh_command_raw` from `src-tauri/src/runtime/mod.rs` (add to the `pub use ssh::` line at line 8)

### Implementation detail

**Unix:**
```rust
pub fn ssh_command_raw(host: &str, remote_cmd: &str) -> Command {
    if cfg!(target_os = "windows") {
        let ssh_str = format!(
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new {} {}",
            shell_escape(host),
            shell_escape(remote_cmd)
        );
        let mut cmd = Command::new("wsl");
        cmd.arg("-e").arg("bash").arg("-lc").arg(ssh_str);
        cmd
    } else {
        let mut cmd = Command::new("ssh");
        cmd.arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg(host)
            .arg(remote_cmd);
        cmd
    }
}
```

Note: On Unix, `remote_cmd` is passed as a single arg to SSH. SSH sends it to the remote, where sshd runs `<shell> -c "<remote_cmd>"`. The remote's non-interactive shell processes the command — but since we're only using builtins (`test`, `echo`), PATH doesn't matter.

On Windows/WSL, `shell_escape(remote_cmd)` is still needed for the local bash layer that processes the `ssh_str`, but there's no `$SHELL -lc` on the remote side.

---

## Task 2: Use `ssh_command_raw` for appropriate connection test steps

**Files to modify:** `src-tauri/src/lib.rs`

**Pattern reference:** `connection_test_steps()` at `lib.rs:365-372`

### Checklist

- [x] Import `ssh_command_raw` (update the `use runtime::` import at line 16)
- [x] Change step 1 ("SSH reachable") to use `ssh_command_raw` — `echo OK` doesn't need login shell PATH
- [x] Change step 4 ("Remote path exists") to use `ssh_command_raw` — `test -d` doesn't need login shell PATH
- [x] Keep steps 2 and 3 using `ssh_command` (login shell) — `command -v tmux` and `command -v claude` need the user's PATH

### Updated function

```rust
fn connection_test_steps(ssh_host: &str, remote_path: &str) -> Vec<(String, tokio::process::Command)> {
    let trimmed_path = remote_path.trim();
    vec![
        ("SSH reachable".to_string(), ssh_command_raw(ssh_host, "echo OK")),
        ("tmux available".to_string(), ssh_command(ssh_host, "command -v tmux")),
        ("claude available".to_string(), ssh_command(ssh_host, "command -v claude")),
        ("Remote path exists".to_string(), ssh_command_raw(
            ssh_host,
            &format!("test -d {} && echo OK", ssh_shell_escape(trimmed_path))
        )),
    ]
}
```

Note: Added `trimmed_path` to strip any leading/trailing whitespace from the path before using it. Also trimming in `test_ssh_connection_steps` for safety.

---

## Task 3: Improve path check error diagnostics

**Files to modify:** `src-tauri/src/lib.rs`

**Pattern reference:** `test_ssh_connection_steps()` at `lib.rs:374-398`

### Checklist

- [x] When the "Remote path exists" step fails, run a follow-up diagnostic command to determine **why** the path check failed:
  - Run: `ssh_command_raw(ssh_host, &format!("stat {} 2>&1 || echo 'PATH_NOT_FOUND'", ssh_shell_escape(remote_path)))`
  - Parse stdout to classify the error:
    - If stdout contains `No such file or directory` → "Directory does not exist: {path}"
    - If stdout contains `Permission denied` → "Permission denied: {path} (check SSH user permissions)"
    - If stdout contains `Not a directory` → "Path exists but is not a directory: {path}"
    - If stdout contains `PATH_NOT_FOUND` → "Directory not found: {path}"
    - Otherwise → show the raw stderr/stdout for debugging
- [x] Emit the descriptive error message instead of the generic "Check failed" fallback

### Implementation detail

Add a helper function:

```rust
async fn diagnose_path_failure(ssh_host: &str, remote_path: &str) -> String {
    let trimmed = remote_path.trim();
    let diag_cmd = format!(
        "if [ -e {} ]; then if [ -d {} ]; then echo PERM_ISSUE; else echo NOT_A_DIR; fi; else echo NOT_FOUND; fi",
        ssh_shell_escape(trimmed),
        ssh_shell_escape(trimmed)
    );
    let output = ssh_command_raw(ssh_host, &diag_cmd).output().await;
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            match stdout.as_str() {
                "NOT_FOUND" => format!("Directory does not exist: {trimmed}"),
                "NOT_A_DIR" => format!("Path exists but is not a directory: {trimmed}"),
                "PERM_ISSUE" => format!("Directory exists but is not accessible (check permissions): {trimmed}"),
                _ => format!("Path check failed for: {trimmed}"),
            }
        }
        Err(_) => format!("Path check failed for: {trimmed}"),
    }
}
```

Modify the main loop in `test_ssh_connection_steps` to call this diagnostic when the "Remote path exists" step fails:

```rust
} else {
    let error_msg = if step_name == "Remote path exists" {
        diagnose_path_failure(&ssh_host, &remote_path).await
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() { "Check failed".to_string() } else { stderr }
    };
    let _ = app.emit("ssh-test-step", SshTestStep {
        step: step_name,
        status: "fail".to_string(),
        error: Some(error_msg),
    });
    // ...
}
```

---

## Task 4: Add path trimming in `test_ssh_connection_steps`

**Files to modify:** `src-tauri/src/lib.rs`

**Pattern reference:** `test_ssh_connection_steps()` at `lib.rs:375`

### Checklist

- [x] Trim `remote_path` at the start of `test_ssh_connection_steps` before passing to `connection_test_steps`:
  ```rust
  let remote_path = remote_path.trim().to_string();
  ```
- [x] This defends against whitespace in the path from frontend input (the frontend already trims in `handleAddSshRepo` at `Home.tsx:69`, but the stored value might have whitespace from direct store edits or migration)

---

## Task 5: Add unit tests for `ssh_command_raw`

**Files to modify:** `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** Existing `ssh_command` tests at `ssh.rs:488-607`

### Checklist

- [x] Add `ssh_command_raw_creates_command_with_ssh_program` — verify program is `ssh` on Unix
- [x] Add `ssh_command_raw_includes_host_in_args` — verify host appears in args
- [x] Add `ssh_command_raw_includes_remote_command_in_args` — verify remote command appears
- [x] Add `ssh_command_raw_does_not_wrap_in_login_shell` — verify args do NOT contain `$SHELL -lc`
- [x] Add `ssh_command_raw_includes_batch_mode` — verify `-o BatchMode=yes` is present

---

## Task 6: Update connection test step tests

**Files to modify:** `src-tauri/src/lib.rs`

**Pattern reference:** Existing tests at `lib.rs:1254-1347`

### Checklist

- [x] Update `connection_test_steps_first_step_is_ssh_reachable` — verify it uses raw command (no `$SHELL -lc` in args)
- [x] Update `connection_test_steps_fourth_step_checks_remote_path` — verify it uses raw command (no `$SHELL -lc` in args)
- [x] Add `connection_test_steps_trims_remote_path_whitespace` — pass a path with leading/trailing spaces, verify the command contains the trimmed path
- [x] Verify steps 2 and 3 still use login shell (contain `$SHELL -lc` in args)

---

## Task 7: Verify with `cargo test` and `cargo check`

**Files:** N/A (verification step)

### Checklist

- [x] Run `cd src-tauri && cargo check` — no compilation errors
- [x] Run `cd src-tauri && cargo test` — all tests pass
- [x] Run `npx tsc --noEmit` — no TypeScript errors (no frontend files modified; node not available in env but no TS changes)

---

## Edge Cases & Considerations

### Why not remove `$SHELL -lc` from `ssh_command()` entirely?

The login shell wrapper is necessary for commands that depend on the user's PATH (like `command -v claude`, `claude -p`, tmux commands). The issue is that it was applied as a blanket wrapper to ALL remote commands, including simple ones that don't need it. The fix is surgical: only bypass the login shell for commands that don't need it.

### What if `test -d` fails for permissions?

With the diagnostic follow-up (Task 3), the user will see "Directory exists but is not accessible (check permissions)" instead of the generic "Check failed". This is the most likely cause for `/root/repos/yarr` — the SSH user may not have read+execute permissions on `/root/`.

### What about paths with special characters?

The `ssh_shell_escape()` function handles paths with spaces, quotes, and special characters. The raw SSH command still passes the escaped path correctly — the remote sshd shell processes the quoting. No change needed.

### What about the Windows/WSL branch?

The `ssh_command_raw` Windows branch still wraps the SSH invocation in `wsl -e bash -lc "ssh ..."` (to access the WSL SSH client), and `shell_escape(remote_cmd)` protects the command within that local bash invocation. The key difference is that no `$SHELL -lc` wrapper is added on the **remote** side.

### Will this affect other callers of `ssh_command`?

No. `ssh_command()` remains unchanged. Only `connection_test_steps()` is modified to use `ssh_command_raw` for specific steps. All other SSH operations (health check, tmux commands, tail, cleanup, abort handle) continue to use `ssh_command()` with the login shell wrapper.

---

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| Task 1: Add `ssh_command_raw()` | Done | New function without login shell wrapper |
| Task 2: Use `ssh_command_raw` in connection test | Done | Steps 1 and 4 use raw, steps 2 and 3 keep login shell |
| Task 3: Improve path check error diagnostics | Done | diagnose_path_failure with proper permission checks |
| Task 4: Add path trimming | Done | Defensive whitespace handling in test_ssh_connection_steps and connection_test_steps |
| Task 5: Unit tests for `ssh_command_raw` | Done | 5 new tests |
| Task 6: Update connection test step tests | Done | 4 updated tests + 1 new whitespace trimming test |
| Task 7: Verify with cargo test/check | Done | cargo check and cargo test pass (327 tests), no TS changes |
