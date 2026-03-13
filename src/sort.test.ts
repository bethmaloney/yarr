import { describe, it, expect } from "vitest";
import { sortTraces } from "./sort";
import type { SessionTrace } from "./types";

function makeTrace(
  overrides: Partial<SessionTrace> & { session_id: string },
): SessionTrace {
  return {
    repo_path: "/home/user/repos/project",
    prompt: "do something",
    plan_file: null,
    plan_content: null,
    start_time: "2026-03-07T10:00:00Z",
    end_time: "2026-03-07T10:05:00Z",
    outcome: "completed",
    failure_reason: null,
    total_iterations: 1,
    total_cost_usd: 0.1,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    ...overrides,
  };
}

// Four traces with varied values to make sort differences observable
const traceA = makeTrace({
  session_id: "trace-a",
  prompt: "Add authentication module",
  plan_file: "plans/auth.md",
  start_time: "2026-03-05T09:00:00Z",
  end_time: "2026-03-05T09:12:00Z",
  outcome: "completed",
  total_iterations: 2,
  total_cost_usd: 0.25,
});

const traceB = makeTrace({
  session_id: "trace-b",
  prompt: "Fix broken tests",
  plan_file: "plans/tests.md",
  start_time: "2026-03-07T14:00:00Z",
  end_time: "2026-03-07T14:30:00Z",
  outcome: "failed",
  total_iterations: 5,
  total_cost_usd: 0.89,
});

const traceC = makeTrace({
  session_id: "trace-c",
  prompt: "Refactor database layer",
  plan_file: null,
  start_time: "2026-03-06T11:00:00Z",
  end_time: null, // ongoing — no end_time
  outcome: "running",
  total_iterations: 3,
  total_cost_usd: 0.5,
});

const traceD = makeTrace({
  session_id: "trace-d",
  prompt: "Deploy pipeline setup",
  plan_file: "plans/deploy.md",
  start_time: "2026-03-08T08:00:00Z",
  end_time: "2026-03-08T08:05:00Z",
  outcome: "completed",
  total_iterations: 1,
  total_cost_usd: 0.1,
});

const allTraces = [traceA, traceB, traceC, traceD];

function ids(traces: SessionTrace[]): string[] {
  return traces.map((t) => t.session_id);
}

describe("sortTraces", () => {
  describe("edge cases", () => {
    it("returns empty array for empty input", () => {
      expect(sortTraces([], "start_time", "desc")).toEqual([]);
    });

    it("returns single-element array unchanged", () => {
      const result = sortTraces([traceA], "start_time", "desc");
      expect(result).toEqual([traceA]);
    });

    it("does not mutate the original array", () => {
      const original = [traceB, traceA];
      const copy = [...original];
      sortTraces(original, "start_time", "asc");
      expect(original).toEqual(copy);
    });
  });

  describe("sort by start_time", () => {
    it("descending — most recent first (default)", () => {
      // traceD (Mar 8) > traceB (Mar 7) > traceC (Mar 6) > traceA (Mar 5)
      const result = sortTraces(allTraces, "start_time", "desc");
      expect(ids(result)).toEqual(["trace-d", "trace-b", "trace-c", "trace-a"]);
    });

    it("ascending — oldest first", () => {
      const result = sortTraces(allTraces, "start_time", "asc");
      expect(ids(result)).toEqual(["trace-a", "trace-c", "trace-b", "trace-d"]);
    });
  });

  describe("sort by plan_file", () => {
    it("ascending — alphabetical, nulls last", () => {
      // auth.md < deploy.md < tests.md < null
      const result = sortTraces(allTraces, "plan_file", "asc");
      expect(ids(result)).toEqual(["trace-a", "trace-d", "trace-b", "trace-c"]);
    });

    it("descending — reverse alphabetical, nulls last", () => {
      // tests.md > deploy.md > auth.md > null (null always last)
      const result = sortTraces(allTraces, "plan_file", "desc");
      expect(ids(result)).toEqual(["trace-b", "trace-d", "trace-a", "trace-c"]);
    });
  });

  describe("sort by prompt", () => {
    it("ascending — alphabetical", () => {
      // "Add authentication..." < "Deploy pipeline..." < "Fix broken..." < "Refactor database..."
      const result = sortTraces(allTraces, "prompt", "asc");
      expect(ids(result)).toEqual(["trace-a", "trace-d", "trace-b", "trace-c"]);
    });

    it("descending — reverse alphabetical", () => {
      const result = sortTraces(allTraces, "prompt", "desc");
      expect(ids(result)).toEqual(["trace-c", "trace-b", "trace-d", "trace-a"]);
    });
  });

  describe("sort by outcome", () => {
    it("ascending — alphabetical", () => {
      // "completed" (a,d) < "failed" (b) < "running" (c)
      const result = sortTraces(allTraces, "outcome", "asc");
      const resultIds = ids(result);
      // completed traces first, then failed, then running
      expect(resultIds.indexOf("trace-b")).toBeLessThan(
        resultIds.indexOf("trace-c"),
      );
      expect(resultIds[2]).toBe("trace-b");
      expect(resultIds[3]).toBe("trace-c");
    });

    it("descending — reverse alphabetical", () => {
      // "running" > "failed" > "completed"
      const result = sortTraces(allTraces, "outcome", "desc");
      const resultIds = ids(result);
      expect(resultIds[0]).toBe("trace-c");
      expect(resultIds[1]).toBe("trace-b");
    });
  });

  describe("sort by total_iterations", () => {
    it("ascending", () => {
      // traceD(1) < traceA(2) < traceC(3) < traceB(5)
      const result = sortTraces(allTraces, "total_iterations", "asc");
      expect(ids(result)).toEqual(["trace-d", "trace-a", "trace-c", "trace-b"]);
    });

    it("descending", () => {
      const result = sortTraces(allTraces, "total_iterations", "desc");
      expect(ids(result)).toEqual(["trace-b", "trace-c", "trace-a", "trace-d"]);
    });
  });

  describe("sort by total_cost_usd", () => {
    it("ascending", () => {
      // traceD(0.10) < traceA(0.25) < traceC(0.50) < traceB(0.89)
      const result = sortTraces(allTraces, "total_cost_usd", "asc");
      expect(ids(result)).toEqual(["trace-d", "trace-a", "trace-c", "trace-b"]);
    });

    it("descending", () => {
      const result = sortTraces(allTraces, "total_cost_usd", "desc");
      expect(ids(result)).toEqual(["trace-b", "trace-c", "trace-a", "trace-d"]);
    });
  });

  describe("sort by duration", () => {
    // Durations: traceA = 12min, traceB = 30min, traceC = null (ongoing → last), traceD = 5min

    it("ascending — shortest first, null end_time (ongoing) sorts last", () => {
      const result = sortTraces(allTraces, "duration", "asc");
      expect(ids(result)).toEqual(["trace-d", "trace-a", "trace-b", "trace-c"]);
    });

    it("descending — longest first, null end_time (ongoing) sorts last", () => {
      const result = sortTraces(allTraces, "duration", "desc");
      expect(ids(result)).toEqual(["trace-b", "trace-a", "trace-d", "trace-c"]);
    });
  });

  describe("sort by session_type", () => {
    const traceOneshot = makeTrace({
      session_id: "trace-oneshot",
      session_type: "one_shot",
      prompt: "Quick fix",
    });

    const traceRalph = makeTrace({
      session_id: "trace-ralph",
      session_type: "ralph_loop",
      prompt: "Big refactor",
    });

    const traceUndefined = makeTrace({
      session_id: "trace-undefined",
      prompt: "No type set",
      // session_type is intentionally omitted (undefined)
    });

    it("ascending — alphabetical: oneshot before ralph_loop", () => {
      const result = sortTraces(
        [traceRalph, traceOneshot],
        "session_type",
        "asc",
      );
      expect(ids(result)).toEqual(["trace-oneshot", "trace-ralph"]);
    });

    it("descending — reverse alphabetical: ralph_loop before oneshot", () => {
      const result = sortTraces(
        [traceOneshot, traceRalph],
        "session_type",
        "desc",
      );
      expect(ids(result)).toEqual(["trace-ralph", "trace-oneshot"]);
    });

    it("undefined session_type defaults to ralph_loop", () => {
      // traceUndefined has no session_type, should sort as "ralph_loop"
      // So oneshot < ralph_loop ≈ undefined
      const result = sortTraces(
        [traceUndefined, traceOneshot, traceRalph],
        "session_type",
        "asc",
      );
      const resultIds = ids(result);
      // oneshot should come first
      expect(resultIds[0]).toBe("trace-oneshot");
      // ralph_loop and undefined should both sort after oneshot
      // and maintain stable relative order between themselves
      expect(resultIds.indexOf("trace-ralph")).toBeGreaterThan(0);
      expect(resultIds.indexOf("trace-undefined")).toBeGreaterThan(0);
    });
  });

  describe("stability", () => {
    it("traces with the same value maintain their relative order", () => {
      // traceA and traceD both have outcome "completed"
      const input = [traceA, traceD, traceB, traceC];
      const result = sortTraces(input, "outcome", "asc");
      const resultIds = ids(result);
      // Both completed — traceA should still come before traceD (same relative order as input)
      const idxA = resultIds.indexOf("trace-a");
      const idxD = resultIds.indexOf("trace-d");
      expect(idxA).toBeLessThan(idxD);
    });

    it("traces with the same numeric value maintain their relative order", () => {
      const traceE = makeTrace({
        session_id: "trace-e",
        total_iterations: 2, // same as traceA
      });
      const input = [traceA, traceE, traceB];
      const result = sortTraces(input, "total_iterations", "asc");
      const resultIds = ids(result);
      const idxA = resultIds.indexOf("trace-a");
      const idxE = resultIds.indexOf("trace-e");
      expect(idxA).toBeLessThan(idxE);
    });
  });
});
