# Remove Test Button — Design Plan

## Overview

Remove the "Test Run" button from the repository detail page and all associated code. This button invokes `run_mock_session`, a Tauri command that runs a fake session using `MockRuntime`. It was useful during early development but is no longer needed in the UI. The `MockRuntime` itself is still used extensively in unit/integration tests and must **not** be removed — only the UI button and its Tauri command are removed.

## Task 1: Remove the button from RepoDetail.svelte

**Files to modify:** `src/RepoDetail.svelte`

**Pattern reference:** The button lives in the action bar alongside "Run", "Stop", and "1-Shot" buttons (lines 520–550).

### Checklist

- [x] Remove the `onMockRun` prop from the destructured `$props()` block (line 16) and its type declaration (line 25)
- [x] Remove the "Test Run" `<button>` element (lines 533–540)
- [x] Adjust the surrounding `{#if session.running}` / `{:else}` block — the "Stop" button's else branch previously contained the "Test Run" button; after removal, the else branch is empty and should be removed entirely (keep only the `{#if session.running}` block for the Stop button)

## Task 2: Remove handleMockRun and its wiring from App.svelte

**Files to modify:** `src/App.svelte`

**Pattern reference:** `handleMockRun` (lines 261–283) follows the same pattern as `handleRunSession`. The prop is passed at line 392.

### Checklist

- [x] Delete the `handleMockRun` function (lines 261–283)
- [x] Remove the `onMockRun={() => handleMockRun(repoId)}` prop from the `<RepoDetail>` usage (line 392)

## Task 3: Remove the `run_mock_session` Tauri command from the Rust backend

**Files to modify:** `src-tauri/src/lib.rs`

### Checklist

- [x] Delete the `run_mock_session` function (lines 62–106)
- [x] Remove `run_mock_session` from the `invoke_handler` registration (line 572)
- [x] Remove the `MockRuntime` import from the `use runtime::` line (line 16) — check if any other code in `lib.rs` still uses it first (it should not after this removal)

## Task 4: Remove or update the E2E test

**Files to modify:** `e2e/home.test.ts`

### Checklist

- [x] Delete the test `"'Test Run' button visible instead of 'Mock'"` (lines 179–189)

## Task 5: Update README diagram

**Files to modify:** `README.md`

### Checklist

- [x] Update line 27 — change `Button → invoke("run_mock_session")` to `Button → invoke("run_session")` (or remove the line) to reflect the actual UI flow

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Remove button from RepoDetail.svelte | Done | Removed prop + button element |
| 2. Remove handleMockRun from App.svelte | Done | Deleted function + prop wiring |
| 3. Remove run_mock_session from lib.rs | Done | Deleted command + unregister + cleaned import |
| 4. Remove E2E test | Done | Deleted test case |
| 5. Update README | Done | Fixed diagram + stale quick-start text |
