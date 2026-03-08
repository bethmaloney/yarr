import type { SessionEvent } from "./types";

export type IterationGroup = {
  iteration: number;
  events: SessionEvent[];
  cost: number;
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  startTs: number | undefined;
  endTs: number | undefined;
};

export type GroupedEvents = {
  standaloneEvents: { index: "before" | "after"; event: SessionEvent }[];
  iterations: IterationGroup[];
};

export function groupEventsByIteration(events: SessionEvent[]): GroupedEvents {
  const standaloneEvents: GroupedEvents["standaloneEvents"] = [];
  const iterations: IterationGroup[] = [];
  let currentGroup: IterationGroup | null = null;

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
        startTs: ev._ts,
        endTs: undefined,
      };
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
        startTs: ev._ts,
        endTs: undefined,
      };
    }

    currentGroup.events.push(ev);

    if (ev.kind === "iteration_complete") {
      const result = ev.result;
      currentGroup.cost = (result?.total_cost_usd as number) ?? 0;
      currentGroup.inputTokens = (result?.input_tokens as number) ?? 0;
      currentGroup.outputTokens = (result?.output_tokens as number) ?? 0;
      currentGroup.contextWindow = (result?.context_window as number) ?? 0;
      currentGroup.endTs = ev._ts;
    }
  }

  // Finalize any remaining open group
  if (currentGroup) {
    iterations.push(currentGroup);
  }

  return { standaloneEvents, iterations };
}
