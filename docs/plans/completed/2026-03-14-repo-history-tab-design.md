# Repo Page History Tab

## Summary

Add top-level tabs ("Session" | "History") to the RepoDetail page main content area. The Session tab contains the current session output (events, errors, trace). The History tab shows the same sortable grid as the History page, filtered to the current repo.

## Design

### Tab Placement

Tabs go after the Plan + Action section (line ~1694 in RepoDetail.tsx) and before the session output content. Everything above the tabs (header, branch selector, settings bar, plan selector, action buttons, 1-shot form) remains always visible.

- **Session tab**: Session plan preview banner, disconnected banner, events list/empty state, error section, trace/result section
- **History tab**: Sortable history table (reused from History page, minus the Repo column)

### Tab Behavior

- Default tab: Session (always shown when navigating to a repo)
- No auto-switching when sessions start/stop
- Tab state is ephemeral (resets on navigation)

### History Tab Content

- Same grid layout, columns, and sorting as the History page
- Columns: Date, Type, Description, Status, Duration (no Repo column)
- Sortable by all fields, default sort by start_time descending
- Clicking a row navigates to the run detail page
- All runs shown, full scrollable list
- Fetches traces via `list_traces` with the current repoId

### Shared Component

Extract the history table from `History.tsx` into `src/components/HistoryTable.tsx`. Both the History page and the RepoDetail History tab use it.

Props:
- `traces: SessionTrace[]` — the traces to display
- `loading: boolean`
- `error: string | null`
- `showRepo?: boolean` — whether to show the Repo column (default false)
- `repos: RepoConfig[]` — needed when showRepo is true
- `repoId?: string` — used for navigation context

## Implementation Plan

### Task 1: Extract HistoryTable component

Extract the history table rendering from `History.tsx` into a reusable `src/components/HistoryTable.tsx` component.

**Files to create/modify:**
- `src/components/HistoryTable.tsx` (new)

**Pattern reference:** `src/pages/History.tsx` (the code being extracted)

**Details:**
- Move helper functions (`formatDate`, `formatDuration`, `outcomeBadge`, `planFilename`, `repoNameFromTrace`, `traceDescription`, `traceRepoId`, `gridTemplate`) into the new component file
- The component manages its own sort state (`sortField`, `sortDir`, `toggleSort`)
- Props: `traces`, `loading`, `error`, `showRepo`, `repos`, `repoId`
- Renders the loading state, error state, empty state, header row, and trace rows
- Empty/loading/error states render inline (no page wrapper, no breadcrumbs, no h1)

**Checklist:**
- [x] Create `src/components/HistoryTable.tsx` with extracted table logic
- [x] Export the component as default
- [x] Verify `npx tsc --noEmit` passes

---

### Task 2: Update History page to use HistoryTable

Replace the inline table rendering in `History.tsx` with the new shared component.

**Files to modify:**
- `src/pages/History.tsx`

**Pattern reference:** `src/components/HistoryTable.tsx` (Task 1 output)

**Details:**
- Remove extracted helper functions and inline table rendering
- Import and render `HistoryTable` with appropriate props
- History page still owns: breadcrumbs, page title, data fetching via `list_traces`
- Pass `showRepo={!repoId}` to show Repo column when viewing all history
- Pass fetched traces, loading, and error state

**Checklist:**
- [x] Replace inline table with `<HistoryTable>` component
- [x] Remove now-unused local functions and state
- [x] Verify `npx tsc --noEmit` passes
- [x] Verify `npm test` passes

---

### Task 3: Add Session/History tabs to RepoDetail

Add top-level Tabs to the RepoDetail page wrapping the session output area. Add a History tab that fetches and displays traces via HistoryTable.

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** `src/pages/History.tsx` (for `list_traces` invocation pattern), existing Tabs usage in RepoDetail config sheet

**Details:**
- Insert `<Tabs defaultValue="session">` after the plan section's closing `</section>` (line ~1694)
- TabsList with two triggers: "Session" and "History"
- Session TabsContent wraps existing content: session plan preview banner, disconnected banner, events list, error section, trace/result section
- History TabsContent renders `<HistoryTable>` with repo-filtered traces
- Add state for history traces, loading, error
- Fetch traces on mount and after session completes (reuse the `wasRunningRef` pattern)
- Import `HistoryTable` and `SessionTrace` type
- Style the TabsList to match the design system

**Checklist:**
- [x] Add history state (`traces`, `loading`, `error`) and fetch logic
- [x] Add `fetchHistory` function using `invoke("list_traces", { repoId })`
- [x] Call `fetchHistory` on mount and when session completes
- [x] Wrap session output in `<Tabs>` with Session and History tab content
- [x] Import and render `HistoryTable` in History tab
- [x] Verify `npx tsc --noEmit` passes
- [x] Verify `npm test` passes

---

### Task 4: E2E test for repo history tab

Add an E2E test verifying the history tab appears and displays trace data.

**Files to create/modify:**
- `e2e/repo-history.test.ts` (new)

**Pattern reference:** `e2e/history.test.ts` (if exists), `e2e/fixtures.ts`

**Details:**
- Navigate to a repo page
- Verify Session tab is active by default
- Click History tab
- Verify history table renders with mock trace data
- Mock `list_traces` via Tauri IPC mock

**Checklist:**
- [x] Create E2E test file with history tab test
- [x] Verify `npm run test:e2e` passes

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Extract HistoryTable component | Done |
| 2 | Update History page to use HistoryTable | Done |
| 3 | Add Session/History tabs to RepoDetail | Done |
| 4 | E2E test for repo history tab | Done |
