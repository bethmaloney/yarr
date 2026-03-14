# Fix Failing Tests

## Overview

16 frontend tests are failing in `src/pages/RunDetail.test.tsx` (15 failures) and `src/App.test.tsx` (1 failure) after a UI refactor that changed the RunDetail component layout. The Rust tests (554/554) all pass. The tests need to be updated to match the current component implementation.

### Root Causes

1. **Loading state changed from text to spinner**: The component now renders a `<Loader2>` spinner icon instead of `<p>Loading...</p>` text. Tests looking for "Loading..." text fail.
2. **Outcome badge rendered in two places**: The badge now appears in both the header card (line 218) and the Result sidebar (line 263), causing `getByText()` to throw "Found multiple elements" errors.
3. **Plan name appears in both breadcrumb and sidebar**: The `displayTitle` (derived from plan filename) appears in the breadcrumb (line 173) and the sidebar Plan row (line 286), causing ambiguous text matches.
4. **Layout restructured**: The old layout had a single summary section with labels like "Duration", "Plan", etc. The new layout splits content between a header card and a sidebar. Tests expecting the old structure (e.g., looking for "Run Detail" heading, "Duration" label with "—") don't match the new DOM.

## Task 1: Fix loading state tests

**Files to modify:**
- `src/pages/RunDetail.test.tsx` — lines 151–156
- `src/App.test.tsx` — lines 183–186

**Pattern reference:** The component at `src/pages/RunDetail.tsx:176-183` renders `<Loader2 className="...animate-spin..." />` for loading state.

**Checklist:**
- [x] In `RunDetail.test.tsx`, update the `shows "Loading..." while invoke is pending` test to check for the Loader2 spinner icon via `document.querySelector('.animate-spin')`
- [x] In `App.test.tsx`, update the `renders RunDetail page with loading state` test similarly via `document.querySelector('.animate-spin')`

## Task 2: Fix outcome badge tests (duplicate element errors)

**Files to modify:**
- `src/pages/RunDetail.test.tsx` — outcome badges section (lines 376–419) and summary section outcome test (lines 247–254, 358–368)

**Pattern reference:** The component renders the badge in two locations:
- Header card: `src/pages/RunDetail.tsx:218`
- Sidebar: `src/pages/RunDetail.tsx:263`

**Checklist:**
- [x] Update `summary section > shows outcome badge` test to use `getAllByText("Completed")` and assert length ≥ 1
- [x] Update all 5 outcome badge tests to use `getAllByText()` instead of `getByText()`, asserting at least one match
- [x] Update `does NOT show failure_reason row` test to use `getAllByText("Completed")`

## Task 3: Fix header title test

**Files to modify:**
- `src/pages/RunDetail.test.tsx` — header section (lines 219–239)

**Pattern reference:** The component no longer has a literal "Run Detail" heading. Instead, `src/pages/RunDetail.tsx:213-215` renders `displayTitle` (the plan filename or prompt) as the `<h1>`.

**Checklist:**
- [x] Update `shows "Run Detail" title` test to assert `displayTitle` ("fix bug" from planFilename)
- [x] Replace `shows formatted date` test with `falls back to prompt text when plan_file is null` to cover the displayTitle fallback path

## Task 4: Fix summary section layout tests

**Files to modify:**
- `src/pages/RunDetail.test.tsx` — summary section (lines 265–316)

**Pattern reference:** The new component layout at `src/pages/RunDetail.tsx:254-363` uses a sidebar with a different structure. Duration is conditionally shown only when `elapsed !== "—"` (line 320), and plan_file null renders no Plan row at all (line 276 condition).

**Checklist:**
- [x] Update `shows "—" when plan_file is null` test to verify Plan row is absent instead of looking for "—"
- [x] Update `shows duration "30m 0s"` test to use `getAllByText` (duration appears in header + sidebar)
- [x] Update `shows "—" for duration when end_time is null` test to verify Duration row is absent

## Task 5: Fix PlanPanel integration plan name tests

**Files to modify:**
- `src/pages/RunDetail.test.tsx` — PlanPanel integration (lines 572–601)

**Pattern reference:** The plan display name appears in:
- Breadcrumb: `src/pages/RunDetail.tsx:173` — `{ label: displayTitle }`
- Sidebar Plan row: `src/pages/RunDetail.tsx:286` — via `planDisplayName()`

Note: `displayTitle` uses `planFilename()` (which strips date prefix and replaces `_-` with spaces), while the sidebar uses `planDisplayName()` from `plan-preview.ts`. For `plan_file: "/path/to/plan.md"`, `planFilename` returns `"plan"` and `planDisplayName` also returns `"plan"`, causing the duplicate.

**Checklist:**
- [x] Update `clicking plan name opens PlanPanel` test to use `getByRole("button", { name: "plan" })` to target the sidebar element with role="button"
- [x] Update `plan name is NOT clickable` test to use `queryByRole("button", { name: "plan" })` for negative assertion

---

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| Task 1: Fix loading state tests | Done | 2 tests: spinner check via `.animate-spin` |
| Task 2: Fix outcome badge tests | Done | 7 tests: `getAllByText` for duplicate badges |
| Task 3: Fix header title test | Done | 2 tests: displayTitle + prompt fallback |
| Task 4: Fix summary section layout tests | Done | 3 tests: absent row assertions |
| Task 5: Fix PlanPanel plan name tests | Done | 2 tests: `role="button"` selector |
