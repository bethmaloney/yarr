import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { RepoConfig } from "./repos";
import type { SessionTrace, SessionEvent, TaggedSessionEvent } from "./types";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any vi.mock() calls
// ---------------------------------------------------------------------------

const { mockInvoke, mockListen, mockListenerCallback, mockUnlisten } =
  vi.hoisted(() => {
    return {
      mockInvoke: vi.fn(),
      mockListen: vi.fn(),
      mockListenerCallback: {
        current: null as
          | ((event: { payload: TaggedSessionEvent }) => void)
          | null,
      },
      mockUnlisten: vi.fn(),
    };
  });

const { mockLoadRepos, mockAddLocalRepo, mockAddSshRepo, mockUpdateRepo } =
  vi.hoisted(() => {
    return {
      mockLoadRepos: vi.fn(),
      mockAddLocalRepo: vi.fn(),
      mockAddSshRepo: vi.fn(),
      mockUpdateRepo: vi.fn(),
    };
  });

const { mockSaveRecent } = vi.hoisted(() => {
  return { mockSaveRecent: vi.fn() };
});

const { mockData } = vi.hoisted(() => {
  return { mockData: new Map<string, unknown>() };
});

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("@tauri-apps/plugin-store", () => {
  return {
    LazyStore: class {
      async get<T>(key: string): Promise<T | undefined> {
        return mockData.get(key) as T | undefined;
      }
      async set(key: string, value: unknown): Promise<void> {
        mockData.set(key, value);
      }
      async save(): Promise<void> {}
    },
  };
});

vi.mock("./repos", () => ({
  loadRepos: mockLoadRepos,
  addLocalRepo: mockAddLocalRepo,
  addSshRepo: mockAddSshRepo,
  updateRepo: mockUpdateRepo,
}));

vi.mock("./recents", () => ({
  saveRecent: mockSaveRecent,
}));

// ---------------------------------------------------------------------------
// Import the store under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { useAppStore } from "./store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLocalRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    type: "local",
    id: "repo-1",
    path: "/home/beth/repos/yarr",
    name: "yarr",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeSshRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    type: "ssh",
    id: "repo-2",
    sshHost: "dev-server",
    remotePath: "/home/beth/repos/other",
    name: "other",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    session_id: "sess-abc",
    repo_path: "/home/beth/repos/yarr",
    prompt: "do stuff",
    plan_file: "plan.md",
    repo_id: "repo-1",
    start_time: "2026-03-10T00:00:00Z",
    end_time: "2026-03-10T00:01:00Z",
    outcome: "completed",
    failure_reason: null,
    total_iterations: 3,
    total_cost_usd: 0.05,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    total_cache_read_tokens: 200,
    total_cache_creation_tokens: 100,
    ...overrides,
  };
}

/** Simulate a Tauri session-event by calling the captured listener. */
function emitSessionEvent(repoId: string, event: SessionEvent): void {
  if (!mockListenerCallback.current) {
    throw new Error("Listener not registered — did you call initialize()?");
  }
  mockListenerCallback.current({
    payload: { repo_id: repoId, event },
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockData.clear();
  mockListenerCallback.current = null;

  // Default: listen captures the callback and returns the unlisten fn
  mockListen.mockImplementation(
    async (
      _eventName: string,
      callback: (event: { payload: TaggedSessionEvent }) => void,
    ) => {
      mockListenerCallback.current = callback;
      return mockUnlisten;
    },
  );

  // Defaults for invoke — individual tests override as needed
  mockInvoke.mockResolvedValue(undefined);

  // Default repos empty
  mockLoadRepos.mockResolvedValue([]);
  mockAddLocalRepo.mockResolvedValue(undefined);
  mockAddSshRepo.mockResolvedValue(undefined);
  mockUpdateRepo.mockResolvedValue(undefined);
  mockSaveRecent.mockResolvedValue(undefined);

  // Reset the store state to initial values between tests
  useAppStore.setState({
    repos: [],
    sessions: new Map(),
    latestTraces: new Map(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// 1. Initial state
// ===========================================================================

describe("initial state", () => {
  it("repos starts as empty array", () => {
    const state = useAppStore.getState();
    expect(state.repos).toEqual([]);
  });

  it("sessions starts as empty Map", () => {
    const state = useAppStore.getState();
    expect(state.sessions).toBeInstanceOf(Map);
    expect(state.sessions.size).toBe(0);
  });

  it("latestTraces starts as empty Map", () => {
    const state = useAppStore.getState();
    expect(state.latestTraces).toBeInstanceOf(Map);
    expect(state.latestTraces.size).toBe(0);
  });
});

// ===========================================================================
// 2. initialize()
// ===========================================================================

describe("initialize", () => {
  it("calls listen for session-event", () => {
    useAppStore.getState().initialize();
    expect(mockListen).toHaveBeenCalledWith(
      "session-event",
      expect.any(Function),
    );
  });

  it("calls invoke to list latest traces", () => {
    useAppStore.getState().initialize();
    expect(mockInvoke).toHaveBeenCalledWith("list_latest_traces");
  });

  it("calls loadRepos", () => {
    useAppStore.getState().initialize();
    expect(mockLoadRepos).toHaveBeenCalled();
  });

  it("starts a sync interval that calls get_active_sessions", () => {
    vi.useFakeTimers();
    useAppStore.getState().initialize();

    // Should not have called get_active_sessions immediately
    const callsBefore = mockInvoke.mock.calls.filter(
      (c) => c[0] === "get_active_sessions",
    );
    expect(callsBefore).toHaveLength(0);

    // Advance by 5 seconds
    vi.advanceTimersByTime(5000);
    const callsAfter = mockInvoke.mock.calls.filter(
      (c) => c[0] === "get_active_sessions",
    );
    expect(callsAfter.length).toBeGreaterThanOrEqual(1);
  });

  it("returns a cleanup function", () => {
    const cleanup = useAppStore.getState().initialize();
    expect(typeof cleanup).toBe("function");
  });

  it("cleanup calls unlisten and clears the interval", () => {
    vi.useFakeTimers();
    const cleanup = useAppStore.getState().initialize();

    cleanup();

    // After cleanup, advancing time should not trigger more calls
    const callsBeforeAdvance = mockInvoke.mock.calls.filter(
      (c) => c[0] === "get_active_sessions",
    ).length;

    vi.advanceTimersByTime(10000);

    const callsAfterAdvance = mockInvoke.mock.calls.filter(
      (c) => c[0] === "get_active_sessions",
    ).length;

    expect(callsAfterAdvance).toBe(callsBeforeAdvance);
  });

  it("populates latestTraces from invoke result", async () => {
    const tracesMap: Record<string, SessionTrace> = {
      "repo-1": makeTrace({ repo_id: "repo-1" }),
    };
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_latest_traces") return tracesMap;
      return undefined;
    });

    useAppStore.getState().initialize();

    // Allow the async invoke to resolve
    await vi.waitFor(() => {
      const state = useAppStore.getState();
      expect(state.latestTraces.size).toBe(1);
    });

    const state = useAppStore.getState();
    expect(state.latestTraces.get("repo-1")).toEqual(tracesMap["repo-1"]);
  });

  it("populates repos via loadRepos", async () => {
    const repos = [makeLocalRepo()];
    mockLoadRepos.mockResolvedValue(repos);

    useAppStore.getState().initialize();

    await vi.waitFor(() => {
      expect(useAppStore.getState().repos).toEqual(repos);
    });
  });
});

// ===========================================================================
// 3. Session event handling
// ===========================================================================

describe("session event handling", () => {
  beforeEach(() => {
    useAppStore.getState().initialize();
  });

  it("creates a new session entry when one does not exist", () => {
    emitSessionEvent("repo-1", { kind: "iteration_start", iteration: 1 });

    const sessions = useAppStore.getState().sessions;
    expect(sessions.has("repo-1")).toBe(true);
  });

  it("appends the event to the session events array", () => {
    emitSessionEvent("repo-1", { kind: "iteration_start", iteration: 1 });
    emitSessionEvent("repo-1", { kind: "tool_use", tool_name: "Bash" });

    const session = useAppStore.getState().sessions.get("repo-1")!;
    expect(session.events).toHaveLength(2);
    expect(session.events[0].kind).toBe("iteration_start");
    expect(session.events[1].kind).toBe("tool_use");
  });

  it("handles disconnected event: sets disconnected true, reconnecting false, stores reason", () => {
    // First create a session
    emitSessionEvent("repo-1", { kind: "iteration_start", iteration: 1 });
    // Then disconnect
    emitSessionEvent("repo-1", {
      kind: "disconnected",
      reason: "connection lost",
    });

    const session = useAppStore.getState().sessions.get("repo-1")!;
    expect(session.disconnected).toBe(true);
    expect(session.reconnecting).toBe(false);
    expect(session.disconnectReason).toBe("connection lost");
  });

  it("handles reconnecting event: sets reconnecting true, disconnected false", () => {
    emitSessionEvent("repo-1", { kind: "iteration_start", iteration: 1 });
    emitSessionEvent("repo-1", {
      kind: "disconnected",
      reason: "connection lost",
    });
    emitSessionEvent("repo-1", { kind: "reconnecting" });

    const session = useAppStore.getState().sessions.get("repo-1")!;
    expect(session.reconnecting).toBe(true);
    expect(session.disconnected).toBe(false);
  });

  it("handles session_complete event: sets running false, clears disconnected/reconnecting", () => {
    emitSessionEvent("repo-1", { kind: "iteration_start", iteration: 1 });
    emitSessionEvent("repo-1", { kind: "session_complete" });

    const session = useAppStore.getState().sessions.get("repo-1")!;
    expect(session.running).toBe(false);
    expect(session.disconnected).toBeFalsy();
    expect(session.reconnecting).toBeFalsy();
  });

  it("handles other events when disconnected: clears disconnected/reconnecting state", () => {
    emitSessionEvent("repo-1", { kind: "iteration_start", iteration: 1 });
    emitSessionEvent("repo-1", {
      kind: "disconnected",
      reason: "connection lost",
    });

    // A normal event arrives — proves the connection is alive
    emitSessionEvent("repo-1", { kind: "tool_use", tool_name: "Bash" });

    const session = useAppStore.getState().sessions.get("repo-1")!;
    expect(session.disconnected).toBeFalsy();
    expect(session.reconnecting).toBeFalsy();
  });

  it("creates session entry with running true for first event", () => {
    emitSessionEvent("repo-1", { kind: "iteration_start", iteration: 1 });

    const session = useAppStore.getState().sessions.get("repo-1")!;
    expect(session.running).toBe(true);
  });

  it("handles events for multiple repos independently", () => {
    emitSessionEvent("repo-1", { kind: "iteration_start", iteration: 1 });
    emitSessionEvent("repo-2", { kind: "iteration_start", iteration: 1 });
    emitSessionEvent("repo-1", {
      kind: "disconnected",
      reason: "lost",
    });

    const sessions = useAppStore.getState().sessions;
    expect(sessions.get("repo-1")!.disconnected).toBe(true);
    expect(sessions.get("repo-2")!.disconnected).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Auto-move plan on successful session completion
  // -------------------------------------------------------------------------

  it("auto-move: invokes move_plan_to_completed on successful completion with plan_file", () => {
    useAppStore.setState({
      repos: [
        makeLocalRepo({
          plansDir: "docs/plans/",
        } as Partial<RepoConfig>),
      ],
    });

    emitSessionEvent("repo-1", {
      kind: "session_complete",
      outcome: "completed",
      plan_file: "docs/plans/my-plan.md",
    });

    expect(mockInvoke).toHaveBeenCalledWith("move_plan_to_completed", {
      repo: { type: "local", path: "/home/beth/repos/yarr" },
      plansDir: "docs/plans/",
      filename: "my-plan.md",
    });
  });

  it("auto-move: uses default plansDir when repo has no plansDir", () => {
    useAppStore.setState({
      repos: [makeLocalRepo()],
    });

    emitSessionEvent("repo-1", {
      kind: "session_complete",
      outcome: "completed",
      plan_file: "docs/plans/my-plan.md",
    });

    expect(mockInvoke).toHaveBeenCalledWith("move_plan_to_completed", {
      repo: { type: "local", path: "/home/beth/repos/yarr" },
      plansDir: "docs/plans/",
      filename: "my-plan.md",
    });
  });

  it("auto-move: NOT invoked when outcome is not completed", () => {
    useAppStore.setState({
      repos: [makeLocalRepo()],
    });

    emitSessionEvent("repo-1", {
      kind: "session_complete",
      outcome: "failed",
      plan_file: "docs/plans/my-plan.md",
    });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "move_plan_to_completed",
      expect.anything(),
    );
  });

  it("auto-move: NOT invoked when plan_file is not set", () => {
    useAppStore.setState({
      repos: [makeLocalRepo()],
    });

    emitSessionEvent("repo-1", {
      kind: "session_complete",
      outcome: "completed",
    });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "move_plan_to_completed",
      expect.anything(),
    );
  });

  it("auto-move: failure is logged but does not throw", async () => {
    useAppStore.setState({
      repos: [makeLocalRepo()],
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "move_plan_to_completed") {
        throw new Error("filesystem error");
      }
      return undefined;
    });

    // Should not throw — fire-and-forget
    expect(() => {
      emitSessionEvent("repo-1", {
        kind: "session_complete",
        outcome: "completed",
        plan_file: "docs/plans/my-plan.md",
      });
    }).not.toThrow();

    // Let the rejected promise settle
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "move_plan_to_completed",
        expect.anything(),
      );
    });
  });
});

// ===========================================================================
// 4. syncActiveSessions (called by the interval)
// ===========================================================================

describe("syncActiveSessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("marks sessions as not running when they are no longer active", async () => {
    // Set up a session that is running
    useAppStore.setState({
      sessions: new Map([
        [
          "repo-1",
          {
            running: true,
            events: [],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    // get_active_sessions returns empty list — repo-1 is no longer active
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_active_sessions") return [];
      return undefined;
    });

    useAppStore.getState().initialize();
    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      const session = useAppStore.getState().sessions.get("repo-1");
      expect(session).toBeDefined();
      expect(session!.running).toBe(false);
    });
  });

  it("creates session entry for active repo that has no session", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_active_sessions") return [["repo-new", "sess-new"]];
      return undefined;
    });

    useAppStore.getState().initialize();
    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      const session = useAppStore.getState().sessions.get("repo-new");
      expect(session).toBeDefined();
      expect(session!.running).toBe(true);
    });
  });

  it("marks existing non-running session as running when it appears in active list", async () => {
    useAppStore.setState({
      sessions: new Map([
        [
          "repo-1",
          {
            running: false,
            events: [{ kind: "session_complete" }],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_active_sessions") return [["repo-1", "sess-123"]];
      return undefined;
    });

    useAppStore.getState().initialize();
    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      const session = useAppStore.getState().sessions.get("repo-1");
      expect(session).toBeDefined();
      expect(session!.running).toBe(true);
    });
  });

  it("does not change already-running sessions that remain active", async () => {
    useAppStore.setState({
      sessions: new Map([
        [
          "repo-1",
          {
            running: true,
            events: [{ kind: "iteration_start", iteration: 1 }],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_active_sessions") return [["repo-1", "sess-123"]];
      return undefined;
    });

    useAppStore.getState().initialize();
    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      const session = useAppStore.getState().sessions.get("repo-1");
      expect(session).toBeDefined();
      expect(session!.running).toBe(true);
      // Events should be preserved
      expect(session!.events).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // New format: [string, string][] — session_id stored in SessionState
  // -------------------------------------------------------------------------

  it("stores session_id in SessionState when creating new session entry", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_active_sessions") return [["repo-1", "sess-123"]];
      return undefined;
    });

    useAppStore.getState().initialize();
    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      const session = useAppStore.getState().sessions.get("repo-1");
      expect(session).toBeDefined();
      expect(session!.session_id).toBe("sess-123");
    });
  });

  // -------------------------------------------------------------------------
  // Event recovery: load historical events from disk for empty sessions
  // -------------------------------------------------------------------------

  it("loads events from disk when running session has empty events array", async () => {
    const recoveredEvents: SessionEvent[] = [
      { kind: "iteration_start", iteration: 1 },
      { kind: "tool_use", tool_name: "Bash" },
    ];

    useAppStore.setState({
      sessions: new Map([
        [
          "repo-1",
          {
            running: true,
            events: [],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_active_sessions") return [["repo-1", "sess-123"]];
      if (cmd === "get_trace_events") {
        const typedArgs = args as { repoId: string; sessionId: string };
        expect(typedArgs.repoId).toBe("repo-1");
        expect(typedArgs.sessionId).toBe("sess-123");
        return recoveredEvents;
      }
      return undefined;
    });

    useAppStore.getState().initialize();
    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      const session = useAppStore.getState().sessions.get("repo-1");
      expect(session).toBeDefined();
      expect(session!.events).toEqual(recoveredEvents);
    });
  });

  it("does NOT call get_trace_events when session already has events", async () => {
    useAppStore.setState({
      sessions: new Map([
        [
          "repo-1",
          {
            running: true,
            events: [{ kind: "iteration_start", iteration: 1 }],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_active_sessions") return [["repo-1", "sess-123"]];
      if (cmd === "get_trace_events") {
        throw new Error("get_trace_events should not have been called");
      }
      return undefined;
    });

    useAppStore.getState().initialize();
    vi.advanceTimersByTime(5000);

    // Wait for the sync to complete, then verify get_trace_events was never called
    await vi.waitFor(() => {
      const calls = mockInvoke.mock.calls.filter(
        (c) => c[0] === "get_active_sessions",
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    const traceEventCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "get_trace_events",
    );
    expect(traceEventCalls).toHaveLength(0);
  });

  it("handles get_trace_events failure gracefully without crashing", async () => {
    useAppStore.setState({
      sessions: new Map([
        [
          "repo-1",
          {
            running: true,
            events: [],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_active_sessions") return [["repo-1", "sess-123"]];
      if (cmd === "get_trace_events") {
        throw new Error("disk read failed");
      }
      return undefined;
    });

    useAppStore.getState().initialize();
    vi.advanceTimersByTime(5000);

    // Wait for the sync cycle to complete
    await vi.waitFor(() => {
      const calls = mockInvoke.mock.calls.filter(
        (c) => c[0] === "get_active_sessions",
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    // Session should still exist with empty events — no crash
    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.running).toBe(true);
    expect(session!.events).toEqual([]);
  });
});

// ===========================================================================
// 5. runSession
// ===========================================================================

describe("runSession", () => {
  const repo = makeLocalRepo();

  beforeEach(() => {
    useAppStore.setState({ repos: [repo] });
  });

  it("returns early if repo not found", async () => {
    useAppStore.setState({ repos: [] });
    await useAppStore.getState().runSession("nonexistent", "plan.md");

    // invoke should not have been called with run_session
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "run_session",
      expect.anything(),
    );
  });

  it("sets session to running with empty state before invoke", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "run_session") {
        // Check state during the call
        const session = useAppStore.getState().sessions.get("repo-1");
        expect(session).toBeDefined();
        expect(session!.running).toBe(true);
        expect(session!.events).toEqual([]);
        expect(session!.trace).toBeNull();
        expect(session!.error).toBeNull();
        return makeTrace();
      }
      return undefined;
    });

    await useAppStore.getState().runSession("repo-1", "plan.md");
  });

  it("calls invoke with run_session and correct payload", async () => {
    mockInvoke.mockResolvedValue(makeTrace());

    await useAppStore.getState().runSession("repo-1", "plan.md");

    expect(mockInvoke).toHaveBeenCalledWith(
      "run_session",
      expect.objectContaining({
        repoId: "repo-1",
        planFile: "plan.md",
      }),
    );
  });

  it("passes repo config fields in the invoke payload", async () => {
    mockInvoke.mockResolvedValue(makeTrace());

    await useAppStore.getState().runSession("repo-1", "plan.md");

    expect(mockInvoke).toHaveBeenCalledWith(
      "run_session",
      expect.objectContaining({
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      }),
    );
  });

  it("on success: updates session with trace", async () => {
    const trace = makeTrace();
    mockInvoke.mockResolvedValue(trace);

    await useAppStore.getState().runSession("repo-1", "plan.md");

    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.trace).toEqual(trace);
  });

  it("on success: updates latestTraces map", async () => {
    const trace = makeTrace();
    mockInvoke.mockResolvedValue(trace);

    await useAppStore.getState().runSession("repo-1", "plan.md");

    const latestTraces = useAppStore.getState().latestTraces;
    expect(latestTraces.get("repo-1")).toEqual(trace);
  });

  it("on success: calls saveRecent with promptFiles and planFile", async () => {
    const trace = makeTrace();
    mockInvoke.mockResolvedValue(trace);

    await useAppStore.getState().runSession("repo-1", "plan.md");

    expect(mockSaveRecent).toHaveBeenCalledWith("promptFiles", "plan.md");
  });

  it("on error: sets session error to the error string", async () => {
    mockInvoke.mockRejectedValue(new Error("backend crashed"));

    await useAppStore.getState().runSession("repo-1", "plan.md");

    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.error).toBe("backend crashed");
  });

  it("in finally: sets running to false", async () => {
    mockInvoke.mockResolvedValue(makeTrace());

    await useAppStore.getState().runSession("repo-1", "plan.md");

    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.running).toBe(false);
  });

  it("in finally: sets running to false even on error", async () => {
    mockInvoke.mockRejectedValue(new Error("fail"));

    await useAppStore.getState().runSession("repo-1", "plan.md");

    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.running).toBe(false);
  });
});

// ===========================================================================
// 6. stopSession
// ===========================================================================

describe("stopSession", () => {
  it("calls invoke with stop_session and repoId", async () => {
    await useAppStore.getState().stopSession("repo-1");

    expect(mockInvoke).toHaveBeenCalledWith("stop_session", {
      repoId: "repo-1",
    });
  });
});

// ===========================================================================
// 7. reconnectSession
// ===========================================================================

describe("reconnectSession", () => {
  it("sets session to reconnecting true and disconnected false", async () => {
    // Seed a disconnected session
    useAppStore.setState({
      sessions: new Map([
        [
          "repo-1",
          {
            running: true,
            disconnected: true,
            reconnecting: false,
            disconnectReason: "lost",
            events: [],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    // Make invoke hang so we can inspect intermediate state
    let resolveInvoke: () => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInvoke = resolve;
        }),
    );

    const promise = useAppStore.getState().reconnectSession("repo-1");

    // Check intermediate state
    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.reconnecting).toBe(true);
    expect(session!.disconnected).toBe(false);

    resolveInvoke!();
    await promise;
  });

  it("calls invoke with reconnect_session and repoId", async () => {
    useAppStore.setState({
      sessions: new Map([
        [
          "repo-1",
          {
            running: true,
            disconnected: true,
            reconnecting: false,
            events: [],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    mockInvoke.mockResolvedValue(undefined);
    await useAppStore.getState().reconnectSession("repo-1");

    expect(mockInvoke).toHaveBeenCalledWith("reconnect_session", {
      repoId: "repo-1",
    });
  });

  it("on error: sets session error and reconnecting false, disconnected true", async () => {
    useAppStore.setState({
      sessions: new Map([
        [
          "repo-1",
          {
            running: true,
            disconnected: true,
            reconnecting: false,
            events: [],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    mockInvoke.mockRejectedValue(new Error("reconnect failed"));
    await useAppStore.getState().reconnectSession("repo-1");

    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.error).toBe("reconnect failed");
    expect(session!.reconnecting).toBe(false);
    expect(session!.disconnected).toBe(true);
  });
});

// ===========================================================================
// 8. Repo actions
// ===========================================================================

describe("repo actions", () => {
  describe("loadRepos", () => {
    it("calls loadRepos from repos.ts and updates state", async () => {
      const repos = [makeLocalRepo(), makeSshRepo()];
      mockLoadRepos.mockResolvedValue(repos);

      await useAppStore.getState().loadRepos();

      expect(mockLoadRepos).toHaveBeenCalled();
      expect(useAppStore.getState().repos).toEqual(repos);
    });
  });

  describe("addLocalRepo", () => {
    it("calls addLocalRepo from repos.ts", async () => {
      mockLoadRepos.mockResolvedValue([makeLocalRepo()]);
      await useAppStore.getState().addLocalRepo("/home/beth/repos/yarr");

      expect(mockAddLocalRepo).toHaveBeenCalledWith("/home/beth/repos/yarr");
    });

    it("reloads repos after adding", async () => {
      const repoAfterAdd = makeLocalRepo();
      mockLoadRepos.mockResolvedValue([repoAfterAdd]);

      await useAppStore.getState().addLocalRepo("/home/beth/repos/yarr");

      // loadRepos should have been called to refresh
      expect(mockLoadRepos).toHaveBeenCalled();
      expect(useAppStore.getState().repos).toEqual([repoAfterAdd]);
    });
  });

  describe("addSshRepo", () => {
    it("calls addSshRepo from repos.ts", async () => {
      mockLoadRepos.mockResolvedValue([makeSshRepo()]);
      await useAppStore
        .getState()
        .addSshRepo("dev-server", "/home/beth/repos/other");

      expect(mockAddSshRepo).toHaveBeenCalledWith(
        "dev-server",
        "/home/beth/repos/other",
      );
    });

    it("reloads repos after adding", async () => {
      const repoAfterAdd = makeSshRepo();
      mockLoadRepos.mockResolvedValue([repoAfterAdd]);

      await useAppStore
        .getState()
        .addSshRepo("dev-server", "/home/beth/repos/other");

      expect(mockLoadRepos).toHaveBeenCalled();
      expect(useAppStore.getState().repos).toEqual([repoAfterAdd]);
    });
  });

  describe("updateRepo", () => {
    it("calls updateRepo from repos.ts", async () => {
      const repo = makeLocalRepo({ model: "sonnet" });
      mockLoadRepos.mockResolvedValue([repo]);

      await useAppStore.getState().updateRepo(repo);

      expect(mockUpdateRepo).toHaveBeenCalledWith(repo);
    });

    it("reloads repos after updating", async () => {
      const updatedRepo = makeLocalRepo({ model: "sonnet" });
      mockLoadRepos.mockResolvedValue([updatedRepo]);

      await useAppStore.getState().updateRepo(updatedRepo);

      expect(mockLoadRepos).toHaveBeenCalled();
      expect(useAppStore.getState().repos).toEqual([updatedRepo]);
    });
  });
});
