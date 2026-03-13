# Plan Progress Bar

## Overview

Show plan completion progress during live sessions (Ralph loops and oneshots). A thin progress bar appears at the top of the EventsList showing checklist-item-level progress with the current task name. A compact version appears on the RepoCard on the dashboard.

Progress is derived by parsing the plan markdown for `## Task N` headings and `- [x]`/`- [ ]` checklist items. The backend emits fresh plan content after each iteration completes, so the frontend always has up-to-date markdown to parse.

**Resilience:** If the plan has no parseable tasks/checklists (e.g. freeform Ralph loop plans), the progress bar simply doesn't render. The parser never crashes on unexpected input.

## Design Decisions

- **Granularity:** Bar tracks checklist items (smooth movement), label shows current task name (context)
- **Data source:** New `PlanContentUpdated` event emitted after each `IterationComplete`, not polling
- **EventsList:** Thin 4px bar + percentage + "Next: Task N — Title" below the Events header
- **RepoCard:** Thin 3px bar + fraction (e.g. "14/42") between status indicator and footer
- **Scope:** Both Ralph loops and oneshots — shown whenever plan has parseable checklists

---

## Task 1: Add plan progress parser

**Files to create:**
- `src/plan-progress.ts`

**Pattern reference:** `src/plan-preview.ts` — hand-written line-by-line markdown parser, same approach.

**Details:**
- Scans lines for `## Task` or `## ` headings with a number to find task boundaries
- Within each task section, counts `- [x]` (completed) and `- [ ]` (pending) lines
- Tasks with zero checklist items are excluded from results
- `currentTask` = first task where `completed < total`; null if all complete

**Checklist:**
- [x] Define `TaskProgress` interface: `{ number, title, total, completed }`
- [x] Define `PlanProgress` interface: `{ tasks, totalItems, completedItems, currentTask }`
- [x] Implement `parsePlanProgress(content: string): PlanProgress | null`
  - Return `null` if no checklist items found anywhere (graceful no-op)
  - Use regex: `/^##\s+(?:Task\s+)?(\d+)[:\s—–-]*(.*)$/i` for task headings
  - Use regex: `/^[\s]*- \[([ xX])\]/ ` for checklist items
  - Heading text after the number becomes the task title (trimmed)
- [x] Add unit tests in `src/plan-progress.test.ts`:
  - Standard plan with tasks and mixed checked/unchecked items
  - Plan with all items complete → `currentTask` is null
  - Plan with no checklist items → returns null
  - Plan with no `## Task` headings but has checklists under `##` headings → still works
  - Malformed/empty input → returns null, no crash
- [x] Run `npm test` to verify

---

## Task 2: Add `PlanContentUpdated` event to Rust backend

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `SessionEvent::IterationComplete` variant (session.rs:140) and its emission (session.rs:733-736).

**Details:**
- New enum variant carries the full plan markdown string
- Emitted right after `IterationComplete`, before checks/git sync
- Only emitted when `config.plan_file` is set and the file reads successfully
- Uses `debug!` level logging on read failure (expected for sessions without plans)

**Checklist:**
- [ ] Add `PlanContentUpdated { plan_content: String }` variant to `SessionEvent` enum (after line 140)
- [ ] Add `SessionEvent::PlanContentUpdated { .. } => "plan_content_updated"` to the `emit()` match arm (after line 293)
- [ ] After the `IterationComplete` emission (line 736), add plan file read + emit:
  ```rust
  if let Some(ref plan_file) = self.config.plan_file {
      match tokio::fs::read_to_string(plan_file).await {
          Ok(content) => {
              self.emit(SessionEvent::PlanContentUpdated { plan_content: content });
          }
          Err(e) => {
              tracing::debug!(plan_file = %plan_file, error = %e, "could not read plan file for progress");
          }
      }
  }
  ```
- [ ] Run `cd src-tauri && cargo check` to verify compilation

---

## Task 3: Add `plan_content` field to frontend SessionEvent and `planProgress` to SessionState

**Files to modify:**
- `src/types.ts`

**Pattern reference:** Existing optional fields on `SessionEvent` (types.ts:25-49) and `SessionState` (types.ts:75-84).

**Checklist:**
- [ ] Add `plan_content?: string` to `SessionEvent` type (after line 48)
- [ ] Add `planProgress?: PlanProgress | null` to `SessionState` type (after line 83)
- [ ] Add import of `PlanProgress` from `./plan-progress` in types.ts (or keep the type inline if circular import is a concern — use inline)
- [ ] Run `npx tsc --noEmit` to verify

---

## Task 4: Handle `plan_content_updated` event in the Zustand store

**Files to modify:**
- `src/store.ts`

**Pattern reference:** The `disconnected` / `reconnecting` event handling pattern (store.ts:289-297) — check event kind, update session state fields.

**Details:**
- When `plan_content_updated` arrives, parse the content and store the result
- Also parse plan progress from trace `plan_content` when loading historical sessions (so completed runs show final progress)

**Checklist:**
- [ ] Import `parsePlanProgress` from `./plan-progress`
- [ ] In the event listener (after line 297), add:
  ```ts
  if (sessionEvent.kind === "plan_content_updated" && sessionEvent.plan_content) {
    updates.planProgress = parsePlanProgress(sessionEvent.plan_content);
  }
  ```
- [ ] When loading trace on session complete (store.ts:352-361), also parse plan progress from `trace.plan_content`:
  ```ts
  const planProgress = trace.plan_content
    ? parsePlanProgress(trace.plan_content)
    : current.planProgress;
  s.set(repo_id, { ...current, trace, planProgress });
  ```
- [ ] Same for the oneshot trace loading (store.ts:406-413)
- [ ] Run `npx tsc --noEmit` to verify

---

## Task 5: Add event emoji and label for `plan_content_updated`

**Files to modify:**
- `src/event-format.ts`

**Pattern reference:** Existing cases in `eventEmoji` (event-format.ts:67-127) and `eventLabel` (event-format.ts:154-216).

**Checklist:**
- [ ] Add `case "plan_content_updated": return "\u{1F4CA}";` (bar chart emoji) to `eventEmoji` (before `default:` at line 125)
- [ ] Add `case "plan_content_updated": return "Plan progress updated";` to `eventLabel` (before `default:` at line 214)
- [ ] Run `npx tsc --noEmit` to verify

---

## Task 6: Create `PlanProgressBar` component

**Files to create:**
- `src/components/PlanProgressBar.tsx`

**Pattern reference:** EventsList header styling (EventsList.tsx:153-160) for color palette and spacing conventions.

**Details:**
- Accepts `PlanProgress` as prop
- Thin 4px bar: `bg-[#2a2a3e]` track, `bg-[#4ecdc4]` fill, `bg-[#34d399]` when 100%
- Below bar: `63% · 27/42 items` in muted monospace xs text
- Second line: `Next: Task 7 — Frontend store` or "All tasks complete" when done
- Wrapped in a div with bottom margin to separate from events list

**Checklist:**
- [ ] Create component with `PlanProgressBarProps { progress: PlanProgress }`
- [ ] Render 4px-tall rounded bar with percentage-width fill
- [ ] Render stats line: percentage, item fraction
- [ ] Render current task line: "Next: Task {N} — {title}" or "All tasks complete"
- [ ] Fill color transitions to green (`bg-[#34d399]`) when `completedItems === totalItems`
- [ ] Run `npx tsc --noEmit` to verify

---

## Task 7: Integrate `PlanProgressBar` into EventsList

**Files to modify:**
- `src/components/EventsList.tsx`

**Pattern reference:** The existing `EventsListProps` interface (EventsList.tsx:7-11) and the header div (EventsList.tsx:153-160).

**Checklist:**
- [ ] Add `planProgress?: PlanProgress | null` to `EventsListProps` (import type from plan-progress)
- [ ] Render `<PlanProgressBar progress={planProgress} />` between the header div (line 160) and the scrollable div (line 161), guarded by `planProgress &&`
- [ ] Pass `planProgress` from session state in all EventsList usage sites:
  - `src/pages/OneShotDetail.tsx` — pass `session.planProgress`
  - `src/pages/RepoDetail.tsx` — pass `session.planProgress`
  - `src/pages/RunDetail.tsx` — parse from `trace.plan_content` if available
- [ ] Run `npx tsc --noEmit` to verify

---

## Task 8: Add compact progress bar to RepoCard

**Files to modify:**
- `src/components/RepoCard.tsx`

**Pattern reference:** Status indicator area (RepoCard.tsx:173-183) and the `RepoCardProps` interface (RepoCard.tsx:13-21).

**Details:**
- New optional prop `planProgress?: PlanProgress | null`
- Thin 3px bar + fraction shown between status indicator and footer cost line
- Only rendered when `planProgress` is truthy (session has parseable plan)

**Checklist:**
- [ ] Add `planProgress?: PlanProgress | null` to `RepoCardProps` (import type)
- [ ] After the status indicator div (line 183) and before the `lastTrace &&` footer (line 184), render:
  ```tsx
  {planProgress && (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-[3px] rounded-full bg-[#2a2a3e] overflow-hidden">
        <div
          className={completedItems === totalItems ? "bg-[#34d399]" : "bg-[#4ecdc4]"}
          style={{ width: `${pct}%`, height: "100%" }}
        />
      </div>
      <span className="text-xs text-muted-foreground font-mono shrink-0">
        {completedItems}/{totalItems}
      </span>
    </div>
  )}
  ```
- [ ] Pass `planProgress` from session state in the dashboard page where RepoCard is rendered
- [ ] Run `npx tsc --noEmit` to verify

---

## Task 9: Pass `planProgress` from dashboard to RepoCard

**Files to modify:**
- Whichever page renders `<RepoCard>` (likely `src/pages/Dashboard.tsx` or similar)

**Pattern reference:** How `status` and `lastTrace` are currently derived and passed to RepoCard.

**Checklist:**
- [ ] Find where `<RepoCard>` is rendered on the dashboard
- [ ] Derive `planProgress` from `sessions.get(repo.id)?.planProgress`
- [ ] Pass as prop: `planProgress={planProgress}`
- [ ] Run `npx tsc --noEmit` to verify

---

## Task 10: E2E and integration verification

**Checklist:**
- [ ] Run `cd src-tauri && cargo check` — Rust compiles
- [ ] Run `cd src-tauri && cargo test` — Rust tests pass
- [ ] Run `npx tsc --noEmit` — TypeScript compiles
- [ ] Run `npm test` — unit tests pass (including new plan-progress tests)
- [ ] Run `npx eslint .` — no lint errors
- [ ] Run `npx prettier --check .` — formatting OK (fix with `--write` if needed)

---

## Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Plan progress parser + tests | Done |
| 2 | Rust `PlanContentUpdated` event | Not Started |
| 3 | Frontend type updates | Not Started |
| 4 | Zustand store handling | Not Started |
| 5 | Event emoji/label | Not Started |
| 6 | PlanProgressBar component | Not Started |
| 7 | Integrate into EventsList | Not Started |
| 8 | Compact bar in RepoCard | Not Started |
| 9 | Dashboard → RepoCard wiring | Not Started |
| 10 | E2E verification | Not Started |
