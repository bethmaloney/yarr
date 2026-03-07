import type { SessionEvent } from './types';

export type IterationGroup = {
  iteration: number;
  events: SessionEvent[];
  cost: number;
  inputTokens: number;
  outputTokens: number;
  startTs: number | undefined;
  endTs: number | undefined;
};

export type GroupedEvents = {
  standaloneEvents: { index: 'before' | 'after'; event: SessionEvent }[];
  iterations: IterationGroup[];
};

export function groupEventsByIteration(events: SessionEvent[]): GroupedEvents {
  const standaloneEvents: GroupedEvents['standaloneEvents'] = [];
  const iterations: IterationGroup[] = [];
  let currentGroup: IterationGroup | null = null;

  for (const ev of events) {
    if (ev.kind === 'session_started') {
      standaloneEvents.push({ index: 'before', event: ev });
      continue;
    }

    if (ev.kind === 'session_complete') {
      // Finalize any open group before adding standalone
      if (currentGroup) {
        iterations.push(currentGroup);
        currentGroup = null;
      }
      standaloneEvents.push({ index: 'after', event: ev });
      continue;
    }

    if (ev.kind === 'iteration_started') {
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
        startTs: ev._ts,
        endTs: undefined,
      };
      continue;
    }

    // Any other event goes into the current group
    if (currentGroup) {
      currentGroup.events.push(ev);

      if (ev.kind === 'iteration_complete') {
        const result = ev.result;
        currentGroup.cost = (result?.total_cost_usd as number) ?? 0;
        currentGroup.inputTokens = (result?.input_tokens as number) ?? 0;
        currentGroup.outputTokens = (result?.output_tokens as number) ?? 0;
        currentGroup.endTs = ev._ts;
      }
    }
  }

  // Finalize any remaining open group
  if (currentGroup) {
    iterations.push(currentGroup);
  }

  return { standaloneEvents, iterations };
}
