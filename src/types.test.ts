import { describe, it, expect } from "vitest";
import type {
  Check,
  SessionEvent,
  SessionTrace,
  SessionState,
  RepoStatus,
  TaggedSessionEvent,
  GitSyncConfig,
  RepoGitStatus,
  OneShotEntry,
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
    plan_content: null,
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
      plan_content: null,
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
      plan_content: null,
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

  it("accepts a trace with context_window and final_context_tokens set", () => {
    const traceWithContext: SessionTrace = {
      session_id: "sess-004",
      repo_path: "/home/beth/repos/yarr",
      prompt: "add context tracking",
      plan_file: null,
      plan_content: null,
      start_time: "2026-03-07T13:00:00Z",
      end_time: "2026-03-07T13:10:00Z",
      outcome: "completed",
      failure_reason: null,
      total_iterations: 3,
      total_cost_usd: 0.25,
      total_input_tokens: 8000,
      total_output_tokens: 4000,
      total_cache_read_tokens: 1000,
      total_cache_creation_tokens: 500,
      context_window: 200000,
      final_context_tokens: 150000,
    };
    expect(traceWithContext.context_window).toBe(200000);
    expect(traceWithContext.final_context_tokens).toBe(150000);
  });

  it("is backwards compatible without context_window and final_context_tokens", () => {
    const traceWithoutContext: SessionTrace = {
      session_id: "sess-005",
      repo_path: "/home/beth/repos/other",
      prompt: "fix bug",
      plan_file: null,
      plan_content: null,
      start_time: "2026-03-07T14:00:00Z",
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
    expect(traceWithoutContext.context_window).toBeUndefined();
    expect(traceWithoutContext.final_context_tokens).toBeUndefined();
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
      plan_content: null,
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

  it("accepts a disconnected state", () => {
    const state: SessionState = {
      running: false,
      events: [],
      trace: null,
      error: null,
      disconnected: true,
      reconnecting: false,
    };
    expect(state.disconnected).toBe(true);
    expect(state.reconnecting).toBe(false);
  });

  it("accepts a reconnecting state", () => {
    const state: SessionState = {
      running: true,
      events: [],
      trace: null,
      error: null,
      disconnected: false,
      reconnecting: true,
    };
    expect(state.reconnecting).toBe(true);
    expect(state.disconnected).toBe(false);
  });

  it("is backwards compatible without disconnected and reconnecting fields", () => {
    const state: SessionState = {
      running: false,
      events: [],
      trace: null,
      error: null,
    };
    expect(state.disconnected).toBeUndefined();
    expect(state.reconnecting).toBeUndefined();
  });
});

describe("RepoStatus", () => {
  it("accepts all valid status values including disconnected", () => {
    const statuses: RepoStatus[] = [
      "idle",
      "running",
      "completed",
      "failed",
      "disconnected",
    ];
    expect(statuses).toHaveLength(5);
    expect(statuses).toContain("idle");
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
    expect(statuses).toContain("disconnected");
  });

  it("can be used in conditional logic", () => {
    const status: RepoStatus = "running";
    const isActive = status === "running";
    expect(isActive).toBe(true);
  });

  it("can represent a disconnected status", () => {
    const status: RepoStatus = "disconnected";
    const isDisconnected = status === "disconnected";
    expect(isDisconnected).toBe(true);
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

describe("Check", () => {
  it("accepts a Check with all required fields", () => {
    const check: Check = {
      name: "lint",
      command: "npm run lint",
      when: "each_iteration",
      timeoutSecs: 60,
      maxRetries: 3,
    };
    expect(check.name).toBe("lint");
    expect(check.command).toBe("npm run lint");
    expect(check.when).toBe("each_iteration");
    expect(check.timeoutSecs).toBe(60);
    expect(check.maxRetries).toBe(3);
  });

  it("accepts a Check with optional fields omitted", () => {
    const check: Check = {
      name: "typecheck",
      command: "npx tsc --noEmit",
      when: "post_completion",
      timeoutSecs: 120,
      maxRetries: 2,
    };
    expect(check.prompt).toBeUndefined();
    expect(check.model).toBeUndefined();
  });

  it("accepts a Check with all optional fields populated", () => {
    const check: Check = {
      name: "test",
      command: "npm test",
      when: "post_completion",
      prompt: "Fix failing tests",
      model: "sonnet",
      timeoutSecs: 300,
      maxRetries: 5,
    };
    expect(check.prompt).toBe("Fix failing tests");
    expect(check.model).toBe("sonnet");
  });

  it("accepts when value each_iteration", () => {
    const check: Check = {
      name: "format",
      command: "npx prettier --check .",
      when: "each_iteration",
      timeoutSecs: 30,
      maxRetries: 1,
    };
    expect(check.when).toBe("each_iteration");
  });

  it("accepts when value post_completion", () => {
    const check: Check = {
      name: "build",
      command: "npm run build",
      when: "post_completion",
      timeoutSecs: 180,
      maxRetries: 2,
    };
    expect(check.when).toBe("post_completion");
  });
});

describe("SessionEvent oneshot fields", () => {
  it("accepts a one_shot_started event with title and merge_strategy", () => {
    const event: SessionEvent = {
      kind: "one_shot_started",
      title: "Implement auth module",
      merge_strategy: "squash",
    };
    expect(event.kind).toBe("one_shot_started");
    expect(event.title).toBe("Implement auth module");
    expect(event.merge_strategy).toBe("squash");
  });

  it("accepts a design_phase_started event with just kind", () => {
    const event: SessionEvent = {
      kind: "design_phase_started",
    };
    expect(event.kind).toBe("design_phase_started");
  });

  it("accepts a design_phase_complete event with plan_file", () => {
    const event: SessionEvent = {
      kind: "design_phase_complete",
      plan_file: "/tmp/plan.md",
    };
    expect(event.kind).toBe("design_phase_complete");
    expect(event.plan_file).toBe("/tmp/plan.md");
  });

  it("accepts an implementation_phase_started event with just kind", () => {
    const event: SessionEvent = {
      kind: "implementation_phase_started",
    };
    expect(event.kind).toBe("implementation_phase_started");
  });

  it("accepts an implementation_phase_complete event with just kind", () => {
    const event: SessionEvent = {
      kind: "implementation_phase_complete",
    };
    expect(event.kind).toBe("implementation_phase_complete");
  });

  it("accepts a git_finalize_started event with strategy", () => {
    const event: SessionEvent = {
      kind: "git_finalize_started",
      strategy: "squash",
    };
    expect(event.kind).toBe("git_finalize_started");
    expect(event.strategy).toBe("squash");
  });

  it("accepts a git_finalize_complete event with just kind", () => {
    const event: SessionEvent = {
      kind: "git_finalize_complete",
    };
    expect(event.kind).toBe("git_finalize_complete");
  });

  it("accepts a one_shot_complete event with just kind", () => {
    const event: SessionEvent = {
      kind: "one_shot_complete",
    };
    expect(event.kind).toBe("one_shot_complete");
  });

  it("accepts a one_shot_failed event with reason", () => {
    const event: SessionEvent = {
      kind: "one_shot_failed",
      reason: "Design phase timed out",
    };
    expect(event.kind).toBe("one_shot_failed");
    expect(event.reason).toBe("Design phase timed out");
  });
});

describe("SessionEvent check fields", () => {
  it("accepts a check_started event with check_name", () => {
    const event: SessionEvent = {
      kind: "check_started",
      check_name: "lint",
    };
    expect(event.kind).toBe("check_started");
    expect(event.check_name).toBe("lint");
  });

  it("accepts a check_failed event with check_name and output", () => {
    const event: SessionEvent = {
      kind: "check_failed",
      check_name: "typecheck",
      output: "error TS2304: Cannot find name 'Foo'",
    };
    expect(event.kind).toBe("check_failed");
    expect(event.check_name).toBe("typecheck");
    expect(event.output).toBe("error TS2304: Cannot find name 'Foo'");
  });

  it("accepts a check_fix_started event with check_name and attempt", () => {
    const event: SessionEvent = {
      kind: "check_fix_started",
      check_name: "lint",
      attempt: 1,
    };
    expect(event.kind).toBe("check_fix_started");
    expect(event.check_name).toBe("lint");
    expect(event.attempt).toBe(1);
  });

  it("accepts a check_fix_complete event with check_name, attempt, and success", () => {
    const event: SessionEvent = {
      kind: "check_fix_complete",
      check_name: "test",
      attempt: 2,
      success: true,
    };
    expect(event.kind).toBe("check_fix_complete");
    expect(event.check_name).toBe("test");
    expect(event.attempt).toBe(2);
    expect(event.success).toBe(true);
  });

  it("accepts a check_fix_complete event where success is false", () => {
    const event: SessionEvent = {
      kind: "check_fix_complete",
      check_name: "build",
      attempt: 3,
      success: false,
    };
    expect(event.success).toBe(false);
  });
});

describe("GitSyncConfig", () => {
  it("can be constructed with all fields", () => {
    const config: GitSyncConfig = {
      enabled: true,
      conflictPrompt: "Resolve the merge conflicts in the files listed above",
      model: "sonnet",
      maxPushRetries: 3,
    };
    expect(config.enabled).toBe(true);
    expect(config.conflictPrompt).toBe(
      "Resolve the merge conflicts in the files listed above",
    );
    expect(config.model).toBe("sonnet");
    expect(config.maxPushRetries).toBe(3);
  });

  it("can be constructed with only required fields", () => {
    const config: GitSyncConfig = {
      enabled: false,
      maxPushRetries: 5,
    };
    expect(config.enabled).toBe(false);
    expect(config.maxPushRetries).toBe(5);
    expect(config.conflictPrompt).toBeUndefined();
    expect(config.model).toBeUndefined();
  });
});

describe("SessionEvent git sync fields", () => {
  it("accepts a git_sync_started event with just kind and iteration", () => {
    const event: SessionEvent = {
      kind: "git_sync_started",
      iteration: 2,
    };
    expect(event.kind).toBe("git_sync_started");
    expect(event.iteration).toBe(2);
    expect(event.files).toBeUndefined();
    expect(event.attempt).toBeUndefined();
    expect(event.success).toBeUndefined();
    expect(event.error).toBeUndefined();
  });

  it("accepts a git_sync_conflict event with files array", () => {
    const event: SessionEvent = {
      kind: "git_sync_conflict",
      iteration: 3,
      files: ["src/main.rs", "src/lib.rs"],
      attempt: 1,
    };
    expect(event.kind).toBe("git_sync_conflict");
    expect(event.files).toEqual(["src/main.rs", "src/lib.rs"]);
    expect(event.attempt).toBe(1);
  });

  it("accepts a git_sync_failed event with error string", () => {
    const event: SessionEvent = {
      kind: "git_sync_failed",
      iteration: 4,
      error: "push rejected after 3 retries",
      success: false,
    };
    expect(event.kind).toBe("git_sync_failed");
    expect(event.error).toBe("push rejected after 3 retries");
    expect(event.success).toBe(false);
  });

  it("accepts a git_sync_completed event with success", () => {
    const event: SessionEvent = {
      kind: "git_sync_completed",
      iteration: 5,
      success: true,
      attempt: 2,
    };
    expect(event.kind).toBe("git_sync_completed");
    expect(event.success).toBe(true);
    expect(event.attempt).toBe(2);
  });

  it("does not break existing events without git sync fields", () => {
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
    expect(event.files).toBeUndefined();
    expect(event.attempt).toBeUndefined();
    expect(event.success).toBeUndefined();
    expect(event.error).toBeUndefined();
  });
});

describe("RepoGitStatus", () => {
  it("accepts a fully populated RepoGitStatus", () => {
    const status: RepoGitStatus = {
      branchName: "main",
      dirtyCount: 3,
      ahead: 2,
      behind: 1,
    };
    expect(status.branchName).toBe("main");
    expect(status.dirtyCount).toBe(3);
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
  });

  it("accepts RepoGitStatus with ahead/behind as null (no upstream)", () => {
    const status: RepoGitStatus = {
      branchName: "feature/no-tracking",
      dirtyCount: 5,
      ahead: null,
      behind: null,
    };
    expect(status.branchName).toBe("feature/no-tracking");
    expect(status.dirtyCount).toBe(5);
    expect(status.ahead).toBeNull();
    expect(status.behind).toBeNull();
  });

  it("accepts with only ahead set and behind null", () => {
    const status: RepoGitStatus = {
      branchName: "feature/ahead-only",
      dirtyCount: 1,
      ahead: 4,
      behind: null,
    };
    expect(status.branchName).toBe("feature/ahead-only");
    expect(status.ahead).toBe(4);
    expect(status.behind).toBeNull();
  });

  it("accepts with only behind set and ahead null", () => {
    const status: RepoGitStatus = {
      branchName: "feature/behind-only",
      dirtyCount: 2,
      ahead: null,
      behind: 6,
    };
    expect(status.branchName).toBe("feature/behind-only");
    expect(status.ahead).toBeNull();
    expect(status.behind).toBe(6);
  });

  it("accepts dirtyCount of 0", () => {
    const status: RepoGitStatus = {
      branchName: "main",
      dirtyCount: 0,
      ahead: null,
      behind: null,
    };
    expect(status.dirtyCount).toBe(0);
  });
});

describe("OneShotEntry", () => {
  it("accepts an entry with all new fields populated", () => {
    const entry: OneShotEntry = {
      id: "oneshot-abc123",
      parentRepoId: "repo-001",
      parentRepoName: "yarr",
      title: "Add auth module",
      prompt: "Implement OAuth2 authentication",
      model: "opus",
      effortLevel: "high",
      designEffortLevel: "max",
      mergeStrategy: "squash",
      status: "running",
      startedAt: 1709827200000,
      session_id: "sess-100",
      worktreePath: "/home/beth/repos/yarr-worktrees/oneshot-abc123",
      branch: "oneshot/add-auth-module",
    };
    expect(entry.id).toBe("oneshot-abc123");
    expect(entry.session_id).toBe("sess-100");
    expect(entry.worktreePath).toBe(
      "/home/beth/repos/yarr-worktrees/oneshot-abc123",
    );
    expect(entry.branch).toBe("oneshot/add-auth-module");
  });

  it("is backward compatible without new optional fields", () => {
    const entry: OneShotEntry = {
      id: "oneshot-def456",
      parentRepoId: "repo-002",
      parentRepoName: "other-project",
      title: "Fix login bug",
      prompt: "The login form crashes on submit",
      model: "sonnet",
      effortLevel: "medium",
      designEffortLevel: "high",
      mergeStrategy: "merge",
      status: "completed",
      startedAt: 1709830800000,
    };
    expect(entry.id).toBe("oneshot-def456");
    expect(entry.status).toBe("completed");
    expect(entry.session_id).toBeUndefined();
    expect(entry.worktreePath).toBeUndefined();
    expect(entry.branch).toBeUndefined();
  });

  it("accepts an entry with only some new fields set", () => {
    const entry: OneShotEntry = {
      id: "oneshot-ghi789",
      parentRepoId: "repo-003",
      parentRepoName: "api-service",
      title: "Refactor database layer",
      prompt: "Extract the database queries into a repository pattern",
      model: "opus",
      effortLevel: "medium",
      designEffortLevel: "high",
      mergeStrategy: "rebase",
      status: "failed",
      startedAt: 1709834400000,
      session_id: "sess-200",
    };
    expect(entry.session_id).toBe("sess-200");
    expect(entry.worktreePath).toBeUndefined();
    expect(entry.branch).toBeUndefined();
  });

  it("accepts different effort level combinations", () => {
    const entry: OneShotEntry = {
      id: "oneshot-eff-test",
      parentRepoId: "repo-001",
      parentRepoName: "yarr",
      title: "Test effort levels",
      prompt: "Test",
      model: "opus",
      effortLevel: "low",
      designEffortLevel: "max",
      mergeStrategy: "squash",
      status: "running",
      startedAt: 1709827200000,
    };
    expect(entry.effortLevel).toBe("low");
    expect(entry.designEffortLevel).toBe("max");
  });
});
