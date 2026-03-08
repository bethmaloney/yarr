import { describe, it, expect } from "vitest";
import { groupEventsByIteration } from "./iteration-groups";
import type { SessionEvent } from "./types";

function makeEvent(overrides: Partial<SessionEvent>): SessionEvent {
  return { kind: "unknown", ...overrides };
}

describe("groupEventsByIteration", () => {
  describe("edge cases", () => {
    it("returns empty standaloneEvents and iterations for empty array", () => {
      const result = groupEventsByIteration([]);
      expect(result.standaloneEvents).toEqual([]);
      expect(result.iterations).toEqual([]);
    });
  });

  describe("standalone events", () => {
    it('session_started is a standalone "before" event', () => {
      const event = makeEvent({
        kind: "session_started",
        session_id: "sess-1",
        _ts: 1000,
      });
      const result = groupEventsByIteration([event]);

      expect(result.standaloneEvents).toEqual([{ index: "before", event }]);
      expect(result.iterations).toEqual([]);
    });

    it('session_complete is a standalone "after" event', () => {
      const event = makeEvent({
        kind: "session_complete",
        session_id: "sess-1",
        _ts: 9000,
      });
      const result = groupEventsByIteration([event]);

      expect(result.standaloneEvents).toEqual([{ index: "after", event }]);
      expect(result.iterations).toEqual([]);
    });
  });

  describe("single iteration", () => {
    it("groups all event types into one IterationGroup with correct stats", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "tool_use",
          tool_name: "Read",
          tool_input: { path: "/foo" },
          _ts: 1500,
        }),
        makeEvent({
          kind: "assistant_text",
          text: "I will read the file.",
          _ts: 2000,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 3000,
          result: {
            total_cost_usd: 0.42,
            input_tokens: 5000,
            output_tokens: 1200,
          },
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.standaloneEvents).toEqual([]);
      expect(result.iterations).toHaveLength(1);

      const group = result.iterations[0];
      expect(group.iteration).toBe(1);
      expect(group.events).toEqual(events);
      expect(group.cost).toBe(0.42);
      expect(group.inputTokens).toBe(5000);
      expect(group.outputTokens).toBe(1200);
      expect(group.startTs).toBe(1000);
      expect(group.endTs).toBe(3000);
    });
  });

  describe("multiple iterations", () => {
    it("creates separate groups with correct stats per iteration", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "assistant_text",
          text: "Working on task 1.",
          _ts: 1100,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 2000,
          result: {
            total_cost_usd: 0.2,
            input_tokens: 3000,
            output_tokens: 800,
          },
        }),
        makeEvent({ kind: "iteration_started", iteration: 2, _ts: 2500 }),
        makeEvent({ kind: "tool_use", tool_name: "Write", _ts: 2700 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 2,
          _ts: 3500,
          result: {
            total_cost_usd: 0.35,
            input_tokens: 6000,
            output_tokens: 1500,
          },
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(2);

      const g1 = result.iterations[0];
      expect(g1.iteration).toBe(1);
      expect(g1.events).toHaveLength(3);
      expect(g1.cost).toBe(0.2);
      expect(g1.inputTokens).toBe(3000);
      expect(g1.outputTokens).toBe(800);
      expect(g1.startTs).toBe(1000);
      expect(g1.endTs).toBe(2000);

      const g2 = result.iterations[1];
      expect(g2.iteration).toBe(2);
      expect(g2.events).toHaveLength(3);
      expect(g2.cost).toBe(0.35);
      expect(g2.inputTokens).toBe(6000);
      expect(g2.outputTokens).toBe(1500);
      expect(g2.startTs).toBe(2500);
      expect(g2.endTs).toBe(3500);
    });
  });

  describe("full session", () => {
    it("session_started + 3 iterations + session_complete", () => {
      const sessionStarted = makeEvent({
        kind: "session_started",
        session_id: "sess-1",
        _ts: 100,
      });
      const sessionComplete = makeEvent({
        kind: "session_complete",
        session_id: "sess-1",
        _ts: 9000,
        outcome: "completed",
      });

      const events: SessionEvent[] = [
        sessionStarted,
        // Iteration 1
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 200 }),
        makeEvent({ kind: "assistant_text", text: "Planning.", _ts: 300 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1000,
          result: {
            total_cost_usd: 0.1,
            input_tokens: 1000,
            output_tokens: 400,
          },
        }),
        // Iteration 2
        makeEvent({ kind: "iteration_started", iteration: 2, _ts: 1100 }),
        makeEvent({ kind: "tool_use", tool_name: "Edit", _ts: 1200 }),
        makeEvent({ kind: "assistant_text", text: "Editing file.", _ts: 1300 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 2,
          _ts: 2000,
          result: {
            total_cost_usd: 0.25,
            input_tokens: 4000,
            output_tokens: 1000,
          },
        }),
        // Iteration 3
        makeEvent({ kind: "iteration_started", iteration: 3, _ts: 2100 }),
        makeEvent({ kind: "assistant_text", text: "Verifying.", _ts: 2200 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 3,
          _ts: 3000,
          result: {
            total_cost_usd: 0.15,
            input_tokens: 2000,
            output_tokens: 600,
          },
        }),
        sessionComplete,
      ];

      const result = groupEventsByIteration(events);

      // Standalone events
      expect(result.standaloneEvents).toHaveLength(2);
      expect(result.standaloneEvents[0]).toEqual({
        index: "before",
        event: sessionStarted,
      });
      expect(result.standaloneEvents[1]).toEqual({
        index: "after",
        event: sessionComplete,
      });

      // Iteration groups
      expect(result.iterations).toHaveLength(3);

      expect(result.iterations[0].iteration).toBe(1);
      expect(result.iterations[0].events).toHaveLength(3);
      expect(result.iterations[0].cost).toBe(0.1);
      expect(result.iterations[0].startTs).toBe(200);
      expect(result.iterations[0].endTs).toBe(1000);

      expect(result.iterations[1].iteration).toBe(2);
      expect(result.iterations[1].events).toHaveLength(4);
      expect(result.iterations[1].cost).toBe(0.25);
      expect(result.iterations[1].inputTokens).toBe(4000);
      expect(result.iterations[1].outputTokens).toBe(1000);
      expect(result.iterations[1].startTs).toBe(1100);
      expect(result.iterations[1].endTs).toBe(2000);

      expect(result.iterations[2].iteration).toBe(3);
      expect(result.iterations[2].events).toHaveLength(3);
      expect(result.iterations[2].cost).toBe(0.15);
      expect(result.iterations[2].startTs).toBe(2100);
      expect(result.iterations[2].endTs).toBe(3000);
    });
  });

  describe("in-progress iteration (missing iteration_complete)", () => {
    it("creates group with default cost/tokens and undefined endTs", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "assistant_text",
          text: "Still working...",
          _ts: 1500,
        }),
        makeEvent({ kind: "tool_use", tool_name: "Bash", _ts: 2000 }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(1);

      const group = result.iterations[0];
      expect(group.iteration).toBe(1);
      expect(group.events).toHaveLength(3);
      expect(group.cost).toBe(0);
      expect(group.inputTokens).toBe(0);
      expect(group.outputTokens).toBe(0);
      expect(group.startTs).toBe(1000);
      expect(group.endTs).toBeUndefined();
    });

    it("handles multiple iterations where only the last is in-progress", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 2000,
          result: {
            total_cost_usd: 0.1,
            input_tokens: 1000,
            output_tokens: 300,
          },
        }),
        makeEvent({ kind: "iteration_started", iteration: 2, _ts: 2500 }),
        makeEvent({
          kind: "assistant_text",
          text: "In progress...",
          _ts: 3000,
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(2);

      // First iteration: complete
      expect(result.iterations[0].cost).toBe(0.1);
      expect(result.iterations[0].endTs).toBe(2000);

      // Second iteration: in-progress
      expect(result.iterations[1].iteration).toBe(2);
      expect(result.iterations[1].cost).toBe(0);
      expect(result.iterations[1].inputTokens).toBe(0);
      expect(result.iterations[1].outputTokens).toBe(0);
      expect(result.iterations[1].endTs).toBeUndefined();
    });
  });

  describe("iteration_complete with missing result fields", () => {
    it("defaults cost to 0 when result has no total_cost_usd", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 2000,
          result: {},
        }),
      ];

      const result = groupEventsByIteration(events);
      expect(result.iterations[0].cost).toBe(0);
    });

    it("defaults tokens to 0 when result has no input_tokens or output_tokens", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 2000,
          result: { total_cost_usd: 0.05 },
        }),
      ];

      const result = groupEventsByIteration(events);
      expect(result.iterations[0].cost).toBe(0.05);
      expect(result.iterations[0].inputTokens).toBe(0);
      expect(result.iterations[0].outputTokens).toBe(0);
    });

    it("defaults all stats to 0 when result is undefined on iteration_complete", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({ kind: "iteration_complete", iteration: 1, _ts: 2000 }),
      ];

      const result = groupEventsByIteration(events);
      expect(result.iterations[0].cost).toBe(0);
      expect(result.iterations[0].inputTokens).toBe(0);
      expect(result.iterations[0].outputTokens).toBe(0);
      expect(result.iterations[0].endTs).toBe(2000);
    });
  });

  describe("token data extraction", () => {
    it("correctly extracts input_tokens and output_tokens from result", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: {
            total_cost_usd: 1.23,
            input_tokens: 50000,
            output_tokens: 12000,
          },
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].inputTokens).toBe(50000);
      expect(result.iterations[0].outputTokens).toBe(12000);
      expect(result.iterations[0].cost).toBe(1.23);
    });

    it("handles partial token data — only input_tokens present", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: { total_cost_usd: 0.5, input_tokens: 8000 },
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].inputTokens).toBe(8000);
      expect(result.iterations[0].outputTokens).toBe(0);
    });

    it("handles partial token data — only output_tokens present", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: { total_cost_usd: 0.3, output_tokens: 2000 },
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].inputTokens).toBe(0);
      expect(result.iterations[0].outputTokens).toBe(2000);
    });
  });

  describe("context window extraction", () => {
    it("extracts context_window from result when present", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: {
            total_cost_usd: 0.5,
            input_tokens: 60000,
            output_tokens: 5000,
            context_window: 200000,
          },
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].contextWindow).toBe(200000);
    });

    it("defaults contextWindow to 0 when context_window is not in result", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: {
            total_cost_usd: 0.5,
            input_tokens: 60000,
            output_tokens: 5000,
          },
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].contextWindow).toBe(0);
    });

    it("defaults contextWindow to 0 when result is undefined", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({ kind: "iteration_complete", iteration: 1, _ts: 1500 }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].contextWindow).toBe(0);
    });

    it("works correctly across multiple iterations with different context_window values", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: {
            total_cost_usd: 0.3,
            input_tokens: 40000,
            output_tokens: 3000,
            context_window: 200000,
          },
        }),
        makeEvent({ kind: "iteration_started", iteration: 2, _ts: 2000 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 2,
          _ts: 3000,
          result: {
            total_cost_usd: 0.6,
            input_tokens: 80000,
            output_tokens: 7000,
            context_window: 180000,
          },
        }),
        makeEvent({ kind: "iteration_started", iteration: 3, _ts: 3500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 3,
          _ts: 4500,
          result: {
            total_cost_usd: 0.1,
            input_tokens: 10000,
            output_tokens: 1000,
          },
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(3);
      expect(result.iterations[0].contextWindow).toBe(200000);
      expect(result.iterations[1].contextWindow).toBe(180000);
      expect(result.iterations[2].contextWindow).toBe(0); // not present in result
    });

    it("defaults contextWindow to 0 for in-progress iteration (no iteration_complete)", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({ kind: "assistant_text", text: "Working...", _ts: 800 }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].contextWindow).toBe(0);
    });
  });

  describe("orphaned events (e.g. after sleep/wake)", () => {
    it("creates an implicit group for events without a preceding iteration_started", () => {
      const events: SessionEvent[] = [
        makeEvent({
          kind: "tool_use",
          iteration: 3,
          tool_name: "Read",
          _ts: 5000,
        }),
        makeEvent({
          kind: "assistant_text",
          iteration: 3,
          text: "Reading file...",
          _ts: 5500,
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.standaloneEvents).toEqual([]);
      expect(result.iterations).toHaveLength(1);
      expect(result.iterations[0].iteration).toBe(3);
      expect(result.iterations[0].events).toHaveLength(2);
      expect(result.iterations[0].startTs).toBe(5000);
    });

    it("handles orphaned events followed by a normal iteration", () => {
      const events: SessionEvent[] = [
        makeEvent({
          kind: "assistant_text",
          iteration: 2,
          text: "Orphaned text",
          _ts: 4000,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 2,
          _ts: 4500,
          result: { total_cost_usd: 0.1, input_tokens: 1000, output_tokens: 300 },
        }),
        makeEvent({ kind: "iteration_started", iteration: 3, _ts: 5000 }),
        makeEvent({
          kind: "assistant_text",
          iteration: 3,
          text: "Normal text",
          _ts: 5500,
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(2);
      expect(result.iterations[0].iteration).toBe(2);
      expect(result.iterations[0].cost).toBe(0.1);
      expect(result.iterations[1].iteration).toBe(3);
      expect(result.iterations[1].events).toHaveLength(2);
    });

    it("uses fallback iteration number when event has no iteration field", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "tool_use", tool_name: "Bash", _ts: 1000 }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(1);
      expect(result.iterations[0].iteration).toBe(1);
      expect(result.iterations[0].events).toHaveLength(1);
    });
  });
});
