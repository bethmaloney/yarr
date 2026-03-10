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
- `src/pages/RepoDetail.tsx` (React, not Svelte — project was migrated)

**Pattern reference:** `src/pages/RepoDetail.tsx` — existing settings fields like `model`, `completionSignal` (state hooks, settings collapsible section)

**Details:**
- Add `plansDir` local state variable, initialized from `repo.plansDir ?? ""`
- Sync in the existing useEffect that re-syncs when repo prop changes
- Add input field in settings section with placeholder `docs/plans/`
- Include in `saveSettings` — only set on repo if non-empty (`plansDir || undefined`)

**Checklist:**
- [x] Add `plansDir` state variable
- [x] Sync from repo prop in existing useEffect
- [x] Add labeled input in settings section
- [x] Include in `saveSettings` logic
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
- [x] Add `list_plans` command function
- [x] Handle missing directory gracefully (empty vec)
- [x] Register in `tauri::generate_handler![]`
- [x] Verify: `cd src-tauri && cargo check`

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
- [x] Add `move_plan_to_completed` command function
- [x] Shell-escape filename parameter
- [x] Register in `tauri::generate_handler![]`
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 5: Build plan selector dropdown component

Replace the current plan text input with a dropdown following the branch selector pattern.

**Files modified:**
- `src/pages/RepoDetail.tsx` (React, not Svelte — project was migrated)

**Pattern reference:** `src/pages/RepoDetail.tsx` — branch selector (Popover + Command components)

**Details:**
- Added state: `plans: string[]`, `planDropdownOpen: boolean`, `planSearch: string`
- Added `filteredPlans` useMemo derived from search
- Added `selectedPlanName` useMemo to extract filename from path
- Added `fetchPlans()` — invokes `list_plans` with repo payload and `plansDir || "docs/plans/"`, normalizes trailing slash
- Added `handleSelectPlan(filename: string)` — sets `planFile` to `<plansDir>/<filename>`, closes dropdown, clears search
- Click-outside handled by Popover component (same as branch selector)
- Fetch plans on dropdown open (same pattern as branches)

**Template:**
- Replaced existing plan Input+Browse with Popover+Command dropdown + Browse button
- Trigger shows selected filename or "Select..." placeholder
- CommandInput for search, CommandEmpty for "No plans found", CommandItem for each plan
- Browse button kept alongside for files outside plans directory
- Preview section unchanged (reacts to `planFile`)

**Checklist:**
- [x] Add plan selector state variables
- [x] Add `fetchPlans()` function
- [x] Add `handleSelectPlan()` function
- [x] Search handled by Command shouldFilter={false} + filteredPlans memo
- [x] Click-outside handled by Popover component
- [x] Replace plan section template with dropdown + browse button
- [x] Styles via Tailwind classes (no separate CSS needed)
- [x] Verify: `npx tsc --noEmit`
- [x] 10 new tests added and passing in RepoDetail.test.tsx

---

### Task 6: Auto-move plan on successful session completion

After a session completes successfully, move the plan file to completed and clear the selector.

**Files to modify:**
- `src/store.ts` (Zustand store — session event handler; project uses React, not Svelte)

**Pattern reference:** `src/store.ts` — session event handler where `session_complete` events are processed

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
- `src/pages/RepoDetail.tsx` (React, not Svelte — project was migrated)

**Pattern reference:** `src/pages/RepoDetail.tsx` — `wasRunningRef` useEffect that refreshes branch info after session ends (lines 150-161)

**Details:**
- Add a useEffect similar to the branch refresh pattern: when `wasRunningRef.current && !session.running`, clear `planFile` if the session completed successfully
- Check `session.trace?.outcome === "completed"` and `session.trace?.plan_file` to determine if the plan was moved
- Reset `setPlanFile("")` to clear the dropdown

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
- [x] Test list_plans returns only top-level .md files
- [x] Test list_plans excludes completed/ subdirectory
- [x] Test list_plans with missing directory
- [x] Test move_plan_to_completed moves file and creates dir
- [x] Verify: `cd src-tauri && cargo test`

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
| 3 | Add `list_plans` Tauri command | Done |
| 4 | Add `move_plan_to_completed` Tauri command | Done |
| 5 | Build plan selector dropdown component | Done |
| 6 | Auto-move plan on successful completion | Not Started |
| 7 | Clear plan selector after auto-move | Not Started |
| 8 | Tests for new Tauri commands | Done |
| 9 | Frontend tests for plan selector | Not Started |
