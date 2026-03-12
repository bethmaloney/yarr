# One-Shot Improvements Design

## Problems

Three issues with the current one-shot implementation:

1. **No history after restart.** `OneShotEntry` doesn't store `session_id`, so on restart there's no way to load events from disk. `syncActiveSession()` reconciles the `sessions` map but never updates `oneShotEntries`, so interrupted entries stay `status: "running"` forever, appearing as "Ready to Run" with no events.

2. **No empty state.** When a one-shot is running but no iteration events have arrived yet (or events were lost), `EventsList` returns `null`. The loop shows a dashed-border placeholder ("No sessions yet"), but the one-shot detail page shows nothing.

3. **No resumption.** If Yarr closes or Claude errors mid-flight, the worktree and branch are preserved on disk but the user can't resume. They have to start over. The `OneShotEntry` doesn't store `worktreePath` or `branch`, and there's no `resume_oneshot` backend command.

## Design

### 1. State Recovery on Restart

**Add `session_id` to `OneShotEntry`:**
- Populate it when the backend returns from `run_oneshot` (the session_id is already generated in `lib.rs:280`)
- Persist it to `oneshot-entries.json` alongside everything else

**Reconcile one-shot entries in `syncActiveSession()`:**
- After reconciling the `sessions` map, iterate `oneShotEntries`
- Any entry with `status: "running"` that's NOT in the backend's active sessions → mark as `"failed"` (interrupted)
- Persist the updated entries

**Load events on startup:**
- In `initialize()`, after `loadOneShotEntries()`, for entries with a `session_id`:
  - Call `get_trace_events(oneshotId, sessionId)` to recover events into the `sessions` map
  - Call `get_trace(oneshotId, sessionId)` to recover the trace (for completed sessions whose completion event was missed)
- This follows the same pattern as the loop's event recovery at `store.ts:84-111`

### 2. Empty State Display

In `OneShotDetail`, when `session.events.length === 0`:

- `entry.status === "running"` → dashed-border box with "Session starting..." and a pulse indicator
- `entry.status === "failed"` with `worktreePath` → "Session was interrupted" with a Resume button
- `entry.status === "failed"` without `worktreePath` → "Session failed before starting"
- Not running, no trace → "No events recorded"

### 3. Resumption

**Extend `OneShotEntry` type:**
```typescript
export type OneShotEntry = {
  id: string;
  parentRepoId: string;
  parentRepoName: string;
  title: string;
  prompt: string;
  model: string;
  mergeStrategy: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  session_id?: string;       // NEW
  worktreePath?: string;     // NEW
  branch?: string;           // NEW
};
```

**Populate via `OneShotStarted` event:**

Extend the `OneShotStarted` event to include `worktree_path` and `branch`. The frontend event handler saves these to the one-shot entry when received.

**Backend `ResumeState`:**

```rust
pub struct ResumeState {
    pub worktree_path: PathBuf,
    pub branch: String,
    pub plan_file: Option<String>,  // set if design phase completed
    pub skip_design: bool,
    pub skip_implementation: bool,
}
```

**Phase detection for resume:**

The `resume_oneshot` command detects where the previous run left off:

1. Check if worktree directory exists on disk
2. Load trace events from disk via `TraceCollector::read_events()`
3. Scan events for phase markers:
   - Has `design_phase_complete` with `plan_file` → skip design, resume at implementation
   - Has `implementation_phase_complete` → skip both, resume at git finalize
   - Otherwise → re-run from design in existing worktree (worktree already created)

**`OneShotRunner::run()` changes:**

Accept an optional `ResumeState`. At each phase gate, check if the phase should be skipped:
- If `resume.worktree_path` is set → skip worktree creation, use existing path
- If `resume.skip_design` → skip design phase, use `resume.plan_file`
- If `resume.skip_implementation` → skip implementation, jump to git finalize

**Frontend resume flow:**

1. User clicks Resume on a failed one-shot entry
2. Frontend calls `resume_oneshot` with the `oneshot_id` and original config
3. Backend detects phase, creates `ResumeState`, runs `OneShotRunner` with it
4. Events flow back via the same `session-event` channel
5. Entry status updated back to `"running"`

---

## Implementation Plan

### Task 1: Add fields to `OneShotEntry` type

Add `session_id`, `worktreePath`, and `branch` to the TypeScript type.

**Files to modify:**
- `src/types.ts`

**Pattern reference:** `src/types.ts:91-101` (existing `OneShotEntry` type)

**Details:**
- Add `session_id?: string`, `worktreePath?: string`, `branch?: string` as optional fields
- All optional to maintain backward compatibility with existing persisted entries

**Checklist:**
- [x] Add three optional fields to `OneShotEntry`
- [x] Run `npx tsc --noEmit` to verify

---

### Task 2: Extend `OneShotStarted` event with worktree/branch info

Add `worktree_path` and `branch` fields to the `OneShotStarted` event variant so the frontend can capture them.

**Files to modify:**
- `src-tauri/src/session.rs` (event enum)
- `src-tauri/src/oneshot.rs` (emit call)
- `src/event-format.ts` (if event display needs updating)
- `src/oneshot-helpers.ts` (if phase detection references these fields)

**Pattern reference:** `src-tauri/src/session.rs:156-172` (existing event variants), `src-tauri/src/oneshot.rs:291-296` (emit call)

**Details:**
- Add `worktree_path: String` and `branch: String` to `OneShotStarted` variant
- Update the emit at `oneshot.rs:291` to include `wt_path.display().to_string()` and `branch.clone()`
- Update any frontend event format/display code that destructures this event

**Checklist:**
- [x] Add fields to `OneShotStarted` in `session.rs`
- [x] Update emit in `oneshot.rs`
- [x] Update frontend event format if needed
- [x] Run `cd src-tauri && cargo check`

---

### Task 3: Persist `session_id` in `OneShotEntry` on launch

Save the `session_id` to the one-shot entry when the session starts.

**Files to modify:**
- `src/store.ts`

**Pattern reference:** `src/store.ts:278-342` (existing `runOneShot`)

**Details:**
- The `session_id` is already generated in `lib.rs:280` and stored in `ActiveSessions`, but never returned to the frontend
- Option A: Return `session_id` alongside `oneshot_id` from `run_oneshot` command
- Option B: Extract it from the first event that arrives (but events are keyed by `oneshot_id`, not `session_id`)
- Recommended: Option A — update `OneShotResult` to include `session_id`, then save it to the entry in `runOneShot`

**Checklist:**
- [x] Add `session_id` to `OneShotResult` struct in `lib.rs`
- [x] Return `session_id` from `run_oneshot` command
- [x] Save `session_id` to the `OneShotEntry` in `store.ts` `runOneShot`
- [x] Persist to store
- [x] Run `cd src-tauri && cargo check` and `npx tsc --noEmit`

---

### Task 4: Save `worktreePath` and `branch` from `OneShotStarted` event

When the frontend receives `OneShotStarted` with the new fields, update the one-shot entry.

**Files to modify:**
- `src/store.ts`

**Pattern reference:** `src/store.ts:217-239` (existing one-shot event handler)

**Details:**
- In the `session-event` listener, when `sessionEvent.kind === "one_shot_started"`, extract `worktree_path` and `branch` from the event
- Update the corresponding `oneShotEntries` entry with these values
- Persist to `oneShotStore`

**Checklist:**
- [x] Add handler for `one_shot_started` in event listener
- [x] Update entry with `worktreePath` and `branch`
- [x] Persist to store
- [x] Run `npx tsc --noEmit`

---

### Task 5: Reconcile one-shot entries in `syncActiveSession()`

Mark interrupted one-shot entries as failed when the backend process is gone.

**Files to modify:**
- `src/store.ts`

**Pattern reference:** `src/store.ts:59-63` (existing loop reconciliation)

**Details:**
- After the existing `sessions` map reconciliation, iterate `oneShotEntries`
- For each entry with `status: "running"`: check if `entry.id` is in `activeMap`
- If not in active map → set `status: "failed"`
- Persist updated entries to `oneShotStore`

**Checklist:**
- [x] Add one-shot reconciliation after sessions reconciliation
- [x] Persist changes
- [x] Run `npx tsc --noEmit`

---

### Task 6: Load one-shot events and traces on startup

Recover event history for one-shot entries that have a `session_id`.

**Files to modify:**
- `src/store.ts`

**Pattern reference:** `src/store.ts:84-111` (existing loop event recovery)

**Details:**
- In `initialize()`, after `loadOneShotEntries()`, iterate entries with a `session_id`
- For each, call `get_trace_events(entry.id, entry.session_id)` to populate the `sessions` map
- Also call `get_trace(entry.id, entry.session_id)` to recover traces for completed-but-missed entries
- If trace shows `outcome: "completed"` or `"failed"`, update `oneShotEntries` status accordingly
- Use same `recoveryInFlight` guard pattern to avoid duplicate requests

**Checklist:**
- [x] Add one-shot event recovery in `initialize()`
- [x] Recover traces and reconcile entry status
- [x] Run `npx tsc --noEmit`

---

### Task 7: Add empty state to `OneShotDetail`

Show appropriate placeholder when no events are available.

**Files to modify:**
- `src/pages/OneShotDetail.tsx`

**Pattern reference:** `src/pages/RepoDetail.tsx:1329-1336` (loop empty state)

**Details:**
- When `session.events.length === 0`, show a dashed-border empty state instead of `EventsList`
- Vary message based on `entry.status`:
  - `"running"` → "Session starting..." with pulse
  - `"failed"` with `worktreePath` → "Session was interrupted" + Resume button
  - `"failed"` without `worktreePath` → "Session failed before starting"
  - Otherwise → "No events recorded"
- Resume button wires to `resumeOneShot()` store action (Task 10)

**Checklist:**
- [x] Add conditional empty state rendering
- [x] Style consistently with loop empty state
- [x] Run `npx tsc --noEmit`

---

### Task 8: Add `ResumeState` and refactor `OneShotRunner::run()`

Make the runner accept an optional resume state to skip completed phases.

**Files to modify:**
- `src-tauri/src/oneshot.rs`

**Pattern reference:** `src-tauri/src/oneshot.rs:275-590` (existing `run()` method)

**Details:**
- Add `ResumeState` struct with `worktree_path`, `branch`, `plan_file`, `skip_design`, `skip_implementation`
- Add `resume_state: Option<ResumeState>` field to `OneShotRunner`
- Add builder method `.with_resume_state(state)`
- In `run()`:
  - If `resume_state.worktree_path` exists → skip worktree creation, use it directly
  - If `resume_state.skip_design` → skip design phase, use `resume_state.plan_file`
  - If `resume_state.skip_implementation` → skip implementation, jump to git finalize
  - Still emit all phase events so the frontend tracks progress

**Checklist:**
- [x] Add `ResumeState` struct
- [x] Add field and builder method to `OneShotRunner`
- [x] Refactor `run()` with phase skip guards
- [x] Run `cd src-tauri && cargo check`
- [x] Run `cd src-tauri && cargo test`

---

### Task 9: Add `resume_oneshot` Tauri command

Backend command that detects phase and resumes.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs:263-342` (existing `run_oneshot` command)

**Details:**
- New command `resume_oneshot` takes `oneshot_id`, `repo_id`, repo config, title, prompt, model, merge_strategy, env_vars, max_iterations, completion_signal, checks, git_sync, `worktree_path`, `branch`
- Load events from disk: `TraceCollector::read_events(base_dir, oneshot_id, session_id)` (need session_id passed in too)
- Detect phase from events:
  - Scan for `design_phase_complete` → extract `plan_file`, set `skip_design = true`
  - Scan for `implementation_phase_complete` → set `skip_implementation = true`
- Verify worktree exists on disk (if not, clear resume state and start fresh)
- Build `ResumeState`, create `OneShotRunner` with `.with_resume_state()`
- Generate new `session_id` for the resumed run
- Spawn background task, return `OneShotResult` with new `session_id`
- Register in `ActiveSessions`

**Checklist:**
- [ ] Add `resume_oneshot` command
- [ ] Add phase detection logic
- [ ] Register in `tauri::generate_handler![]`
- [ ] Run `cd src-tauri && cargo check`

---

### Task 10: Add `resumeOneShot` store action and wire UI

Frontend action to call `resume_oneshot` and update state.

**Files to modify:**
- `src/store.ts`
- `src/pages/OneShotDetail.tsx`

**Pattern reference:** `src/store.ts:278-342` (existing `runOneShot`)

**Details:**
- Add `resumeOneShot(oneshotId: string)` action to the store
- Looks up the entry, extracts config fields, `worktreePath`, `branch`, `session_id`
- Calls `invoke("resume_oneshot", { ... })`
- Updates entry `status` back to `"running"`, saves new `session_id`
- Sets up session state in `sessions` map (running, empty events)
- In `OneShotDetail`, wire Resume button `onClick` to `resumeOneShot(oneshotId)`

**Checklist:**
- [ ] Add `resumeOneShot` action to store
- [ ] Wire Resume button in `OneShotDetail`
- [ ] Run `npx tsc --noEmit`

---

### Task 11: Update tests

Update existing tests and add new ones for the changed behavior.

**Files to modify:**
- `src/store.test.ts`
- `e2e/oneshot.test.ts`
- `src-tauri/src/oneshot.rs` (Rust unit tests)

**Pattern reference:** `src/store.test.ts:1436` (existing one-shot store tests), `e2e/oneshot.test.ts` (existing E2E tests)

**Details:**
- Store tests: verify `syncActiveSession` marks interrupted one-shots as failed, verify event recovery loads for one-shot entries
- E2E tests: add test for resume flow, verify empty state rendering
- Rust tests: test `OneShotRunner` with `ResumeState` (skip design, skip implementation)
- Update existing tests that assert on `OneShotEntry` shape or `OneShotStarted` event fields

**Checklist:**
- [ ] Update store tests for reconciliation
- [ ] Add store tests for event recovery
- [ ] Update E2E tests for empty state
- [ ] Add E2E test for resume button
- [ ] Update Rust tests for `ResumeState`
- [ ] Run `npm test`, `npm run test:e2e`, `cd src-tauri && cargo test`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add fields to `OneShotEntry` type | Done |
| 2 | Extend `OneShotStarted` event with worktree/branch | Done |
| 3 | Persist `session_id` in entry on launch | Done |
| 4 | Save `worktreePath`/`branch` from event | Done |
| 5 | Reconcile one-shot entries in `syncActiveSession()` | Done |
| 6 | Load one-shot events/traces on startup | Done |
| 7 | Add empty state to `OneShotDetail` | Done |
| 8 | Add `ResumeState` and refactor runner | Done |
| 9 | Add `resume_oneshot` Tauri command | Not Started |
| 10 | Add `resumeOneShot` store action and wire UI | Not Started |
| 11 | Update tests | Not Started |
