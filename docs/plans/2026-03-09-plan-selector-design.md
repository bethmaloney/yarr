# Plan Selector Improvements

Improve plan file selection with a dropdown browser, configurable plans directory, and auto-move on session completion.

## Design

### Plan Storage Configuration

Add an optional `plansDir` field to `RepoConfig` (both `LocalRepoConfig` and `SshRepoConfig`). Relative to repo root, defaults to `docs/plans/` when absent. Configurable per-repo in the settings section of RepoDetail.

The `completed/` subfolder is always relative to `plansDir` (e.g. `docs/plans/completed/`).

### Plan Selector UI

Replace the current "Prompt file" text input + Browse button with a plan dropdown, following the same pattern as the branch selector:

- **Dropdown trigger** — shows selected plan filename or "Select a plan..." placeholder. Clicking opens the dropdown.
- **Dropdown menu** — lists `.md` files from `plansDir` (excluding `completed/`), with a search/filter input at the top. Files listed by name only (without directory prefix).
- **Browse button** — opens native file picker (local/WSL) or text input (SSH) for selecting files outside the standard plans directory.

The one-shot prompt flow (1-Shot button + OneShotView) remains unchanged.

### Plan Listing via Runtime

A new Tauri command `list_plans` takes the repo config and plans directory path, executes through the appropriate runtime (local, WSL, SSH):

```
find <repoRoot>/<plansDir> -maxdepth 1 -name '*.md' -type f -printf '%f\n'
```

Returns filenames only. `maxdepth 1` excludes the `completed/` subdirectory.

### Auto-Move on Completion

When a session completes successfully (`session_complete` event with `outcome === "completed"`) and has a `plan_file` set, invoke a new Tauri command `move_plan_to_completed` that executes through the runtime:

```
mkdir -p <plansDir>/completed && mv <plansDir>/<file> <plansDir>/completed/<file>
```

This fires in `App.svelte`'s session event handler. Fire-and-forget — failures are logged but don't block. After the move, the plan selector is cleared to prevent stale selection.

Works for both Ralph loop and 1-shot sessions.

---

## Implementation Plan

### Task 1: Add `plansDir` to RepoConfig

Add the optional `plansDir` field to the repo configuration types.

**Files to modify:**
- `src/repos.ts`

**Pattern reference:** `src/repos.ts` — existing `LocalRepoConfig` and `SshRepoConfig` types (lines 6-33)

**Details:**
- Add `plansDir?: string` to both `LocalRepoConfig` and `SshRepoConfig`
- No migration needed — field is optional, defaults handled at usage site

**Checklist:**
- [x] Add `plansDir?: string` to `LocalRepoConfig`
- [x] Add `plansDir?: string` to `SshRepoConfig`
- [x] Verify: `npx tsc --noEmit`

---

### Task 2: Add `plansDir` setting to RepoDetail UI

Expose the plans directory configuration in the repo settings section.

**Files to modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** `src/RepoDetail.svelte` — existing settings fields like `model`, `completionSignal` (lines 30-43 for state, settings template section)

**Details:**
- Add `plansDir` local state variable, initialized from `repo.plansDir ?? ""`
- Sync in the existing `$effect` that re-syncs when repo prop changes
- Add input field in settings section with placeholder `docs/plans/`
- Include in `handleSave` — only set on repo if non-empty

**Checklist:**
- [x] Add `plansDir` state variable
- [x] Sync from repo prop in existing `$effect`
- [x] Add labeled input in settings section
- [x] Include in `handleSave` logic
- [x] Verify: `npx tsc --noEmit`

---

### Task 3: Add `list_plans` Tauri command

Backend command to list plan files from the configured directory via the runtime.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs` — `list_local_branches` command (lines 440-460)

**Details:**
- New `#[tauri::command] async fn list_plans(repo: RepoType, plans_dir: String)`
- Use `resolve_runtime` to get the runtime and working dir
- Execute: `find <working_dir>/<plans_dir> -maxdepth 1 -name '*.md' -type f -printf '%f\n' | sort`
- Parse stdout lines into `Vec<String>`
- If the directory doesn't exist, return empty vec (don't error)
- Register in `invoke_handler`

**Checklist:**
- [ ] Add `list_plans` command function
- [ ] Handle missing directory gracefully (empty vec)
- [ ] Register in `tauri::generate_handler![]`
- [ ] Verify: `cd src-tauri && cargo check`

---

### Task 4: Add `move_plan_to_completed` Tauri command

Backend command to move a plan file to the completed subdirectory via the runtime.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs` — `list_local_branches` command (lines 440-460) for runtime dispatch pattern

**Details:**
- New `#[tauri::command] async fn move_plan_to_completed(repo: RepoType, plans_dir: String, filename: String)`
- Use `resolve_runtime`
- Execute: `mkdir -p <working_dir>/<plans_dir>/completed && mv <working_dir>/<plans_dir>/<filename> <working_dir>/<plans_dir>/completed/<filename>`
- Shell-escape the filename to prevent injection
- Return `Ok(())` or error string
- Register in `invoke_handler`

**Checklist:**
- [ ] Add `move_plan_to_completed` command function
- [ ] Shell-escape filename parameter
- [ ] Register in `tauri::generate_handler![]`
- [ ] Verify: `cd src-tauri && cargo check`

---

### Task 5: Build plan selector dropdown component

Replace the current plan text input with a dropdown following the branch selector pattern.

**Files to modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** `src/RepoDetail.svelte` — branch selector (lines 154-260 logic, 290-336 template, 1079-1199 styles)

**Details:**
- Add state: `plans: string[]`, `planDropdownOpen: boolean`, `planSearch: string`
- Add `filteredPlans` derived from search
- Add `fetchPlans()` — invokes `list_plans` with repo payload and `plansDir ?? "docs/plans/"`
- Add `handleSelectPlan(filename: string)` — sets `planFile` to `<plansDir>/<filename>`, closes dropdown
- Add `handlePlanSearchKeydown` for Escape/Enter
- Add click-outside handler (extend existing `handleClickOutside` to also close `.plan-selector`)
- Fetch plans on dropdown open (same pattern as branches)

**Template:**
- Replace the existing plan section (lines 519-543) with:
  - Dropdown trigger button showing selected plan name or "Select a plan..."
  - Dropdown menu with search input and plan list
  - Browse button (kept, using existing `browsePrompt`)
- Keep the preview section as-is (it reacts to `planFile` changes)

**Styles:**
- Reuse branch selector CSS classes or duplicate with `plan-` prefix

**Checklist:**
- [ ] Add plan selector state variables
- [ ] Add `fetchPlans()` function
- [ ] Add `handleSelectPlan()` function
- [ ] Add search keydown handler
- [ ] Extend click-outside handler for plan selector
- [ ] Replace plan section template with dropdown + browse button
- [ ] Add/reuse dropdown styles
- [ ] Verify: `npx tsc --noEmit`

---

### Task 6: Auto-move plan on successful session completion

After a session completes successfully, move the plan file to completed and clear the selector.

**Files to modify:**
- `src/App.svelte`

**Pattern reference:** `src/App.svelte` — session_complete handler (lines 132-137)

**Details:**
- In the `session_complete` event handler, check `event.outcome === "completed"` and `event.plan_file` is set
- Look up the repo config to get `plansDir` (default `docs/plans/`)
- Extract the filename from the plan_file path
- Build repo payload and invoke `move_plan_to_completed`
- Fire-and-forget: `.catch(e => console.warn("Failed to move plan:", e))`
- Need to track which plan file is associated with which repo's session — the `plan_file` field is on the `session_complete` event or can be found from the session's events (the `session_started` event carries it)

**Checklist:**
- [ ] Add auto-move logic in `session_complete` handler
- [ ] Extract filename and plansDir from repo config
- [ ] Invoke `move_plan_to_completed` fire-and-forget
- [ ] Log warning on failure
- [ ] Verify: `npx tsc --noEmit`

---

### Task 7: Clear plan selector after auto-move

Reset the plan selection in RepoDetail after a plan is moved to completed.

**Files to modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** `src/RepoDetail.svelte` — `wasRunning` effect that refreshes branch info after session ends (lines 245-252)

**Details:**
- Add an `$effect` similar to the branch refresh pattern: when `wasRunning && !session.running`, clear `planFile` if the session completed successfully
- Check `session.trace?.outcome === "completed"` and `session.trace?.plan_file` to determine if the plan was moved
- Reset `planFile = ""` to clear the dropdown

**Checklist:**
- [ ] Add effect to clear `planFile` after successful completion
- [ ] Only clear when outcome is "completed" and plan_file was set
- [ ] Verify: `npx tsc --noEmit`

---

### Task 8: Tests for new Tauri commands

Add Rust tests for `list_plans` and `move_plan_to_completed`.

**Files to modify:**
- `src-tauri/src/lib.rs` (or a new test module)

**Pattern reference:** `src-tauri/src/` — existing test patterns

**Details:**
- Test `list_plans` with a temp directory containing `.md` files and a `completed/` subdirectory
- Verify `completed/` contents are excluded
- Verify non-`.md` files are excluded
- Verify empty/missing directory returns empty vec
- Test `move_plan_to_completed` moves file correctly and creates `completed/` dir
- These test the command logic directly, not through Tauri IPC

**Checklist:**
- [ ] Test list_plans returns only top-level .md files
- [ ] Test list_plans excludes completed/ subdirectory
- [ ] Test list_plans with missing directory
- [ ] Test move_plan_to_completed moves file and creates dir
- [ ] Verify: `cd src-tauri && cargo test`

---

### Task 9: Frontend tests for plan selector

Add Vitest tests for plan selector behavior.

**Files to modify:**
- `src/RepoDetail.test.ts` (or new file if needed)

**Pattern reference:** `src/OneShotView.test.ts` — existing component test patterns

**Details:**
- Test plan dropdown opens and shows plans
- Test search filtering
- Test plan selection sets planFile
- Test plan selector clears after successful session
- Mock `invoke("list_plans", ...)` to return test data

**Checklist:**
- [ ] Test dropdown toggle and plan listing
- [ ] Test search filtering
- [ ] Test plan selection
- [ ] Test auto-clear after completion
- [ ] Verify: `npm test`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add `plansDir` to RepoConfig | Done |
| 2 | Add `plansDir` setting to RepoDetail UI | Done |
| 3 | Add `list_plans` Tauri command | Not Started |
| 4 | Add `move_plan_to_completed` Tauri command | Not Started |
| 5 | Build plan selector dropdown component | Not Started |
| 6 | Auto-move plan on successful completion | Not Started |
| 7 | Clear plan selector after auto-move | Not Started |
| 8 | Tests for new Tauri commands | Not Started |
| 9 | Frontend tests for plan selector | Not Started |
