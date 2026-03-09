# Git Branch Support

## Summary

Add git branch awareness and management to Yarr. Users can see the current branch for each repo, switch branches, fast-forward when behind, and optionally create a new branch when starting a Ralph loop session.

## Motivation

Ralph loop sessions currently run on whatever branch the repo happens to be on — usually `main`. This is risky: a failed or incomplete session leaves work directly on the main branch. Adding branch creation as a default behavior encourages safe workflows while still giving users control.

## Scope

- **Ralph loops only** — 1-shot keeps its existing worktree-based branching
- **Local and WSL repos** — SSH repos supported once `SshRuntime::run_command()` is implemented

## Design

### Backend: Git Branch Commands

New Tauri commands for git branch operations, all routed through `RuntimeProvider::run_command()` to handle local/WSL/SSH transparently.

**Commands:**

- **`get_branch_info(repo_id, repo)`** — Returns current branch name, ahead count, and behind count relative to upstream. Runs `git branch --show-current` and `git rev-list --left-right --count HEAD...@{upstream}`.

- **`list_local_branches(repo_id, repo)`** — Returns list of local branch names. Runs `git branch --format='%(refname:short)'`.

- **`switch_branch(repo_id, repo, branch_name)`** — Checks out the given branch. Runs `git checkout {branch_name}`. Returns error if uncommitted changes conflict.

- **`fast_forward_branch(repo_id, repo)`** — Fetches from origin and fast-forwards. Runs `git fetch origin` then `git merge --ff-only @{upstream}`. Returns error if histories have diverged.

- **`create_branch(repo_path, branch_name)`** — Creates and checks out a new branch. Runs `git checkout -b {branch_name}`. Used internally by the session runner.

**Types:**

```rust
struct BranchInfo {
    name: String,
    ahead: Option<u32>,
    behind: Option<u32>,
}
```

**Runtime abstraction:** All commands resolve the correct runtime based on repo type — `default_runtime()` for local repos (picks `LocalRuntime` or `WslRuntime` based on platform), `SshRuntime` for SSH repos. Same pattern used by `session.rs` for git sync.

### Frontend: Types and Config Changes

**New type in `types.ts`:**

```typescript
interface BranchInfo {
  name: string;
  ahead: number | null;
  behind: number | null;
}
```

**RepoConfig additions:**

Both `LocalRepoConfig` and `SshRepoConfig` get a new optional field:

```typescript
createBranch?: boolean;  // defaults to true
```

This sits alongside other settings like `model` and `maxIterations`.

### Frontend: RepoDetail — Branch Display

Branch info is displayed near the top of RepoDetail, below the repo name, as a compact clickable chip/badge.

**Default state:** Shows the branch name with a small chevron icon indicating it's a dropdown (e.g., `main ▾`).

**Ahead/behind indicators:** When behind > 0, the chip gets a warning color (yellow/orange) and shows `↓3` inline. When ahead > 0, shows `↑2`. Both can appear at once. Stays compact.

**Dropdown (click to open):**
- When behind, a "Fast-forward" action appears at the top of the dropdown, visually distinct from the branch list
- Lists all local branches below, current branch highlighted/checked
- Selecting a different branch calls `switch_branch`
- Closes on selection or clicking outside
- **Disabled while a session is running** for that repo

**Loading state:** Brief loading indicator while fetching. If the command fails (not a git repo), the branch display is hidden entirely.

**Data refresh:** `get_branch_info` is called on mount and after a session completes.

### Frontend: RepoCard — Branch Label

RepoCard shows a small branch name label below the repo path. Informational only — no interactivity.

Branch info for all repos is fetched in parallel when the home view loads, stored in a `Map<string, BranchInfo>` in App.svelte state.

Hidden if the repo is not a git repo or fetch fails.

### Frontend: Settings — Create Branch Toggle

A toggle in the RepoDetail settings section: "Create branch on run". Defaults to on. Stored as `createBranch` in the repo config.

### Session Runner: Branch Creation

When a Ralph loop starts with `createBranch` enabled:

1. Generate branch name: `yarr/{slug}-{short_id}` where slug is derived from the plan file name (strip path/extension, lowercase, replace non-alphanumeric with hyphens) and short_id is the first 6 chars of the session ID
2. Run `git checkout -b {branch_name}` via the runtime provider
3. If branch creation fails (e.g., name collision), emit an error event and abort the session
4. Session proceeds as normal — git sync handles pushing if enabled

**No cleanup on session end.** The branch stays checked out. Users may want to review, run more sessions, or create a PR.

The `run_session` Tauri command gets a new parameter: `create_branch: bool`.

## Error Handling

- **Switch branch during running session:** Dropdown is disabled
- **Dirty working tree on switch:** Error message surfaced to user; no auto-stash
- **Fast-forward on diverged branch:** Error message explaining fast-forward isn't possible
- **No upstream tracking:** Ahead/behind are `null`, no fast-forward offered, just branch name shown
- **Not a git repo:** Branch display hidden entirely
- **SSH repos:** Commands go through `SshRuntime` — currently blocked until `run_command()` is implemented there
- **Create branch on non-main branch:** Works fine, branches off current HEAD

---

## Implementation Plan

### Task 1: Add `BranchInfo` type and git branch Tauri commands

Add the backend infrastructure for querying and manipulating git branches, routed through `RuntimeProvider::run_command()`.

**Files to create/modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs:308-338` (existing `read_file_preview` and `test_ssh_connection` commands for simple Tauri command pattern); `src-tauri/src/session.rs:451-462` (runtime `run_command` + output parsing pattern)

**Details:**
- Define `BranchInfo` struct with `name: String`, `ahead: Option<u32>`, `behind: Option<u32>`, derive `Serialize`
- Add `get_branch_info(repo: RepoType) -> Result<BranchInfo, String>` command:
  - Resolve runtime via `default_runtime()` for `Local`, `SshRuntime::new()` for `Ssh`
  - Run `git branch --show-current` to get branch name
  - Run `git rev-list --left-right --count HEAD...@{upstream}` for ahead/behind (parse `"3\t5"` format)
  - If upstream command fails (no tracking branch), return `ahead: None, behind: None`
- Add `list_local_branches(repo: RepoType) -> Result<Vec<String>, String>` command:
  - Run `git branch --format='%(refname:short)'`
  - Parse stdout lines into Vec
- Add `switch_branch(repo: RepoType, branch: String) -> Result<(), String>` command:
  - Run `git checkout {branch}` — surface error on failure (dirty tree, etc.)
- Add `fast_forward_branch(repo: RepoType) -> Result<(), String>` command:
  - Run `git fetch origin`, then `git merge --ff-only @{upstream}`
  - Surface error if fast-forward not possible
- Register all four commands in `invoke_handler` at bottom of `run()`
- Resolve repo path from `RepoType` for `run_command`'s `working_dir` parameter

**Checklist:**
- [x] Define `BranchInfo` struct
- [x] Implement `get_branch_info` command
- [x] Implement `list_local_branches` command
- [x] Implement `switch_branch` command
- [x] Implement `fast_forward_branch` command
- [x] Register commands in `invoke_handler`
- [x] `cd src-tauri && cargo check`

---

### Task 2: Add `BranchInfo` type and `createBranch` to frontend types

Add the TypeScript types and update `RepoConfig` to include the `createBranch` setting.

**Files to modify:**
- `src/types.ts`
- `src/repos.ts`

**Pattern reference:** `src/types.ts` (existing type definitions like `GitSyncConfig`); `src/repos.ts:6-31` (existing `RepoConfig` union types)

**Details:**
- Add `BranchInfo` interface to `types.ts`: `{ name: string; ahead: number | null; behind: number | null }`
- Add `createBranch?: boolean` to both `LocalRepoConfig` and `SshRepoConfig` in `repos.ts`
- Export `BranchInfo` from `types.ts`

**Checklist:**
- [x] Add `BranchInfo` type to `types.ts`
- [x] Add `createBranch` field to `LocalRepoConfig`
- [x] Add `createBranch` field to `SshRepoConfig`
- [x] `npx tsc --noEmit`

---

### Task 3: Add "Create branch on run" toggle to RepoDetail settings

Add the toggle to the settings section and wire it into the save function.

**Files to modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** `src/RepoDetail.svelte:312-353` (git sync toggle and settings pattern — checkbox with `bind:checked`, disabled during session)

**Details:**
- Add `let createBranch = $state(repo.createBranch ?? true)` in the script section alongside other settings state
- Add re-sync in the `$effect` block: `createBranch = repo.createBranch ?? true`
- Add a checkbox label in the settings form (inside the `<details class="settings">` block), after the completion signal field and before env vars: "Create branch on run" with `bind:checked={createBranch}`, `disabled={session.running}`
- Update `saveSettings()` to include `createBranch` in the spread to `onUpdateRepo`

**Checklist:**
- [x] Add `createBranch` state variable
- [x] Add re-sync in `$effect`
- [x] Add toggle UI in settings section
- [x] Wire into `saveSettings()`
- [x] `npx tsc --noEmit`

---

### Task 4: Pass `createBranch` through to backend and create branch before session

Wire the `createBranch` flag from frontend through `run_session` invocation, and create the branch in the session runner before the iteration loop begins.

**Files to modify:**
- `src/App.svelte` (pass `createBranch` in `invoke("run_session", ...)`)
- `src-tauri/src/lib.rs` (add `create_branch` parameter to `run_session`, create branch before running)
- `src-tauri/src/oneshot.rs` (reuse `slugify` and `generate_short_id` — already public)

**Pattern reference:** `src/App.svelte:207-217` (existing `run_session` invoke); `src-tauri/src/lib.rs:101-174` (`run_session` command with runtime resolution); `src-tauri/src/oneshot.rs:42-81` (`slugify` and `generate_short_id`)

**Details:**
- In `App.svelte` `handleRunSession`: add `createBranch: repo.createBranch ?? true` to the invoke params
- In `lib.rs` `run_session`: add `create_branch: bool` parameter
- In the `Local` branch of `run_session`, after verifying the plan file exists and before building the config:
  - If `create_branch` is true:
    - Extract plan file stem (strip path and extension)
    - Call `oneshot::slugify()` on the stem
    - Call `oneshot::generate_short_id()` for the short ID
    - Format branch name as `yarr/{slug}-{short_id}`
    - Run `runtime.run_command(&format!("git checkout -b {branch_name}"), &repo_path_buf, timeout)`
    - If it fails, clean up the active session token and return error
- The timeout for the git command can be a reasonable default (e.g., 30 seconds)

**Checklist:**
- [x] Add `createBranch` to frontend `invoke` call
- [x] Add `create_branch` param to `run_session` Tauri command
- [x] Implement branch creation logic in `Local` arm
- [x] `cd src-tauri && cargo check`
- [x] `npx tsc --noEmit`

---

### Task 5: Add branch display chip to RepoDetail

Show the current branch name with ahead/behind indicators below the repo name in RepoDetail, with click-to-open dropdown for switching branches.

**Files to modify:**
- `src/RepoDetail.svelte`

**Pattern reference:** `src/RepoDetail.svelte:155-180` (header section with repo name and path); `src/RepoDetail.svelte:76-88` (invoke + promise pattern for loading data)

**Details:**
- Add state: `branchInfo: BranchInfo | null = null`, `branches: string[] = []`, `branchDropdownOpen = false`, `branchLoading = false`, `branchError: string | null = null`
- Add `fetchBranchInfo()` function: builds `repoPayload` from repo type, calls `invoke("get_branch_info", { repo: repoPayload })`, sets `branchInfo` state
- Add `fetchBranches()` function: calls `invoke("list_local_branches", { repo: repoPayload })`, sets `branches` state
- Call `fetchBranchInfo()` on mount via `$effect` that runs once (or `onMount`)
- Also call `fetchBranchInfo()` when `session.running` transitions from true to false (session completed)
- In the template, after `<p class="repo-path">` and before `<details class="settings">`:
  - Show branch chip only when `branchInfo` is not null
  - Chip content: branch name, plus `↑{ahead}` and/or `↓{behind}` when non-null and > 0
  - Behind state: chip gets warning color (e.g., `color: #f59e0b`)
  - Clicking chip: toggle `branchDropdownOpen`, call `fetchBranches()` when opening
  - Dropdown (positioned below chip):
    - If `branchInfo.behind > 0`: "Fast-forward" button at top, calls `invoke("fast_forward_branch", { repo })` then refreshes
    - List of branches, current branch highlighted, click switches and refreshes
    - Disabled when `session.running`
  - Click outside closes dropdown
- Add styles: chip styling, dropdown positioning, warning color, disabled state

**Checklist:**
- [ ] Add branch state variables
- [ ] Implement `fetchBranchInfo()` and `fetchBranches()`
- [ ] Add fetch on mount
- [ ] Add fetch after session completes
- [ ] Add branch chip markup
- [ ] Add dropdown with fast-forward and branch list
- [ ] Add click-outside-to-close behavior
- [ ] Add CSS styles
- [ ] `npx tsc --noEmit`

---

### Task 6: Add branch label to RepoCard

Show the current branch name as a small label on the repo card in the home view.

**Files to modify:**
- `src/RepoCard.svelte`
- `src/App.svelte`

**Pattern reference:** `src/RepoCard.svelte:41-78` (card layout with repo-info, last-run, repo-status sections); `src/App.svelte:68-81` (parallel data fetching on mount)

**Details:**
- In `App.svelte`:
  - Add `branchInfos` state: `SvelteMap<string, BranchInfo>`
  - In `onMount`, after repos are loaded, fetch `get_branch_info` for each repo in parallel using `Promise.allSettled`
  - Store results in `branchInfos` map keyed by repo ID
  - Build `repoPayload` from each repo's type for the invoke call
- In `RepoCard.svelte`:
  - Add `branchName` prop: `branchName?: string`
  - Display below `.repo-path` as a small label (e.g., `<span class="branch-label">branchName</span>`) when present
  - Style: small font, monospace, muted color, with a branch icon character (e.g., a simple text prefix or unicode)
- In `App.svelte` template: pass `branchName={branchInfos.get(repo.id)?.name}` to `RepoCard`

**Checklist:**
- [ ] Add `branchInfos` state to `App.svelte`
- [ ] Fetch branch info for all repos on mount
- [ ] Add `branchName` prop to `RepoCard`
- [ ] Add branch label markup and styles to `RepoCard`
- [ ] Pass `branchName` from `App.svelte` to `RepoCard`
- [ ] `npx tsc --noEmit`

---

### Task 7: Tests for backend git branch commands

Add unit tests for the new Tauri commands — primarily testing `BranchInfo` serialization, the `slugify` reuse for branch naming, and command output parsing.

**Files to modify:**
- `src-tauri/src/lib.rs` (add tests in existing `#[cfg(test)] mod tests`)

**Pattern reference:** `src-tauri/src/lib.rs:420-513` (existing tests for `TaggedSessionEvent` serialization, `RepoType` deserialization)

**Details:**
- Test `BranchInfo` serializes correctly with all fields
- Test `BranchInfo` serializes correctly with `None` ahead/behind
- Test branch name generation: `slugify` on plan file stem + short ID format
- Test parsing of `git rev-list --left-right --count` output format (`"3\t5\n"` → ahead=3, behind=5)
- Extract the rev-list parsing logic into a helper function to make it testable

**Checklist:**
- [ ] Add `BranchInfo` serialization tests
- [ ] Add branch name generation tests
- [ ] Add rev-list output parsing tests
- [ ] `cd src-tauri && cargo test`

---

### Task 8: Frontend tests for branch display

Add tests for the branch-related UI logic and interactions.

**Files to modify:**
- `src/RepoCard.test.ts` or new test file if none exists
- `src/RepoDetail.test.ts` or new test file if none exists

**Pattern reference:** `src/*.test.ts` (existing Vitest test files)

**Details:**
- Test RepoCard renders branch label when `branchName` is provided
- Test RepoCard hides branch label when `branchName` is undefined
- Test that `createBranch` defaults to true when not set in repo config
- Verify type correctness of `BranchInfo` interface

**Checklist:**
- [ ] Add RepoCard branch label tests
- [ ] Add createBranch default behavior tests
- [ ] `npm test`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Backend git branch Tauri commands | Complete |
| 2 | Frontend `BranchInfo` type and `createBranch` config | Complete |
| 3 | "Create branch on run" toggle in RepoDetail settings | Complete |
| 4 | Pass `createBranch` to backend and create branch before session | Complete |
| 5 | Branch display chip with dropdown on RepoDetail | Not Started |
| 6 | Branch label on RepoCard + fetch in App.svelte | Not Started |
| 7 | Backend tests for git branch commands | Not Started |
| 8 | Frontend tests for branch display | Not Started |
