# Custom Prompt Overrides

## Overview

Add support for specifying custom design (research) and implementation (orchestrator) prompt files in repo config. This allows developers to override the built-in `DESIGN_PROMPT` and `IMPLEMENTATION_PROMPT` with their own prompt files, stored in the repo and versioned with git.

Prompts are referenced by file path (relative to repo root) and read at session start via the runtime provider (supporting local, WSL, and SSH repos). Omitting the fields falls back to built-in defaults. An "Export Default" button lets developers export the built-in prompt as a starting point.

## Design

### Config Schema

Two new optional fields on `RepoConfig`:

```typescript
designPromptFile?: string;          // e.g. ".yarr/prompts/design.md"
implementationPromptFile?: string;  // e.g. ".yarr/prompts/implementation.md"
```

On the Rust side, these are passed as `Option<String>` parameters to `run_session` and `run_oneshot`.

### Prompt Resolution Flow

1. **Session start** — backend receives optional prompt file paths from config
2. **Read prompt file** — if path is set, read file contents via runtime provider (`rt.run_command("cat <path>", ...)`)
3. **Error handling** — if the file can't be read, emit an error event and abort. No silent fallback.
4. **Build prompt** — pass custom content to `build_prompt()` / `build_design_prompt()`, which use it instead of the hardcoded constant
5. **Append context** — plan file reference / task description appended as today

### Export Default Prompts

New Tauri command `export_default_prompt`:
- Accepts: `repo` (RepoType), `prompt_type` ("design" | "implementation")
- Writes the built-in prompt content to `.yarr/prompts/{design|implementation}.md` in the repo via runtime provider
- Returns the relative file path so the frontend can auto-populate the config field
- Creates `.yarr/prompts/` directory if it doesn't exist

### UI

New "Custom Prompts" section in repo settings (between "Plans" and "Behavior"):
- **Design Prompt File** — text input + "Export Default" button
- **Implementation Prompt File** — text input + "Export Default" button
- Help text: "Override the built-in prompt. Leave empty to use default."

---

## Implementation Plan

### Task 1: Add prompt file fields to RepoConfig

Add `designPromptFile` and `implementationPromptFile` optional fields to the TypeScript `RepoConfig` type and ensure they persist through save/load.

**Files to modify:**
- `src/repos.ts`

**Pattern reference:** `plansDir` field in `src/repos.ts`

**Checklist:**
- [x] Add `designPromptFile?: string` to `LocalRepoConfig` type
- [x] Add `implementationPromptFile?: string` to `LocalRepoConfig` type
- [x] Add same fields to `SshRepoConfig` type
- [x] Ensure `loadRepos()` defaults handle missing fields (no default needed — they're optional)
- [x] Verify: `npx tsc --noEmit`

---

### Task 2: Add settings UI for custom prompt files

Add a "Custom Prompts" section to the repo settings form with text inputs and export buttons.

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** Plans section in `src/pages/RepoDetail.tsx` (lines 1013-1052)

**Checklist:**
- [x] Add `designPromptFile` and `implementationPromptFile` local state variables
- [x] Initialize them from `repo` config in the existing settings sync effect
- [x] Add "Custom Prompts" section with icon and heading (between Plans and Behavior)
- [x] Add text input for Design Prompt File with placeholder `.yarr/prompts/design.md`
- [x] Add text input for Implementation Prompt File with placeholder `.yarr/prompts/implementation.md`
- [x] Add "Export Default" button next to each input
- [x] Wire Export Default buttons to call `export_default_prompt` Tauri command
- [x] On successful export, auto-populate the corresponding input field
- [x] Include both fields in the `saveSettings()` config object
- [x] Add help text: "Override the built-in prompt. Leave empty for default."
- [x] Verify: `npx tsc --noEmit`

---

### Task 3: Add `export_default_prompt` Tauri command

Backend command that writes the built-in default prompt to a file in the repo via the runtime provider.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `move_plan_to_completed` command in `src-tauri/src/lib.rs` (lines 1517-1530) for the runtime + shell command pattern

**Checklist:**
- [x] Add `export_default_prompt` Tauri command accepting `repo: RepoType`, `prompt_type: String`
- [x] Validate `prompt_type` is "design" or "implementation"
- [x] Select the correct built-in prompt constant (`DESIGN_PROMPT` or `IMPLEMENTATION_PROMPT`)
- [x] Build runtime provider from `RepoType`
- [x] Create `.yarr/prompts/` directory via `rt.run_command("mkdir -p .yarr/prompts", ...)`
- [x] Write prompt content to file via `rt.run_command()` using heredoc or base64-encode + decode to handle special characters safely
- [x] Return the relative file path (`.yarr/prompts/design.md` or `.yarr/prompts/implementation.md`)
- [x] Register command in Tauri builder's `invoke_handler`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 4: Pass prompt file paths through `run_session`

Add prompt file parameters to the `run_session` flow and read custom prompts via runtime provider.

**Files to modify:**
- `src-tauri/src/lib.rs`
- `src-tauri/src/prompt.rs`
- `src/store.ts`

**Pattern reference:** How `effort_level` is passed through `run_session` in `src/store.ts` and `src-tauri/src/lib.rs`

**Checklist:**
- [ ] Add `implementation_prompt_file: Option<String>` parameter to `run_session` Tauri command
- [ ] If set, read file contents via runtime provider before building prompt
- [ ] Update `build_prompt()` to accept `Option<&str>` for custom prompt content, using it instead of `IMPLEMENTATION_PROMPT` when `Some`
- [ ] On file read failure, return error (abort session)
- [ ] Update `store.ts` `runSession()` to pass `implementationPromptFile` from repo config
- [ ] Verify: `cd src-tauri && cargo check && npx tsc --noEmit`

---

### Task 5: Pass prompt file paths through `run_oneshot`

Add prompt file parameters to the `run_oneshot` flow for both design and implementation phases.

**Files to modify:**
- `src-tauri/src/lib.rs`
- `src-tauri/src/oneshot.rs`
- `src/store.ts`

**Pattern reference:** How `plans_dir` is passed through `run_oneshot` in `src/store.ts` and `src-tauri/src/lib.rs`

**Checklist:**
- [ ] Add `design_prompt_file: Option<String>` and `implementation_prompt_file: Option<String>` parameters to `run_oneshot` Tauri command
- [ ] Pass both to `OneShotConfig`
- [ ] Add fields to `OneShotConfig` struct in `oneshot.rs`
- [ ] In design phase: if `design_prompt_file` is set, read via runtime and pass custom content to `build_design_prompt()`
- [ ] Update `build_design_prompt()` to accept `Option<&str>` for custom prompt, using it instead of `DESIGN_PROMPT` when `Some`
- [ ] In implementation phase: if `implementation_prompt_file` is set, read via runtime and pass custom content to `build_prompt()`
- [ ] On file read failure, emit error event and abort
- [ ] Update `store.ts` `runOneShot()` to pass both fields from repo config
- [ ] Verify: `cd src-tauri && cargo check && npx tsc --noEmit`

---

### Task 6: Tests

Add tests for the new prompt override functionality.

**Files to modify:**
- `src-tauri/src/prompt.rs` (unit tests)
- `src/repos.test.ts` (if exists, or create)

**Pattern reference:** Existing tests in `src-tauri/src/prompt.rs` (if any), test files in `src/*.test.ts`

**Checklist:**
- [ ] Add Rust unit test: `build_prompt` with custom prompt uses custom content
- [ ] Add Rust unit test: `build_prompt` without custom prompt uses default
- [ ] Add Rust unit test: `build_design_prompt` with custom prompt uses custom content
- [ ] Add Rust unit test: `build_design_prompt` without custom prompt uses default
- [ ] Verify: `cd src-tauri && cargo test`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add prompt file fields to RepoConfig | Done |
| 2 | Add settings UI for custom prompt files | Done |
| 3 | Add `export_default_prompt` Tauri command | Done |
| 4 | Pass prompt file paths through `run_session` | Not Started |
| 5 | Pass prompt file paths through `run_oneshot` | Not Started |
| 6 | Tests | Not Started |
