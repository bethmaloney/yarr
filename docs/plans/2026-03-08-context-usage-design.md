# Context Window Usage Tracking

## Summary

Display the context window usage percentage for each session, showing how full the context was at the end of the last iteration. Displayed as a color-coded percentage in session summary cards with hover tooltip showing raw token count.

## Motivation

When orchestrating Claude Code sessions, it's critical to judge whether tasks are correctly sized. If a session consistently uses 90%+ of the context window, the tasks are too big and risk hitting limits. A quick visual indicator in the session card makes this immediately scannable.

## Data Source

Each `claude -p` invocation emits `assistant` events with per-turn `usage` data, and a final `result` event with aggregate data and `modelUsage` containing `contextWindow`.

**Key insight**: The `ResultEvent.usage.input_tokens` is the aggregate across ALL API turns, which overcounts. For "how full was the context window at the end", we need the **last assistant message's** effective input tokens:

```
effective_context = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

This represents the total tokens sent in the final prompt, regardless of caching.

## Data Model Changes

### Rust: `SpanAttributes` (trace.rs)

Add one field:

```rust
pub final_context_tokens: u64,  // effective input tokens from last API turn
```

The `context_window` is already available from `model_token_usage` — no need to duplicate it.

### Rust: `SessionTrace` (trace.rs)

Add two fields:

```rust
#[serde(default)]
pub context_window: u64,         // max context from model_token_usage
#[serde(default)]
pub final_context_tokens: u64,   // from last iteration's last API turn
```

`#[serde(default)]` ensures backward compatibility with old trace files.

### TypeScript: `SessionTrace` (types.ts)

Add matching optional fields:

```typescript
context_window?: number;
final_context_tokens?: number;
```

## Backend Logic

### Capturing last turn's context (session.rs `run_iteration`)

Track a running `last_context_tokens: u64` that updates from each `AssistantMessage.usage`:

```rust
StreamEvent::Assistant(assistant) => {
    if let Some(ref usage) = assistant.message.usage {
        last_context_tokens =
            usage.input_tokens.unwrap_or(0)
            + usage.cache_read_input_tokens.unwrap_or(0)
            + usage.cache_creation_input_tokens.unwrap_or(0);
    }
    // ... existing content block processing ...
}
```

Return this value alongside the `ResultEvent` (change return type to a tuple or add to ResultEvent).

### Recording in trace (session.rs `run` + trace.rs)

- Pass `last_context_tokens` into `SpanAttributes.final_context_tokens`
- In `record_iteration()`, always overwrite `trace.context_window` and `trace.final_context_tokens` from the latest iteration — the last call wins

For `context_window`, extract from `model_token_usage`: take the max `context_window` across all models (usually just one).

## Frontend Display

### Session summary card (RepoDetail.svelte)

After "Total Cost", add a "Context" row:

```svelte
{@const ctxPercent = trace.context_window
  ? Math.round((trace.final_context_tokens / trace.context_window) * 100)
  : null}
{#if ctxPercent !== null}
  <dt>Context</dt>
  <dd>
    <span class="context-pct {colorClass}" title="{tokens} tokens">
      {ctxPercent}%
    </span>
  </dd>
{/if}
```

Color thresholds:
- **Green** (`#34d399`): < 60%
- **Yellow** (`#fbbf24`): 60–85%
- **Red** (`#f87171`): > 85%

Hover shows: `"{final_context_tokens formatted with commas} tokens"` (e.g. "98,341 tokens")

### Home page card (RepoCard.svelte)

Add context percentage inline with existing stats:

```
plan.md · $1.23 · 73% · 5m ago
```

Same color coding. Only shown when data is available.

## Implementation Plan

### Task 1: Add `final_context_tokens` tracking to `run_iteration`

Capture the last assistant message's effective context size during iteration processing.

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `src-tauri/src/session.rs:606-632` (existing assistant event processing in `run_iteration`)

**Details:**
- Add `let mut last_context_tokens: u64 = 0;` before the event loop
- In the `StreamEvent::Assistant` arm, update `last_context_tokens` from `assistant.message.usage`
- Effective context = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
- Change return type to `(ResultEvent, u64)` to return the last context tokens alongside the result

**Checklist:**
- [ ] Add `last_context_tokens` tracking variable
- [ ] Update from each assistant event's usage
- [ ] Change return type and return the tuple
- [ ] Update call site in `run()` to destructure the tuple
- [ ] `cargo check` passes

---

### Task 2: Add context fields to `SpanAttributes` and `SessionTrace`

Store the context usage data in the trace data model.

**Files to modify:**
- `src-tauri/src/trace.rs`

**Pattern reference:** `src-tauri/src/trace.rs:50-62` (SpanAttributes fields), `src-tauri/src/trace.rs:24-48` (SessionTrace fields)

**Details:**
- Add `final_context_tokens: u64` to `SpanAttributes`
- Add `context_window: u64` and `final_context_tokens: u64` to `SessionTrace` with `#[serde(default)]`
- In `start_session()`, initialize both to 0
- In `record_iteration()`, overwrite `trace.context_window` and `trace.final_context_tokens` on every call (last call wins)
- Extract `context_window` from `attrs.model_token_usage`: take max `.context_window` across all models
- In `finalize()`, recompute from last iteration (same pattern as other fields)

**Checklist:**
- [ ] Add field to `SpanAttributes`
- [ ] Add fields to `SessionTrace` with `#[serde(default)]`
- [ ] Update `start_session()` initializer
- [ ] Update `record_iteration()` to set context fields
- [ ] Update `finalize()` to recompute from last iteration
- [ ] `cargo check` passes

---

### Task 3: Wire context data through `session.rs` run loop

Pass the captured `last_context_tokens` into `SpanAttributes` when recording iterations.

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `src-tauri/src/session.rs:430-447` (SpanAttributes construction in successful iteration)

**Details:**
- Destructure `run_iteration()` return as `(result, last_context_tokens)`
- Add `final_context_tokens: last_context_tokens` to the `SpanAttributes` struct literal
- Also add `final_context_tokens: 0` to the error-path `SpanAttributes` (line ~517)

**Checklist:**
- [ ] Update successful iteration SpanAttributes
- [ ] Update error-path SpanAttributes
- [ ] `cargo check` passes

---

### Task 4: Add TypeScript fields and display in RepoDetail

Add context usage percentage to the session summary card.

**Files to modify:**
- `src/types.ts`
- `src/RepoDetail.svelte`
- `src/context-bar.ts`

**Pattern reference:** `src/RepoDetail.svelte:334-352` (existing session summary), `src/context-bar.ts` (color function)

**Details:**
- Add `context_window?: number` and `final_context_tokens?: number` to `SessionTrace` type
- Add a `sessionContextColor(pct)` function to `context-bar.ts` with thresholds: <60 green, 60-85 yellow, >85 red
- In `RepoDetail.svelte`, after the "Total Cost" `<dt>/<dd>`, add a "Context" row
- Compute percentage: `Math.round((final_context_tokens / context_window) * 100)`
- Color the percentage text using `sessionContextColor()`
- Add `title` attribute with `final_context_tokens.toLocaleString() + " tokens"` for hover
- Only show when `context_window > 0`

**Checklist:**
- [ ] Update TypeScript `SessionTrace` type
- [ ] Add `sessionContextColor` function
- [ ] Add context row to RepoDetail session summary
- [ ] Verify hover tooltip shows formatted token count
- [ ] `npx tsc --noEmit` passes

---

### Task 5: Add context percentage to RepoCard

Show context usage inline on the home page cards.

**Files to modify:**
- `src/RepoCard.svelte`

**Pattern reference:** `src/RepoCard.svelte:48-58` (existing last-run stats)

**Details:**
- After the cost `<span>`, add context percentage with color
- Format: `73%` with colored text
- Only show when `lastTrace.context_window > 0`
- Use `sessionContextColor()` from `context-bar.ts`

**Checklist:**
- [ ] Add context percentage span to RepoCard
- [ ] Apply color styling
- [ ] Only render when data available
- [ ] `npx tsc --noEmit` passes

---

### Task 6: Update test helpers and add tests

Update test helpers for new fields and add a test for context tracking.

**Files to modify:**
- `src-tauri/src/trace.rs` (test helpers)
- `src-tauri/src/session.rs` (test helpers if needed)

**Pattern reference:** `src-tauri/src/trace.rs:341-362` (make_test_trace helper)

**Details:**
- Update `make_test_trace()` to include `context_window: 200_000` and `final_context_tokens: 0`
- Add backward compat test: deserialize old-format trace JSON without new fields, verify defaults to 0
- Add test: verify `record_iteration` overwrites context fields (last iteration wins)

**Checklist:**
- [ ] Update test helpers
- [ ] Add backward compat test
- [ ] Add record_iteration context test
- [ ] `cargo test` passes

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Track last_context_tokens in run_iteration | Not Started |
| 2 | Add context fields to SpanAttributes/SessionTrace | Not Started |
| 3 | Wire context data through run loop | Not Started |
| 4 | TypeScript types + RepoDetail display | Not Started |
| 5 | RepoCard context percentage | Not Started |
| 6 | Update tests | Not Started |
