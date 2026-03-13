# Plan Viewer Design

## Problem

Plan files are central to both Ralph loops and one-shots, but Yarr only shows a name and short excerpt. Users can't read the full plan without leaving Yarr to open the file in an editor. Worse, after a session completes and the plan file is moved to `completed/` (or deleted), there's no way to view it at all.

## Design

### Data Layer: Snapshot Plan Content in Trace

Add `plan_content: Option<String>` to `SessionTrace`.

**Ralph loops** (`session.rs`): When building the session, if `plan_file` is set, read the file contents and store it in `plan_content` on the trace before starting the first iteration. This captures the plan as it was at session start, before any modifications during execution.

**One-shots** (`oneshot.rs`): After the design phase completes and the plan file is written, read the file back and populate `plan_content` on the trace.

The existing `plan_file: Option<String>` field remains unchanged — it's still used for knowing the original filename.

`plan_content` is serialized with the rest of the trace, so plans are viewable from history permanently regardless of what happens to the file on disk.

### UI: PlanPanel Component

A new `PlanPanel.tsx` component using shadcn's `Sheet` (slide-out from the right):

- **Header**: plan filename (basename only, e.g. `2026-03-14-auth-redesign.md`), extracted from the `plan_file` path
- **Body**: full markdown rendered via `react-markdown`, scrollable

### Triggers

The panel opens two ways:

1. **Clickable plan name/excerpt text** — anywhere plan previews currently appear (RunDetail summary, RepoCard, OneShotDetail)
2. **"View Plan" button** — on OneShotDetail and RunDetail pages

Both provide the trace's `plan_content` and `plan_file` to `PlanPanel`.

The panel closes via the Sheet's built-in X button or clicking outside.

### State

A small amount of state to manage the panel — either local state lifted to detail pages, or a lightweight Zustand slice holding `planPanelOpen`, `planContent`, and `planFile`.

## Implementation Plan

### Task 1: Add `plan_content` to `SessionTrace`

Add the new field to the trace struct and ensure it serializes/deserializes.

**Files to modify:**
- `src-tauri/src/trace.rs`

**Pattern reference:** existing `plan_file: Option<String>` field in `trace.rs`

**Details:**
- Add `plan_content: Option<String>` to `SessionTrace`
- Field should default to `None` for backwards compatibility with existing serialized traces

**Checklist:**
- [ ] Add field to `SessionTrace`
- [ ] Verify `cargo check` passes

---

### Task 2: Snapshot plan content in Ralph loop sessions

Read the plan file at session start and store the content in the trace.

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** existing plan file path handling in `session.rs`

**Details:**
- After `plan_file` is resolved but before the first iteration, read the file with `tokio::fs::read_to_string`
- Store the content in `trace.plan_content`
- If the file can't be read, log a warning and leave `plan_content` as `None` — don't fail the session

**Checklist:**
- [ ] Read plan file content at session start
- [ ] Store in trace
- [ ] Handle file-read errors gracefully
- [ ] Verify `cargo check` passes
- [ ] Verify `cargo test` passes

---

### Task 3: Snapshot plan content in one-shot sessions

Populate plan content on the trace after the design phase writes the plan file.

**Files to modify:**
- `src-tauri/src/oneshot.rs`

**Pattern reference:** design phase completion handling in `oneshot.rs`

**Details:**
- After the design phase completes and `plan_file` is set on the trace, read the file content
- Store in `trace.plan_content`
- Same error handling as Task 2 — log and continue if read fails

**Checklist:**
- [ ] Read plan file after design phase completes
- [ ] Store in trace
- [ ] Handle file-read errors gracefully
- [ ] Verify `cargo check` passes
- [ ] Verify `cargo test` passes

---

### Task 4: Create PlanPanel component

Build the Sheet-based plan viewer component.

**Files to create:**
- `src/PlanPanel.tsx`

**Pattern reference:** existing `Sheet` usage in the codebase; `react-markdown` usage in `IterationGroup.tsx`

**Details:**
- Props: `open: boolean`, `onOpenChange: (open: boolean) => void`, `planContent: string`, `planFile: string`
- Extract basename from `planFile` for the header
- Render markdown body with `react-markdown` in a scrollable container
- Style consistently with existing dark theme

**Checklist:**
- [ ] Create `PlanPanel.tsx` with Sheet + react-markdown
- [ ] Header shows filename
- [ ] Body renders markdown and scrolls
- [ ] Verify `npx tsc --noEmit` passes

---

### Task 5: Wire PlanPanel into RunDetail

Add the "View Plan" button and make the plan excerpt clickable on the completed session detail page.

**Files to modify:**
- `src/pages/RunDetail.tsx`

**Pattern reference:** existing plan preview display in `RunDetail.tsx`

**Details:**
- Add local state for panel open/close
- Make existing plan name/excerpt text clickable (cursor-pointer, hover style)
- Add a "View Plan" button near the plan preview
- Both open `PlanPanel` with `trace.plan_content` and `trace.plan_file`
- Only show triggers when `trace.plan_content` is present

**Checklist:**
- [ ] Add PlanPanel state and component
- [ ] Make plan excerpt clickable
- [ ] Add "View Plan" button
- [ ] Hide triggers when no plan content
- [ ] Verify `npx tsc --noEmit` passes

---

### Task 6: Wire PlanPanel into OneShotDetail

Add the "View Plan" button and clickable plan text on the one-shot detail page.

**Files to modify:**
- `src/pages/OneShotDetail.tsx`

**Pattern reference:** Task 5 wiring in RunDetail

**Details:**
- Same pattern as RunDetail — local state, clickable text, button
- Plan content comes from the session's trace (`session.trace?.plan_content`)
- Only show triggers after design phase completes (when plan content is available)

**Checklist:**
- [ ] Add PlanPanel state and component
- [ ] Make plan info clickable
- [ ] Add "View Plan" button
- [ ] Only show after design phase completes
- [ ] Verify `npx tsc --noEmit` passes

---

### Task 7: Wire PlanPanel into RepoCard

Make the plan excerpt on repo cards clickable to open the plan viewer.

**Files to modify:**
- `src/RepoCard.tsx` (or wherever RepoCard renders plan previews)

**Details:**
- Make plan name/excerpt text clickable
- Open PlanPanel with plan content from the latest trace
- Only clickable when plan content is available

**Checklist:**
- [ ] Make plan excerpt clickable
- [ ] Open PlanPanel with trace plan content
- [ ] Verify `npx tsc --noEmit` passes

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add `plan_content` to `SessionTrace` | Not Started |
| 2 | Snapshot plan content in Ralph loop sessions | Not Started |
| 3 | Snapshot plan content in one-shot sessions | Not Started |
| 4 | Create PlanPanel component | Not Started |
| 5 | Wire PlanPanel into RunDetail | Not Started |
| 6 | Wire PlanPanel into OneShotDetail | Not Started |
| 7 | Wire PlanPanel into RepoCard | Not Started |
