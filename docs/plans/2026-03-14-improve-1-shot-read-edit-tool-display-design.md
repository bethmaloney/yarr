# Improve 1-Shot Read/Edit Tool Display

## Overview

1-Shot sessions display full absolute worktree paths for Read/Edit/Write tool uses (e.g., `/home/beth/.yarr/worktrees/209caef3-2d13-4d24-a83c-943ed684f858-oneshot-b775c9/src/components/IterationGroup.tsx`) instead of relative paths (`src/components/IterationGroup.tsx`). Ralph loops already show relative paths correctly. The fix is to pass the worktree path as the `repoPath` to the display components so `relativePath()` can strip the worktree prefix.

## Root Cause

In `src/pages/OneShotDetail.tsx:37-45`, the `repoPath` passed to `EventsList` is derived from the **parent repo config** (e.g., `/home/beth/repos/yarr`). However, Claude runs inside a **worktree** (e.g., `/home/beth/.yarr/worktrees/<id>-oneshot-<short>/`), so all tool_use file paths are absolute paths within the worktree. Since the parent repo path doesn't match the worktree prefix, `relativePath()` returns the full absolute path unchanged.

**Ralph loops work correctly** because in `src/pages/RunDetail.tsx:259`, `repoPath` comes from `trace.repo_path`, which the backend sets to the actual repo directory where Claude runs — which matches the file paths Claude produces.

## Solution

Use `entry.worktreePath` (already available on the `OneShotEntry` type at `src/types.ts:105`) as the `repoPath` for display. This is the directory where Claude actually runs, so it matches the file paths in tool_use events.

---

## Task 1: Update `OneShotDetail.tsx` to use worktree path

**Files to modify:**
- `src/pages/OneShotDetail.tsx`

**Pattern reference:**
- `src/pages/RunDetail.tsx:259` — uses `trace.repo_path` (the actual working directory of the Claude session)

**Checklist:**
- [x] Replace the `repoPath` derivation (lines 37-45) to use `entry.worktreePath` instead of the parent repo path
- [x] The new logic: `const repoPath = entry?.worktreePath;` — simple, since `worktreePath` is already optional (`string | undefined`) which is what `EventsList` accepts
- [x] Remove the now-unused `repos` selector (`useAppStore((s) => s.repos)`) and `parentRepo` lookup if they are no longer used elsewhere in the component (verify first — they are not used elsewhere)

## Task 2: Add test coverage

**Files to modify:**
- `src/event-format.test.ts`

**Pattern reference:**
- Existing `relativePath` tests at `src/event-format.test.ts:289-365`

**Checklist:**
- [x] Add a test case to `relativePath` that verifies worktree paths are correctly relativized:
  ```ts
  it("strips worktree prefix for 1-shot sessions", () => {
    expect(
      relativePath(
        "/home/beth/.yarr/worktrees/209caef3-oneshot-b775c9/src/components/Foo.tsx",
        "/home/beth/.yarr/worktrees/209caef3-oneshot-b775c9",
      ),
    ).toBe("src/components/Foo.tsx");
  });
  ```
  (Note: this should already pass since `relativePath` is path-agnostic — it just strips prefixes. This test documents the 1-shot use case explicitly.)

## Task 3: Update E2E test if needed

**Files to check:**
- `e2e/oneshot.test.ts`

**Checklist:**
- [x] Review existing 1-shot E2E tests; if any assert on full absolute paths in tool display, update them to expect relative paths
- [x] If mock data includes worktree-style paths, ensure the mocked `OneShotEntry` has a `worktreePath` set so the relative path logic is exercised

**Result:** E2E tests do not assert on tool_use file path display — they test phase indicators, form submission, and navigation. No E2E changes needed. Existing `OneShotDetail.test.tsx` unit tests for repoPath were updated to reflect the new worktree-based logic.

---

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Update `OneShotDetail.tsx` | Done | Replaced parent repo lookup with `entry?.worktreePath` |
| 2. Add unit test | Done | Added worktree case to `relativePath` tests + updated `OneShotDetail.test.tsx` |
| 3. Review E2E tests | Done | No changes needed — E2E tests don't assert on file paths in tool display |
