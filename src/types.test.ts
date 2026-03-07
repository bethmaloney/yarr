import { describe, it, expect } from "vitest";
import type {
  SessionEvent,
  SessionTrace,
  SessionState,
  RepoStatus,
  TaggedSessionEvent,
} from "./types";

describe("SessionEvent", () => {
  it("accepts a minimal event with only kind", () => {
    const event: SessionEvent = { kind: "system" };
    expect(event.kind).toBe("system");
    expect(event.session_id).toBeUndefined();
    expect(event.iteration).toBeUndefined();
    expect(event.tool_name).toBeUndefined();
    expect(event.text).toBeUndefined();
    expect(event.result).toBeUndefined();
    expect(event.outcome).toBeUndefined();
    expect(event._ts).toBeUndefined();
  });

  it("accepts a fully populated event", () => {
    const event: SessionEvent = {
      kind: "tool_use",
      session_id: "sess-001",
      iteration: 3,
      tool_name: "Bash",
      text: "running npm test",
      result: { exit_code: 0, stdout: "ok" },
      outcome: "success",
      _ts: 1709827200000,
    };
    expect(event.kind).toBe("tool_use");
    expect(event.session_id).toBe("sess-001");
    expect(event.iteration).toBe(3);
    expect(event.tool_name).toBe("Bash");
    expect(event.text).toBe("running npm test");
    expect(event.result).toEqual({ exit_code: 0, stdout: "ok" });
    expect(event.outcome).toBe("success");
    expect(event._ts).toBe(1709827200000);
  });
});

describe("SessionTrace", () => {
  const fullTrace: SessionTrace = {
    session_id: "sess-001",
    repo_path: "/home/beth/repos/yarr",
    prompt: "fix the tests",
    plan_file: "/tmp/plan.md",
    repo_id: "repo-abc",
    start_time: "2026-03-07T10:00:00Z",
    end_time: "2026-03-07T10:05:00Z",
    outcome: "completed",
    failure_reason: null,
    total_iterations: 5,
    total_cost_usd: 0.42,
    total_input_tokens: 10000,
    total_output_tokens: 5000,
    total_cache_read_tokens: 2000,
    total_cache_creation_tokens: 1000,
  };

  it("accepts a trace with all fields populated", () => {
    expect(fullTrace.session_id).toBe("sess-001");
    expect(fullTrace.repo_path).toBe("/home/beth/repos/yarr");
    expect(fullTrace.prompt).toBe("fix the tests");
    expect(fullTrace.plan_file).toBe("/tmp/plan.md");
    expect(fullTrace.repo_id).toBe("repo-abc");
    expect(fullTrace.start_time).toBe("2026-03-07T10:00:00Z");
    expect(fullTrace.end_time).toBe("2026-03-07T10:05:00Z");
    expect(fullTrace.outcome).toBe("completed");
    expect(fullTrace.total_iterations).toBe(5);
    expect(fullTrace.total_cost_usd).toBe(0.42);
    expect(fullTrace.total_input_tokens).toBe(10000);
    expect(fullTrace.total_output_tokens).toBe(5000);
    expect(fullTrace.total_cache_read_tokens).toBe(2000);
    expect(fullTrace.total_cache_creation_tokens).toBe(1000);
  });

  it("accepts a trace with optional repo_id omitted", () => {
    const traceWithoutRepoId: SessionTrace = {
      session_id: "sess-002",
      repo_path: "/home/beth/repos/other",
      prompt: "add feature",
      plan_file: null,
      start_time: "2026-03-07T11:00:00Z",
      end_time: null,
      outcome: "running",
      failure_reason: null,
      total_iterations: 0,
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
    };
    expect(traceWithoutRepoId.repo_id).toBeUndefined();
    expect(traceWithoutRepoId.plan_file).toBeNull();
    expect(traceWithoutRepoId.end_time).toBeNull();
  });

  it("accepts a trace with repo_id explicitly set to null", () => {
    const traceNullRepoId: SessionTrace = {
      session_id: "sess-003",
      repo_path: "/home/beth/repos/yarr",
      prompt: "refactor types",
      plan_file: null,
      repo_id: null,
      start_time: "2026-03-07T12:00:00Z",
      end_time: null,
      outcome: "running",
      failure_reason: null,
      total_iterations: 1,
      total_cost_usd: 0.01,
      total_input_tokens: 500,
      total_output_tokens: 200,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
    };
    expect(traceNullRepoId.repo_id).toBeNull();
  });
});

describe("SessionState", () => {
  it("accepts a state with null trace and no error", () => {
    const state: SessionState = {
      running: false,
      events: [],
      trace: null,
      error: null,
    };
    expect(state.running).toBe(false);
    expect(state.events).toEqual([]);
    expect(state.trace).toBeNull();
    expect(state.error).toBeNull();
  });

  it("accepts a state with a populated trace and events", () => {
    const event: SessionEvent = {
      kind: "assistant",
      text: "I will fix the bug",
      _ts: 1709827200000,
    };
    const trace: SessionTrace = {
      session_id: "sess-001",
      repo_path: "/home/beth/repos/yarr",
      prompt: "fix the bug",
      plan_file: null,
      start_time: "2026-03-07T10:00:00Z",
      end_time: "2026-03-07T10:05:00Z",
      outcome: "completed",
      failure_reason: null,
      total_iterations: 2,
      total_cost_usd: 0.15,
      total_input_tokens: 3000,
      total_output_tokens: 1500,
      total_cache_read_tokens: 500,
      total_cache_creation_tokens: 200,
    };
    const state: SessionState = {
      running: true,
      events: [event],
      trace,
      error: null,
    };
    expect(state.running).toBe(true);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].kind).toBe("assistant");
    expect(state.trace).not.toBeNull();
    expect(state.trace!.session_id).toBe("sess-001");
  });

  it("accepts a state with an error", () => {
    const state: SessionState = {
      running: false,
      events: [],
      trace: null,
      error: "Process exited with code 1",
    };
    expect(state.error).toBe("Process exited with code 1");
  });
});

describe("RepoStatus", () => {
  it("accepts all valid status values", () => {
    const statuses: RepoStatus[] = ["idle", "running", "completed", "failed"];
    expect(statuses).toHaveLength(4);
    expect(statuses).toContain("idle");
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
  });

  it("can be used in conditional logic", () => {
    const status: RepoStatus = "running";
    const isActive = status === "running";
    expect(isActive).toBe(true);
  });
});

describe("TaggedSessionEvent", () => {
  it("wraps a SessionEvent with a repo_id", () => {
    const event: SessionEvent = {
      kind: "result",
      session_id: "sess-001",
      iteration: 5,
      outcome: "completed",
    };
    const tagged: TaggedSessionEvent = {
      repo_id: "repo-abc",
      event,
    };
    expect(tagged.repo_id).toBe("repo-abc");
    expect(tagged.event.kind).toBe("result");
    expect(tagged.event.session_id).toBe("sess-001");
    expect(tagged.event.iteration).toBe(5);
    expect(tagged.event.outcome).toBe("completed");
  });

  it("works with a minimal inner event", () => {
    const tagged: TaggedSessionEvent = {
      repo_id: "repo-xyz",
      event: { kind: "system" },
    };
    expect(tagged.repo_id).toBe("repo-xyz");
    expect(tagged.event.kind).toBe("system");
    expect(tagged.event.text).toBeUndefined();
  });
});
