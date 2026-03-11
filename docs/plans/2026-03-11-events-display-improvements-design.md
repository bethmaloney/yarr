# Events Display Improvements

## Overview

Five improvements to the events display page: fix relative paths on WSL, show Agent descriptions, render Agent prompts as markdown, round costs to cents, and add context percentage to iteration titles.

## Changes

### 1. Fix relative paths (WSL path mismatch)

**Problem:** `repo.path` from the Windows file picker is a UNC path like `\\wsl.localhost\Ubuntu-24.04\home\beth\repos\yarr2`. Claude reports file paths as Unix paths like `/home/beth/repos/yarr2/CLAUDE.md`. The `relativePath()` function normalizes backslashes but doesn't strip UNC prefixes, so paths never match.

**Fix:** Add a `toWslPath()` helper in `event-format.ts` (mirroring the Rust `to_wsl_path()` in `wsl.rs`) and call it on `repoPath` inside `relativePath()` before comparison. Handles:
- `\\wsl.localhost\Distro\path` → `/path`
- `\\wsl$\Distro\path` → `/path`
- `C:\path` → `/mnt/c/path`
- Unix paths pass through unchanged

### 2. Agent description in title

Add a `"Agent"` case in `toolSummary()` that uses `input.description` — displays as `"Agent: Review working_dir changes"`.

### 3. Agent prompt as markdown

When an Agent tool_use event is expanded, render a structured detail view:
- **Metadata block** at top: small key-value pairs for non-prompt fields (`description`, `model`, `subagent_type`, etc.)
- **Prompt section** below: rendered as markdown using `react-markdown`

All other tool_use events keep the existing `<pre>` JSON display.

### 4. Dollar amount to nearest cent

Change `.toFixed(4)` to `.toFixed(2)` in:
- `IterationGroup.tsx` header (line 66)
- `event-format.ts` `eventLabel` for `iteration_complete` (line 119)

### 5. Context percentage in iteration title

Add percentage between cost and token counts in the iteration header. Format: `Iteration 3 — 12 events · $1.24 · 23% ctx · 45K in / 8K out · 2m 15s`. Remove the duplicate percentage from the context bar label below (keep bar visual only).

---

## Implementation Plan

### Task 1: Add `toWslPath()` and fix `relativePath()`

**Files to modify:** `src/event-format.ts`
**Pattern reference:** `src-tauri/src/runtime/wsl.rs` lines 230-260 (`to_wsl_path`)

**Details:**
- Add `toWslPath(path: string): string` that converts UNC paths to WSL paths
- Call `toWslPath()` on the normalized repo path inside `relativePath()` before the `startsWith` check
- Handle `//wsl.localhost/Distro/path` and `//wsl$/Distro/path` (after backslash normalization)
- Handle `X:/path` → `/mnt/x/path` (drive letter, after normalization)

**Checklist:**
- [x] Add `toWslPath()` function
- [x] Update `relativePath()` to use it
- [x] Verify: `npm test -- event-format`

---

### Task 2: Tests for `toWslPath()` and updated `relativePath()`

**Files to modify:** `src/event-format.test.ts`
**Pattern reference:** `src/event-format.test.ts` lines 288-337 (existing `relativePath` tests)

**Details:**
- Test UNC `\\wsl.localhost\Distro\...` repo path with Unix file path
- Test UNC `\\wsl$\Distro\...` variant
- Test drive letter `C:\Users\...` repo path
- Test that existing Unix-to-Unix matching still works

**Checklist:**
- [x] Add `toWslPath` unit tests
- [x] Add `relativePath` tests with UNC repo paths
- [x] Verify: `npm test -- event-format`

---

### Task 3: Agent description in `toolSummary()`

**Files to modify:** `src/event-format.ts`
**Pattern reference:** `src/event-format.ts` lines 90-105 (existing `toolSummary` switch cases)

**Details:**
- Add `case "Agent":` that returns `Agent: ${input.description}` if description exists, else `"Agent"`

**Checklist:**
- [x] Add Agent case to `toolSummary()`
- [x] Verify: `npm test -- event-format`

---

### Task 4: Tests for Agent `toolSummary()`

**Files to modify:** `src/event-format.test.ts`
**Pattern reference:** `src/event-format.test.ts` lines 339-375 (existing `toolSummary` tests)

**Details:**
- Test Agent with description field
- Test Agent without description field

**Checklist:**
- [x] Add Agent toolSummary tests
- [x] Verify: `npm test -- event-format`

---

### Task 5: Install `react-markdown` and render Agent prompt

**Files to modify:** `package.json`, `src/components/IterationGroup.tsx`
**Pattern reference:** `src/components/IterationGroup.tsx` lines 119-123 (existing expanded detail)

**Details:**
- `npm install react-markdown`
- When tool_name is "Agent", render a structured detail instead of raw JSON:
  - Metadata section: key-value pairs for all fields except `prompt` (description, model, subagent_type, etc.)
  - Prompt section: rendered with `<ReactMarkdown>` component
- Non-Agent tool_use events keep existing `<pre>` JSON display
- Style markdown container with the same bg/border as existing detail blocks, but use prose-friendly text styling

**Checklist:**
- [x] Install `react-markdown`
- [x] Add Agent-specific expanded detail rendering
- [x] Verify: `npx tsc --noEmit`

---

### Task 6: Round cost to nearest cent

**Files to modify:** `src/components/IterationGroup.tsx`, `src/event-format.ts`

**Details:**
- `IterationGroup.tsx` line 66: change `group.cost.toFixed(4)` → `group.cost.toFixed(2)`
- `event-format.ts` line 119: change `.toFixed(4)` → `.toFixed(2)`

**Checklist:**
- [ ] Update both `.toFixed(4)` → `.toFixed(2)`
- [ ] Verify: `npm test`

---

### Task 7: Add context percentage to iteration title

**Files to modify:** `src/components/IterationGroup.tsx`

**Details:**
- Add `{percentage}% ctx` between cost and token counts in iteration header (line 66 area)
- Only show when `group.contextWindow > 0`
- Remove `({percentage}%)` from the context bar label below (line 92) — keep bar visual + token counts only

**Checklist:**
- [ ] Add percentage to iteration header
- [ ] Remove percentage from context bar label
- [ ] Verify: `npx tsc --noEmit`

---

### Task 8: Tests for iteration title and cost changes

**Files to modify:** `src/components/IterationGroup.test.tsx`
**Pattern reference:** `src/components/IterationGroup.test.tsx` lines 387+ (existing stat display tests)

**Details:**
- Update existing tests that assert `.toFixed(4)` cost format
- Add test for percentage in iteration title
- Verify context bar label no longer shows percentage

**Checklist:**
- [ ] Update cost format assertions
- [ ] Add percentage-in-title test
- [ ] Verify: `npm test -- IterationGroup`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add `toWslPath()` and fix `relativePath()` | Done |
| 2 | Tests for `toWslPath()` and `relativePath()` | Done |
| 3 | Agent description in `toolSummary()` | Done |
| 4 | Tests for Agent `toolSummary()` | Done |
| 5 | Install `react-markdown` and render Agent prompt | Done |
| 6 | Round cost to nearest cent | Not Started |
| 7 | Add context percentage to iteration title | Not Started |
| 8 | Tests for iteration title and cost changes | Not Started |
