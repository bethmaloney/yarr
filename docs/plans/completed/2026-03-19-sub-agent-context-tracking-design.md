# Sub-Agent Context Tracking

## Problem

When Claude Code spawns sub-agents (via the Agent tool), their `context_updated` events come through the same stream as the main agent's. Since sub-agents start with a fresh context, the context bar suddenly drops — making it look like the main agent's context shrank. There's no way to distinguish whether context belongs to the main agent or a sub-agent.

## Solution

Use the `parent_tool_use_id` field present on every stream-json event (`null` for main agent, a tool_use ID string for sub-agent events) to separate main-agent and sub-agent context tracking.

- **Main agent context bar stays stable** — sub-agent events don't affect it
- **Iteration header shows aggregate sub-agent peak** — "sub-agents peak: 45k/200k"
- **Individual Agent tool events show per-agent context** when expanded

## Design

### 1. Parsing — Capture `parent_tool_use_id`

**`output.rs`** — Add `parent_tool_use_id: Option<String>` to `AssistantEvent` and `UserEvent`. The field is present on every stream-json event: `null` for main agent, a tool_use ID string for sub-agent events. Serde handles this naturally — `Option<String>` deserializes `null` as `None`.

**`session.rs` / `ssh_orchestrator.rs`** — At the point where we process `StreamEvent::Assistant`, check `assistant.parent_tool_use_id`. If it's `Some(id)`:

- Do **not** update `last_context_tokens` or emit `ContextUpdated` for the main agent
- Instead, track sub-agent context in a separate `HashMap<String, u64>` keyed by `parent_tool_use_id`, storing the peak context for each sub-agent
- Emit a new event `SubAgentContextUpdated { iteration, parent_tool_use_id, context_tokens }` so the frontend can display live sub-agent context

When the sub-agent completes (a `tool_result` arrives for the Agent tool_use), the sub-agent's peak context is finalized.

### 2. Session Events — New event types and updated data model

**New `SessionEvent` variant** in Rust:

```rust
SubAgentContextUpdated {
    iteration: u32,
    parent_tool_use_id: String,
    context_tokens: u64,
}
```

Emitted live as sub-agent assistant messages arrive.

**`IterationComplete` enrichment** — When serializing `iteration_complete` to the frontend, include:

```
sub_agent_peak_context: Option<u64>  // max context across all sub-agents in this iteration
```

Computed from the `HashMap<String, u64>` tracking per-sub-agent peaks, taking the max value. The map resets at iteration boundaries.

**Frontend `SessionEvent` type** (`types.ts`) — Add:

- `parent_tool_use_id?: string` — present on `sub_agent_context_updated` events
- `sub_agent_peak_context?: number` — present on `iteration_complete` events

**Frontend `IterationGroup` type** (`iteration-groups.ts`) — Add:

- `subAgentPeakContext: number` — populated from `iteration_complete`'s `sub_agent_peak_context`, or tracked live from `sub_agent_context_updated` events
- `subAgentCount: number` — count of distinct `parent_tool_use_id` values seen

### 3. Frontend Display

**Iteration header** — After the existing context tokens display, append the sub-agent peak when present:

```
· 142k ctx · sub-agents peak: 45k/200k
```

Styled in `text-muted-foreground` to keep it secondary. Uses the same `formatTokenCount` helper. The context window for sub-agents comes from the sub-agent's model usage if available, otherwise falls back to the iteration's `contextWindow`.

**Context bar** — No change. The bar always reflects the main agent's `inputTokens / contextWindow`. Sub-agent activity doesn't affect it.

**Live iteration** — `context_updated` events from the main agent update the bar as before. `sub_agent_context_updated` events update `subAgentPeakContext` but don't touch the main context bar. The header shows the live sub-agent peak as it grows.

**Agent tool_use events** (expanded detail panel) — Add the sub-agent's peak context below the existing metadata fields:

```
context: 45k / 200k
```

Gives per-agent breakdown when expanding individual Agent tool calls. The value comes from matching the tool_use's `id` against the `parent_tool_use_id` from `sub_agent_context_updated` events.

**No changes** to `RunDetail.tsx` or `OneShotDetail.tsx` peak context calculations — `maxContextPercent()` is based on main agent `inputTokens`, which will now correctly exclude sub-agent tokens.

## Implementation Plan

### Task 1: Add `parent_tool_use_id` to stream event structs

Add the field to `AssistantEvent` and `UserEvent` so the Rust parser captures it from the stream-json output. Add a test that parses a sub-agent assistant event.

**Files to modify:**
- `src-tauri/src/output.rs`

**Pattern reference:** `src-tauri/src/output.rs:51-55` (existing `AssistantEvent` struct)

**Details:**
- Add `pub parent_tool_use_id: Option<String>` to both `AssistantEvent` and `UserEvent`
- Serde deserializes JSON `null` as `None` and a string as `Some(id)` automatically
- Add a test `parse_assistant_with_parent_tool_use_id` that parses a sub-agent event with a non-null `parent_tool_use_id`
- Add a test confirming main-agent events parse with `parent_tool_use_id: None`

**Checklist:**
- [x] Add `parent_tool_use_id` field to `AssistantEvent`
- [x] Add `parent_tool_use_id` field to `UserEvent`
- [x] Add test for sub-agent assistant event parsing
- [x] Add test for main-agent event parsing (field is None)
- [x] `cd src-tauri && cargo test`

---

### Task 2: Add `SubAgentContextUpdated` session event variant

Add the new event variant to the `SessionEvent` enum so it can be emitted and serialized to the frontend.

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `src-tauri/src/session.rs:200-205` (existing `ContextUpdated`, `Compacted`, `RateLimited` variants)

**Details:**
- Add `SubAgentContextUpdated { iteration: u32, parent_tool_use_id: String, context_tokens: u64 }` variant after `ContextUpdated`
- Add the `kind_str()` match arm returning `"sub_agent_context_updated"`
- Add serialization test matching the pattern of `context_updated_event_serializes_correctly`

**Checklist:**
- [x] Add `SubAgentContextUpdated` variant to `SessionEvent` enum
- [x] Add `kind_str()` match arm
- [x] Add serialization test
- [x] `cd src-tauri && cargo test`

---

### Task 3: Filter sub-agent events in `session.rs` event processing

Update the assistant event processing loop to check `parent_tool_use_id`, skip main-agent context updates for sub-agent events, and emit `SubAgentContextUpdated` instead. Track per-sub-agent peak context in a HashMap.

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `src-tauri/src/session.rs:985-993` (existing `ContextUpdated` emission logic)

**Details:**
- Add `let mut sub_agent_peaks: HashMap<String, u64> = HashMap::new();` alongside `last_context_tokens` at the iteration scope
- In the `StreamEvent::Assistant` handler, check `assistant.parent_tool_use_id`:
  - `None` → existing behavior (update `last_context_tokens`, emit `ContextUpdated`)
  - `Some(id)` → compute context tokens, update `sub_agent_peaks` entry (max of current and new), emit `SubAgentContextUpdated`
- Also gate `ToolUse`, `AssistantText` emissions on `parent_tool_use_id.is_none()` so sub-agent intermediate events don't pollute the main event stream
- Reset `sub_agent_peaks` at iteration boundaries (already scoped if declared inside the iteration loop)
- Add integration test: feed a mix of main-agent and sub-agent assistant events, verify only main-agent `ContextUpdated` events are emitted and `SubAgentContextUpdated` events are emitted for sub-agent events

**Checklist:**
- [x] Add `sub_agent_peaks` HashMap
- [x] Gate `ContextUpdated` emission on `parent_tool_use_id.is_none()`
- [x] Emit `SubAgentContextUpdated` for sub-agent assistant events
- [x] Gate `ToolUse` and `AssistantText` on `parent_tool_use_id.is_none()`
- [x] Add integration test with mixed main/sub-agent events
- [x] `cd src-tauri && cargo test`

---

### Task 4: Mirror sub-agent filtering in `ssh_orchestrator.rs`

Apply the same changes from Task 3 to the SSH orchestrator's event processing loop.

**Files to modify:**
- `src-tauri/src/ssh_orchestrator.rs`

**Pattern reference:** `src-tauri/src/ssh_orchestrator.rs:216-245` (existing assistant event processing)

**Details:**
- Same logic as Task 3: `sub_agent_peaks` HashMap, gate on `parent_tool_use_id`, emit `SubAgentContextUpdated`
- Gate `ToolUse` and `AssistantText` emissions on `parent_tool_use_id.is_none()`
- Add test mirroring the session.rs test

**Checklist:**
- [x] Add `sub_agent_peaks` HashMap
- [x] Gate `ContextUpdated` emission on `parent_tool_use_id.is_none()`
- [x] Emit `SubAgentContextUpdated` for sub-agent events
- [x] Gate `ToolUse` and `AssistantText` on `parent_tool_use_id.is_none()`
- [x] Add integration test
- [x] `cd src-tauri && cargo test`

---

### Task 5: Add frontend types and grouping logic

Update the TypeScript types and `groupEventsByIteration` to track sub-agent context.

**Files to modify:**
- `src/types.ts`
- `src/iteration-groups.ts`

**Pattern reference:** `src/iteration-groups.ts:111-118` (existing `context_updated` and `compacted` handling)

**Details:**
- `types.ts`: Add `parent_tool_use_id?: string` and `sub_agent_peak_context?: number` to `SessionEvent`
- `iteration-groups.ts`: Add `subAgentPeakContext: number` and `subAgentCount: number` to `IterationGroup` type (default 0)
- In `groupEventsByIteration`, handle `"sub_agent_context_updated"` events:
  - Track seen `parent_tool_use_id` values in a `Set` per group for `subAgentCount`
  - Update `subAgentPeakContext` as `Math.max(current, ev.context_tokens)`
- On `"iteration_complete"`, also read `ev.result?.sub_agent_peak_context` if present
- Filter `sub_agent_context_updated` from `group.events` (like `context_updated` is filtered in the UI)

**Checklist:**
- [x] Update `SessionEvent` type in `types.ts`
- [x] Add `subAgentPeakContext` and `subAgentCount` to `IterationGroup`
- [x] Initialize new fields in both group creation sites (lines 70-83 and 96-108)
- [x] Handle `sub_agent_context_updated` in the grouping loop
- [x] Add tests in `iteration-groups.test.ts`
- [x] `npx tsc --noEmit`

---

### Task 6: Add `sub_agent_context_updated` to event-format.ts

Add emoji and label handlers for the new event type.

**Files to modify:**
- `src/event-format.ts`

**Pattern reference:** `src/event-format.ts:135-136` (existing `compacted` case)

**Details:**
- `eventEmoji`: Add `case "sub_agent_context_updated": return "\u{1F916}";` (robot face)
- `eventLabel`: Add `case "sub_agent_context_updated": return \`[${ev.iteration}] Sub-agent context: ${formatTokenCount(ev.context_tokens ?? 0)}\`;`

**Checklist:**
- [x] Add emoji case
- [x] Add label case
- [x] `npx tsc --noEmit`

---

### Task 7: Display sub-agent peak in iteration header

Show the aggregate sub-agent peak context in the iteration header, and add per-agent context to the Agent tool_use detail panel.

**Files to modify:**
- `src/components/IterationGroup.tsx`

**Pattern reference:** `src/components/IterationGroup.tsx:174-185` (existing context tokens display)

**Details:**
- After the `group.contextTokens > 0` span (line 174-185), add a conditional span for `group.subAgentPeakContext > 0`:
  - Display: `· sub-agents peak: {formatTokenCount(group.subAgentPeakContext)}/{formatTokenCount(group.contextWindow)}`
  - Style: `text-muted-foreground`
- In the Agent detail panel (line 251-272), compute per-agent context from matching `sub_agent_context_updated` events in `group.events` where `parent_tool_use_id` matches the tool_use's `tool_use_id`
  - Display: `context: {formatTokenCount(peakContext)} / {formatTokenCount(group.contextWindow)}`
  - Only show if a matching event exists
- Filter `sub_agent_context_updated` events from the rendered event list (add to the `.filter()` on line 214)

**Checklist:**
- [x] Add sub-agent peak display in iteration header
- [x] Add per-agent context in Agent tool_use detail panel
- [x] Filter `sub_agent_context_updated` from event list
- [x] Add tests in `IterationGroup.test.tsx`
- [x] `npx tsc --noEmit && npm test`

---

### Task 8: E2E smoke test

Add a Playwright test that verifies sub-agent context is displayed correctly for a completed iteration with sub-agent events.

**Files to modify:**
- `e2e/` (new or existing test file)

**Pattern reference:** `e2e/fixtures.ts` (Tauri IPC mock setup)

**Details:**
- Create a test that mocks a session with events including `sub_agent_context_updated` events
- Verify the iteration header shows "sub-agents peak: ..." text
- Verify the main context bar does NOT reflect sub-agent context values
- Verify expanding an Agent tool_use shows per-agent context

**Checklist:**
- [x] Add E2E test for sub-agent context display
- [x] `npm run test:e2e`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add `parent_tool_use_id` to stream event structs | Done |
| 2 | Add `SubAgentContextUpdated` session event variant | Done |
| 3 | Filter sub-agent events in `session.rs` | Done |
| 4 | Mirror sub-agent filtering in `ssh_orchestrator.rs` | Done |
| 5 | Add frontend types and grouping logic | Done |
| 6 | Add `sub_agent_context_updated` to event-format.ts | Done |
| 7 | Display sub-agent peak in iteration header | Done |
| 8 | E2E smoke test | Done |
