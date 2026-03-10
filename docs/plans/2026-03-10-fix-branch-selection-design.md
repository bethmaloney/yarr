# Fix: Branch Selection Does Nothing

## Overview

When a user selects a different branch from the branch dropdown in `RepoDetail`, the `handleSwitchBranch` function fires and calls `invoke("switch_branch", ...)`, but the `cmdk` `CommandItem` `onSelect` callback receives a **lowercased string value** (cmdk's default behavior), not the original branch name. This means the branch name sent to the backend is mangled (e.g. `feature/My-Branch` becomes `feature/my-branch`), causing `git checkout` to fail silently — the error is caught and logged to console but never shown to the user.

There are two problems to fix:

1. **cmdk lowercases the value by default** — The `CommandItem` `onSelect` callback receives a normalized (lowercased) string. Since we pass `() => handleSwitchBranch(branch)` using the outer `branch` variable from the `.map()`, this part is actually fine — the closure captures the original cased branch name. So the real issue may be elsewhere: either cmdk's internal filtering interfering (since `shouldFilter={false}` is set, this should be OK), or the `onSelect` simply not firing.

   **Root cause identified**: The `CommandItem` in cmdk uses the `value` prop (or the text content lowercased) as its internal value. When `onSelect` fires, it provides this internal value as an argument. However, the code uses `onSelect={() => handleSwitchBranch(branch)}` which captures `branch` from the closure — this should work correctly regardless of cmdk's lowercasing.

   **Actual root cause**: After closer inspection, the issue is likely that `cmdk` `CommandItem`'s `onSelect` may not fire in certain configurations, or the popover/command interaction has a conflict. The `shouldFilter={false}` combined with `onValueChange` on `CommandInput` may cause selection events to be swallowed. Alternatively, the branch selected could be the current branch, which would be a no-op.

   **Most likely root cause**: The `CommandItem` `onSelect` fires, `handleSwitchBranch` is called, the `invoke("switch_branch")` succeeds or fails, but **there is no user feedback on failure** — errors are only `console.error`'d. If `git checkout` fails (dirty working tree, branch doesn't exist, etc.), the user sees nothing.

2. **No error feedback to user** — The `handleSwitchBranch` catch block only does `console.error`. The `handleFastForward` catch block has the same problem.

## Solution

1. Add a **toast notification system** using `sonner` (the standard shadcn/ui toast library) to show success/error feedback for branch operations.
2. Add a `value` prop to `CommandItem` to ensure cmdk uses the exact branch name (defense in depth).
3. Show a toast on success confirming the branch switch, and show a toast on error explaining why it failed.

**Decision: Use `sonner`** — This is the recommended toast library for shadcn/ui projects. It's lightweight, has great defaults, and integrates cleanly. Alternatively, we could use inline error state, but toasts are better UX for transient operations like branch switching.

---

## Task 1: Install `sonner` and set up the Toaster

### Files to create or modify

- `package.json` — add `sonner` dependency
- `src/App.tsx` — add `<Toaster />` component at the root
- `src/components/ui/sonner.tsx` — create shadcn-style Toaster wrapper (optional, but follows shadcn conventions)

### Pattern references

- `src/App.tsx:36-42` — current root App component structure
- `src/main.tsx:1-6` — entry point that renders App
- shadcn/ui sonner pattern: wrap `sonner`'s `<Toaster>` with theme-appropriate defaults

### Checklist

- [x] Install `sonner`: `npm install sonner`
- [x] Create `src/components/ui/sonner.tsx` with a themed `Toaster` wrapper that uses the app's dark theme colors
- [x] Add `<Toaster />` to `src/App.tsx` inside the `<BrowserRouter>` (after `<AppRoutes />`)
- [ ] Verify the toaster renders (visual check with `npx tauri dev`)

---

## Task 2: Add toast feedback to `handleSwitchBranch`

### Files to modify

- `src/pages/RepoDetail.tsx` — update `handleSwitchBranch` and `handleFastForward`

### Pattern references

- `src/pages/RepoDetail.tsx:379-393` — current `handleSwitchBranch` implementation
- `src/pages/RepoDetail.tsx:363-377` — current `handleFastForward` implementation
- `src/pages/RepoDetail.tsx:516-524` — current `CommandItem` with `onSelect`

### Checklist

- [x] Import `toast` from `sonner` in `RepoDetail.tsx`
- [x] In `handleSwitchBranch`: on success, show `toast.success(\`Switched to ${branchName}\`)`
- [x] In `handleSwitchBranch`: on failure, show `toast.error(\`Failed to switch branch: ${errorMessage}\`)` instead of (or in addition to) `console.error`
- [x] In `handleFastForward`: on success, show `toast.success("Branch fast-forwarded")`
- [x] In `handleFastForward`: on failure, show `toast.error(\`Failed to fast-forward: ${errorMessage}\`)` instead of `console.error`
- [x] Add explicit `value={branch}` prop to `CommandItem` to ensure cmdk uses the exact branch name (prevents any potential lowercasing issues)
- [ ] Verify the toast appears when switching branches (manual test with `npx tauri dev`)

---

## Task 3: Add tests for branch switch success/error feedback

### Files to modify

- `src/pages/RepoDetail.test.tsx` — add tests for toast behavior

### Pattern references

- `src/pages/RepoDetail.test.tsx:367-420` — existing branch selector tests
- `src/pages/RepoDetail.test.tsx:187-206` — `setupMockState` pattern
- `src/pages/RepoDetail.test.tsx:222-232` — `beforeEach`/`afterEach` pattern

### Checklist

- [x] Mock `sonner` at the top of the test file: `vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))`
- [x] Add test: "shows success toast when branch switch succeeds"
  - Set up mock state with a repo
  - Mock `invoke` to resolve for `get_branch_info` and `switch_branch`
  - Mock `invoke` for `list_local_branches` to return `["main", "develop"]`
  - Open the branch popover, select "develop"
  - Assert `toast.success` was called with a message containing "develop"
- [x] Add test: "shows error toast when branch switch fails"
  - Set up mock state with a repo
  - Mock `invoke` to resolve for `get_branch_info`, reject for `switch_branch`
  - Mock `invoke` for `list_local_branches` to return `["main", "develop"]`
  - Open the branch popover, select "develop"
  - Assert `toast.error` was called with a failure message
- [x] Add test: "shows success toast when fast-forward succeeds"
  - Set up with `branchInfo` that has `behind > 0`
  - Mock `invoke` to resolve for `fast_forward_branch`
  - Click the fast-forward button
  - Assert `toast.success` was called
- [x] Add test: "shows error toast when fast-forward fails"
  - Set up with `branchInfo` that has `behind > 0`
  - Mock `invoke` to reject for `fast_forward_branch`
  - Click the fast-forward button
  - Assert `toast.error` was called
- [x] Run `npm test` and verify all tests pass
- [ ] Run `npx tsc --noEmit` to verify no type errors

---

## Task 4: Type-check, lint, and format

### Commands

- `npx tsc --noEmit`
- `npx eslint .`
- `npx prettier --write .`

### Checklist

- [ ] Run TypeScript check — no errors
- [ ] Run ESLint — no errors
- [ ] Run Prettier — all files formatted
- [ ] Run `npm test` — all tests pass

---

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Install sonner and set up Toaster | Done | Visual verification still needed |
| 2. Add toast feedback to branch operations | Done | Visual verification still needed |
| 3. Add tests for branch switch feedback | Done | 4 tests added, all passing |
| 4. Type-check, lint, and format | Not started | Final validation |
