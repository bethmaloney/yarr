# Session Lifecycle Redesign

## Problem

Ralph loop sessions can become orphaned zombies. Starting a new session for the same repo overwrites the previous `CancellationToken` in `ActiveSessions`, making the old session unkillable. Events from the zombie keep flowing to the frontend with no way to stop them. Stopping a session only kills one of the duplicates.

## Core Invariant

**At most one ralph loop may be active per repo at any time.** 1-shots are independent and keyed by `oneshot_id`. Both share the same `ActiveSessions` registry with no structural split needed — there is no key collision between `repo_id` and `oneshot_id`.

## Design

### Backend Changes

#### 1. SessionHandle replaces the tuple

```rust
struct SessionHandle {
    cancel_token: CancellationToken,
    session_id: String,
    join_handle: JoinHandle<()>,
}
```

`ActiveSessions` stores `SessionHandle` instead of `(CancellationToken, String)`.

#### 2. run_session becomes spawn-and-return

- **Reject guard**: Checks `ActiveSessions` for existing `repo_id` entry. If present, returns an error ("Session already running for this repo").
- **Spawn**: Session runs inside `tokio::spawn`, consistent with how 1-shots already work.
- **Register**: The `JoinHandle` is stored in `ActiveSessions` alongside the token.
- **Return**: Returns `{ session_id }` immediately.

#### 3. Scope guard cleanup

Inside the spawned task, a `scopeguard` ensures the `ActiveSessions` entry is removed when the task exits — success, error, or panic:

```rust
let _guard = scopeguard::guard((), {
    let app = app.clone();
    let repo_id = repo_id.clone();
    move |_| {
        let app = app.clone();
        let repo_id = repo_id.clone();
        tokio::spawn(async move {
            app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
        });
    }
});
```

The guard spawns a cleanup task because `.await` cannot be used in `Drop`.

#### 4. stop_session — drop lock before cancelling

```rust
async fn stop_session(app: AppHandle, repo_id: String) -> Result<(), String> {
    let active = app.state::<ActiveSessions>();
    let token = {
        let sessions = active.tokens.lock().await;
        sessions.get(&repo_id).map(|h| h.cancel_token.clone())
    };
    match token {
        Some(t) => { t.cancel(); Ok(()) }
        None => Err("No active session to stop".to_string())
    }
}
```

Lock is dropped before cancelling to avoid deadlock with the scope guard's cleanup task, which needs to acquire the same lock.

We do NOT await the JoinHandle. Cancellation is asynchronous — the token signals, the runner detects it in `tokio::select!`, aborts the child process, and the scope guard cleans up.

### Frontend Changes

#### runSession — fire and forget

```typescript
runSession: async (repoId, planFile) => {
  next.set(repoId, { running: true, events: [], trace: null, error: null, ... });
  try {
    const { session_id } = await invoke<{ session_id: string }>("run_session", { ... });
    // Store session_id, done
    next.set(repoId, { ...current, session_id });
  } catch (e) {
    // Reject guard or startup error
    next.set(repoId, { ...current, running: false, error: String(e) });
  }
  // No await for completion — events handle everything
}
```

#### session_complete event — fetch trace

When the frontend receives a `session_complete` event, it sets `running: false` (already done) and fetches the trace:

```typescript
if (sessionEvent.kind === "session_complete") {
  updates.running = false;
  const sessionId = session.session_id;
  if (sessionId) {
    invoke<SessionTrace>("get_trace", { repoId: repo_id, sessionId })
      .then(trace => { /* update latestTraces and session.trace */ });
  }
}
```

The `try/catch/finally` block in the current `runSession` that sets `running: false` on invoke return is removed — the event handles this now.

#### stopSession — no change

Already just calls `invoke("stop_session", { repoId })`.

#### syncActiveSession — no change

Already polls `get_active_sessions` and reconciles. With JoinHandle tracking, stale entries get reaped by the backend scope guard.

### Edge Cases

| Scenario | Handling |
|----------|----------|
| Frontend reload while session running | Backend task continues. On reload, `syncActiveSession` rediscovers it, events resume. |
| App exit | `GlobalAbortRegistry` aborts all child processes (unchanged). |
| Process crash (claude exits unexpectedly) | `runner.run()` returns error, task emits `session_complete` with failed outcome, scope guard cleans up. |
| Tokio task panic | Scope guard fires on drop, spawns cleanup task. |
| Double-click Run (race condition) | Frontend disables button when `running === true`. Backend reject guard catches any race that slips through. |

### What does NOT change

- `SessionRunner` / `session.rs` — the runner internals are fine
- `SshSessionOrchestrator` — same spawn-and-return pattern applies (already uses it)
- Event format / `TaggedSessionEvent` — no session_id added to events
- `GlobalAbortRegistry` — unchanged

### New dependency

- `scopeguard` crate

---

## Implementation Plan

### Task 1: Add `scopeguard` dependency and `SessionHandle` struct

Add the `scopeguard` crate and replace the `(CancellationToken, String)` tuple with a `SessionHandle` struct in `ActiveSessions`.

**Files to modify:**
- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs:46-48` (existing `ActiveSessions` struct)

**Details:**
- Add `scopeguard = "1"` to `[dependencies]` in Cargo.toml
- Define `SessionHandle` struct with `cancel_token: CancellationToken`, `session_id: String`, `join_handle: JoinHandle<()>`
- Update `ActiveSessions` to use `Mutex<HashMap<String, SessionHandle>>`
- Update `get_active_sessions` to read `session_id` from `SessionHandle` instead of tuple
- Update `stop_session` to read `cancel_token` from `SessionHandle`, drop the lock before calling `cancel()`

**Checklist:**
- [x] Add `scopeguard` to Cargo.toml
- [x] Define `SessionHandle` struct
- [x] Update `ActiveSessions` type alias
- [x] Update `get_active_sessions` to destructure `SessionHandle`
- [x] Update `stop_session` to clone token, drop lock, then cancel
- [x] `cd src-tauri && cargo check`

---

### Task 2: Convert `run_session` local path to spawn-and-return

Convert the `RepoType::Local` branch of `run_session` from blocking to spawn-and-return. Add the reject guard and scope guard.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs:345-354` (existing 1-shot spawn-and-return pattern)

**Details:**
- Change return type from `Result<SessionTrace, String>` to `Result<SessionResult, String>` (new struct with `session_id: String`)
- Add reject guard at top: check `ActiveSessions.contains_key(&repo_id)`, return error if present
- Keep all setup code (env cache, plan validation, branch creation, config building) before the spawn
- Move `runner.run()` into `tokio::spawn`
- Inside spawn: add `scopeguard` to remove `repo_id` from `ActiveSessions` on exit
- Inside spawn: after `runner.run()` completes (success or error), emit `session_complete` event if the runner didn't already (error case)
- Register the `JoinHandle` in `ActiveSessions` after spawning
- Return `SessionResult { session_id }` immediately
- Note: the reject guard insert and the JoinHandle registration are two separate steps. Insert a placeholder first (with a dummy JoinHandle or use a two-phase approach), or insert after spawn. Since spawn happens synchronously (it returns the handle immediately), insert after spawn is safe.

**Checklist:**
- [x] Define `SessionResult` struct
- [x] Add reject guard before any setup
- [x] Wrap runner execution in `tokio::spawn`
- [x] Add scope guard inside spawn for `ActiveSessions` cleanup
- [ ] Emit `session_complete` on error paths inside spawn (deferred to Task 9)
- [x] Store `JoinHandle` in `ActiveSessions`
- [x] Return `SessionResult { session_id }` immediately
- [x] `cd src-tauri && cargo check`

---

### Task 3: Convert `run_session` SSH path to spawn-and-return

Same spawn-and-return conversion for the `RepoType::Ssh` branch.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** Task 2's local path implementation

**Details:**
- Apply the same pattern as the local path: reject guard (already covered by the shared guard at top), spawn, scope guard, return session_id
- SSH path also needs to clean up `ActiveSshSessions` in the scope guard
- The orchestrator's `run()` already emits `SessionComplete`, so the spawn just needs error handling for failures before `run()` is called

**Checklist:**
- [x] Wrap SSH orchestrator execution in `tokio::spawn`
- [x] Add scope guard for both `ActiveSessions` and `ActiveSshSessions` cleanup
- [ ] Emit `session_complete` on error paths inside spawn (deferred to Task 9)
- [x] Store `JoinHandle` in `ActiveSessions`
- [x] `cd src-tauri && cargo check`

---

### Task 4: Add scope guard to 1-shot spawn

The existing 1-shot spawn at `lib.rs:348-352` has the same vulnerability — if the task panics, `ActiveSessions` leaks. Apply the same scope guard pattern.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** Task 2's scope guard implementation

**Details:**
- Add `scopeguard` inside the existing `tokio::spawn` block for 1-shot
- Remove the explicit `app_bg.state::<ActiveSessions>().tokens.lock().await.remove(...)` line (the guard replaces it)

**Checklist:**
- [x] Add scope guard to 1-shot spawn block
- [x] Remove manual cleanup line
- [x] `cd src-tauri && cargo check`

---

### Task 5: Update frontend `runSession` to fire-and-forget

Change `runSession` in the Zustand store to handle the new spawn-and-return response.

**Files to modify:**
- `src/store.ts`

**Pattern reference:** `src/store.ts:286-351` (existing `runOneShot` fire-and-forget pattern)

**Details:**
- Change `invoke<SessionTrace>("run_session", ...)` to `invoke<{ session_id: string }>("run_session", ...)`
- On success: store `session_id` on the session state, done (no await for completion)
- Remove the `try/catch/finally` structure that sets `trace`, `latestTraces`, and `running: false` — all of this moves to the event handler
- Keep the `catch` for startup errors (reject guard, plan not found, branch creation failure) — set `running: false` and `error`
- Remove the `saveRecent` call from `runSession` (move to event handler)

**Checklist:**
- [x] Update invoke return type
- [x] Simplify success path to just store session_id
- [x] Remove finally block
- [x] Move `saveRecent` call (see Task 6)
- [x] `npx tsc --noEmit`

---

### Task 6: Update `session_complete` event handler to fetch trace

Add trace fetching and `saveRecent` to the event handler for `session_complete`.

**Files to modify:**
- `src/store.ts`

**Pattern reference:** `src/store.ts:164-211` (existing `session_complete` event handling)

**Details:**
- After setting `running: false`, fetch the trace if `session.session_id` is set:
  ```typescript
  invoke<SessionTrace>("get_trace", { repoId: repo_id, sessionId })
  ```
- On trace fetch success: update `session.trace` and `latestTraces`
- On fetch failure: log warning, don't block (trace is nice-to-have, not critical)
- Move `saveRecent("promptFiles", ...)` here — extract `plan_file` from the `session_complete` event payload (it's already available as `sessionEvent.plan_file`)
- Move the plan-to-completed logic (already in this handler, no change needed)

**Checklist:**
- [x] Add trace fetch after `running: false`
- [x] Update `latestTraces` on fetch success
- [x] Move `saveRecent` from `runSession` to here
- [x] `npx tsc --noEmit`

---

### Task 7: Update Rust tests

Update existing tests that depend on `run_session` returning `SessionTrace` or on `ActiveSessions` tuple structure.

**Files to modify:**
- `src-tauri/src/lib.rs` (any tests in this file)

**Pattern reference:** Existing tests in `src-tauri/src/lib.rs`

**Details:**
- Update any tests that construct `ActiveSessions` with tuples to use `SessionHandle`
- `SessionRunner` tests in `session.rs` should not need changes (runner internals unchanged)
- If there are integration tests calling `run_session` directly, update expected return type

**Checklist:**
- [x] Update tests for `SessionHandle` struct
- [x] Update tests for new `run_session` return type
- [x] `cd src-tauri && cargo test`

---

### Task 8: Update frontend tests

Update `store.test.ts` tests for `runSession` to match new behavior.

**Files to modify:**
- `src/store.test.ts`

**Pattern reference:** `src/store.test.ts:830-920` (existing `runSession` tests)

**Details:**
- Update mock return value from `makeTrace()` to `{ session_id: "test-session-id" }`
- "on success: updates session with trace" test — trace now comes from events, not invoke return. Either remove or rewrite to test that `session_id` is stored.
- "on success: updates latestTraces map" test — remove or move to event handler tests
- "in finally: sets running to false" test — remove (running is set to false by event handler)
- "on success: calls saveRecent" test — remove or move to event handler tests
- Add new test: "on reject: sets error and running=false" — mock invoke to reject with "Session already running"
- Keep: "sets session to running with empty state before invoke"
- Keep: "calls invoke with run_session and correct payload"

**Checklist:**
- [x] Update mock return values
- [x] Remove/rewrite trace-on-return tests
- [x] Remove finally test
- [x] Add reject guard test
- [x] `npm test`

---

### Task 9: Backend `session_complete` event for error paths

Ensure that when the spawned task fails before `runner.run()` is called (or if `run()` returns an error without emitting `SessionComplete`), a `session_complete` event is still emitted so the frontend knows the session ended.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/session.rs:874-875` (existing `SessionComplete` emission in runner)

**Details:**
- `runner.run()` already emits `SessionComplete` on success, max iterations, and cancellation
- If `run()` returns `Err`, the runner may not have emitted `SessionComplete` — the spawn block must emit it
- Add a catch-all after `runner.run()` in the spawn block: if result is `Err`, emit `SessionComplete { outcome: Failed }`
- Include `plan_file` in the event so the frontend can do `saveRecent`

**Checklist:**
- [x] Add error-path `SessionComplete` emission in local spawn block
- [x] Add error-path `SessionComplete` emission in SSH spawn block
- [x] Verify `plan_file` is included in the event payload
- [x] `cd src-tauri && cargo check`

---

### Task 10: E2E smoke test

Verify the full lifecycle works end-to-end.

**Files to modify:**
- None (manual testing) or `e2e/*.test.ts` if adding automated coverage

**Details:**
- Start a session → verify it returns immediately with session_id
- Events flow to frontend in real-time
- Stop the session → verify it stops and `session_complete` fires
- Try starting a second session for same repo → verify reject error
- Reload the frontend while session is running → verify recovery via `syncActiveSession`

**Checklist:**
- [x] E2E smoke tests for start/stop/reject lifecycle (automated in `e2e/session-lifecycle.test.ts`)
- [x] Verify no zombie processes after stop (covered by scope guard + session_complete event tests)
- [x] `cd src-tauri && cargo test`
- [x] `npm test`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add scopeguard + SessionHandle struct | Done |
| 2 | Convert run_session local to spawn-and-return | Done |
| 3 | Convert run_session SSH to spawn-and-return | Done |
| 4 | Add scope guard to 1-shot spawn | Done |
| 5 | Update frontend runSession to fire-and-forget | Done |
| 6 | Update session_complete handler to fetch trace | Done |
| 7 | Update Rust tests | Done |
| 8 | Update frontend tests | Done |
| 9 | Backend session_complete for error paths | Done |
| 10 | E2E smoke test | Done |
