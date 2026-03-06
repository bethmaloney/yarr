# Run Session — Design

Wire up a "Run" button that reads a prompt file from a target repo, executes the Ralph loop via `WslRuntime`, and streams events back to the UI.

## Scope

- Minimal: core loop end-to-end, no lint/push hooks
- User provides repo path + prompt file path via text inputs
- Prompt file is read server-side and piped to Claude as stdin (matching `run_ralph.sh`)

## Data Flow

```
UI Form (repo path + prompt file path)
  -> invoke("run_session", { repoPath, promptFile })
    -> Tauri command reads prompt file contents from disk
    -> Builds SessionConfig { repo_path, prompt: file_contents, ... }
    -> Creates WslRuntime, SessionRunner
    -> SessionRunner.run() loops iterations of `claude -p`
    -> Each StreamEvent -> emit("session-event") -> UI updates live
    -> Returns SessionTrace on completion
```

## Changes

### Rust (`src-tauri/src/lib.rs`)

New `run_session` Tauri command:
- Takes `repo_path: String` and `prompt_file: String` as args
- Reads prompt file with `tokio::fs::read_to_string`
- If `prompt_file` is relative, resolves it against `repo_path`
- Builds `SessionConfig`:
  - prompt = file contents
  - model = `"opus"`
  - max_iterations = 40
  - completion_signal = `"ALL TODO ITEMS COMPLETE"`
- Instantiates `WslRuntime`, `TraceCollector`, `SessionRunner`
- Wires up `app.emit("session-event")` callback
- Registers alongside existing `run_mock_session`

### Svelte (`ui/src/App.svelte`)

Replace mock button with form:
- Two text inputs: repo path, prompt file path
- "Run" button calls `invoke("run_session", { repoPath, promptFile })`
- Disable form while running
- Event stream display unchanged

### No changes to

- `session.rs` — already supports all needed config
- `runtime/` — `WslRuntime` already works
- `output.rs` — parsing is complete
- `trace.rs` — tracing is complete

---

## Implementation Plan

### Task 1: Add `run_session` Tauri command

Add the new command to `src-tauri/src/lib.rs` that takes repo path and prompt file, reads the file, and runs a real session via `WslRuntime`.

**Files to modify:** `src-tauri/src/lib.rs`
**Pattern reference:** existing `run_mock_session` command in same file

**Details:**
- New async Tauri command `run_session(app, repo_path, prompt_file)`
- Read prompt file: if relative, join with repo_path; read with `tokio::fs::read_to_string`
- Build `SessionConfig` with hardcoded defaults (opus, 40 iters, `ALL TODO ITEMS COMPLETE`)
- Use `WslRuntime::new()` instead of `MockRuntime`
- Same event emission pattern as mock command
- Register in `invoke_handler` alongside `run_mock_session`

**Checklist:**
- [ ] Add `run_session` command function
- [ ] Handle relative/absolute prompt file path
- [ ] Register command in Tauri builder
- [ ] Verify: `cd ui && npx tauri build` (or `cargo check` in `src-tauri/`)

---

### Task 2: Update Svelte UI with form inputs

Replace the mock session button with a form that has repo path and prompt file inputs, wired to the new `run_session` command.

**Files to modify:** `ui/src/App.svelte`
**Pattern reference:** existing `runMockSession` function and button in same file

**Details:**
- Add two `$state` variables: `repoPath` and `promptFile` (default empty strings)
- Replace button's `onclick` to call new `runSession()` function
- `runSession()` calls `invoke("run_session", { repoPath, promptFile })`
- Keep event display, error handling, trace display as-is
- Disable inputs and button while `running` is true
- Keep the mock session button as a secondary/smaller option for dev testing

**Checklist:**
- [ ] Add state variables and text inputs
- [ ] Add `runSession()` function calling new command
- [ ] Disable form while running
- [ ] Keep mock button as secondary option
- [ ] Verify: `cd ui && npm run check` (if available) or manual test with `npx tauri dev`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add `run_session` Tauri command | Done |
| 2 | Update Svelte UI with form inputs | Done |
