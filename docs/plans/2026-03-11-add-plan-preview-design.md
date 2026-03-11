# Add Plan Preview to Session Display

## Overview

When a plan is selected (either for a running session or for a completed/cancelled one), the UI should display the plan name and a short preview (first paragraph) of the plan content. This gives users an at-a-glance understanding of what each session is working on, without needing to navigate to the plan file.

Currently, plan previews only appear in the RepoDetail page's plan selector — when a user picks a plan file before starting a run. Once a session is running or completed, the user only sees the filename (e.g., in RepoCard, History table, RunDetail). This change adds a visible plan name + first-paragraph preview in the session display areas.

## Design Decisions

1. **Where to show the preview**: The task says "both ongoing and completed/cancelled plans." The primary places where sessions are displayed:
   - **RepoDetail** (ongoing sessions): Already shows events list while running. We'll add a plan name + preview banner above the events list when a session is running or has a trace.
   - **RepoCard** (home page): Currently shows the filename only. We'll add a 1-2 line preview excerpt below the plan filename.
   - **RunDetail** (completed session detail): Shows a summary table. We'll add the plan preview to the summary.
   - **History table**: Too compact for previews — keep as filename only (already works).

2. **How to get the preview content**: The backend already has `read_file_preview` which reads the first N lines of a file. For running sessions, `planFile` state is available in RepoDetail. For completed/historical sessions, `SessionTrace.plan_file` contains the full path. We can call `read_file_preview` with the plan path from the trace. For completed plans that have been moved to `completed/` subdir, the path in the trace still points to the original location — we need to handle the case where the file has been moved (try original path, fall back to `completed/` subdir).

3. **Plan name extraction**: Extract from filename — strip `.md` extension and the date prefix if present (e.g., `2026-03-11-add-plan-preview-design.md` → `add-plan-preview-design`). But actually, plan files are Markdown, so the first `# heading` is likely the human-readable name. We should extract the first H1 heading from the preview content as the plan name. Fall back to the filename if no heading found.

4. **Preview length**: "First paragraph or so" — extract content after the first heading up to the first blank line or ~200 characters, whichever comes first. The backend `read_file_preview` returns 5 lines by default, which is enough for a heading + first paragraph.

5. **Shared utility**: Create a small utility to parse plan preview text (extract heading + first paragraph) since it'll be used in multiple components.

## Tasks

### Task 1: Create Plan Preview Utility

Extract plan name and preview text from raw file content.

**Files to create:**
- `src/plan-preview.ts`

**Pattern reference:** `src/event-format.ts` — small utility module with pure functions, exported and tested.

**Checklist:**
- [x] Create `parsePlanPreview(content: string): { name: string; excerpt: string }` function
  - Extract first `# ` heading line as `name`
  - Extract text after the heading, up to the first blank line or 200 chars, as `excerpt`
  - If no `# ` heading found, return `name: ""` and first non-blank line(s) as excerpt
- [x] Create `planDisplayName(planFile: string | null, parsedName?: string): string` helper
  - If `parsedName` is provided and non-empty, use it
  - Otherwise extract filename from path, strip `.md`, strip leading date prefix (`YYYY-MM-DD-`)
  - Return `"—"` if planFile is null
- [x] Export both functions

### Task 2: Add Plan Preview to RepoDetail (Running + Last Session)

Show a plan name and excerpt banner between the plan selector section and the events list, visible when a session is running or has completed (trace exists).

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** The existing plan preview at lines 225-247 and 1164-1167 in RepoDetail.tsx — `useEffect` that calls `read_file_preview` and shows content in a bounded container.

**Checklist:**
- [ ] Import `parsePlanPreview`, `planDisplayName` from `../plan-preview`
- [ ] Add a new state: `sessionPlanPreview: string` and `sessionPlanLoading: boolean` for the *session's* plan preview (distinct from the plan-selector preview which uses `previewContent`)
- [ ] Add a `useEffect` that triggers when `session.trace?.plan_file` changes or when a `session_start` event appears with a `plan_file`:
  - Determine the plan file path: use `session.trace?.plan_file` if available, otherwise look for the `plan_file` from the latest `session_complete` or first event with `plan_file`
  - If we have a plan path, call `invoke("read_file_preview", { path, maxLines: 8 })`
  - Store result in `sessionPlanPreview`
  - On error (file moved/deleted), try the `completed/` variant of the path (insert `/completed/` before the filename)
- [ ] Render a plan banner section between the plan section (`</section>` at line 1306) and the disconnected banner / events list:
  - Show plan display name (from `planDisplayName` + parsed heading) as a bold label
  - Show excerpt in muted text, truncated to 2 lines with `line-clamp-2`
  - Style: subtle card with `bg-muted/50 border border-border rounded-md p-3 mb-4`
  - Only render when there's a plan file associated with the current/last session AND (session is running OR session has a trace)
  - Skip rendering if `planFile` is set (user is selecting a new plan — the plan selector already shows its own preview)

### Task 3: Add Plan Preview to RepoCard (Home Page)

Show a short excerpt below the plan filename in the home page repo card.

**Files to modify:**
- `src/components/RepoCard.tsx`

**Pattern reference:** Lines 68-72 in RepoCard.tsx — existing plan filename display.

**Checklist:**
- [ ] Add `planExcerpt?: string` to `RepoCardProps`
- [ ] Below the existing plan filename span (line 68-72), add a `<span>` showing the excerpt:
  - `text-xs text-muted-foreground truncate` (single line, truncated)
  - Only render if `planExcerpt` is non-empty
- [ ] In `Home.tsx`, pass `planExcerpt` to `RepoCard`:
  - Derive from `latestTraces` — but we need the preview content, not just the filename
  - Add state `planPreviews: Map<string, string>` in Home.tsx
  - Add `useEffect` that iterates `latestTraces`, calls `read_file_preview` for each trace with a `plan_file`, parses with `parsePlanPreview`, and stores the excerpt
  - Pass `planExcerpt={planPreviews.get(item.repo.id)}` to RepoCard

### Task 4: Add Plan Preview to RunDetail (Historical Runs)

Show the plan name and excerpt in the run detail summary.

**Files to modify:**
- `src/pages/RunDetail.tsx`

**Pattern reference:** Lines 182-183 — existing plan filename display in the summary `<dl>`.

**Checklist:**
- [ ] Import `parsePlanPreview`, `planDisplayName` from `../plan-preview`
- [ ] Add state: `planPreview: string` for the plan file content preview
- [ ] Add `useEffect` watching `trace?.plan_file`:
  - Call `invoke("read_file_preview", { path: trace.plan_file, maxLines: 8 })`
  - On error, try the `completed/` variant path
  - Store in `planPreview`
- [ ] Replace the plain `planFilename()` display (line 183) with:
  - Show `planDisplayName(trace.plan_file, parsedName)` as the plan value
  - Add a new row below it: `<dt>Plan Preview</dt><dd>` with the excerpt in muted text, max 3 lines
  - Only show the preview row if `planPreview` is non-empty

### Task 5: Add Unit Tests for Plan Preview Utility

**Files to create:**
- `src/plan-preview.test.ts`

**Pattern reference:** `src/sort.test.ts`, `src/types.test.ts` — Vitest test files with `describe`/`it` blocks.

**Checklist:**
- [x] Test `parsePlanPreview`:
  - Content with `# Heading` followed by paragraph → extracts both
  - Content with no heading → excerpt from first lines
  - Content with heading only, no body → name set, excerpt empty
  - Content with `## Sub-heading` (not H1) → treated as excerpt, no name
  - Long paragraph → truncated to ~200 chars
  - Empty string → empty name and excerpt
- [x] Test `planDisplayName`:
  - With parsed name → uses it
  - Without parsed name, path with date prefix → strips date and `.md`
  - Null planFile → returns "—"
  - Filename without date prefix → strips `.md` only

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Plan preview utility | Done | `src/plan-preview.ts` |
| 2. RepoDetail plan banner | Not started | Running + last session display |
| 3. RepoCard plan excerpt | Not started | Home page cards |
| 4. RunDetail plan preview | Not started | Historical run detail |
| 5. Unit tests | Done | `src/plan-preview.test.ts` — 26 tests |
