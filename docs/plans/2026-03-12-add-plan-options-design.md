# Add Plan Options — Design Plan

## Overview

Add two per-repo configuration options for plan management:
1. **Plans directory** — already exists as `plansDir` on `RepoConfig` (both local and SSH variants), with a UI field in the Settings tab and backend support. However, the design prompt in `prompt.rs` and the plan file extraction logic in `oneshot.rs` both hardcode `docs/plans/`. These need to be made configurable so the plans directory flows through from config to the design prompt and plan extraction.
2. **Move plans to completed subfolder** — a new boolean option (`movePlansToCompleted`, default `true`) that controls whether plans are automatically moved to the `completed/` subdirectory after a successful session. Currently, the auto-move is unconditional in `store.ts`.

## Task 1: Add `movePlansToCompleted` to RepoConfig types

**Files to modify:**
- `src/repos.ts`

**Pattern references:**
- `createBranch?: boolean` field pattern in `repos.ts:17,33` — optional boolean with implicit default

**Checklist:**
- [x] Add `movePlansToCompleted?: boolean` to `LocalRepoConfig` type (after `plansDir`)
- [x] Add `movePlansToCompleted?: boolean` to `SshRepoConfig` type (after `plansDir`)

## Task 2: Add `movePlansToCompleted` toggle to Settings UI

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern references:**
- `createBranch` checkbox pattern at `RepoDetail.tsx:851-859` — Label wrapping Checkbox with descriptive text
- `plansDir` state initialization at `RepoDetail.tsx:111,175,380`

**Checklist:**
- [x] Add `movePlansToCompleted` state: `const [movePlansToCompleted, setMovePlansToCompleted] = useState(true);`
- [x] Initialize from repo config in the `useEffect` that syncs state (near line 175): `setMovePlansToCompleted(repo.movePlansToCompleted ?? true);`
- [x] Include in `saveSettings()` (near line 380): `movePlansToCompleted`
- [x] Add a Checkbox UI element below the Plans Directory input (after line 850), following the `createBranch` checkbox pattern:
  ```tsx
  <Label htmlFor="move-plans-completed" className="flex items-center gap-2 text-sm font-normal">
    <Checkbox
      id="move-plans-completed"
      checked={movePlansToCompleted}
      onCheckedChange={(v) => setMovePlansToCompleted(v === true)}
      disabled={session.running}
    />
    Move plans to completed folder after run
  </Label>
  ```

## Task 3: Gate auto-move logic on `movePlansToCompleted` config

**Files to modify:**
- `src/store.ts`

**Pattern references:**
- Session complete auto-move at `store.ts:177-215`
- 1-shot complete auto-move at `store.ts:251-294`

**Checklist:**
- [x] In the `session_complete` handler (line 177-215): add a check for `repo.movePlansToCompleted !== false` before invoking `move_plan_to_completed`. The condition should be:
  ```typescript
  if (
    sessionEvent.outcome === "completed" &&
    sessionEvent.plan_file &&
    (repo.movePlansToCompleted ?? true) !== false
  )
  ```
  Or more simply: `(repo.movePlansToCompleted ?? true)` as an additional condition.
- [x] In the `one_shot_complete` handler (line 251-294): add the same guard. After finding the parent repo (line 255), check `(repo.movePlansToCompleted ?? true)` before proceeding with the move.

## Task 4: Pass `plansDir` to the design prompt so Claude writes plans to the configured directory

**Files to modify:**
- `src-tauri/src/prompt.rs`
- `src-tauri/src/oneshot.rs`
- `src-tauri/src/lib.rs` (run_oneshot command)

**Pattern references:**
- `build_design_prompt()` at `prompt.rs:202-204`
- Design prompt constant at `prompt.rs:141-199` — specifically the `### Step 4: Write the Plan` section (line 177-183) which hardcodes `docs/plans/`
- `OneShotConfig` at `oneshot.rs:25-37`
- `run_oneshot` command handler at `lib.rs:276-355`

**Checklist:**
- [x] Add `plans_dir: String` field to `OneShotConfig` struct
- [x] Update `build_design_prompt()` signature to accept `plans_dir: &str` parameter
- [x] Modify the `DESIGN_PROMPT` constant's Step 4 section to use a `{plans_dir}` placeholder instead of hardcoded `docs/plans/`. Change:
  ```
  Write the plan to `docs/plans/<date>-<slug>-design.md`
  ```
  to:
  ```
  Write the plan to `{plans_dir}<date>-<slug>-design.md`
  ```
  And change:
  ```
  Create the `docs/plans/` directory if it does not exist.
  ```
  to:
  ```
  Create the `{plans_dir}` directory if it does not exist.
  ```
- [x] In `build_design_prompt()`, replace `{plans_dir}` in the prompt text with the actual value (similar to how `build_conflict_prompt` replaces `{conflict_files}`)
- [x] Update the default plan file fallback in `oneshot.rs` (line 478-481) to use `self.config.plans_dir` instead of hardcoded `"docs/plans/"`:
  ```rust
  let default_path = format!("{}{}-{}-design.md", self.config.plans_dir, date, slug);
  ```
  Ensure the plans_dir has a trailing slash (normalize in config or at use site).
- [x] Update `extract_plan_file_from_events()` to accept a `plans_dir` parameter and check against that instead of hardcoded `"docs/plans/"`. The function should check `file_path.contains(plans_dir)` in addition to (or instead of) `file_path.contains("docs/plans/")`. Keep the `-design.md` suffix fallback.
- [x] Update `extract_plan_file_from_output()` similarly — replace hardcoded `"docs/plans/"` with the configured plans_dir.
- [x] Pass `plans_dir` when calling `extract_plan_file_from_events()` and `extract_plan_file_from_output()` in the `run()` method.
- [x] In `run_oneshot` command handler (`lib.rs:276-355`): read `plansDir` from the repo config (it's not currently passed to the backend — will need to be added as a parameter or derived from the frontend). Add `plans_dir` parameter to `run_oneshot` and pass it through to `OneShotConfig`.
- [x] In `runOneShot` in `store.ts`: pass `plansDir` (from repo config, defaulting to `"docs/plans/"`) to the `run_oneshot` invoke call.

## Task 5: Update existing tests

**Files to modify:**
- `src/store.test.ts`
- `src-tauri/src/oneshot.rs` (inline tests if any)
- `src-tauri/src/prompt.rs` (inline tests)
- `src/pages/RepoDetail.test.tsx`

**Pattern references:**
- Store test patterns in `store.test.ts`
- Prompt tests at `prompt.rs:232-350`

**Checklist:**
- [x] Update `build_design_prompt` tests in `prompt.rs` to pass the new `plans_dir` parameter
- [x] Add test that `build_design_prompt` includes the custom plans_dir in output
- [x] Add test that `build_design_prompt` uses default `docs/plans/` when given that value
- [x] Update any `extract_plan_file_from_events` tests to pass `plans_dir` parameter
- [x] In `store.test.ts`: update the `session_complete` event tests to verify auto-move respects `movePlansToCompleted` config:
  - Test that move IS called when `movePlansToCompleted` is `true` (or undefined/default)
  - Test that move is NOT called when `movePlansToCompleted` is `false`
- [x] In `store.test.ts`: same for `one_shot_complete` event handler
- [x] In `RepoDetail.test.tsx`: verify the new checkbox renders and toggles correctly
- [x] Update `OneShotConfig` construction in any Rust tests to include `plans_dir`

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Add `movePlansToCompleted` to RepoConfig | Complete | Added to both LocalRepoConfig and SshRepoConfig |
| 2. Settings UI toggle | Complete | Added state, useEffect init, saveSettings, and Checkbox UI |
| 3. Gate auto-move on config | Complete | Gated both session_complete and one_shot_complete handlers |
| 4. Pass `plansDir` to design prompt | Complete | Added plans_dir to OneShotConfig, prompt template, extraction functions, lib.rs command, store.ts invoke |
| 5. Update tests | Complete | Updated prompt.rs tests, oneshot.rs tests (extract + config), store.test.ts plansDir tests |
