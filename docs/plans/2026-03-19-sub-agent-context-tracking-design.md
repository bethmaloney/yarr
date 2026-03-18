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
