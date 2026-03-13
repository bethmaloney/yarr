# Add Effort Level Option

## Overview

Add `--effort <level>` support to Yarr's Claude Code invocations. Two separate effort settings:

1. **Standard effort** — used by Ralph loops and 1-shot implementation phases. Default: `medium`.
2. **Design effort** — used by the 1-shot design phase. Default: `high`.

Both appear as `<Select>` dropdowns placed directly below the model input in their respective UI sections. The effort level maps to `--effort <level>` appended to the Claude CLI invocation.

Valid levels: `low`, `medium`, `high`, `max`.

## Task 1: Add effort fields to RepoConfig (frontend persistence)

**Files to modify:**
- `src/repos.ts`

**Pattern reference:** How `model: string` is defined in `LocalRepoConfig` and `SshRepoConfig` (repos.ts:11, repos.ts:29).

**Checklist:**
- [x] Add `effortLevel?: string` to `LocalRepoConfig` (optional, defaults handled at usage site)
- [x] Add `effortLevel?: string` to `SshRepoConfig`
- [x] Add `designEffortLevel?: string` to `LocalRepoConfig`
- [x] Add `designEffortLevel?: string` to `SshRepoConfig`
- [x] In `addLocalRepo()`, set `effortLevel: "medium"` and `designEffortLevel: "high"` in the default config (repos.ts:64-73)
- [x] In `addSshRepo()`, set `effortLevel: "medium"` and `designEffortLevel: "high"` in the default config (repos.ts:86-96)

## Task 2: Add effort to OneShotEntry type

**Files to modify:**
- `src/types.ts`

**Pattern reference:** `model: string` field on `OneShotEntry` (types.ts:101).

**Checklist:**
- [x] Add `effortLevel: string` to `OneShotEntry` — records which effort was used for the implementation phase
- [x] Add `designEffortLevel: string` to `OneShotEntry` — records which effort was used for the design phase

## Task 3: Add effort to Rust backend configs

**Files to modify:**
- `src-tauri/src/session.rs` — `SessionConfig`
- `src-tauri/src/oneshot.rs` — `OneShotConfig`

**Pattern reference:** How `model: Option<String>` is defined in `SessionConfig` (session.rs:30) and `model: String` in `OneShotConfig` (oneshot.rs:32).

**Checklist:**
- [ ] Add `pub effort_level: Option<String>` to `SessionConfig` (session.rs ~line 30)
- [ ] Update `SessionConfig::default()` to set `effort_level: None`
- [ ] Add `pub effort_level: String` to `OneShotConfig` (for implementation phase effort)
- [ ] Add `pub design_effort_level: String` to `OneShotConfig` (for design phase effort)

## Task 4: Thread effort through ClaudeInvocation and runtimes

**Files to modify:**
- `src-tauri/src/runtime/mod.rs` — `ClaudeInvocation`
- `src-tauri/src/runtime/local.rs` — `LocalRuntime::spawn_claude`
- `src-tauri/src/runtime/wsl.rs` — `WslRuntime::build_command`
- `src-tauri/src/runtime/ssh.rs` — `SshRuntime::build_tmux_command`
- `src-tauri/src/session.rs` — `SessionRunner::build_invocation`

**Pattern reference:** How `--model` is added via `ClaudeInvocation.model` → runtime `spawn_claude`/`build_command`:
- `mod.rs:23` — `pub model: Option<String>` on `ClaudeInvocation`
- `local.rs:60-63` — `if let Some(ref model)` → push `--model` + value
- `wsl.rs:97-98` — `if let Some(ref model)` → format into cmd_parts
- `ssh.rs:173` — `if let Some(ref model)` → push `--model` into claude_cmd
- `session.rs:331-338` — `build_invocation` maps config fields to `ClaudeInvocation`

**Checklist:**
- [ ] Add `pub effort_level: Option<String>` to `ClaudeInvocation` (mod.rs ~line 23)
- [ ] In `LocalRuntime::spawn_claude` (local.rs ~line 60), add after model block:
  ```rust
  if let Some(ref effort) = invocation.effort_level {
      args.push("--effort".to_string());
      args.push(effort.clone());
  }
  ```
- [ ] In `WslRuntime::build_command` (wsl.rs ~line 97), add after model block:
  ```rust
  if let Some(ref effort) = invocation.effort_level {
      cmd_parts.push(format!("--effort {}", shell_escape(effort)));
  }
  ```
- [ ] In `SshRuntime::build_tmux_command` (ssh.rs ~line 173), add after model block:
  ```rust
  if let Some(ref effort) = invocation.effort_level {
      claude_cmd.push_str(&format!(" --effort {}", shell_escape(effort)));
  }
  ```
- [ ] In `SessionRunner::build_invocation` (session.rs ~line 331), add `effort_level: self.config.effort_level.clone()`
- [ ] Update all existing `ClaudeInvocation { ... }` literals in tests (ssh.rs tests) to include `effort_level: None`

## Task 5: Thread effort through Tauri commands

**Files to modify:**
- `src-tauri/src/lib.rs` — `run_session`, `run_oneshot`, `resume_oneshot`

**Pattern reference:** How `model: String` is threaded from command params → config struct:
- `run_session` (lib.rs:80-92) → `SessionConfig { model: Some(model), ... }` (lib.rs:179)
- `run_oneshot` (lib.rs:414-428) → `OneShotConfig { model, ... }` (lib.rs:453-466)
- `resume_oneshot` (lib.rs:536-554) → `OneShotConfig { model, ... }`

**Checklist:**
- [ ] Add `effort_level: Option<String>` parameter to `run_session` command (lib.rs ~line 85)
- [ ] Pass `effort_level` into `SessionConfig` in `run_session` (lib.rs ~line 173)
- [ ] Add `effort_level: Option<String>` and `design_effort_level: Option<String>` parameters to `run_oneshot` command (lib.rs ~line 420)
- [ ] Pass effort levels into `OneShotConfig` in `run_oneshot` (lib.rs ~line 453), defaulting: `effort_level.unwrap_or_else(|| "medium".to_string())` and `design_effort_level.unwrap_or_else(|| "high".to_string())`
- [ ] Add same effort parameters to `resume_oneshot` command (lib.rs ~line 543)
- [ ] Pass effort levels into `OneShotConfig` in `resume_oneshot` with same defaults
- [ ] Add `tracing::info!` fields for effort_level in each command's entry log

## Task 6: Use effort in OneShot design and implementation phases

**Files to modify:**
- `src-tauri/src/oneshot.rs`

**Pattern reference:** How `model` is set in design_config and impl_config:
- Design phase: `model: Some(self.config.model.clone())` (oneshot.rs:514)
- Implementation phase: `model: Some(self.config.model.clone())` (oneshot.rs:674)

**Checklist:**
- [ ] In the design phase `SessionConfig` (oneshot.rs ~line 508), set `effort_level: Some(self.config.design_effort_level.clone())`
- [ ] In the implementation phase `SessionConfig` (oneshot.rs ~line 668), set `effort_level: Some(self.config.effort_level.clone())`

## Task 7: Thread effort through frontend store → Tauri invoke

**Files to modify:**
- `src/store.ts`

**Pattern reference:** How `model` is passed in `runOneShot` and `runSession`:
- `runOneShot` signature (store.ts:47) and invoke call (store.ts:572-584)
- `runSession` invoke call (store.ts:734-744)

**Checklist:**
- [ ] Update `runOneShot` signature to accept `effortLevel: string` and `designEffortLevel: string` parameters (store.ts:47)
- [ ] Pass `effortLevel` and `designEffortLevel` in the `invoke("run_oneshot", {...})` call (store.ts:572)
- [ ] Store `effortLevel` and `designEffortLevel` in the `OneShotEntry` created (store.ts:544)
- [ ] In `runSession` invoke call (store.ts:734), pass `effortLevel: repo.effortLevel ?? "medium"`
- [ ] In `resumeOneShot`, pass `effortLevel` and `designEffortLevel` from the stored entry to the `invoke("resume_oneshot", {...})` call

## Task 8: Add effort level UI controls to RepoDetail page

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** Model input field in the Ralph section (RepoDetail.tsx:860-869) and the oneshot section (RepoDetail.tsx:1442-1449). Use `<Select>` from `src/components/ui/select.tsx`.

**Checklist:**
- [ ] Import `Select, SelectContent, SelectItem, SelectTrigger, SelectValue` from `@/components/ui/select`
- [ ] Add state: `const [effortLevel, setEffortLevel] = useState("medium")`
- [ ] Initialize `effortLevel` from `repo.effortLevel ?? "medium"` when repo loads (follow model pattern ~line 168)
- [ ] Add a `<Select>` dropdown **directly below the Model input** in the Ralph/standard loop section (~line 869):
  ```tsx
  <Label className="flex flex-col gap-1">
    Effort Level
    <Select value={effortLevel} onValueChange={setEffortLevel} disabled={session.running}>
      <SelectTrigger className="font-mono">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="low">low</SelectItem>
        <SelectItem value="medium">medium</SelectItem>
        <SelectItem value="high">high</SelectItem>
        <SelectItem value="max">max</SelectItem>
      </SelectContent>
    </Select>
  </Label>
  ```
- [ ] Save `effortLevel` to repo config via `updateRepo({...repo, effortLevel})` — follow the pattern of how `model` is saved (in the existing save/blur handler ~line 375)
- [ ] Add state: `const [oneShotDesignEffort, setOneShotDesignEffort] = useState("high")`
- [ ] Add state: `const [oneShotEffort, setOneShotEffort] = useState("medium")`
- [ ] Initialize both from repo config when repo loads (follow oneShotModel pattern ~line 186):
  - `setOneShotDesignEffort(repo.designEffortLevel ?? "high")`
  - `setOneShotEffort(repo.effortLevel ?? "medium")`
- [ ] Add **two** `<Select>` dropdowns in the 1-shot form, placed directly below the oneshot Model input (~line 1449):
  - "Design Effort Level" → `oneShotDesignEffort` (default "high")
  - "Implementation Effort Level" → `oneShotEffort` (default "medium")
- [ ] Pass `oneShotEffort` and `oneShotDesignEffort` to `runOneShot()` in `handleOneShotSubmit` (~line 529)

## Task 9: Tests

**Files to modify:**
- `src-tauri/src/runtime/ssh.rs` (existing tests)
- `src-tauri/src/session.rs` (if existing tests reference `SessionConfig`)

**Pattern reference:** Existing SSH runtime tests that verify `--model` flag (ssh.rs ~lines 1132-1170).

**Checklist:**
- [ ] Add `effort_level: None` to all existing `ClaudeInvocation` literals in tests to fix compilation
- [ ] Add a test `build_tmux_command_includes_effort_level` that verifies `--effort high` appears in the command when `effort_level: Some("high".to_string())`
- [ ] Add a test `build_tmux_command_excludes_effort_when_none` that verifies no `--effort` flag when `effort_level: None`
- [ ] Run `cd src-tauri && cargo test` to verify all Rust tests pass
- [ ] Run `npx tsc --noEmit` to verify TypeScript compiles

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. RepoConfig fields | Done | Frontend persistence |
| 2. OneShotEntry type | Done | TypeScript type |
| 3. Rust backend configs | Not started | SessionConfig + OneShotConfig |
| 4. ClaudeInvocation + runtimes | Not started | All 3 runtimes + build_invocation |
| 5. Tauri commands | Not started | run_session, run_oneshot, resume_oneshot |
| 6. OneShot phase configs | Not started | design vs implementation effort |
| 7. Frontend store | Not started | Zustand store invoke calls |
| 8. UI controls | Not started | Select dropdowns in RepoDetail |
| 9. Tests | Not started | SSH runtime tests + compilation |
