import type { SessionEvent } from "./types";

export type IterationGroup = {
  iteration: number;
  events: SessionEvent[];
  cost: number;
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  contextTokens: number;
  compacted: boolean;
  compactedPreTokens: number;
  subAgentPeakContext: number;
  subAgentCount: number;
  startTs: number | undefined;
  endTs: number | undefined;
};

export type GroupedEvents = {
  standaloneEvents: { index: "before" | "after"; event: SessionEvent }[];
  iterations: IterationGroup[];
};

const GIT_SYNC_EVENTS = new Set([
  "git_sync_started",
  "git_sync_push_succeeded",
  "git_sync_conflict",
  "git_sync_conflict_resolve_started",
  "git_sync_conflict_resolve_complete",
  "git_sync_failed",
]);

export function groupEventsByIteration(events: SessionEvent[]): GroupedEvents {
  const standaloneEvents: GroupedEvents["standaloneEvents"] = [];
  const iterations: IterationGroup[] = [];
  let currentGroup: IterationGroup | null = null;
  let subAgentIds = new Set<string>();

  for (const ev of events) {
    if (
      ev.kind === "session_started" ||
      ev.kind === "one_shot_started" ||
      ev.kind === "design_phase_started" ||
      ev.kind === "design_phase_complete" ||
      ev.kind === "implementation_phase_started" ||
      ev.kind === "implementation_phase_complete" ||
      ev.kind === "git_finalize_started" ||
      ev.kind === "git_finalize_complete"
    ) {
      standaloneEvents.push({ index: "before", event: ev });
      continue;
    }

    if (
      ev.kind === "session_complete" ||
      ev.kind === "one_shot_complete" ||
      ev.kind === "one_shot_failed"
    ) {
      // Finalize any open group before adding standalone
      if (currentGroup) {
        iterations.push(currentGroup);
        currentGroup = null;
      }
      standaloneEvents.push({ index: "after", event: ev });
      continue;
    }

    if (ev.kind === "iteration_started") {
      // Finalize previous group if open
      if (currentGroup) {
        iterations.push(currentGroup);
      }
      currentGroup = {
        iteration: ev.iteration ?? 0,
        events: [ev],
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextWindow: 0,
        contextTokens: 0,
        compacted: false,
        compactedPreTokens: 0,
        subAgentPeakContext: 0,
        subAgentCount: 0,
        startTs: ev._ts,
        endTs: undefined,
      };
      subAgentIds = new Set<string>();
      continue;
    }

    // Git sync events without an open iteration group (e.g. during finalize)
    // are shown as standalone events rather than creating a fake iteration group.
    if (!currentGroup && GIT_SYNC_EVENTS.has(ev.kind)) {
      standaloneEvents.push({ index: "before", event: ev });
      continue;
    }

    // Any other event goes into the current group.
    // If there's no current group (e.g. events missed during sleep), create one.
    if (!currentGroup) {
      currentGroup = {
        iteration: ev.iteration ?? iterations.length + 1,
        events: [],
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextWindow: 0,
        contextTokens: 0,
        compacted: false,
        compactedPreTokens: 0,
        subAgentPeakContext: 0,
        subAgentCount: 0,
        startTs: ev._ts,
        endTs: undefined,
      };
      subAgentIds = new Set<string>();
    }

    if (ev.kind === "context_updated") {
      currentGroup.contextTokens = ev.context_tokens ?? 0;
    }

    if (ev.kind === "compacted") {
      currentGroup.compacted = true;
      currentGroup.compactedPreTokens = ev.pre_tokens ?? 0;
    }

    if (ev.kind === "sub_agent_context_updated") {
      currentGroup.subAgentPeakContext = Math.max(
        currentGroup.subAgentPeakContext,
        ev.context_tokens ?? 0,
      );
      if (ev.parent_tool_use_id) {
        subAgentIds.add(ev.parent_tool_use_id);
        currentGroup.subAgentCount = subAgentIds.size;
      }
    }

    currentGroup.events.push(ev);

    if (ev.kind === "iteration_complete") {
      const result = ev.result;
      currentGroup.cost = (result?.total_cost_usd as number) ?? 0;
      const usage = result?.usage as Record<string, number> | undefined;
      currentGroup.inputTokens =
        (usage?.input_tokens ?? 0) +
        (usage?.cache_read_input_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0);
      currentGroup.outputTokens = usage?.output_tokens ?? 0;
      // context_window is inside modelUsage (per-model), take the max
      const modelUsage = result?.model_usage as
        | Record<string, Record<string, number>>
        | undefined;
      currentGroup.contextWindow = modelUsage
        ? Math.max(
            ...Object.values(modelUsage).map((m) => m?.contextWindow ?? 0),
          )
        : 0;
      const subAgentPeak = result?.sub_agent_peak_context as number | undefined;
      if (subAgentPeak !== undefined) {
        currentGroup.subAgentPeakContext = Math.max(
          currentGroup.subAgentPeakContext,
          subAgentPeak,
        );
      }
      currentGroup.endTs = ev._ts;
    }

    if (ev.kind === "iteration_failed") {
      currentGroup.endTs = ev._ts;
    }
  }

  // Finalize any remaining open group
  if (currentGroup) {
    iterations.push(currentGroup);
  }

  // Merge tool_result events onto their corresponding tool_use events
  for (const group of iterations) {
    const merged: SessionEvent[] = [];
    for (const ev of group.events) {
      if (ev.kind === "tool_result" && ev.tool_use_id) {
        // Find the matching tool_use in this group
        const toolUse = merged.find(
          (e) => e.kind === "tool_use" && e.tool_use_id === ev.tool_use_id,
        );
        if (toolUse) {
          const idx = merged.indexOf(toolUse);
          merged[idx] = { ...toolUse, tool_output: ev.tool_output };
          continue; // Remove tool_result from the list
        }
      }
      if (ev.kind === "check_fix_tool_result" && ev.tool_use_id) {
        const toolUse = merged.find(
          (e) => e.kind === "check_fix_tool_use" && e.tool_use_id === ev.tool_use_id,
        );
        if (toolUse) {
          const idx = merged.indexOf(toolUse);
          merged[idx] = { ...toolUse, tool_output: ev.tool_output };
          continue;
        }
      }
      merged.push(ev);
    }
    group.events = merged;
  }

  return { standaloneEvents, iterations };
}

export function maxContextPercent(groups: GroupedEvents): number {
  let max = 0;
  for (const iter of groups.iterations) {
    if (iter.contextWindow > 0) {
      const pct = Math.round((iter.inputTokens / iter.contextWindow) * 100);
      if (pct > max) {
        max = pct;
      }
    }
  }
  return max;
}
