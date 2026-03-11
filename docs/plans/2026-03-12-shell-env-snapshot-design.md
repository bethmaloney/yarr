# Shell Environment Snapshot

## Problem

When yarr spawns a process via `wsl -e bash -lc "..."` (or `bash -c` for local), the shell runs as non-interactive. Both bash and zsh skip their rc files (`.bashrc`/`.zshrc`) for non-interactive shells. Those rc files are where users configure their entire dev environment — not just nvm, but any custom PATH entries, language version managers, tool configs, etc.

The current fix patches over one symptom (nvm) but doesn't solve the underlying problem: the spawned shell doesn't have the user's full environment.

Using interactive mode (`-i`) would source rc files but introduces side effects:
1. bash MOTD on stdout — corrupts `run_command`/`health_check` output
2. zsh stderr noise — oh-my-zsh/gitstatus warnings without a tty
3. Job control warnings — "cannot set terminal process group"

## Solution: Two-Phase Snapshot + Apply

Modeled after VS Code's approach, battle-tested across millions of users.

**Phase 1 — Snapshot (once, lazily):** Spawn the user's shell in interactive login mode with UUID markers around `env -0`. Parse the null-delimited environment between markers, discarding all noise (MOTD, oh-my-zsh, prompts).

**Phase 2 — Apply:** For every subsequent command, run a plain non-interactive shell with the cached env injected — no interactive flag, no noise.

### Snapshot Command

Per shell type (detected via `$SHELL`, falling back to `bash` if unset or fish):

- **bash:** `bash -ilc 'echo -n <MARKER>; env -0; echo -n <MARKER>'`
- **zsh:** `zsh -ilc 'echo -n <MARKER>; env -0; echo -n <MARKER>'`
- **fish:** Falls back to `bash` (fish syntax is incompatible, and users are rare)

For each runtime, the command is wrapped in the runtime's transport:
- **Local:** Direct `Command::new("bash")` / `Command::new("zsh")`
- **WSL:** `wsl -e bash -ilc '...'`
- **SSH:** `ssh <host> $SHELL -ilc '...'`

### Caching Strategy

- **Local/WSL:** Share a `static OnceCell<HashMap<String, String>>` — both resolve to the same user environment. Snapshot on first call, cached forever (until app restart).
- **SSH:** Per-host cache via `DashMap<String, HashMap<String, String>>` in Tauri managed state, keyed by SSH host string. Lazy — snapshot deferred until the SSH repo/card is first loaded.

### Env Var Filtering

**All runtimes denylist:** `_`, `SHLVL`, `PWD`, `OLDPWD`

**SSH additionally denylists:** `SSH_AUTH_SOCK`, `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY` (these are session-specific and will be set correctly by the new SSH connection itself)

### Timeout and Fallback

- **Local/WSL timeout:** 10 seconds
- **SSH timeout:** 15 seconds
- **On failure:** Fall back to `std::env::vars()` (local/WSL) or empty map (SSH). Log via `tracing::warn!`. Return a warning string from the Tauri command so the frontend can show a toast: *"Failed to load shell environment — some tools (nvm, pyenv, etc.) may not be available. Restart the app to retry."*

### Applying the Environment

- **LocalRuntime:** `Command::envs(&env_map)` — Rust's API handles this natively. Drop the `-l` flag from commands.
- **WslRuntime:** Prepend `export KEY=VALUE;` statements to the command string (same pattern already used for `invocation.env_vars`). Drop `-l` flag from `bash -lc` → `bash -c`.
- **SshRuntime:** Prepend `export` statements to the remote command string. Drop the `$SHELL -lc` wrapper → `bash -c`.

### No Re-snapshot Mechanism

User restarts the app if their rc files change. A cache-clearing API can be added later if needed.

---

## Implementation Plan

### Task 1: Create `shell_env.rs` module with snapshot logic

Core module with the snapshot function and parsing logic.

**Files to create:**
- `src-tauri/src/runtime/shell_env.rs`

**Pattern reference:** `src-tauri/src/runtime/local.rs` (for `Command` spawning patterns)

**Details:**
- `snapshot_shell_env(spawn_fn)` — async function that takes a closure `Fn(String) -> Future<Output = Result<Output>>` for transport abstraction
- The closure receives the full shell command string and returns the process `Output`
- Generate UUID marker via `uuid::Uuid::new_v4()`
- Detect `$SHELL` from existing env, fall back to `bash` if unset or fish
- Build command: `<shell> -ilc 'echo -n <MARKER>; env -0; echo -n <MARKER>'`
- Parse stdout: find content between markers, split on `\0`, parse `KEY=VALUE` pairs
- Apply denylist filtering (parameterized: `&[&str]` so callers can add SSH-specific vars)
- Return `Result<HashMap<String, String>>` — `Err` on timeout or parse failure
- Constants: `LOCAL_TIMEOUT = 10s`, `SSH_TIMEOUT = 15s`
- `COMMON_DENYLIST = ["_", "SHLVL", "PWD", "OLDPWD"]`
- `SSH_DENYLIST = ["SSH_AUTH_SOCK", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]`

**Checklist:**
- [x] Create `shell_env.rs` with `snapshot_shell_env` function
- [x] Implement marker-based stdout parsing
- [x] Implement null-delimited env var parsing
- [x] Implement denylist filtering
- [x] Add `mod shell_env;` to `runtime/mod.rs`
- [x] Add unit tests for parsing (mock stdout with markers, noise, null-delimited vars)
- [x] Add unit tests for denylist filtering
- [x] `cd src-tauri && cargo check`

---

### Task 2: Add local env cache and `resolve_env` to `RuntimeProvider` trait

Add the caching layer and trait method.

**Files to modify:**
- `src-tauri/src/runtime/mod.rs`

**Pattern reference:** `src-tauri/src/runtime/mod.rs` (existing trait definition)

**Details:**
- Add `async fn resolve_env(&self) -> Result<HashMap<String, String>>` to `RuntimeProvider` trait with a default implementation returning `Ok(std::env::vars().collect())`
- Add `static LOCAL_ENV_CACHE: OnceCell<HashMap<String, String>>` (use `tokio::sync::OnceCell`) for local/WSL shared cache
- Export a helper `get_or_init_local_env()` that uses the OnceCell, calls `snapshot_shell_env` with a local spawn closure, falls back to `std::env::vars()` on error
- Add `SshEnvCache` newtype around `DashMap<String, HashMap<String, String>>` for Tauri managed state (add `dashmap` dependency)

**Checklist:**
- [ ] Add `resolve_env` to `RuntimeProvider` trait
- [ ] Add `LOCAL_ENV_CACHE` static OnceCell
- [ ] Add `get_or_init_local_env()` helper
- [ ] Add `SshEnvCache` newtype struct
- [ ] Add `dashmap` to `Cargo.toml` if not present
- [ ] Update MockRuntime to implement `resolve_env` (return empty or process env)
- [ ] `cd src-tauri && cargo check`

---

### Task 3: Implement `resolve_env` for LocalRuntime

Wire up the local runtime to use the shared cache.

**Files to modify:**
- `src-tauri/src/runtime/local.rs`

**Pattern reference:** `src-tauri/src/runtime/local.rs` (existing `health_check` for spawning)

**Details:**
- Implement `resolve_env(&self)` calling `get_or_init_local_env()`
- The spawn closure: `Command::new(shell).args(&["-ilc", &cmd]).output()`
- On error, log `tracing::warn!` and fall back to `std::env::vars()`
- Update `spawn_claude` to call `self.resolve_env().await?` and inject env via `Command::envs()`
- Update `run_command` to inject env via `Command::envs()`
- Update `health_check` to inject env via `Command::envs()`

**Checklist:**
- [ ] Implement `resolve_env` for LocalRuntime
- [ ] Update `spawn_claude` to use resolved env
- [ ] Update `run_command` to use resolved env
- [ ] Update `health_check` to use resolved env
- [ ] `cd src-tauri && cargo check`

---

### Task 4: Implement `resolve_env` for WslRuntime

Wire up WSL runtime to use the shared local cache and apply env via exports.

**Files to modify:**
- `src-tauri/src/runtime/wsl.rs`

**Pattern reference:** `src-tauri/src/runtime/wsl.rs` (existing `build_command` with `export` statements)

**Details:**
- Implement `resolve_env(&self)` calling `get_or_init_local_env()` (same cache as local — both target the same WSL user env)
- The spawn closure: `Command::new("wsl").args(&["-e", shell, "-ilc", &cmd]).output()`
- Update `build_command` to include snapshot env vars as `export` statements
- Change `bash -lc` to `bash -c` in `spawn_claude`, `run_command`, `health_check` since env is pre-resolved
- On error, log `tracing::warn!` and fall back to current behavior (`bash -lc`)

**Checklist:**
- [ ] Implement `resolve_env` for WslRuntime
- [ ] Update `spawn_claude` to use resolved env, drop `-l` flag
- [ ] Update `run_command` to use resolved env, drop `-l` flag
- [ ] Update `health_check` to use resolved env, drop `-l` flag
- [ ] `cd src-tauri && cargo check`

---

### Task 5: Implement `resolve_env` for SshRuntime

Wire up SSH runtime with per-host cache from Tauri managed state.

**Files to modify:**
- `src-tauri/src/runtime/ssh.rs`

**Pattern reference:** `src-tauri/src/runtime/ssh.rs` (existing `ssh_command` wrapper)

**Details:**
- SshRuntime needs access to the `SshEnvCache`. Add an `env_cache: Arc<DashMap<String, HashMap<String, String>>>` field to `SshRuntime`
- Update `SshRuntime::new()` to accept the cache reference
- Implement `resolve_env(&self)`: check cache by `self.ssh_host`, on miss call `snapshot_shell_env` with an SSH spawn closure: `ssh <host> <shell> -ilc '<cmd>'`
- Apply SSH-specific denylist in addition to common denylist
- Use 15s timeout
- On error, log `tracing::warn!` and return empty map
- Update `build_tmux_command` and `build_run_command` to include snapshot env as `export` statements
- Drop `$SHELL -lc` wrapper from `ssh_command()` → use `bash -c` since env is pre-resolved

**Checklist:**
- [ ] Add `env_cache` field to SshRuntime
- [ ] Update `SshRuntime::new()` signature
- [ ] Implement `resolve_env` for SshRuntime
- [ ] Update `build_tmux_command` to use resolved env
- [ ] Update `build_run_command` to use resolved env
- [ ] Update `ssh_command` to drop `$SHELL -lc` wrapper
- [ ] `cd src-tauri && cargo check`

---

### Task 6: Wire up `SshEnvCache` in Tauri managed state and update call sites

Thread the SSH env cache through app setup and all `SshRuntime::new()` call sites.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs` (existing `GlobalAbortRegistry` managed state pattern)

**Details:**
- Register `SshEnvCache` as Tauri managed state in app builder (same pattern as `GlobalAbortRegistry`)
- Update `resolve_runtime()` to accept `&SshEnvCache` and pass to `SshRuntime::new()`
- Update all `SshRuntime::new()` call sites in `run_session`, `run_oneshot`, etc.
- Update all `default_runtime()` call sites — no changes needed since local/WSL use static cache

**Checklist:**
- [ ] Register `SshEnvCache` in Tauri managed state
- [ ] Update `resolve_runtime()` to pass cache to SshRuntime
- [ ] Update all `SshRuntime::new()` call sites
- [ ] `cd src-tauri && cargo check`

---

### Task 7: Surface env snapshot warnings as toast notifications

Return warning from Tauri commands when snapshot fails, show toast on frontend.

**Files to modify:**
- `src-tauri/src/runtime/mod.rs` (add warning return type)
- `src-tauri/src/lib.rs` (return warnings from commands)
- `src/store.ts` or relevant frontend call sites (show toast)

**Pattern reference:** `src/pages/RepoDetail.tsx` (existing `toast.error(...)` pattern)

**Details:**
- `resolve_env` already returns `Result` — on `Err`, the caller (Tauri command) catches it and includes a warning string in the response
- Option A: Add an optional `warning` field to command return types
- Option B: Emit a Tauri event `"env-warning"` from the runtime — but we decided against threading app_handle
- Go with Option A: modify `run_session` and `run_oneshot` to call `runtime.resolve_env()` early, catch errors, and return warning alongside the normal result
- Frontend: check for warning in response, call `toast.warning(...)` if present

**Checklist:**
- [ ] Add warning propagation from `resolve_env` failures in Tauri commands
- [ ] Frontend: show `toast.warning(...)` on env snapshot failure
- [ ] `cd src-tauri && cargo check && npx tsc --noEmit`

---

### Task 8: Update existing tests and add integration tests

Ensure MockRuntime and existing tests still pass, add new tests.

**Files to modify:**
- `src-tauri/src/runtime/mock.rs`
- `src-tauri/src/runtime/ssh.rs` (existing tests — update `SshRuntime::new()` calls)

**Pattern reference:** `src-tauri/src/runtime/ssh.rs` (existing test module at bottom of file)

**Details:**
- MockRuntime: implement `resolve_env` returning process env or configurable map
- Update all `SshRuntime::new()` calls in SSH tests to pass a test cache
- Add tests for `shell_env.rs` edge cases: empty output, missing markers, markers with noise around them, values containing newlines/equals signs
- Verify `cargo test` passes

**Checklist:**
- [ ] Update MockRuntime `resolve_env`
- [ ] Update SSH test `SshRuntime::new()` calls
- [ ] Add edge case tests for `snapshot_shell_env`
- [ ] `cd src-tauri && cargo test`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Create `shell_env.rs` module with snapshot logic | Done |
| 2 | Add local env cache and `resolve_env` to trait | Not Started |
| 3 | Implement `resolve_env` for LocalRuntime | Not Started |
| 4 | Implement `resolve_env` for WslRuntime | Not Started |
| 5 | Implement `resolve_env` for SshRuntime | Not Started |
| 6 | Wire up `SshEnvCache` in Tauri state | Not Started |
| 7 | Surface warnings as toast notifications | Not Started |
| 8 | Update tests | Not Started |
