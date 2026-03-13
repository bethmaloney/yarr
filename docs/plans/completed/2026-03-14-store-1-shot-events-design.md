# Store 1-Shot Events — Design Plan

## Overview

After an app restart, 1-shot session data (events, traces, results) is not reliably visible in the UI. While the Rust backend **already persists** events (JSONL) and traces (JSON) to disk for oneshots — identical to the Ralph loop — the frontend has several gaps that prevent this data from being surfaced after restart:

1. **No trace fetch on oneshot completion** — the `one_shot_complete` event handler doesn't fetch the finalized trace, so `session.trace` is never populated during the live session.
2. **No session state initialization** — `runOneShot` doesn't create a `sessions` map entry with `session_id`, unlike `runSession`.
3. **Aggressive pruning** — only 5 completed oneshot entries are kept; pruned entries lose their link to on-disk data.
4. **No `latestTraces` update** — oneshot completion never updates the `latestTraces` map.
5. **History page doesn't link back to OneShotDetail** — clicking a oneshot trace in History navigates to the generic RunDetail page, losing phase/worktree context.

The backend (Rust) requires **no changes** — `OneShotRunner.emit()` already calls `collector.append_event()` for every event, and `collector.finalize()` writes the trace JSON on every exit path. This is a **frontend-only** fix.

## Pattern References

- **Ralph loop session init**: `src/store.ts:707-751` — `runSession` creates session state with `session_id`, then updates after invoke returns.
- **Ralph loop trace fetch on completion**: `src/store.ts:263-331` — `session_complete` handler fetches trace via `get_trace`, updates `sessions` and `latestTraces`.
- **Oneshot event recovery on startup**: `src/store.ts:153-219` — loads entries from disk, fetches events+trace for each.
- **Oneshot completion handler**: `src/store.ts:358-381` — updates entry status but does NOT fetch trace.
- **History page navigation**: `src/pages/History.tsx:250-254` — always navigates to `/run/{repoId}/{sessionId}`.

---

## Task 1: Initialize session state in `runOneShot`

**Files to modify:** `src/store.ts`

When `runOneShot` is called, it should initialize a session state entry in the `sessions` map — matching how `runSession` (line 711-721) does it. Currently the session state is only created lazily when the first event arrives via the listener, and that lazy creation doesn't include `session_id`.

**Pattern:** Follow `runSession` at line 711-721 and 747-751.

### Checklist

- [x] After calling `invoke("run_oneshot", ...)` and getting back `{ oneshot_id, session_id }`, create a session state entry.
- [x] This goes at ~line 593, after the entry swap from tempId to real oneshot_id.

---

## Task 2: Fetch trace on oneshot completion

**Files to modify:** `src/store.ts`

When `one_shot_complete` fires, the store should fetch the finalized trace from disk — matching what the `session_complete` handler does for Ralph loops (line 315-331). Without this, `session.trace` stays `null` and the OneShotDetail Result section never appears during the live session.

**Pattern:** Follow `session_complete` handler at line 315-331.

### Checklist

- [x] In the `one_shot_complete` branch, after updating entry status, fetch trace and update `sessions` + `latestTraces`.
- [x] The `session_id` comes from the session state first, falling back to the oneshot entry's `session_id`.

**Note:** Trace is only fetched on `one_shot_complete`, not `one_shot_failed`. Consider also fetching on failure for diagnostic data (cost, iterations) — matches how `session_complete` works regardless of outcome.

---

## Task 3: Remove aggressive pruning of completed entries

**Files to modify:** `src/store.ts`

Currently, completed oneshot entries are pruned to keep only the last 5 (line 366-376). Once pruned, the entry is gone from `oneShotEntries` and there's no way to navigate to OneShotDetail for that oneshot. The on-disk trace/events files still exist but are only accessible via History → RunDetail (which lacks oneshot-specific context).

### Checklist

- [x] Remove the pruning block entirely. All completed entries are now retained.
- [x] No upper bound — entries are small and growth is bounded by usage.

---

## Task 4: Navigate History page to OneShotDetail for oneshot traces

**Files to modify:** `src/pages/History.tsx`

When a user clicks a trace row in the History page, oneshot traces should navigate to `/oneshot/{oneshotId}` (OneShotDetail) instead of `/run/{repoId}/{sessionId}` (RunDetail). This provides the full oneshot context (phases, worktree path, prompt, resume button).

**Pattern:** `History.tsx` line 250-254 — the onClick handler.

### Checklist

- [x] Check `trace.session_type` — if it's `"one_shot"`, navigate to `/oneshot/${trace.repo_id}` instead of `/run/...`.
- [x] The `trace.repo_id` for oneshot traces is the `oneshot_id` (e.g., `"oneshot-abc123"`), which is the key used in `oneShotEntries`.
- [x] If the entry doesn't exist in `oneShotEntries` (was pruned or from a previous install), fall back to `/run/{repoId}/{sessionId}` so the user can still see the generic trace+events view.

### Implementation detail

```typescript
onClick={() => {
  if (trace.session_type === "one_shot") {
    navigate(`/oneshot/${trace.repo_id ?? "unknown"}`);
  } else {
    navigate(`/run/${traceRepoId(trace, repoId)}/${trace.session_id}`);
  }
}}
```

---

## Task 5: Ensure OneShotDetail works for entries loaded from History (no entry in store)

**Files to modify:** `src/pages/OneShotDetail.tsx`, `src/store.ts`

If a user navigates to `/oneshot/{oneshotId}` from History but the entry was pruned from `oneShotEntries`, the page currently shows "Not found." It should fall back to loading data from disk.

### Checklist

- [x] In `OneShotDetail.tsx`, when `entry` is undefined but `oneshotId` is present, attempt to load the trace from disk via `list_traces` + `get_trace_events`.
- [x] Add local state for `fallbackTrace`, `fallbackEvents`, and `fallbackLoading`.
- [x] When rendering, use fallback data if the entry doesn't exist — show trace info from the `SessionTrace` object (prompt, outcome, cost, etc.) and events from disk.
- [x] The page should still show the full events list and result section using the fallback data.

---

## Task 6: Restore oneshot entries from disk on startup (resilience)

**Files to modify:** `src/store.ts`

If `oneshot-entries.json` gets corrupted or lost, all oneshot history is gone even though trace files exist on disk. Add a reconciliation step during `initialize()` that discovers oneshot traces on disk that aren't in `oneShotEntries` and creates stub entries for them.

### Checklist

- [x] After `loadOneShotEntries()` completes, call `list_traces({ repoId: null })` to get all traces.
- [x] Filter for traces where `session_type === "one_shot"` and `repo_id` starts with `"oneshot-"`.
- [x] For each oneshot trace not already in `oneShotEntries`, create a stub entry:
  ```typescript
  const stub: OneShotEntry = {
    id: trace.repo_id!,
    parentRepoId: "unknown",
    parentRepoName: "Unknown",
    title: trace.prompt.slice(0, 80),
    prompt: trace.prompt,
    model: "unknown",
    mergeStrategy: "branch",
    status: trace.outcome === "completed" ? "completed" : "failed",
    startedAt: new Date(trace.start_time).getTime(),
    session_id: trace.session_id,
  };
  ```
- [x] Persist the updated entries to `oneShotStore`.
- [x] This is a best-effort reconciliation — the stub won't have `worktreePath` or `branch`, but it gives visibility into historical oneshots.

---

## Task 7: Add tests

**Files to modify:** `src/store.test.ts` (or new file), `src/pages/OneShotDetail.test.tsx`, `src/pages/History.test.tsx`

### Checklist

- [x] **store.test.ts**: Test that `runOneShot` initializes session state with `session_id`.
- [x] **store.test.ts**: Test that `one_shot_complete` event triggers trace fetch.
- [x] **store.test.ts**: Test that completed entries are no longer pruned.
- [x] **History.test.tsx**: Test that clicking a `session_type: "one_shot"` trace navigates to `/oneshot/{id}`.
- [x] **OneShotDetail.test.tsx**: Test fallback rendering when entry is not in store but trace exists on disk.

---

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| 1. Initialize session state in runOneShot | Done | `src/store.ts` — session created after invoke returns |
| 2. Fetch trace on oneshot completion | Done | `src/store.ts` — fetches on `one_shot_complete`, updates sessions + latestTraces |
| 3. Remove aggressive pruning | Done | `src/store.ts` — pruning block removed |
| 4. History → OneShotDetail navigation | Done | `src/pages/History.tsx` — uses `trace.repo_id` directly for oneshot, not `traceRepoId` |
| 5. OneShotDetail disk fallback | Done | `src/pages/OneShotDetail.tsx` — loads trace+events from disk when entry not in store |
| 6. Reconcile entries from disk on startup | Done | `src/store.ts` — reconciles oneshot traces from disk after loadOneShotEntries |
| 7. Add tests | Done | Tests already written in prior tasks; fixed pre-existing RepoDetail test |

## Priority Order

Tasks 1-3 are the **critical fixes** — they ensure data flows correctly and is retained. Task 4 improves discoverability. Tasks 5-6 add resilience for edge cases. Task 7 validates everything.
