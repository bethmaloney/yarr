# Event Persistence & Recovery Design

## Problem

When the frontend loses state (hot reload, computer suspend, crash), in-progress session events are lost. The frontend re-detects the session is running via `syncActiveSession()`, but starts with an empty events array. Users can't see what happened before the state loss.

Events are only written to disk when a session completes via `trace.finalize()`, so there's no way to recover mid-session history.

## Design

### Incremental Event Persistence (Backend)

Write events to disk incrementally as they're emitted, instead of only at finalization.

- **Format:** JSONL — one JSON object per line, appended on each `emit()` call.
- **File:** `{appDataDir}/traces/{repo_id}/events_{session_id}.jsonl` (same location as today, new extension).
- **When:** Every event, immediately after accumulation in `emit()`.
- **Finalization:** `trace.finalize()` no longer writes the events file — it's already complete. Still writes `trace_{session_id}.json` summary.

### Frontend Event Recovery

When the frontend detects a running session with an empty events array, it loads historical events from disk via the existing `get_trace_events()` command.

- **Flow:** `syncActiveSession()` detects running session → events array is empty → calls `get_trace_events(repo_id, session_id)` → replaces events array with result.
- **Requires:** `get_active_sessions()` must return session IDs alongside repo IDs so the frontend knows which file to read.
- **Deduplication:** Not needed. The disk load replaces the entire events array. Any events that arrived via the Tauri listener before the load completes are a subset of what's on disk.

### JSONL Reader

`TraceCollector::read_events()` switches from parsing a JSON array to reading JSONL (line-by-line JSON parsing). This is a breaking change — old `events_*.json` files won't be readable. This is acceptable.

## Changes

### Backend (`src-tauri/src/`)

1. **`session.rs`** — In `emit()`, append serialized event + newline to the JSONL file. Add an event file handle or path to `SessionRunner`.
2. **`oneshot.rs`** — Same change to `OneShotRunner::emit()`.
3. **`trace.rs`** — Update `finalize()` to stop writing events file. Update `read_events()` to parse JSONL. Change file extension to `.jsonl`.
4. **`lib.rs`** — Update `ActiveSessions` to store `(CancellationToken, String)` (token + session_id). Update `get_active_sessions()` to return `Vec<(String, String)>` (repo_id, session_id pairs).

### Frontend (`src/`)

1. **`store.ts`** — In `syncActiveSession()`, when a running session has empty events, call `get_trace_events()` with the session_id to load history.
2. **`types.ts`** — Update active sessions type to include session_id.

---

## Implementation Plan

### Task 1: Add JSONL writer to TraceCollector

Add a method to `TraceCollector` for appending a single event to a JSONL file, and update `finalize()` to skip writing the events file.

**Files to modify:**
- `src-tauri/src/trace.rs`

**Pattern reference:** `src-tauri/src/trace.rs:189` (existing `finalize()` method)

**Details:**
- Add `append_event(&self, session_id: &str, event: &SessionEvent)` method
- Opens file in append+create mode, writes `serde_json::to_string(event)? + "\n"`
- Use `std::fs::OpenOptions` with `.create(true).append(true)` — synchronous is fine, this is called from a sync context
- Ensure `output_dir` exists (create_dir_all) on first write
- Update `finalize()` to remove the events file write block
- Change file extension from `.json` to `.jsonl`

**Checklist:**
- [ ] Add `append_event()` method to `TraceCollector`
- [ ] Remove events write from `finalize()`
- [ ] Update file extension to `.jsonl`
- [ ] `cargo check` passes

---

### Task 2: Update JSONL reader in TraceCollector

Update `read_events()` to parse JSONL format instead of JSON array.

**Files to modify:**
- `src-tauri/src/trace.rs`

**Pattern reference:** `src-tauri/src/trace.rs:355` (existing `read_events()` method)

**Details:**
- Read file line by line, parse each line as a `SessionEvent`
- Skip empty lines
- Update file extension from `.json` to `.jsonl`
- Return `Vec<SessionEvent>` (same return type)

**Checklist:**
- [ ] Update `read_events()` to parse JSONL
- [ ] Update file extension to `.jsonl`
- [ ] `cargo check` passes

---

### Task 3: Call append_event from SessionRunner::emit()

Wire up the incremental write in the session runner's event emission path.

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `src-tauri/src/session.rs:260` (existing `emit()` method)

**Details:**
- Add `collector: TraceCollector` reference or `events_path: PathBuf` to `SessionRunner` (or pass session_id so it can call `collector.append_event()`)
- Since `SessionRunner` already has a `collector: TraceCollector` field, and `session_id` is available from `config`, call `self.collector.append_event(&session_id, &event)` in `emit()`
- Handle errors gracefully — log and continue, don't fail the session

**Checklist:**
- [ ] Call `collector.append_event()` in `SessionRunner::emit()`
- [ ] Ensure session_id is accessible in `emit()`
- [ ] Handle write errors with logging (don't panic)
- [ ] `cargo check` passes

---

### Task 4: Call append_event from OneShotRunner::emit()

Same change for the oneshot runner.

**Files to modify:**
- `src-tauri/src/oneshot.rs`

**Pattern reference:** `src-tauri/src/oneshot.rs:210` (existing `emit()` method)

**Details:**
- Same pattern as Task 3 — call `self.collector.append_event()` in `emit()`
- `OneShotRunner` already has `collector` and `config` fields

**Checklist:**
- [ ] Call `collector.append_event()` in `OneShotRunner::emit()`
- [ ] Handle write errors with logging
- [ ] `cargo check` passes

---

### Task 5: Store session_id in ActiveSessions

Update `ActiveSessions` to track session IDs alongside cancellation tokens, and update `get_active_sessions()` to return them.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs:45` (existing `ActiveSessions` struct)

**Details:**
- Change `tokens: Mutex<HashMap<String, CancellationToken>>` to `tokens: Mutex<HashMap<String, (CancellationToken, String)>>` where the second String is session_id
- Update all insertion points in `run_session()` and `run_oneshot()` to include session_id
- Update `get_active_sessions()` return type to `Vec<(String, String)>` (repo_id, session_id)
- Update `stop_session()` to destructure the tuple when accessing the token

**Checklist:**
- [ ] Update `ActiveSessions` struct
- [ ] Update session insertion in `run_session()`
- [ ] Update session insertion in `run_oneshot()`
- [ ] Update `get_active_sessions()` to return session IDs
- [ ] Update `stop_session()` token access
- [ ] `cargo check` passes

---

### Task 6: Frontend event recovery on sync

Update the frontend to load historical events when it detects a running session with no events.

**Files to modify:**
- `src/store.ts`
- `src/types.ts`

**Pattern reference:** `src/store.ts:34` (existing `syncActiveSession()`)

**Details:**
- Update `syncActiveSession()` to handle the new `get_active_sessions()` return type (`[string, string][]` — repo_id, session_id pairs)
- When a running session is detected with an empty events array, call `invoke("get_trace_events", { repoId, sessionId })` to load events from disk
- Replace the session's events array with the loaded events
- Store session_id in `SessionState` so it's available for the `get_trace_events` call
- Add `session_id?: string` to `SessionState` type

**Checklist:**
- [ ] Add `session_id` to `SessionState` type
- [ ] Update `syncActiveSession()` to parse new return format
- [ ] Add event recovery call when events array is empty
- [ ] `npx tsc --noEmit` passes
- [ ] Test manually: start a session, reload the page, verify events are recovered

---

### Task 7: Tests

Add tests for the new JSONL read/write functionality.

**Files to modify:**
- `src-tauri/src/trace.rs` (Rust unit tests)

**Pattern reference:** Existing tests in `src-tauri/src/trace.rs`

**Details:**
- Test `append_event()` writes valid JSONL
- Test `read_events()` reads JSONL correctly
- Test multiple appends produce valid multi-line JSONL
- Test empty file returns empty vec
- Test `finalize()` no longer creates events file

**Checklist:**
- [ ] Add test for `append_event()` JSONL output
- [ ] Add test for `read_events()` JSONL parsing
- [ ] Add test for round-trip (append then read)
- [ ] `cargo test` passes in `src-tauri/`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add JSONL writer to TraceCollector | Not Started |
| 2 | Update JSONL reader in TraceCollector | Not Started |
| 3 | Call append_event from SessionRunner::emit() | Not Started |
| 4 | Call append_event from OneShotRunner::emit() | Not Started |
| 5 | Store session_id in ActiveSessions | Not Started |
| 6 | Frontend event recovery on sync | Not Started |
| 7 | Tests | Not Started |
