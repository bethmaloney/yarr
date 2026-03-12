# Git Status Polling Design

## Overview

Add automatic git status polling to Yarr so users can see uncommitted files, unpushed commits, and remote changes without manually running terminal commands.

## Design Decisions

- **Polling interval:** 30 seconds for repos with auto-fetch enabled
- **SSH repos:** Auto-fetch defaults to `false` (on-demand only with manual refresh button). Can be enabled per-repo.
- **Local repos:** Auto-fetch defaults to `true`
- **During active sessions:** Polling is paused, resumes immediately when the session completes
- **Per-repo toggle:** `autoFetch` boolean in repo config, configurable in the existing Settings tab

## Data Model

### Backend

New Tauri command `get_repo_git_status` replacing `get_branch_info`:

```rust
struct RepoGitStatus {
    branch_name: String,
    dirty_count: u32,        // uncommitted files (modified + untracked + staged)
    ahead: Option<u32>,      // unpushed commits
    behind: Option<u32>,     // commits on remote not yet pulled
}
```

Runs:
1. `git fetch` (only when auto-fetch is enabled and explicitly requested)
2. `git status --porcelain` (count lines for dirty_count)
3. `git rev-list --left-right --count HEAD...@{upstream}` (ahead/behind)

### Frontend

New Zustand store state:

```typescript
gitStatus: Record<string, {
  status: RepoGitStatus | null;
  lastChecked: Date | null;
  loading: boolean;
  error: string | null;
}>
```

### Repo Config

Add `autoFetch: boolean` to `LocalRepoConfig` and `SshRepoConfig`:
- Default `true` for local repos
- Default `false` for SSH repos

## UI

### Home Page — Repo Cards

Compact indicators next to the existing branch name:

```
main  3 dirty · 2↑ · 1↓
```

- Each indicator only shown when > 0
- When all zero, just the branch name (no clutter)
- Behind uses yellow/warning styling (matches existing convention)
- For repos with auto-fetch disabled or stale data: "last checked: 2m ago" label

### RepoDetail Page — Branch Chip

Same indicators with more room:

```
main  3 dirty · 2↑ · 1↓    last checked: 30s ago
```

- "last checked" timestamp shown for all repos
- **Refresh button** (circular arrow icon) always visible, triggers immediate fetch + status
- Existing fast-forward button remains (visible when behind > 0)

### RepoDetail Page — Config Sheet

New toggle in the Settings tab:
- **"Auto-fetch"** — "Automatically fetch from remote every 30 seconds"
- Placed near existing git-related settings (near "Create branch" checkbox)

## Error Handling

- **Automatic poll failures:** No toast spam. Show a subtle warning icon (⚠) on the status indicator. Hover/click reveals the error message. Last known good data + stale timestamp preserved. Clears on next successful fetch.
- **Manual refresh failures:** Show a toast with the actual error (user explicitly requested it).

## Implementation Plan

### Task 1: Add `autoFetch` to repo config types

Add `autoFetch?: boolean` field to both `LocalRepoConfig` and `SshRepoConfig`.

**Files to modify:**
- `src/repos.ts`

**Pattern reference:** `src/repos.ts` — existing optional fields like `gitSync?: GitSyncConfig` (lines 16, 32)

**Details:**
- Add `autoFetch?: boolean` to both config types
- Existing repos without the field will be treated as `undefined`, which the frontend interprets using defaults (true for local, false for SSH)

**Checklist:**
- [x] Add `autoFetch?: boolean` to `LocalRepoConfig`
- [x] Add `autoFetch?: boolean` to `SshRepoConfig`
- [x] Verify: `npx tsc --noEmit`

---

### Task 2: Add `RepoGitStatus` type and new Tauri command

Create the `get_repo_git_status` backend command that returns branch name, dirty count, and ahead/behind.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs` — `get_branch_info` command (lines 513-538)

**Details:**
- Add `RepoGitStatus` struct with `branch_name`, `dirty_count`, `ahead`, `behind`
- New `get_repo_git_status` command that takes `RepoType` and `fetch: bool`
- When `fetch` is true, run `git fetch` first (with timeout)
- Run `git status --porcelain` and count output lines for `dirty_count`
- Run `git rev-list --left-right --count HEAD...@{upstream}` for ahead/behind (reuse existing `parse_rev_list_output`)
- Run `git branch --show-current` for branch name
- Keep `get_branch_info` for now to avoid breaking existing callers (remove in a later task)
- Register the new command in the Tauri builder

**Checklist:**
- [x] Add `RepoGitStatus` struct with serde derives
- [x] Implement `get_repo_git_status` command
- [x] Run `git fetch` conditionally based on `fetch` param
- [x] Run `git status --porcelain` and count lines
- [x] Reuse ahead/behind logic from `get_branch_info`
- [x] Register command in Tauri builder
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 3: Add `RepoGitStatus` type to frontend types

**Files to modify:**
- `src/types.ts`

**Pattern reference:** `src/types.ts` — `BranchInfo` type (lines 6-10)

**Details:**
- Add `RepoGitStatus` type matching the backend struct (uses camelCase: `branchName`, `dirtyCount` — matching `#[serde(rename_all = "camelCase")]`)

**Checklist:**
- [x] Add `RepoGitStatus` type
- [x] Verify: `npx tsc --noEmit`

---

### Task 4: Add git status state and actions to Zustand store

Add `gitStatus` state, polling logic, and actions to the store.

**Files to modify:**
- `src/store.ts`

**Pattern reference:** `src/store.ts` — `sessions` state and `syncActiveSession()` (lines 32, 52-82)

**Details:**
- Add `gitStatus: Record<string, { status: RepoGitStatus | null; lastChecked: Date | null; loading: boolean; error: string | null }>` to store
- Add `fetchGitStatus(repoId: string, repo: RepoConfig, fetch: boolean): void` action — calls `invoke("get_repo_git_status")`, updates store state
- Add `clearGitStatusError(repoId: string): void` action

**Checklist:**
- [x] Add `gitStatus` state to AppStore
- [x] Add `fetchGitStatus` action
- [x] Add `clearGitStatusError` action
- [x] Verify: `npx tsc --noEmit`

---

### Task 5: Create `useGitStatus` hook with polling

Replace `useBranchInfo` with a new hook that polls eligible repos every 30 seconds.

**Files to create:**
- `src/hooks/useGitStatus.ts`

**Files to modify:**
- `src/hooks/useBranchInfo.ts` (keep for now, will remove in task 9)

**Pattern reference:** `src/hooks/useBranchInfo.ts` (lines 1-50)

**Details:**
- Hook takes `repos: RepoConfig[]` and `sessions: Map<string, SessionState>`
- On mount: fetch status for all repos (with `fetch: true` for auto-fetch repos, `fetch: false` otherwise)
- Set up 30-second interval for eligible repos (auto-fetch enabled AND no active session)
- Expose `refresh(repoId: string)` function for manual refresh (always passes `fetch: true`)
- When a session transitions from running to not-running, trigger an immediate fetch for that repo
- Clean up intervals on unmount
- Use `useRef` for the interval to avoid stale closures

**Checklist:**
- [x] Create `useGitStatus` hook
- [x] Implement 30-second polling for eligible repos
- [x] Implement session-aware pause/resume
- [x] Expose `refresh` function for manual triggers
- [x] Immediate fetch on session completion
- [x] Verify: `npx tsc --noEmit`

---

### Task 6: Update Home page repo cards

Add compact git status indicators to repo cards.

**Files to modify:**
- `src/pages/Home.tsx`
- `src/components/RepoCard.tsx`

**Pattern reference:** `src/components/RepoCard.tsx` — branch name display (lines 61-65)

**Details:**
- Replace `useBranchInfo` with `useGitStatus` in Home.tsx
- Pass `gitStatus` data to `RepoCard` instead of just `branchName`
- Display indicators: `3 dirty · 2↑ · 1↓` (each only when > 0)
- Behind indicator uses yellow/warning text color
- Show "last checked: Xm ago" for repos where `autoFetch` is disabled or data is stale
- Show loading spinner when `loading` is true

**Checklist:**
- [x] Switch Home.tsx from `useBranchInfo` to `useGitStatus`
- [x] Update RepoCard props to accept git status data
- [x] Render dirty/ahead/behind indicators
- [x] Add warning styling for behind count
- [x] Add "last checked" label for non-auto-fetch repos
- [x] Verify: `npx tsc --noEmit`

---

### Task 7: Update RepoDetail page branch chip

Enhance the branch chip with dirty count, refresh button, and last-checked timestamp.

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** `src/pages/RepoDetail.tsx` — branch chip (lines 580-675)

**Details:**
- Replace local `branchInfo` state with git status from the store
- Use `useGitStatus` or read directly from store (single repo)
- Add dirty count indicator to chip: `3 dirty`
- Add "last checked: 30s ago" timestamp next to the chip
- Add refresh button (circular arrow icon) that calls `refresh(repoId)` — always visible
- Show loading spinner on refresh button while fetching
- Error state: show ⚠ icon, click/hover reveals error message
- Keep existing fast-forward button (visible when behind > 0)

**Checklist:**
- [x] Replace local branch info state with store git status
- [x] Add dirty count to branch chip
- [x] Add "last checked" timestamp
- [x] Add refresh button with loading state
- [x] Add error warning icon with tooltip
- [x] Verify: `npx tsc --noEmit`

---

### Task 8: Add auto-fetch toggle to repo config sheet

Add the toggle to the Settings tab in the repo configuration sheet.

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** `src/pages/RepoDetail.tsx` — Git Sync tab (lines 1031-1077), createBranch checkbox

**Details:**
- Add `autoFetch` state variable, initialized from `repo.autoFetch` (default `true` for local, `false` for SSH)
- Add toggle in Settings tab near "Create branch" checkbox
- Label: "Auto-fetch" with description "Automatically fetch from remote every 30 seconds"
- Save to repo config on sheet close (alongside other settings)

**Checklist:**
- [ ] Add `autoFetch` state variable with correct default per repo type
- [ ] Add toggle UI in Settings tab
- [ ] Include in save logic
- [ ] Verify: `npx tsc --noEmit`

---

### Task 9: Remove `useBranchInfo` and `get_branch_info`

Clean up the old hook and command now that everything uses the new ones.

**Files to modify:**
- `src/hooks/useBranchInfo.ts` (delete)
- `src-tauri/src/lib.rs` (remove `get_branch_info` command and registration)
- Any remaining imports of `useBranchInfo` or `BranchInfo`

**Pattern reference:** N/A — removal task

**Details:**
- Delete `useBranchInfo.ts`
- Remove `get_branch_info` function from lib.rs
- Remove from Tauri builder command registration
- Remove `BranchInfo` type from `src/types.ts` if no longer used
- Update any remaining references

**Checklist:**
- [ ] Delete `src/hooks/useBranchInfo.ts`
- [ ] Remove `get_branch_info` from `src-tauri/src/lib.rs`
- [ ] Remove from Tauri builder registration
- [ ] Clean up `BranchInfo` type if unused
- [ ] Update remaining imports
- [ ] Verify: `npx tsc --noEmit && cd src-tauri && cargo check`

---

### Task 10: Update E2E tests

Update existing branch display tests and add new tests for git status polling.

**Files to modify:**
- `e2e/branch-display.test.ts`

**Pattern reference:** `e2e/branch-display.test.ts` — existing mock patterns (lines 14-54)

**Details:**
- Update mocks from `get_branch_info` to `get_repo_git_status`
- Update response shape to `RepoGitStatus` (add `dirty_count`)
- Add tests for:
  - Dirty count display on repo card and branch chip
  - "last checked" timestamp display
  - Refresh button triggers fetch
  - Error state warning icon
  - Auto-fetch toggle in config sheet
- Existing tests for ahead/behind/branch switching should still pass with updated mocks

**Checklist:**
- [ ] Update all mocks from `get_branch_info` to `get_repo_git_status`
- [ ] Update response shapes to include `dirty_count`
- [ ] Add dirty count display tests
- [ ] Add "last checked" timestamp tests
- [ ] Add refresh button tests
- [ ] Add error state tests
- [ ] Add auto-fetch toggle tests
- [ ] Verify: `npm run test:e2e`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add `autoFetch` to repo config types | Done |
| 2 | Add `RepoGitStatus` type and new Tauri command | Done |
| 3 | Add `RepoGitStatus` type to frontend types | Done |
| 4 | Add git status state and actions to Zustand store | Done |
| 5 | Create `useGitStatus` hook with polling | Done |
| 6 | Update Home page repo cards | Done |
| 7 | Update RepoDetail page branch chip | Done |
| 8 | Add auto-fetch toggle to repo config sheet | Not Started |
| 9 | Remove `useBranchInfo` and `get_branch_info` | Not Started |
| 10 | Update E2E tests | Not Started |
