# Tool Output Display

## Summary

Show the output of Bash commands and Agent sub-agent responses inline in the event list. Currently, tool invocations are captured and displayed but tool results are discarded in the backend. This feature captures Bash and Agent results, merges them onto the corresponding tool_use event, and renders them in an expandable "Output" section below the existing "Input" section.

## Scope

- **Included tools**: Bash, Agent
- **Excluded tools**: Read, Write, Edit, Grep, Glob (outputs not useful enough to display)

## Architecture

### Backend (Rust)

**New SessionEvent variant:**
```rust
ToolResult {
    iteration: u32,
    tool_use_id: String,
    tool_name: String,
    tool_output: String,
}
```

**Tool use ID tracking:**
- When emitting `SessionEvent::ToolUse`, also store a mapping of `tool_use_id → tool_name` in a `HashMap` on `SessionRunner`
- The `id` field already exists on `ContentBlock::ToolUse` (output.rs:68) but is currently ignored

**Parsing StreamEvent::User:**
- Instead of discarding `StreamEvent::User` events (session.rs:966), parse the `message` field
- Extract `tool_result` content blocks from the message's `content` array
- Match `tool_use_id` back to the tool name via the HashMap
- Only emit `ToolResult` for Bash and Agent tools
- Extract text content from the tool result as `tool_output`

### Frontend (TypeScript/React)

**Type change** (types.ts):
- Add `tool_output?: string` to `SessionEvent`
- Add `tool_use_id?: string` to `SessionEvent`

**Event merging** (iteration-groups.ts):
- After grouping events by iteration, post-process each group's events
- When a `tool_result` event follows a `tool_use` event with the same `tool_use_id`, merge `tool_output` onto the `tool_use` event and remove the `tool_result` from the list

**Rendering** (IterationGroup.tsx):
- Below the existing tool input section, render an "Output" section when `tool_output` is present
- Same container styling as input (`bg-[#1a1a35]` with border)
- Small "Output" label in accent color
- Bash: render as monospace `<pre>` text
- Agent: render as markdown (matching existing agent prompt rendering)
- **Truncation**: If output exceeds 20 lines, show first 20 lines with a "Show more (N more lines)" button that reveals the full output in place

## Data Flow

```
Claude CLI (stream-json)
  → StreamEvent::User { message: { content: [{ tool_result, tool_use_id, content }] } }
  → SessionRunner parses, matches tool_use_id → tool_name
  → Emits SessionEvent::ToolResult (only for Bash/Agent)
  → Persisted to JSONL, sent via Tauri IPC
  → Frontend merges onto preceding ToolUse event
  → IterationGroup renders Output section below Input
```

---

## Implementation Plan

### Task 1: Add ToolResult variant and tool_use_id tracking to SessionEvent

Add the new `ToolResult` variant to the `SessionEvent` enum and update `ToolUse` to include the `id`. Track tool_use_id → tool_name mappings in SessionRunner.

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** Existing `ToolUse` variant at session.rs:132-136

**Details:**
- Add `tool_use_id: String` field to `SessionEvent::ToolUse` variant
- Add new `SessionEvent::ToolResult { iteration: u32, tool_use_id: String, tool_name: String, tool_output: String }` variant
- Add `tool_use_ids: HashMap<String, String>` field to `SessionRunner` (maps tool_use_id → tool_name)
- Initialize the HashMap in `SessionRunner::new()`
- In the `ContentBlock::ToolUse` match arm (line 911), insert into the HashMap and include `id` in the emitted event

**Checklist:**
- [ ] Add `tool_use_id` field to `ToolUse` variant
- [ ] Add `ToolResult` variant to `SessionEvent`
- [ ] Add `tool_use_ids` HashMap to `SessionRunner`
- [ ] Initialize HashMap in constructor
- [ ] Populate HashMap and emit `tool_use_id` in ToolUse arm
- [ ] Verify: `cd src-tauri && cargo check`

---

### Task 2: Parse StreamEvent::User and emit ToolResult events

Replace the discard of `StreamEvent::User` with parsing logic that extracts tool results for Bash and Agent tools.

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** The `StreamEvent::User` discard at session.rs:966-968

**Details:**
- Parse `UserEvent.message` as a JSON object with a `content` array
- Each element may have `type: "tool_result"` with `tool_use_id` and nested content
- Look up `tool_use_id` in the HashMap to get the tool name
- Only emit for "Bash" and "Agent" tool names
- Extract text content from the result (may be a string or array of content blocks)
- Emit `SessionEvent::ToolResult` with the extracted output

**Checklist:**
- [ ] Parse `UserEvent.message.content` array
- [ ] Extract `tool_use_id` and text content from tool_result blocks
- [ ] Look up tool name in HashMap, filter to Bash/Agent only
- [ ] Emit `SessionEvent::ToolResult`
- [ ] Add tracing for tool result parsing
- [ ] Verify: `cd src-tauri && cargo check`

---

### Task 3: Update frontend types and event merging

Add the new fields to the TypeScript type and implement the merge logic.

**Files to modify:**
- `src/types.ts`
- `src/iteration-groups.ts`

**Pattern reference:** `groupEventsByIteration` in iteration-groups.ts:28-136

**Details:**
- Add `tool_output?: string` and `tool_use_id?: string` to `SessionEvent` type
- In `groupEventsByIteration`, after building each iteration group's events array, run a merge pass:
  - For each `tool_result` event, find the preceding `tool_use` event with matching `tool_use_id`
  - Copy `tool_output` onto the `tool_use` event
  - Remove the `tool_result` event from the array
- Handle edge case: `tool_result` arriving before merge (live streaming) — the merge runs on every render via `useMemo`

**Checklist:**
- [ ] Add `tool_output` and `tool_use_id` fields to `SessionEvent` type
- [ ] Add merge pass in `groupEventsByIteration`
- [ ] Verify: `npx tsc --noEmit`

---

### Task 4: Render tool output in IterationGroup

Add the "Output" section below tool input for Bash and Agent events.

**Files to modify:**
- `src/components/IterationGroup.tsx`

**Pattern reference:** Existing tool input rendering at IterationGroup.tsx:123-145

**Details:**
- After the existing tool input blocks, add a conditional section for `ev.tool_output`
- Use a small "Output" label in accent color (`text-[#a78bfa]`)
- For Agent: render with `<Markdown>` component (already imported)
- For Bash: render in `<pre>` with same styling as tool input detail
- Implement truncation: split by `\n`, if > 20 lines show first 20 with a "Show more" button
- "Show more" uses local `useState` per event to toggle
- Same container styling as input section

**Checklist:**
- [ ] Add output rendering block after tool input sections
- [ ] Implement Agent markdown rendering path
- [ ] Implement Bash monospace rendering path
- [ ] Add truncation with "Show more (N more lines)" button
- [ ] Add local state for expand/collapse per event
- [ ] Verify: `npx tsc --noEmit`

---

### Task 5: Update event formatting for tool_result

Ensure the event formatter handles `tool_result` events gracefully (for any that aren't merged).

**Files to modify:**
- `src/event-format.ts`

**Pattern reference:** Existing `eventEmoji` and `eventLabel` functions in event-format.ts

**Details:**
- Add `tool_result` case to `eventEmoji()` — use a result/output emoji
- Add `tool_result` case to `eventLabel()` — show tool name
- These are fallbacks in case a `tool_result` event isn't merged (e.g., if the corresponding `tool_use` was in a different group)

**Checklist:**
- [ ] Add `tool_result` to `eventEmoji()`
- [ ] Add `tool_result` to `eventLabel()`
- [ ] Verify: `npx tsc --noEmit`

---

### Task 6: Rust unit tests for tool result parsing

Add tests for the new StreamEvent::User parsing and ToolResult emission.

**Files to modify:**
- `src-tauri/src/session.rs` (or a new test module)

**Pattern reference:** Existing tests in `src-tauri/src/output.rs`

**Details:**
- Test parsing a StreamEvent::User message with tool_result content
- Test that Bash tool results are emitted
- Test that Agent tool results are emitted
- Test that Read/Write/Edit/Grep/Glob results are NOT emitted
- Test text extraction from various content formats

**Checklist:**
- [ ] Add test for Bash tool result parsing and emission
- [ ] Add test for Agent tool result parsing and emission
- [ ] Add test for filtered-out tool types
- [ ] Verify: `cd src-tauri && cargo test`

---

### Task 7: Frontend tests for event merging

Test the merge logic in iteration-groups.ts.

**Files to modify:**
- `src/iteration-groups.test.ts` (new or existing)

**Pattern reference:** Existing test files in `src/*.test.ts`

**Details:**
- Test that `tool_result` events are merged onto preceding `tool_use` events
- Test that unmatched `tool_result` events remain in the list
- Test that non-Bash/Agent `tool_result` events (shouldn't exist, but defensive) are handled

**Checklist:**
- [ ] Add test for successful merge of tool_result onto tool_use
- [ ] Add test for unmatched tool_result remaining visible
- [ ] Verify: `npm test`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add ToolResult variant and ID tracking | Not Started |
| 2 | Parse StreamEvent::User and emit ToolResult | Not Started |
| 3 | Update frontend types and event merging | Not Started |
| 4 | Render tool output in IterationGroup | Not Started |
| 5 | Update event formatting for tool_result | Not Started |
| 6 | Rust unit tests | Not Started |
| 7 | Frontend tests for event merging | Not Started |
