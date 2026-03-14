# Iteration Context Usage Display

Show live context token usage and compaction events in iteration headers for ralph loops and 1-shot sessions.

## What we're building

1. **Human-friendly token counts** in iteration headers — `338k in / 4k out` with hover for exact numbers
2. **Live context usage** — `142k ctx` with color coding, updated in real-time as assistant messages arrive within an iteration
3. **Compaction detection** — parse `compact_boundary` system events from the `claude -p` stream, show in the event list and as a `⟳` icon on the iteration header

### Iteration header format

```
Iteration 1 — 8 events · $0.72 · 338k in / 4k out · 142k ctx
Iteration 2 — 12 events · $1.04 · 412k in / 8k out · 185k ctx ⟳
```

### Context color thresholds (absolute token counts)

- Green (`#34d399`): < 80k
- Yellow (`#fbbf24`): 80k–140k
- Red (`#f87171`): > 140k

### Compaction event format

Claude emits a `system` event with `subtype: "compact_boundary"`:

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "compact_metadata": { "trigger": "auto", "pre_tokens": 167000 }
}
```

## Implementation Plan

### Task 1: Parse compact_boundary in SystemEvent

Add `compact_metadata` field to the Rust `SystemEvent` struct so we can detect compaction events from the stream.

**Files to modify:**
- `src-tauri/src/output.rs`

**Pattern reference:** `src-tauri/src/output.rs:96` (RateLimitInfo nested struct pattern)

**Details:**
- Add `CompactMetadata` struct with `trigger: Option<String>` and `pre_tokens: Option<u64>`
- Add `compact_metadata: Option<CompactMetadata>` field to `SystemEvent`
- Add a unit test parsing a real compact_boundary event

**Checklist:**
- [ ] Add `CompactMetadata` struct
- [ ] Add field to `SystemEvent`
- [ ] Add `parse_compact_boundary` test
- [ ] `cd src-tauri && cargo test`

---

### Task 2: Add ContextUpdated and Compacted session events

Add two new variants to `SessionEvent` so the frontend can receive live context updates and compaction notifications.

**Files to modify:**
- `src-tauri/src/session.rs` (SessionEvent enum)

**Pattern reference:** `src-tauri/src/session.rs:190` (RateLimited variant with iteration + fields)

**Details:**
- Add `ContextUpdated { iteration: u32, context_tokens: u64 }` variant
- Add `Compacted { iteration: u32, pre_tokens: u64, trigger: String }` variant

**Checklist:**
- [ ] Add both variants to `SessionEvent`
- [ ] `cd src-tauri && cargo test`

---

### Task 3: Emit ContextUpdated and Compacted events in SessionRunner

Wire up the new events in `run_iteration()` so they're emitted during streaming.

**Files to modify:**
- `src-tauri/src/session.rs` (run_iteration method)

**Pattern reference:** `src-tauri/src/session.rs:936-941` (existing last_context_tokens tracking)

**Details:**
- After updating `last_context_tokens` from assistant usage, emit `SessionEvent::ContextUpdated { iteration, context_tokens: last_context_tokens }`
- In the `StreamEvent::System` match arm, check for `subtype == "compact_boundary"` and emit `SessionEvent::Compacted` with the metadata
- Add tracing for compaction events

**Checklist:**
- [ ] Emit `ContextUpdated` after each assistant usage update
- [ ] Detect `compact_boundary` subtype and emit `Compacted`
- [ ] Add tracing log for compaction
- [ ] `cd src-tauri && cargo test`

---

### Task 4: Emit events in SSH orchestrator

Mirror the same ContextUpdated/Compacted event emission in the SSH orchestrator's stream processing.

**Files to modify:**
- `src-tauri/src/ssh_orchestrator.rs`

**Pattern reference:** `src-tauri/src/session.rs` (Task 3 changes)

**Details:**
- The SSH orchestrator has a TODO at line 271: "track last_context_tokens from assistant messages"
- Add `last_context_tokens` tracking from assistant usage (same as session.rs)
- Emit `ContextUpdated` events
- Handle `compact_boundary` system events and emit `Compacted`

**Checklist:**
- [ ] Add `last_context_tokens` tracking in SSH orchestrator
- [ ] Emit `ContextUpdated` on assistant messages
- [ ] Handle `compact_boundary` and emit `Compacted`
- [ ] `cd src-tauri && cargo test`

---

### Task 5: Add context_tokens and compacted fields to IterationGroup

Extend the frontend data model to carry live context tokens and compaction state per iteration.

**Files to modify:**
- `src/iteration-groups.ts`

**Pattern reference:** `src/iteration-groups.ts:3-12` (IterationGroup type)

**Details:**
- Add `contextTokens: number` field to `IterationGroup` (live context, updated by `context_updated` events)
- Add `compacted: boolean` field (set by `compacted` events)
- Add `compactedPreTokens: number` field (pre-compaction token count for display)
- In `groupEventsByIteration()`, handle new event kinds:
  - `context_updated`: update `currentGroup.contextTokens` to latest value
  - `compacted`: set `currentGroup.compacted = true`, store `pre_tokens`
- Update existing tests, add new tests for `context_updated` and `compacted` events

**Checklist:**
- [ ] Add fields to `IterationGroup` type
- [ ] Handle `context_updated` events in grouping logic
- [ ] Handle `compacted` events in grouping logic
- [ ] Add/update tests in `src/iteration-groups.test.ts`
- [ ] `npx tsc --noEmit`

---

### Task 6: Add contextTokensColor helper

Add a helper function for the absolute-threshold context color coding.

**Files to modify:**
- `src/context-bar.ts`

**Pattern reference:** `src/context-bar.ts:19-23` (sessionContextColor function)

**Details:**
- Add `contextTokensColor(tokens: number): string` function
  - Red (`#f87171`): > 140k
  - Yellow (`#fbbf24`): 80k–140k
  - Green (`#34d399`): < 80k
- Add tests

**Checklist:**
- [ ] Add `contextTokensColor` function
- [ ] Add tests in `src/context-bar.test.ts` (create if needed)
- [ ] `npx tsc --noEmit`

---

### Task 7: Update IterationGroup header display

Update the iteration header to show human-friendly tokens with hover, context usage with color, and compaction icon.

**Files to modify:**
- `src/components/IterationGroup.tsx`

**Pattern reference:** `src/components/IterationGroup.tsx:83-97` (current iteration-stats span)

**Details:**
- Import `contextTokensColor` from context-bar
- Change token display from `{group.inputTokens.toLocaleString()} in / {group.outputTokens.toLocaleString()} out` to `{formatTokenCount(group.inputTokens)} in / {formatTokenCount(group.outputTokens)} out` wrapped in a `<span title="{exact counts}">` for hover
- Add context tokens display: `· {formatTokenCount(group.contextTokens)} ctx` with `style={{ color: contextTokensColor(group.contextTokens) }}`
- Use `group.contextTokens` (live value) instead of calculated percentage for the display
- Add compaction icon: show `⟳` after ctx when `group.compacted` is true
- Keep the context bar below the header as-is (it uses contextWindow from the result event)

**Checklist:**
- [ ] Human-friendly token counts with hover title
- [ ] Context tokens display with color
- [ ] Compaction ⟳ icon
- [ ] Visual verification with `npx tauri dev`
- [ ] `npx tsc --noEmit`

---

### Task 8: Add compacted event to event stream display

Show compaction events as visible items in the event list within an iteration.

**Files to modify:**
- `src/event-format.ts`
- `src/components/IterationGroup.tsx`

**Pattern reference:** `src/event-format.ts:123-124` (rate_limited event handling)

**Details:**
- Add `compacted` to `eventEmoji()`: use `⟳` (U+27F3)
- Add `compacted` to `eventLabel()`: show `"Context compacted from {formatTokenCount(pre_tokens)}"` using the `pre_tokens` field from the event
- Add `compacted` to `eventKindColor` in IterationGroup.tsx: use `text-[#60a5fa]` (blue, informational)
- Add `context_updated` kind but do NOT display it in the event list (it's too noisy) — it's only used for updating `IterationGroup.contextTokens`

**Checklist:**
- [ ] Add emoji, label, and color for `compacted` event kind
- [ ] Filter out `context_updated` from visible events (or just don't render — it won't match any display logic)
- [ ] `npx tsc --noEmit`

---

### Task 9: Add SessionEvent fields to TypeScript types

Ensure the `SessionEvent` type covers the new event fields used by `context_updated` and `compacted`.

**Files to modify:**
- `src/types.ts`

**Pattern reference:** `src/types.ts:25-50` (SessionEvent type)

**Details:**
- Add `context_tokens?: number` field (used by `context_updated`)
- Add `pre_tokens?: number` field (used by `compacted`)
- Add `trigger?: string` field (used by `compacted`)
- These are optional fields on the existing `SessionEvent` union type

**Checklist:**
- [ ] Add fields to SessionEvent type
- [ ] `npx tsc --noEmit`

---

### Task 10: Verify end-to-end with tests

Add integration tests and verify the full flow.

**Checklist:**
- [ ] `cd src-tauri && cargo test`
- [ ] `npm test`
- [ ] `npx tsc --noEmit`
- [ ] `npx eslint .`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Parse compact_boundary in SystemEvent | Not Started |
| 2 | Add ContextUpdated and Compacted session events | Not Started |
| 3 | Emit events in SessionRunner | Not Started |
| 4 | Emit events in SSH orchestrator | Not Started |
| 5 | Add fields to IterationGroup | Not Started |
| 6 | Add contextTokensColor helper | Not Started |
| 7 | Update iteration header display | Not Started |
| 8 | Add compacted event to event stream | Not Started |
| 9 | Add fields to TypeScript types | Not Started |
| 10 | Verify end-to-end with tests | Not Started |
