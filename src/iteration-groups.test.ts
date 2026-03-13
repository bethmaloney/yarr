import { describe, it, expect } from "vitest";
import { groupEventsByIteration, maxContextPercent } from "./iteration-groups";
import type { GroupedEvents, IterationGroup } from "./iteration-groups";
import type { SessionEvent } from "./types";

function makeEvent(overrides: Partial<SessionEvent>): SessionEvent {
  return { kind: "unknown", ...overrides };
}

/** Build a result object matching the Rust ResultEvent serialization shape */
function makeResult(opts: {
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextWindow?: number;
}) {
  const result: Record<string, unknown> = {};
  if (opts.cost !== undefined) result.total_cost_usd = opts.cost;
  if (
    opts.inputTokens !== undefined ||
    opts.outputTokens !== undefined ||
    opts.cacheReadTokens !== undefined ||
    opts.cacheCreationTokens !== undefined
  ) {
    result.usage = {
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
      cache_read_input_tokens: opts.cacheReadTokens ?? 0,
      cache_creation_input_tokens: opts.cacheCreationTokens ?? 0,
    };
  }
  if (opts.contextWindow !== undefined) {
    result.model_usage = {
      "claude-opus-4-6": { contextWindow: opts.contextWindow },
    };
  }
  return result;
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
          result: makeResult({
            cost: 0.42,
            inputTokens: 2000,
            cacheReadTokens: 2500,
            cacheCreationTokens: 500,
            outputTokens: 1200,
          }),
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.standaloneEvents).toEqual([]);
      expect(result.iterations).toHaveLength(1);

      const group = result.iterations[0];
      expect(group.iteration).toBe(1);
      expect(group.events).toEqual(events);
      expect(group.cost).toBe(0.42);
      expect(group.inputTokens).toBe(5000); // 2000 + 2500 + 500
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
          result: makeResult({
            cost: 0.2,
            inputTokens: 500,
            cacheReadTokens: 2500,
            outputTokens: 800,
          }),
        }),
        makeEvent({ kind: "iteration_started", iteration: 2, _ts: 2500 }),
        makeEvent({ kind: "tool_use", tool_name: "Write", _ts: 2700 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 2,
          _ts: 3500,
          result: makeResult({
            cost: 0.35,
            inputTokens: 1000,
            cacheReadTokens: 5000,
            outputTokens: 1500,
          }),
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(2);

      const g1 = result.iterations[0];
      expect(g1.iteration).toBe(1);
      expect(g1.events).toHaveLength(3);
      expect(g1.cost).toBe(0.2);
      expect(g1.inputTokens).toBe(3000); // 500 + 2500
      expect(g1.outputTokens).toBe(800);
      expect(g1.startTs).toBe(1000);
      expect(g1.endTs).toBe(2000);

      const g2 = result.iterations[1];
      expect(g2.iteration).toBe(2);
      expect(g2.events).toHaveLength(3);
      expect(g2.cost).toBe(0.35);
      expect(g2.inputTokens).toBe(6000); // 1000 + 5000
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
          result: makeResult({
            cost: 0.1,
            inputTokens: 200,
            cacheReadTokens: 800,
            outputTokens: 400,
          }),
        }),
        // Iteration 2
        makeEvent({ kind: "iteration_started", iteration: 2, _ts: 1100 }),
        makeEvent({ kind: "tool_use", tool_name: "Edit", _ts: 1200 }),
        makeEvent({
          kind: "assistant_text",
          text: "Editing file.",
          _ts: 1300,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 2,
          _ts: 2000,
          result: makeResult({
            cost: 0.25,
            inputTokens: 1000,
            cacheReadTokens: 3000,
            outputTokens: 1000,
          }),
        }),
        // Iteration 3
        makeEvent({ kind: "iteration_started", iteration: 3, _ts: 2100 }),
        makeEvent({ kind: "assistant_text", text: "Verifying.", _ts: 2200 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 3,
          _ts: 3000,
          result: makeResult({
            cost: 0.15,
            inputTokens: 500,
            cacheReadTokens: 1500,
            outputTokens: 600,
          }),
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
      expect(result.iterations[1].inputTokens).toBe(4000); // 1000 + 3000
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
          result: makeResult({
            cost: 0.1,
            inputTokens: 200,
            cacheReadTokens: 800,
            outputTokens: 300,
          }),
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

    it("defaults tokens to 0 when result has no usage", () => {
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
    it("sums all input token types (input + cache_read + cache_creation)", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: makeResult({
            cost: 1.23,
            inputTokens: 5000,
            cacheReadTokens: 40000,
            cacheCreationTokens: 5000,
            outputTokens: 12000,
          }),
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].inputTokens).toBe(50000); // 5000 + 40000 + 5000
      expect(result.iterations[0].outputTokens).toBe(12000);
      expect(result.iterations[0].cost).toBe(1.23);
    });

    it("handles usage with only input_tokens (no cache fields)", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: {
            total_cost_usd: 0.5,
            usage: { input_tokens: 8000 },
          },
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].inputTokens).toBe(8000);
      expect(result.iterations[0].outputTokens).toBe(0);
    });

    it("handles usage with only output_tokens", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: {
            total_cost_usd: 0.3,
            usage: { output_tokens: 2000 },
          },
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].inputTokens).toBe(0);
      expect(result.iterations[0].outputTokens).toBe(2000);
    });
  });

  describe("context window extraction", () => {
    it("extracts context_window from model_usage when present", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: makeResult({
            cost: 0.5,
            inputTokens: 5000,
            cacheReadTokens: 55000,
            outputTokens: 5000,
            contextWindow: 200000,
          }),
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations[0].contextWindow).toBe(200000);
    });

    it("defaults contextWindow to 0 when model_usage is not in result", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 1500,
          result: makeResult({
            cost: 0.5,
            inputTokens: 5000,
            cacheReadTokens: 55000,
            outputTokens: 5000,
          }),
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
          result: makeResult({
            cost: 0.3,
            inputTokens: 5000,
            cacheReadTokens: 35000,
            outputTokens: 3000,
            contextWindow: 200000,
          }),
        }),
        makeEvent({ kind: "iteration_started", iteration: 2, _ts: 2000 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 2,
          _ts: 3000,
          result: makeResult({
            cost: 0.6,
            inputTokens: 10000,
            cacheReadTokens: 70000,
            outputTokens: 7000,
            contextWindow: 180000,
          }),
        }),
        makeEvent({ kind: "iteration_started", iteration: 3, _ts: 3500 }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 3,
          _ts: 4500,
          result: makeResult({
            cost: 0.1,
            inputTokens: 1000,
            cacheReadTokens: 9000,
            outputTokens: 1000,
          }),
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

  describe("git_sync events during finalize", () => {
    it("treats git_sync events as standalone when no iteration group is open", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "git_finalize_started", _ts: 1000 }),
        makeEvent({
          kind: "git_sync_started",
          iteration: 4294967295,
          _ts: 1100,
        }),
        makeEvent({
          kind: "git_sync_conflict",
          iteration: 4294967295,
          _ts: 1200,
        }),
        makeEvent({
          kind: "git_sync_push_succeeded",
          iteration: 4294967295,
          _ts: 1300,
        }),
      ];

      const result = groupEventsByIteration(events);

      // All events should be standalone "before" events, not in any iteration group
      expect(result.iterations).toEqual([]);
      expect(result.standaloneEvents).toHaveLength(4);
      expect(result.standaloneEvents[0]).toEqual({
        index: "before",
        event: events[0],
      });
      expect(result.standaloneEvents[1]).toEqual({
        index: "before",
        event: events[1],
      });
      expect(result.standaloneEvents[2]).toEqual({
        index: "before",
        event: events[2],
      });
      expect(result.standaloneEvents[3]).toEqual({
        index: "before",
        event: events[3],
      });
    });

    it("keeps git_sync events in iteration group when one is open", () => {
      const events: SessionEvent[] = [
        makeEvent({
          kind: "iteration_started",
          iteration: 1,
          _ts: 1000,
        }),
        makeEvent({
          kind: "git_sync_started",
          iteration: 1,
          _ts: 1100,
        }),
        makeEvent({
          kind: "git_sync_push_succeeded",
          iteration: 1,
          _ts: 1200,
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.standaloneEvents).toEqual([]);
      expect(result.iterations).toHaveLength(1);
      expect(result.iterations[0].iteration).toBe(1);
      expect(result.iterations[0].events).toHaveLength(3);
      expect(result.iterations[0].events[0].kind).toBe("iteration_started");
      expect(result.iterations[0].events[1].kind).toBe("git_sync_started");
      expect(result.iterations[0].events[2].kind).toBe(
        "git_sync_push_succeeded",
      );
    });
  });

  describe("tool_result merging", () => {
    it("merges tool_result onto matching tool_use by tool_use_id", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_use_id: "tu_123",
          tool_input: { command: "echo hi" },
          _ts: 1500,
        }),
        makeEvent({
          kind: "tool_result",
          tool_use_id: "tu_123",
          tool_output: "some output",
          _ts: 2000,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 3000,
          result: makeResult({ cost: 0.1, inputTokens: 100, outputTokens: 50 }),
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(1);
      const group = result.iterations[0];

      // The tool_result event should be removed from the group's events
      const toolResultEvents = group.events.filter(
        (e) => e.kind === "tool_result",
      );
      expect(toolResultEvents).toHaveLength(0);

      // The tool_use event should have tool_output merged onto it
      const toolUseEvent = group.events.find((e) => e.kind === "tool_use");
      expect(toolUseEvent).toBeDefined();
      expect(toolUseEvent!.tool_output).toBe("some output");
    });

    it("keeps unmatched tool_result in events array", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "tool_result",
          tool_use_id: "tu_no_match",
          tool_output: "orphaned output",
          _ts: 1500,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 2000,
          result: makeResult({ cost: 0.05, inputTokens: 50, outputTokens: 25 }),
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(1);
      const group = result.iterations[0];

      // The unmatched tool_result should remain in the events
      const toolResultEvents = group.events.filter(
        (e) => e.kind === "tool_result",
      );
      expect(toolResultEvents).toHaveLength(1);
      expect(toolResultEvents[0].tool_output).toBe("orphaned output");
    });

    it("merges multiple tool_use/tool_result pairs correctly", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_use_id: "tu_aaa",
          tool_input: { command: "ls" },
          _ts: 1100,
        }),
        makeEvent({
          kind: "tool_use",
          tool_name: "Read",
          tool_use_id: "tu_bbb",
          tool_input: { file_path: "/foo" },
          _ts: 1200,
        }),
        makeEvent({
          kind: "tool_result",
          tool_use_id: "tu_aaa",
          tool_output: "file1.ts\nfile2.ts",
          _ts: 1300,
        }),
        makeEvent({
          kind: "tool_result",
          tool_use_id: "tu_bbb",
          tool_output: "contents of foo",
          _ts: 1400,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 2000,
          result: makeResult({ cost: 0.2, inputTokens: 200, outputTokens: 100 }),
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(1);
      const group = result.iterations[0];

      // Both tool_result events should be removed
      const toolResultEvents = group.events.filter(
        (e) => e.kind === "tool_result",
      );
      expect(toolResultEvents).toHaveLength(0);

      // Both tool_use events should have their outputs merged
      const toolUseEvents = group.events.filter((e) => e.kind === "tool_use");
      expect(toolUseEvents).toHaveLength(2);

      const bashEvent = toolUseEvents.find((e) => e.tool_name === "Bash");
      expect(bashEvent!.tool_output).toBe("file1.ts\nfile2.ts");

      const readEvent = toolUseEvents.find((e) => e.tool_name === "Read");
      expect(readEvent!.tool_output).toBe("contents of foo");
    });

    it("keeps tool_result without tool_use_id in events", () => {
      const events: SessionEvent[] = [
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "tool_use",
          iteration: 1,
          tool_name: "Bash",
          tool_use_id: "tu_1",
          tool_input: { command: "echo hi" },
          _ts: 1100,
        }),
        makeEvent({
          kind: "tool_result",
          iteration: 1,
          tool_name: "Bash",
          tool_output: "hi",
          _ts: 1200,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 2000,
          result: {},
        }),
      ];

      const result = groupEventsByIteration(events);
      const group = result.iterations[0];
      // The tool_result has no tool_use_id, so it should NOT be merged
      const toolResults = group.events.filter((e) => e.kind === "tool_result");
      expect(toolResults).toHaveLength(1);
      // The tool_use should NOT have tool_output merged
      const toolUse = group.events.find((e) => e.kind === "tool_use");
      expect(toolUse?.tool_output).toBeUndefined();
    });

    it("does not merge tool_result across different iteration groups", () => {
      const events: SessionEvent[] = [
        // Iteration 1: has a tool_use
        makeEvent({ kind: "iteration_started", iteration: 1, _ts: 1000 }),
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_use_id: "tu_cross",
          tool_input: { command: "echo hi" },
          _ts: 1500,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          _ts: 2000,
          result: makeResult({ cost: 0.1, inputTokens: 100, outputTokens: 50 }),
        }),
        // Iteration 2: has a tool_result with the same tool_use_id
        makeEvent({ kind: "iteration_started", iteration: 2, _ts: 2500 }),
        makeEvent({
          kind: "tool_result",
          tool_use_id: "tu_cross",
          tool_output: "late output",
          _ts: 3000,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 2,
          _ts: 3500,
          result: makeResult({ cost: 0.05, inputTokens: 50, outputTokens: 25 }),
        }),
      ];

      const result = groupEventsByIteration(events);

      expect(result.iterations).toHaveLength(2);

      // Iteration 1: tool_use should NOT have tool_output merged
      const group1ToolUse = result.iterations[0].events.find(
        (e) => e.kind === "tool_use",
      );
      expect(group1ToolUse).toBeDefined();
      expect(group1ToolUse!.tool_output).toBeUndefined();

      // Iteration 2: tool_result should remain (unmatched within its group)
      const group2ToolResult = result.iterations[1].events.filter(
        (e) => e.kind === "tool_result",
      );
      expect(group2ToolResult).toHaveLength(1);
      expect(group2ToolResult[0].tool_output).toBe("late output");
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
          result: makeResult({
            cost: 0.1,
            inputTokens: 200,
            cacheReadTokens: 800,
            outputTokens: 300,
          }),
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

function makeIteration(
  overrides: Partial<IterationGroup>,
): IterationGroup {
  return {
    iteration: 1,
    events: [],
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    contextWindow: 0,
    startTs: undefined,
    endTs: undefined,
    ...overrides,
  };
}

function makeGroupedEvents(
  iterations: IterationGroup[],
): GroupedEvents {
  return { standaloneEvents: [], iterations };
}

describe("maxContextPercent", () => {
  it("returns 0 for empty iterations array", () => {
    const groups = makeGroupedEvents([]);
    expect(maxContextPercent(groups)).toBe(0);
  });

  it("returns correct max when one iteration has higher usage than others", () => {
    const groups = makeGroupedEvents([
      makeIteration({
        iteration: 1,
        inputTokens: 50000,
        contextWindow: 200000,
      }), // Math.round((50000/200000)*100) = 25
      makeIteration({
        iteration: 2,
        inputTokens: 160000,
        contextWindow: 200000,
      }), // Math.round((160000/200000)*100) = 80
      makeIteration({
        iteration: 3,
        inputTokens: 90000,
        contextWindow: 200000,
      }), // Math.round((90000/200000)*100) = 45
    ]);

    expect(maxContextPercent(groups)).toBe(80);
  });

  it("returns 0 when no iterations have contextWindow > 0", () => {
    const groups = makeGroupedEvents([
      makeIteration({
        iteration: 1,
        inputTokens: 5000,
        contextWindow: 0,
      }),
      makeIteration({
        iteration: 2,
        inputTokens: 10000,
        contextWindow: 0,
      }),
    ]);

    expect(maxContextPercent(groups)).toBe(0);
  });

  it("handles single iteration correctly", () => {
    const groups = makeGroupedEvents([
      makeIteration({
        iteration: 1,
        inputTokens: 120000,
        contextWindow: 200000,
      }), // Math.round((120000/200000)*100) = 60
    ]);

    expect(maxContextPercent(groups)).toBe(60);
  });

  it("skips iterations where contextWindow is 0 (doesn't divide by zero)", () => {
    const groups = makeGroupedEvents([
      makeIteration({
        iteration: 1,
        inputTokens: 50000,
        contextWindow: 0,
      }), // should be skipped
      makeIteration({
        iteration: 2,
        inputTokens: 70000,
        contextWindow: 200000,
      }), // Math.round((70000/200000)*100) = 35
      makeIteration({
        iteration: 3,
        inputTokens: 99999,
        contextWindow: 0,
      }), // should be skipped
    ]);

    expect(maxContextPercent(groups)).toBe(35);
  });
});
