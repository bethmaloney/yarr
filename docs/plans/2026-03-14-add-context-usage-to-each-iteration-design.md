# Add Context Usage to Each Iteration

## Overview

Currently, context usage is displayed as a single "Context X%" at the session level (in the Result section of RepoDetail and on RepoCard), derived from `final_context_tokens / context_window` on the `SessionTrace`. Each iteration already tracks `contextWindow` and `inputTokens` and displays a `{percentage}% ctx` in the iteration header and a context bar beneath it.

The task has two parts:

1. **Move context % into the iteration header stats line** — specifically between the dollar cost and the total tokens. Currently it's already there (`$0.15 · 73% ctx · 2,500 in / 1,200 out`), so the ordering is correct. No change needed for per-iteration display positioning.

2. **Change session-level "Context X%" to show the *maximum* across all iterations** — instead of using `final_context_tokens / context_window` (which is the *last* iteration's context), compute `max(inputTokens / contextWindow)` across all iterations. This makes the session-level number reflect the peak context pressure.

The per-iteration context percentage is already computed and displayed in `IterationGroup.tsx`. The primary work is:
- Ensuring the iteration header stat ordering is: cost, then context %, then tokens (already correct).
- Changing the session-level context display in `RepoDetail.tsx`, `RepoCard.tsx`, and `OneShotDetail.tsx` to use the **max** iteration context percentage instead of the trace-level `final_context_tokens / context_window`.

## Tasks

### Task 1: Add `maxContextPercent` helper to `iteration-groups.ts`

Add a utility function that computes the maximum context usage percentage across all iterations in a `GroupedEvents` result.

**Files to modify:**
- `src/iteration-groups.ts`

**Pattern reference:** The per-iteration percentage calculation in `src/components/IterationGroup.tsx:55-58`.

**Checklist:**
- [x] Add a `maxContextPercent(groups: GroupedEvents): number` export that:
  - Iterates over `groups.iterations`
  - For each iteration with `contextWindow > 0`, computes `Math.round((inputTokens / contextWindow) * 100)`
  - Returns the maximum value, or `0` if no iterations have context data
- [x] Add unit tests in `src/iteration-groups.test.ts`:
  - Returns 0 for empty iterations
  - Returns correct max when one iteration has higher usage than others
  - Returns 0 when no iterations have contextWindow > 0
  - Handles single iteration correctly

### Task 2: Update `RepoDetail.tsx` session-level context display

Replace the trace-based `final_context_tokens / context_window` computation with the max-across-iterations computation.

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** Current computation at `src/pages/RepoDetail.tsx:578-585`. The `EventsList` component already receives events and groups them; we need to compute the max from those grouped iterations.

**Checklist:**
- [ ] Import `groupEventsByIteration` and `maxContextPercent` from `../iteration-groups`
- [ ] Replace the `ctxPercent` computation (lines 578-585) to:
  - Call `groupEventsByIteration(session.events)` (or reuse the existing grouped result if available)
  - Call `maxContextPercent(grouped)` to get the peak percentage
  - Set `ctxPercent` to this value, or `null` if it's 0
- [ ] Keep the existing display markup (dt "Context", dd with `sessionContextColor(ctxPercent)`) — only the value changes
- [ ] Update the label from "Context" to "Peak Context" to make clear it's the max (optional, decide based on user preference — the task says "largest context usage", so "Peak Context" is clearer)
- [ ] Update existing test in `src/pages/RepoDetail.test.tsx` (around line 1956) to:
  - Provide session events with iteration_complete events that have model_usage data, rather than relying on trace.context_window/final_context_tokens
  - Assert the displayed percentage matches the max across iterations

### Task 3: Update `RepoCard.tsx` session-level context display

Same change as Task 2 but for the repo card summary.

**Files to modify:**
- `src/components/RepoCard.tsx`

**Pattern reference:** Current computation at `src/components/RepoCard.tsx:159-178`.

**Checklist:**
- [ ] The `RepoCard` receives `lastTrace` but does NOT have access to events — it only has `SessionTrace`
- [ ] **Decision:** Since `RepoCard` only has the trace (not events), and the trace is persisted to disk, the cleanest approach is to store the max context percentage in the `SessionTrace` on the Rust side. This avoids needing to load all events just to render the card.
- [ ] **Alternative (simpler, frontend-only):** Pass the max context percentage as a new prop to `RepoCard`. Compute it in the parent component (`RepoDetail` or wherever `RepoCard` is rendered) from the session events. This avoids Rust changes.
- [ ] **Chosen approach:** Store `max_context_percent` in the Rust `SessionTrace` (Task 5) so it's available on `lastTrace` without needing events. This is the cleanest solution since `RepoCard` is rendered in `src/pages/Home.tsx:215` with only `latestTraces.get(item.repo.id)` from the Zustand store — no events are available at that level.

**Detailed steps (chosen approach):**
- [ ] After Task 5 adds `max_context_percent` to `SessionTrace`, update `RepoCard.tsx` to use `lastTrace.max_context_percent` instead of computing from `final_context_tokens / context_window`
- [ ] Fall back to the old `final_context_tokens / context_window` computation when `max_context_percent` is 0 or undefined (backwards compat with old trace files)
- [ ] Update the frontend `SessionTrace` type in `src/types.ts` to include `max_context_percent?: number`
- [ ] Update tests in `src/components/RepoCard.test.tsx` to cover both paths

### Task 4: Update `OneShotDetail.tsx` session-level context display

The `OneShotDetail` page shows a "Result" section with session trace data but currently does NOT display context percentage at all. Add it.

**Files to modify:**
- `src/pages/OneShotDetail.tsx`

**Pattern reference:** The Result section at `src/pages/OneShotDetail.tsx:156-186`. The `session.events` are available in this component.

**Checklist:**
- [ ] Import `groupEventsByIteration` and `maxContextPercent` from `../iteration-groups`
- [ ] Import `sessionContextColor` from `../context-bar`
- [ ] Compute max context percentage from `session.events` using `groupEventsByIteration` + `maxContextPercent`
- [ ] Add a "Peak Context" row to the Result dl section, styled with `sessionContextColor`, matching the pattern in `RepoDetail.tsx`
- [ ] Only show if the percentage is > 0

### Task 5: Store max context percentage in Rust `SessionTrace` (backend)

To support historical traces (loaded from disk) showing the correct max context percentage, store it in the trace during finalization.

**Files to modify:**
- `src-tauri/src/trace.rs`

**Pattern reference:** The `record_iteration()` method at `src-tauri/src/trace.rs:178-217` and the `SessionTrace` struct at lines 27-55.

**Checklist:**
- [x] Add `max_context_percent: u8` field to `SessionTrace` (with `#[serde(default)]` for backwards compatibility)
- [x] In `record_iteration()`, after computing context_window and final_context_tokens:
  - Compute the percentage for this iteration: `(final_context_tokens * 100 / context_window).min(100)` (integer division, clamped to 100, using the span's values)
  - Update `trace.max_context_percent = trace.max_context_percent.max(percent as u8)`
- [x] In `finalize()`, recompute `max_context_percent` from all iterations (not just the last)
- [x] Add the field to the frontend `SessionTrace` type in `src/types.ts`
- [ ] Update `RepoCard` to use `lastTrace.max_context_percent` when available (for historical traces), falling back to the events-based computation
- [x] Add Rust unit tests for the new field (5 tests: backward compat, basic computation, max tracking, zero context_window, finalize recomputation)

### Task 6: Update existing tests

Ensure all existing tests pass and update any that rely on the old context computation.

**Files to modify:**
- `src/iteration-groups.test.ts` (new tests from Task 1)
- `src/components/RepoCard.test.tsx` (update context % tests)
- `src/pages/RepoDetail.test.tsx` (update context % test)
- `src/components/IterationGroup.test.tsx` (no changes expected — per-iteration display is unchanged)
- `src/context-bar.test.ts` (no changes expected)

**Checklist:**
- [ ] Run `npm test` to verify all frontend tests pass
- [ ] Run `cd src-tauri && cargo test` to verify all Rust tests pass
- [ ] Run `npx tsc --noEmit` to verify no type errors

## Implementation Order

The recommended implementation order is:

1. **Task 1** — Add `maxContextPercent` helper (foundation for everything else)
2. **Task 5** — Add `max_context_percent` to Rust `SessionTrace` (backend support)
3. **Task 2** — Update `RepoDetail.tsx` (main session page)
4. **Task 3** — Update `RepoCard.tsx` (card display)
5. **Task 4** — Update `OneShotDetail.tsx` (1-shot page)
6. **Task 6** — Run all tests and fix any failures

## Key Design Decisions

1. **Frontend computation vs Rust-side storage:** Both. The frontend computes it from events for live sessions, and the Rust backend stores it in the trace for historical data. This way, `RepoCard` can display it from the trace without needing to load all events.

2. **Label:** "Peak Context" is more descriptive than "Context" and makes clear this is the maximum across iterations, not the final value.

3. **Iteration header order is already correct:** The current order is `$cost · X% ctx · N in / M out · duration`, which matches the requested "between the dollar amount and the total tokens used".

4. **No changes to iteration-level display:** The per-iteration context bar and percentage are already implemented and working correctly.

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| Task 1: maxContextPercent helper | Complete | Foundation utility |
| Task 2: RepoDetail.tsx update | Not Started | Main session page |
| Task 3: RepoCard.tsx update | Not Started | Card display |
| Task 4: OneShotDetail.tsx update | Not Started | 1-shot page |
| Task 5: Rust SessionTrace field | Complete | `max_context_percent: u8` in struct, `record_iteration`, `finalize`, 5 Rust tests, TS type updated |
| Task 6: Test verification | Not Started | All tests green |
