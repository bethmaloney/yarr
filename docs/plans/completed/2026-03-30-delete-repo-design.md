# Delete Repo — Design Plan

## Overview

Add the ability to remove a repository from Yarr's configuration. This does **not** delete the actual repo on disk — it only removes the entry from Yarr's persisted `repos.json` store. The user accidentally added a non-repo folder and currently has no way to remove it.

The data layer (`removeRepo` in `src/repos.ts`) and its tests already exist. The work is exposing this through the Zustand store and providing UI affordances in two places:

1. **Settings sheet** (RepoDetail) — a destructive "Remove Repository" button in the sheet footer
2. **Dashboard card** (Home) — a right-click / context-menu or secondary action on `RepoCard`

Both surfaces show a native Tauri confirmation dialog before proceeding.

---

## Task 1: Wire `removeRepo` into the Zustand Store

**Files to modify:**
- `src/store.ts`

**Pattern reference:** Follow the existing `updateRepo` store action at `store.ts:775-779` — it calls the repos module function, reloads repos, and sets state.

**Checklist:**
- [x] Import `removeRepo as reposRemoveRepo` from `./repos` (alongside existing imports at line 11-16)
- [x] Add `removeRepo: (id: string) => Promise<void>` to the `AppStore` interface (after `updateRepo` on line 35)
- [x] Implement the store action (after `updateRepo` implementation at line 775-779):
  ```
  removeRepo: async (id: string) => {
    await reposRemoveRepo(id);
    const repos = await reposLoadRepos();
    set({ repos });
  },
  ```
- [x] Also clean up related state when removing a repo:
  - Remove the repo's entry from `sessions` Map (if any)
  - Remove the repo's entry from `gitStatus` record (if any)
  - Remove the repo's entry from `latestTraces` Map (if any)

---

## Task 2: Add "Remove Repository" Button to Settings Sheet (RepoDetail)

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** The existing confirmation dialog pattern using `ask()` from `@tauri-apps/plugin-dialog` at `RepoDetail.tsx:548` and `store.ts:211`. The destructive button variant is defined in `src/components/ui/button.tsx:13-14`.

**Checklist:**
- [x] Import `Trash2` icon from `lucide-react` (add to existing icon imports at line 57-75)
- [x] Pull `removeRepo` from the store: `const removeRepo = useAppStore((s) => s.removeRepo)`
- [x] Add an `async function handleRemoveRepo()` that:
  1. Calls `ask("Remove this repository from Yarr? The repository on disk will not be affected.", { title: "Remove Repository?", kind: "warning" })`
  2. If confirmed, calls `await removeRepo(repo.id)`
  3. Shows a success toast: `toast.success("Repository removed")`
  4. Navigates home: `navigate("/")`
  5. Wraps in try/catch and shows `toast.error(...)` on failure
- [x] Add a "Remove Repository" button in the `SheetFooter` (line 2174-2215), positioned at the right end of the footer using `ml-auto` to push it away from the other buttons:
  ```tsx
  <Button
    type="button"
    variant="destructive"
    size="sm"
    onClick={handleRemoveRepo}
    disabled={session.running}
  >
    <Trash2 className="size-4" />
    Remove
  </Button>
  ```
- [x] The button should be disabled when a session is running (`session.running`) to prevent removing a repo mid-session

**Design system compliance:**
- Uses `variant="destructive"` (red bg, white text) per design system button variants
- Disabled state handled by button component (`disabled:pointer-events-none disabled:opacity-50`)
- Uses native Tauri `ask()` dialog for confirmation (L3 elevation, consistent with existing patterns)
- `Trash2` icon from Lucide React per icon conventions

---

## Task 3: Add Context Menu "Remove" Action on RepoCard (Home)

**Files to modify:**
- `src/components/RepoCard.tsx`
- `src/pages/Home.tsx`

**Pattern reference:** The `RepoCard` component (`src/components/RepoCard.tsx:48-246`) currently accepts `onClick` and `onPlanClick` callbacks. Follow the same callback pattern for an `onRemove` prop.

**Checklist:**

### RepoCard.tsx
- [x] Add `onRemove?: () => void` to `RepoCardProps` interface (line 14-22)
- [x] Accept `onRemove` in the destructured props (line 48-57)
- [x] Add a small icon button in the card header area (top-right corner of the card) that appears on hover (uses `<div role="button">` instead of nested `<button>` to avoid invalid HTML)
- [x] Add `group` and `relative` to the outer button's className so the hover state works
- [x] Import `X` from `lucide-react`

### Home.tsx
- [x] Import `ask` from `@tauri-apps/plugin-dialog` and `toast` from `sonner`
- [x] Pull `removeRepo` from the store
- [x] Create a `handleRemoveRepo` function (with `ask()` inside try/catch for robustness)
- [x] Pass `onRemove={() => handleRemoveRepo(item.repo.id, item.repo.name)}` to `RepoCard` in the render section where repo cards are mapped

**Design system compliance:**
- `X` icon at size-3.5 (small, unobtrusive)
- Appears only on hover (`opacity-0 group-hover:opacity-100`) with `transition-opacity duration-150`
- Hover state uses `text-destructive` and `bg-destructive/10` for clear danger signal
- `stopPropagation` prevents the card click (navigation) from firing
- Native Tauri confirmation dialog (consistent with Task 2)

---

## Task 4: Store Integration Tests

**Files to modify:**
- `src/store.test.ts` (if exists) — or add a new describe block if store tests exist
- `src/repos.test.ts` — existing tests already cover `removeRepo` at the data layer

**Pattern reference:** The existing `repos.test.ts:445-498` tests for `removeRepo`.

**Checklist:**
- [x] Verify existing `repos.test.ts` tests still pass (no changes needed — data layer is unchanged)
- [x] If `store.test.ts` exists, add a test for the `removeRepo` store action verifying:
  - Repo is removed from `repos` array
  - Associated `sessions`, `gitStatus`, and `latestTraces` entries are cleaned up
- [x] If no store tests exist, skip — the data layer is already tested and the store action is a thin wrapper

---

## Task 5: E2E Test for Remove Repo Flow

**Files to modify:**
- `e2e/` — add test case to existing repo management test file, or create a new one

**Pattern reference:** Existing E2E fixtures in `e2e/fixtures.ts` that mock Tauri IPC.

**Checklist:**
- [x] Add E2E test that:
  1. Navigates to a repo detail page
  2. Opens the settings sheet
  3. Clicks "Remove" button
  4. Confirms the dialog
  5. Verifies navigation back to Home
  6. Verifies the repo is no longer shown in the dashboard
- [x] If Tauri dialog `ask()` is not easily mockable in Playwright, test only the button presence and disabled states

---

## Design Decisions & Rationale

1. **Two removal surfaces**: Settings sheet (deliberate action while configuring) and dashboard card hover (quick cleanup). Both require confirmation — prevents accidental removal.

2. **Native Tauri `ask()` dialog** over an inline Dialog component: Consistent with the existing confirmation patterns (export overwrite at `RepoDetail.tsx:548`, update install at `store.ts:211`). Less code, OS-native feel.

3. **`X` icon on card** instead of `Trash2`: The card button is small and contextual — `X` reads as "dismiss/remove" at small sizes. The settings sheet uses the full `Trash2` icon with text label since there's more space.

4. **Cleanup of related state**: When a repo is removed, its `sessions`, `gitStatus`, and `latestTraces` entries become orphaned. Cleaning them up prevents stale data and potential errors if a new repo ever gets the same ID.

5. **Disabled during active session**: Both removal buttons are disabled while a session is running to prevent removing config out from under an active Claude session.

---

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Wire `removeRepo` into Zustand store | Done | Thin wrapper + state cleanup |
| 2. Settings sheet "Remove" button | Done | Destructive variant in SheetFooter |
| 3. RepoCard hover remove action | Done | Hover-reveal X button + Home handler + 4 unit tests + 4 E2E tests |
| 4. Store integration tests | Done | 6 tests added to store.test.ts |
| 5. E2E test for remove flow | Done | 4 E2E tests in e2e/remove-repo.test.ts |
