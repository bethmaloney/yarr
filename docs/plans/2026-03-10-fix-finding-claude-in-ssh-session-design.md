# Fix Finding Claude in SSH Session

## Overview

When Yarr tests an SSH connection (e.g., to "hetzner"), it runs `ssh hetzner "command -v claude"` which fails to find the `claude` binary — even though `which claude` works in an interactive SSH session.

**Root cause:** The `ssh_command()` function in `src-tauri/src/runtime/ssh.rs` executes remote commands in a **non-interactive, non-login shell**. When SSH receives a command to execute, `sshd` runs the user's shell with `-c command` (e.g., `zsh -c "command -v claude"`). In this mode:

- **zsh** only sources `~/.zshenv`, NOT `~/.zshrc`
- **bash** sources nothing (unless `BASH_ENV` is set), NOT `~/.bashrc` or `~/.bash_profile`
- **fish** only sources `~/.config/fish/conf.d/` but NOT interactive config

The user has `export PATH="$HOME/.local/bin:$PATH"` in their `~/.zshrc`, which is never sourced during non-interactive SSH command execution. This affects:

1. **Connection test** (`lib.rs:369`) — `command -v claude` fails
2. **Health check** (`ssh.rs:154-158`) — `command -v tmux && command -v claude` fails
3. **Session execution** — `claude` invocation inside tmux may fail if tmux inherits a non-login environment
4. **Abort handle** (`ssh.rs:71-96`) — `tmux kill-session` is fine (tmux is typically in `/usr/bin`), but this code duplicates `ssh_command` logic and should be kept consistent

## Solution

Wrap all remote commands in a **login shell invocation**: `$SHELL -lc '<command>'`

This causes the remote user's login shell to source its full startup files (`.zshrc`, `.bash_profile`, `.profile`, etc.) before executing the actual command, ensuring `PATH` and other environment variables are properly set.

### Why `$SHELL -lc` is correct

- `$SHELL` is always set by `sshd` from the user's `/etc/passwd` entry — it's available even in non-interactive mode
- `-l` makes it a login shell (sources all startup files)
- `-c` passes the command to execute
- Works across bash, zsh, fish, and other POSIX shells
- On Unix, `ssh_command` uses `.arg()` to pass the remote command, so `$SHELL` is NOT expanded locally — it arrives on the remote where `sshd`'s non-login shell expands it
- On Windows/WSL, the command goes through local `bash -lc`, so `$` must be escaped (`\$SHELL`) to prevent local expansion

### Quoting correctness

The existing `shell_escape()` function wraps strings in single quotes and escapes embedded single quotes. The remote command flow becomes:

```
ssh host "$SHELL -lc 'original_remote_cmd_escaped'"
```

For a tmux command with nested quoting:
```
$SHELL -lc 'tmux new-session -d -s yarr-id '\''cd /path && claude -p ...'\'''
```

The login shell parses this correctly, reconstructing the original `remote_cmd`, and then executes it with full PATH available.

---

## Task 1: Wrap remote commands in login shell in `ssh_command()`

**Files to modify:** `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** The existing `shell_escape()` at `ssh.rs:22-24` handles single-quote escaping

### Checklist

- [x] Modify `ssh_command()` (line 37-57) to wrap `remote_cmd` in a login shell:
  - Unix path: change line 54 from `.arg(remote_cmd)` to `.arg(format!("$SHELL -lc {}", shell_escape(remote_cmd)))`
  - Windows path: change the `ssh_str` format to use `\\$SHELL -lc {}` (escaped `$` to prevent local WSL bash expansion), with `shell_escape(remote_cmd)` for the inner command
- [x] Update the doc comment (lines 26-36) to mention the login shell wrapping and why it exists

### Implementation detail

**Unix (current):**
```rust
let mut cmd = Command::new("ssh");
cmd.arg("-o").arg("BatchMode=yes")
   .arg("-o").arg("StrictHostKeyChecking=accept-new")
   .arg(host)
   .arg(remote_cmd);  // <-- non-login shell on remote
```

**Unix (fix):**
```rust
let mut cmd = Command::new("ssh");
cmd.arg("-o").arg("BatchMode=yes")
   .arg("-o").arg("StrictHostKeyChecking=accept-new")
   .arg(host)
   .arg(format!("$SHELL -lc {}", shell_escape(remote_cmd)));
```

**Windows (current):**
```rust
let ssh_str = format!(
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new {} {}",
    shell_escape(host),
    remote_cmd
);
```

**Windows (fix):**
```rust
let ssh_str = format!(
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new {} \\$SHELL -lc {}",
    shell_escape(host),
    shell_escape(remote_cmd)
);
```

Note: `\\$SHELL` in Rust produces `\$SHELL` in the output string. Local bash interprets `\$` as literal `$`, so the remote receives `$SHELL -lc '...'` which is correctly expanded by `sshd`.

---

## Task 2: Fix the `SshAbortHandle` to match

**Files to modify:** `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** The `SshAbortHandle::abort()` at `ssh.rs:71-96` duplicates SSH command construction (uses `std::process::Command` instead of `tokio::process::Command`, so it can't call `ssh_command()`)

### Checklist

- [x] Update the Unix branch of `SshAbortHandle::abort()` (lines 85-92) to wrap `kill_cmd` in login shell: change `.arg(&kill_cmd)` to `.arg(format!("$SHELL -lc {}", shell_escape(&kill_cmd)))`
- [x] Update the Windows branch (lines 76-83) to use `\\$SHELL -lc` with `shell_escape(&kill_cmd)` in the `ssh_str` format string

### Note

While `tmux kill-session` is likely in the default PATH, keeping the abort handle consistent with `ssh_command()` prevents future issues if tmux is installed in a non-standard location.

---

## Task 3: Update existing unit tests

**Files to modify:** `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** Existing `ssh_command` tests at `ssh.rs:481-601`

### Checklist

- [x] Update `ssh_command_includes_remote_command_in_args` (line 517): no change needed — assertion uses `.contains("ls -la")` which matches inside the `$SHELL -lc 'ls -la'` wrapper
- [x] Update `ssh_command_remote_cmd_with_spaces` (line 571): no change needed — assertion uses `.contains("cat /etc/hostname")` which matches inside the wrapper
- [x] Update other tests that inspect the args of `ssh_command` to account for the login shell wrapper:
  - `ssh_command_includes_batch_mode_option` (line 530) — passes unchanged
  - `ssh_command_includes_strict_host_key_checking_option` (line 544) — passes unchanged
  - `ssh_command_includes_host_in_args` (line 504) — passes unchanged
  - `ssh_command_creates_command_with_ssh_program` (line 484) — passes unchanged
  - `ssh_command_with_user_at_host` (line 558) — passes unchanged
  - `ssh_command_on_unix_does_not_use_wsl` (line 585) — passes unchanged

### New tests to add

- [x] Add `ssh_command_wraps_in_login_shell` — verify the remote command arg contains `$SHELL -lc` and the original command is shell-escaped within it
- [x] Add `ssh_command_login_shell_escapes_single_quotes` — verify a remote command containing single quotes (e.g., `echo 'hello'`) is correctly double-escaped for the login shell wrapper
- [x] Add `ssh_command_login_shell_preserves_dollar_sign` — verify that `$SHELL` literal appears in the arg on Unix (not expanded locally)

---

## Task 4: Update `build_*` method tests

**Files to modify:** `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** Tests for `build_tmux_command`, `build_health_check_command`, etc. starting around line 604

### Checklist

- [x] Review and update any tests that assert on the exact args of commands built by `build_health_check_command`, `build_tmux_command`, `build_mkdir_command`, etc. — these will now have the login shell wrapper. All existing tests use `.contains()` assertions that match content inside the wrapper, so no changes needed.
- [x] For `build_tmux_command` tests: verified nested quoting is correct — tmux body survives two layers of `shell_escape` (one for tmux, one for login shell). All 11 tmux tests pass.
- [x] For `build_health_check_command` tests: verified the combined `command -v tmux && command -v claude && echo OK` is properly wrapped. Both health check tests pass.

---

## Task 5: Update `connection_test_steps` tests

**Files to modify:** `src-tauri/src/lib.rs`

**Pattern reference:** Test at `lib.rs:1260` — `connection_test_steps_first_step_is_ssh_reachable`

### Checklist

- [x] Review the test to ensure it still passes — it checks step names, not command args, so it is unaffected. All 314 tests pass.
- [x] Consider adding a test that verifies the "claude available" step's command includes the login shell wrapper (optional, as this is implicitly tested by `ssh_command` unit tests) — skipped, implicitly covered.

---

## Task 6: Verify with `cargo test` and `cargo check`

**Files:** N/A (verification step)

### Checklist

- [x] Run `cd src-tauri && cargo check` — no compilation errors
- [x] Run `cd src-tauri && cargo test` — all 314 tests pass (including 3 new tests)
- [x] Run `npx tsc --noEmit` — skipped (no Linux node/npm in worktree; no frontend files modified)

---

## Edge Cases & Considerations

### What if `$SHELL` is unset on the remote?

`$SHELL` is set by `sshd` from `/etc/passwd` — it's always available. If somehow unset, the command would fail with "command not found" for the empty string, which is a reasonable error. This is an extremely unlikely edge case.

### What about tmux session environment?

When `$SHELL -lc 'tmux new-session ...'` runs:
1. The login shell sources profiles, setting PATH correctly
2. tmux inherits this environment (including PATH)
3. The tmux pane's command (`cd ... && claude ...`) runs with PATH set

If a tmux server is already running from a previous (non-login) context, `tmux new-session` still creates the session from the current client's environment. The tmux pane inherits the environment of the `tmux new-session` invocation, not the server. So this should work correctly.

### What about `tail -f` and other non-claude commands?

Commands like `tail -f`, `mkdir -p`, `rm -f` use binaries in `/usr/bin` which are in the default PATH. The login shell wrapper adds negligible overhead (one extra shell invocation) and ensures consistency. There's no reason to skip it for these commands.

### What about fish shell?

Fish uses `-l` for login and `-c` for command: `fish -l -c 'command'`. The `$SHELL -lc` invocation becomes `fish -lc 'command'` which fish interprets as `-l` (login) and `-c 'command'` (run command). This works correctly in fish.

### Performance impact

The login shell wrapper adds one extra shell invocation per remote command. For the connection test (4 commands), this adds ~100ms total. For session execution, the overhead is negligible compared to the claude run time.

---

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| Task 1: Wrap remote commands in login shell | Done | Core fix in `ssh_command()` |
| Task 2: Fix `SshAbortHandle` | Done | Keep consistent with `ssh_command()` |
| Task 3: Update existing unit tests | Done | No changes needed; added 3 new tests |
| Task 4: Update `build_*` method tests | Done | All pass unchanged (`.contains()` assertions match inside wrapper) |
| Task 5: Update `connection_test_steps` tests | Done | No changes needed |
| Task 6: Verify with cargo test/check | Done | 314 tests pass |
