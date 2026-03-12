import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { RepoConfig } from "./repos";
import type {
  SessionTrace,
  SessionEvent,
  TaggedSessionEvent,
  OneShotEntry,
} from "./types";

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

const { mockToast } = vi.hoisted(() => {
  return {
    mockToast: {
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
  };
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

vi.mock("sonner", () => ({
  toast: mockToast,
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

function makeOneShotEntry(
  overrides: Partial<OneShotEntry> = {},
): OneShotEntry {
  return {
    id: "oneshot-abc123",
    parentRepoId: "repo-1",
    parentRepoName: "yarr",
    title: "Fix the bug",
    prompt: "Fix the flaky test in store.test.ts",
    model: "opus",
    mergeStrategy: "fast-forward",
    status: "running",
    startedAt: 1000,
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

  // Default: listen captures the session-event callback and returns the unlisten fn
  mockListen.mockImplementation(
    async (
      eventName: string,
      callback: (event: { payload: TaggedSessionEvent }) => void,
    ) => {
      if (eventName === "session-event") {
        mockListenerCallback.current = callback;
      }
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
    oneShotEntries: new Map(),
    gitStatus: {},
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

  // -------------------------------------------------------------------------
  // session_complete: trace fetching and saveRecent
  // -------------------------------------------------------------------------

  it("session_complete: fetches trace when session has session_id", async () => {
    const trace = makeTrace({ session_id: "sess-123" });

    // Set up a session with session_id
    useAppStore.setState({
      repos: [makeLocalRepo()],
      sessions: new Map([
        [
          "repo-1",
          {
            running: true,
            session_id: "sess-123",
            events: [],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_trace") return trace;
      return undefined;
    });

    emitSessionEvent("repo-1", { kind: "session_complete" });

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_trace", {
        repoId: "repo-1",
        sessionId: "sess-123",
      });
    });

    await vi.waitFor(() => {
      const session = useAppStore.getState().sessions.get("repo-1");
      expect(session).toBeDefined();
      expect(session!.trace).toEqual(trace);
    });

    const latestTraces = useAppStore.getState().latestTraces;
    expect(latestTraces.get("repo-1")).toEqual(trace);
  });

  it("session_complete: does not fetch trace when session has no session_id", () => {
    // Set up a session WITHOUT session_id
    useAppStore.setState({
      repos: [makeLocalRepo()],
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

    emitSessionEvent("repo-1", { kind: "session_complete" });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "get_trace",
      expect.anything(),
    );
  });

  it("session_complete: trace fetch failure does not throw", async () => {
    // Set up a session with session_id
    useAppStore.setState({
      repos: [makeLocalRepo()],
      sessions: new Map([
        [
          "repo-1",
          {
            running: true,
            session_id: "sess-123",
            events: [],
            trace: null,
            error: null,
          },
        ],
      ]),
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_trace") throw new Error("trace not found");
      return undefined;
    });

    // Should not throw
    expect(() => {
      emitSessionEvent("repo-1", { kind: "session_complete" });
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_trace", {
        repoId: "repo-1",
        sessionId: "sess-123",
      });
    });
  });

  it("session_complete: calls saveRecent with plan_file from event", () => {
    useAppStore.setState({
      repos: [makeLocalRepo()],
    });

    emitSessionEvent("repo-1", {
      kind: "session_complete",
      plan_file: "docs/plans/my-plan.md",
    });

    expect(mockSaveRecent).toHaveBeenCalledWith(
      "promptFiles",
      "docs/plans/my-plan.md",
    );
  });

  it("session_complete: does not call saveRecent when no plan_file", () => {
    useAppStore.setState({
      repos: [makeLocalRepo()],
    });

    emitSessionEvent("repo-1", { kind: "session_complete" });

    expect(mockSaveRecent).not.toHaveBeenCalled();
  });

  it("auto-move: NOT invoked when movePlansToCompleted is false", () => {
    useAppStore.setState({
      repos: [
        makeLocalRepo({
          plansDir: "docs/plans/",
          movePlansToCompleted: false,
        } as Partial<RepoConfig>),
      ],
    });

    emitSessionEvent("repo-1", {
      kind: "session_complete",
      outcome: "completed",
      plan_file: "docs/plans/my-plan.md",
    });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "move_plan_to_completed",
      expect.anything(),
    );
  });

  it("auto-move: invoked when movePlansToCompleted is true", () => {
    useAppStore.setState({
      repos: [
        makeLocalRepo({
          plansDir: "docs/plans/",
          movePlansToCompleted: true,
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

  it("auto-move: invoked when movePlansToCompleted is undefined (default true)", () => {
    useAppStore.setState({
      repos: [
        makeLocalRepo({
          plansDir: "docs/plans/",
        } as Partial<RepoConfig>),
      ],
    });

    // movePlansToCompleted is not set on the repo — should default to true
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

  // -------------------------------------------------------------------------
  // One-shot entry reconciliation
  // -------------------------------------------------------------------------

  describe("one-shot entry reconciliation", () => {
    it("marks running one-shot entry as failed when NOT in active sessions", async () => {
      const entry = makeOneShotEntry({ id: "oneshot-abc", status: "running" });
      useAppStore.setState({
        oneShotEntries: new Map([["oneshot-abc", entry]]),
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_active_sessions") return [];
        return undefined;
      });

      useAppStore.getState().initialize();
      vi.advanceTimersByTime(5000);

      await vi.waitFor(() => {
        const updated = useAppStore.getState().oneShotEntries.get("oneshot-abc");
        expect(updated).toBeDefined();
        expect(updated!.status).toBe("failed");
      });
    });

    it("keeps running one-shot entry as running when IN active sessions", async () => {
      const entry = makeOneShotEntry({ id: "oneshot-abc", status: "running" });
      useAppStore.setState({
        oneShotEntries: new Map([["oneshot-abc", entry]]),
      });

      // oneshot-abc IS in the active sessions list
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_active_sessions")
          return [["oneshot-abc", "sess-oneshot"]];
        return undefined;
      });

      useAppStore.getState().initialize();
      vi.advanceTimersByTime(5000);

      await vi.waitFor(() => {
        const calls = mockInvoke.mock.calls.filter(
          (c) => c[0] === "get_active_sessions",
        );
        expect(calls.length).toBeGreaterThanOrEqual(1);
      });

      const updated = useAppStore.getState().oneShotEntries.get("oneshot-abc");
      expect(updated).toBeDefined();
      expect(updated!.status).toBe("running");
    });

    it("does not change non-running one-shot entries", async () => {
      const completed = makeOneShotEntry({
        id: "oneshot-done",
        status: "completed",
      });
      const failed = makeOneShotEntry({
        id: "oneshot-fail",
        status: "failed",
      });
      useAppStore.setState({
        oneShotEntries: new Map([
          ["oneshot-done", completed],
          ["oneshot-fail", failed],
        ]),
      });

      // No active sessions at all
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_active_sessions") return [];
        return undefined;
      });

      useAppStore.getState().initialize();
      vi.advanceTimersByTime(5000);

      await vi.waitFor(() => {
        const calls = mockInvoke.mock.calls.filter(
          (c) => c[0] === "get_active_sessions",
        );
        expect(calls.length).toBeGreaterThanOrEqual(1);
      });

      const entries = useAppStore.getState().oneShotEntries;
      expect(entries.get("oneshot-done")!.status).toBe("completed");
      expect(entries.get("oneshot-fail")!.status).toBe("failed");
    });

    it("persists updated entries to oneShotStore after reconciliation", async () => {
      const entry = makeOneShotEntry({ id: "oneshot-abc", status: "running" });
      useAppStore.setState({
        oneShotEntries: new Map([["oneshot-abc", entry]]),
      });

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_active_sessions") return [];
        return undefined;
      });

      useAppStore.getState().initialize();
      vi.advanceTimersByTime(5000);

      await vi.waitFor(() => {
        const updated = useAppStore.getState().oneShotEntries.get("oneshot-abc");
        expect(updated).toBeDefined();
        expect(updated!.status).toBe("failed");
      });

      // Verify persistence
      const saved = mockData.get("oneshot-entries") as
        | [string, OneShotEntry][]
        | undefined;
      expect(saved).toBeDefined();
      const restoredMap = new Map(saved);
      expect(restoredMap.get("oneshot-abc")).toBeDefined();
      expect(restoredMap.get("oneshot-abc")!.status).toBe("failed");
    });

    it("only marks stale running entries as failed among multiple entries", async () => {
      const staleRunning = makeOneShotEntry({
        id: "oneshot-stale",
        status: "running",
      });
      const activeRunning = makeOneShotEntry({
        id: "oneshot-active",
        status: "running",
      });
      const completedEntry = makeOneShotEntry({
        id: "oneshot-done",
        status: "completed",
      });

      useAppStore.setState({
        oneShotEntries: new Map([
          ["oneshot-stale", staleRunning],
          ["oneshot-active", activeRunning],
          ["oneshot-done", completedEntry],
        ]),
      });

      // Only oneshot-active is in the active sessions
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_active_sessions")
          return [["oneshot-active", "sess-active"]];
        return undefined;
      });

      useAppStore.getState().initialize();
      vi.advanceTimersByTime(5000);

      await vi.waitFor(() => {
        const stale =
          useAppStore.getState().oneShotEntries.get("oneshot-stale");
        expect(stale).toBeDefined();
        expect(stale!.status).toBe("failed");
      });

      const entries = useAppStore.getState().oneShotEntries;
      expect(entries.get("oneshot-active")!.status).toBe("running");
      expect(entries.get("oneshot-done")!.status).toBe("completed");
    });
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
        return { session_id: "test-session-id" };
      }
      return undefined;
    });

    await useAppStore.getState().runSession("repo-1", "plan.md");
  });

  it("calls invoke with run_session and correct payload", async () => {
    mockInvoke.mockResolvedValue({ session_id: "test-session-id" });

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
    mockInvoke.mockResolvedValue({ session_id: "test-session-id" });

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

  it("on success: stores session_id on session state", async () => {
    mockInvoke.mockResolvedValue({ session_id: "test-session-id" });

    await useAppStore.getState().runSession("repo-1", "plan.md");

    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.session_id).toBe("test-session-id");
    expect(session!.running).toBe(true);
  });

  it("on error: sets session error to the error string", async () => {
    mockInvoke.mockRejectedValue(new Error("backend crashed"));

    await useAppStore.getState().runSession("repo-1", "plan.md");

    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.error).toBe("backend crashed");
    expect(session!.running).toBe(false);
  });

  it("on error: sets running to false", async () => {
    mockInvoke.mockRejectedValue(new Error("fail"));

    await useAppStore.getState().runSession("repo-1", "plan.md");

    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.running).toBe(false);
  });

  it("on reject: sets error and running=false for Session already running", async () => {
    mockInvoke.mockRejectedValue(
      new Error("Session already running for this repo"),
    );

    await useAppStore.getState().runSession("repo-1", "plan.md");

    const session = useAppStore.getState().sessions.get("repo-1");
    expect(session).toBeDefined();
    expect(session!.error).toBe("Session already running for this repo");
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

// ===========================================================================
// 9. OneShotEntry initial state
// ===========================================================================

describe("OneShotEntry initial state", () => {
  it("oneShotEntries starts as empty Map", () => {
    const state = useAppStore.getState();
    expect(state.oneShotEntries).toBeInstanceOf(Map);
    expect(state.oneShotEntries.size).toBe(0);
  });
});

// ===========================================================================
// 10. runOneShot
// ===========================================================================

describe("runOneShot", () => {
  const repo = makeLocalRepo({
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
    gitSync: { enabled: true, conflictPrompt: undefined, model: undefined, maxPushRetries: 3 },
    envVars: { MY_VAR: "hello" },
  });

  beforeEach(() => {
    useAppStore.setState({ repos: [repo] });
  });

  it("returns early if repo not found", async () => {
    useAppStore.setState({ repos: [] });
    await useAppStore.getState().runOneShot("nonexistent", "Fix bug", "fix it", "opus", "fast-forward");

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "run_oneshot",
      expect.anything(),
    );
  });

  it("creates OneShotEntry with status running and calls invoke", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "run_oneshot") {
        // Check state during the call — an entry with status "running" should exist
        const entries = useAppStore.getState().oneShotEntries;
        // There should be exactly one entry with status "running"
        const running = [...entries.values()].filter((e) => e.status === "running");
        expect(running.length).toBeGreaterThanOrEqual(1);
        return { oneshot_id: "oneshot-xyz", trace: makeTrace() };
      }
      return undefined;
    });

    await useAppStore.getState().runOneShot("repo-1", "Fix bug", "fix it", "opus", "fast-forward");

    expect(mockInvoke).toHaveBeenCalledWith(
      "run_oneshot",
      expect.objectContaining({
        repoId: "repo-1",
        title: "Fix bug",
        prompt: "fix it",
        model: "opus",
        mergeStrategy: "fast-forward",
      }),
    );
  });

  it("passes repo config fields (maxIterations, completionSignal, checks, gitSync) to invoke", async () => {
    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-xyz", trace: makeTrace() });

    await useAppStore.getState().runOneShot("repo-1", "Fix bug", "fix it", "opus", "fast-forward");

    expect(mockInvoke).toHaveBeenCalledWith(
      "run_oneshot",
      expect.objectContaining({
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        checks: [],
        gitSync: { enabled: true, conflictPrompt: undefined, model: undefined, maxPushRetries: 3 },
        envVars: { MY_VAR: "hello" },
      }),
    );
  });

  it("passes custom plansDir from repo config to invoke", async () => {
    const repoWithPlansDir = makeLocalRepo({
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      checks: [],
      gitSync: { enabled: true, conflictPrompt: undefined, model: undefined, maxPushRetries: 3 },
      envVars: { MY_VAR: "hello" },
      plansDir: "custom/plans/",
    });
    useAppStore.setState({ repos: [repoWithPlansDir] });
    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-xyz", trace: makeTrace() });

    await useAppStore.getState().runOneShot("repo-1", "Fix bug", "fix it", "opus", "fast-forward");

    expect(mockInvoke).toHaveBeenCalledWith(
      "run_oneshot",
      expect.objectContaining({
        plansDir: "custom/plans/",
      }),
    );
  });

  it("defaults plansDir to docs/plans/ when repo config has no plansDir", async () => {
    const repoWithoutPlansDir = makeLocalRepo({
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      checks: [],
    });
    useAppStore.setState({ repos: [repoWithoutPlansDir] });
    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-xyz", trace: makeTrace() });

    await useAppStore.getState().runOneShot("repo-1", "Fix bug", "fix it", "opus", "fast-forward");

    expect(mockInvoke).toHaveBeenCalledWith(
      "run_oneshot",
      expect.objectContaining({
        plansDir: "docs/plans/",
      }),
    );
  });

  it("on success: stores entry with returned oneshot_id and updates status", async () => {
    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-xyz", trace: makeTrace() });

    await useAppStore.getState().runOneShot("repo-1", "Fix bug", "fix it", "opus", "fast-forward");

    const entries = useAppStore.getState().oneShotEntries;
    expect(entries.has("oneshot-xyz")).toBe(true);

    const entry = entries.get("oneshot-xyz")!;
    expect(entry.id).toBe("oneshot-xyz");
    expect(entry.parentRepoId).toBe("repo-1");
    expect(entry.parentRepoName).toBe("yarr");
    expect(entry.title).toBe("Fix bug");
    expect(entry.prompt).toBe("fix it");
    expect(entry.model).toBe("opus");
    expect(entry.mergeStrategy).toBe("fast-forward");
    expect(entry.status).toBe("running");
    expect(entry.startedAt).toBeGreaterThan(0);
  });

  it("on error: updates entry status to failed", async () => {
    mockInvoke.mockRejectedValue(new Error("backend crashed"));

    await useAppStore.getState().runOneShot("repo-1", "Fix bug", "fix it", "opus", "fast-forward");

    const entries = useAppStore.getState().oneShotEntries;
    // There should be an entry with status "failed"
    const failed = [...entries.values()].filter((e) => e.status === "failed");
    expect(failed.length).toBe(1);
    expect(failed[0].parentRepoId).toBe("repo-1");
  });

  it("returns the oneshot_id on success", async () => {
    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-xyz", trace: makeTrace() });

    const result = await useAppStore.getState().runOneShot("repo-1", "Fix bug", "fix it", "opus", "fast-forward");

    expect(result).toBe("oneshot-xyz");
  });

  it("on success: saves session_id from backend result to entry", async () => {
    mockInvoke.mockResolvedValue({
      oneshot_id: "oneshot-xyz",
      session_id: "sess-123",
      trace: makeTrace(),
    });

    await useAppStore.getState().runOneShot("repo-1", "Fix bug", "fix it", "opus", "fast-forward");

    const entries = useAppStore.getState().oneShotEntries;
    expect(entries.has("oneshot-xyz")).toBe(true);

    const entry = entries.get("oneshot-xyz")!;
    expect(entry.session_id).toBe("sess-123");
  });
});

// ===========================================================================
// 11. dismissOneShot
// ===========================================================================

describe("dismissOneShot", () => {
  it("removes failed entry from oneShotEntries", async () => {
    const entry = makeOneShotEntry({ id: "oneshot-abc", status: "failed" });
    useAppStore.setState({
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    await useAppStore.getState().dismissOneShot("oneshot-abc");

    const entries = useAppStore.getState().oneShotEntries;
    expect(entries.has("oneshot-abc")).toBe(false);
    expect(entries.size).toBe(0);
  });

  it("does nothing if entry does not exist", async () => {
    const entry = makeOneShotEntry({ id: "oneshot-abc", status: "failed" });
    useAppStore.setState({
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    await useAppStore.getState().dismissOneShot("oneshot-nonexistent");

    // Original entry should still be there
    const entries = useAppStore.getState().oneShotEntries;
    expect(entries.has("oneshot-abc")).toBe(true);
    expect(entries.size).toBe(1);
  });
});

// ===========================================================================
// 12. 1-shot event listener
// ===========================================================================

describe("1-shot event listener", () => {
  beforeEach(() => {
    useAppStore.getState().initialize();
  });

  it("updates entry status to completed on one_shot_complete event", () => {
    const entry = makeOneShotEntry({ id: "oneshot-abc", status: "running" });
    useAppStore.setState({
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    emitSessionEvent("oneshot-abc", { kind: "one_shot_complete" });

    const entries = useAppStore.getState().oneShotEntries;
    expect(entries.get("oneshot-abc")!.status).toBe("completed");
  });

  it("updates entry status to failed on one_shot_failed event", () => {
    const entry = makeOneShotEntry({ id: "oneshot-abc", status: "running" });
    useAppStore.setState({
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    emitSessionEvent("oneshot-abc", { kind: "one_shot_failed" });

    const entries = useAppStore.getState().oneShotEntries;
    expect(entries.get("oneshot-abc")!.status).toBe("failed");
  });

  it("prunes completed entries to keep last 5 by startedAt", () => {
    // Create 6 completed entries
    const entries = new Map<string, OneShotEntry>();
    for (let i = 0; i < 5; i++) {
      entries.set(
        `oneshot-old-${i}`,
        makeOneShotEntry({
          id: `oneshot-old-${i}`,
          status: "completed",
          startedAt: 1000 + i,
        }),
      );
    }
    // Add one more running entry that will become completed
    entries.set(
      "oneshot-new",
      makeOneShotEntry({
        id: "oneshot-new",
        status: "running",
        startedAt: 2000,
      }),
    );

    useAppStore.setState({ oneShotEntries: entries });

    // Complete the newest one — now there are 6 completed, should prune to 5
    emitSessionEvent("oneshot-new", { kind: "one_shot_complete" });

    const result = useAppStore.getState().oneShotEntries;
    const completedEntries = [...result.values()].filter(
      (e) => e.status === "completed",
    );
    expect(completedEntries.length).toBe(5);

    // The oldest entry (startedAt: 1000) should have been pruned
    expect(result.has("oneshot-old-0")).toBe(false);
    // The newest entry should still be there
    expect(result.has("oneshot-new")).toBe(true);
  });

  it("does not prune running or failed entries", () => {
    const entries = new Map<string, OneShotEntry>();
    // 5 completed entries
    for (let i = 0; i < 5; i++) {
      entries.set(
        `oneshot-done-${i}`,
        makeOneShotEntry({
          id: `oneshot-done-${i}`,
          status: "completed",
          startedAt: 1000 + i,
        }),
      );
    }
    // 1 failed entry
    entries.set(
      "oneshot-fail",
      makeOneShotEntry({
        id: "oneshot-fail",
        status: "failed",
        startedAt: 500,
      }),
    );
    // 1 running entry that will become completed
    entries.set(
      "oneshot-running",
      makeOneShotEntry({
        id: "oneshot-running",
        status: "running",
        startedAt: 2000,
      }),
    );

    useAppStore.setState({ oneShotEntries: entries });

    // Complete the running one — now 6 completed, should prune to 5
    emitSessionEvent("oneshot-running", { kind: "one_shot_complete" });

    const result = useAppStore.getState().oneShotEntries;
    // Failed entry should NOT be pruned
    expect(result.has("oneshot-fail")).toBe(true);
    expect(result.get("oneshot-fail")!.status).toBe("failed");
  });

  it("ignores one_shot_complete for unknown oneshot IDs", () => {
    const entry = makeOneShotEntry({ id: "oneshot-abc", status: "running" });
    useAppStore.setState({
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    // Emit for an unknown ID — should not throw or modify existing entries
    emitSessionEvent("oneshot-unknown", { kind: "one_shot_complete" });

    const entries = useAppStore.getState().oneShotEntries;
    expect(entries.size).toBe(1);
    expect(entries.get("oneshot-abc")!.status).toBe("running");
  });
});

// ===========================================================================
// 12b. 1-shot auto-move plan on completion
// ===========================================================================

describe("1-shot auto-move plan on completion", () => {
  beforeEach(() => {
    useAppStore.getState().initialize();
  });

  it("auto-move: invokes move_plan_to_completed on one_shot_complete when design_phase_complete event exists", () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-1",
      status: "running",
    });
    useAppStore.setState({
      repos: [
        makeLocalRepo({
          plansDir: "docs/plans/",
        } as Partial<RepoConfig>),
      ],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    // First emit design_phase_complete so plan_file is in session events
    emitSessionEvent("oneshot-abc", {
      kind: "design_phase_complete",
      plan_file: "docs/plans/my-plan.md",
    });

    // Then emit one_shot_complete to trigger the auto-move
    emitSessionEvent("oneshot-abc", { kind: "one_shot_complete" });

    expect(mockInvoke).toHaveBeenCalledWith("move_plan_to_completed", {
      repo: { type: "local", path: "/home/beth/repos/yarr" },
      plansDir: "docs/plans/",
      filename: "my-plan.md",
    });
  });

  it("auto-move: uses default plansDir when parent repo has no plansDir", () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-1",
      status: "running",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    emitSessionEvent("oneshot-abc", {
      kind: "design_phase_complete",
      plan_file: "docs/plans/my-plan.md",
    });

    emitSessionEvent("oneshot-abc", { kind: "one_shot_complete" });

    expect(mockInvoke).toHaveBeenCalledWith("move_plan_to_completed", {
      repo: { type: "local", path: "/home/beth/repos/yarr" },
      plansDir: "docs/plans/",
      filename: "my-plan.md",
    });
  });

  it("auto-move: NOT invoked on one_shot_complete when no design_phase_complete event exists", () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-1",
      status: "running",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    // Emit one_shot_complete without any prior design_phase_complete
    emitSessionEvent("oneshot-abc", { kind: "one_shot_complete" });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "move_plan_to_completed",
      expect.anything(),
    );
  });

  it("auto-move: NOT invoked on one_shot_failed", () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-1",
      status: "running",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    emitSessionEvent("oneshot-abc", {
      kind: "design_phase_complete",
      plan_file: "docs/plans/my-plan.md",
    });

    emitSessionEvent("oneshot-abc", { kind: "one_shot_failed" });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "move_plan_to_completed",
      expect.anything(),
    );
  });

  it("auto-move: NOT invoked when parent repo is not found", () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-nonexistent",
      status: "running",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    emitSessionEvent("oneshot-abc", {
      kind: "design_phase_complete",
      plan_file: "docs/plans/my-plan.md",
    });

    emitSessionEvent("oneshot-abc", { kind: "one_shot_complete" });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "move_plan_to_completed",
      expect.anything(),
    );
  });

  it("auto-move: failure is logged but does not throw", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-1",
      status: "running",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "move_plan_to_completed") {
        throw new Error("filesystem error");
      }
      return undefined;
    });

    emitSessionEvent("oneshot-abc", {
      kind: "design_phase_complete",
      plan_file: "docs/plans/my-plan.md",
    });

    // Should not throw — fire-and-forget
    expect(() => {
      emitSessionEvent("oneshot-abc", { kind: "one_shot_complete" });
    }).not.toThrow();

    // Let the rejected promise settle
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "move_plan_to_completed",
        expect.anything(),
      );
    });
  });

  it("auto-move: works with SSH repos", () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-2",
      status: "running",
    });
    useAppStore.setState({
      repos: [
        makeSshRepo({
          plansDir: "docs/plans/",
        } as Partial<RepoConfig>),
      ],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    emitSessionEvent("oneshot-abc", {
      kind: "design_phase_complete",
      plan_file: "docs/plans/my-plan.md",
    });

    emitSessionEvent("oneshot-abc", { kind: "one_shot_complete" });

    expect(mockInvoke).toHaveBeenCalledWith("move_plan_to_completed", {
      repo: {
        type: "ssh",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/other",
      },
      plansDir: "docs/plans/",
      filename: "my-plan.md",
    });
  });

  it("auto-move: NOT invoked when parent repo has movePlansToCompleted false", () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-1",
      status: "running",
    });
    useAppStore.setState({
      repos: [
        makeLocalRepo({
          plansDir: "docs/plans/",
          movePlansToCompleted: false,
        } as Partial<RepoConfig>),
      ],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    // First emit design_phase_complete so plan_file is in session events
    emitSessionEvent("oneshot-abc", {
      kind: "design_phase_complete",
      plan_file: "docs/plans/my-plan.md",
    });

    // Then emit one_shot_complete to trigger the auto-move
    emitSessionEvent("oneshot-abc", { kind: "one_shot_complete" });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "move_plan_to_completed",
      expect.anything(),
    );
  });

  it("auto-move: invoked when parent repo has movePlansToCompleted true", () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-1",
      status: "running",
    });
    useAppStore.setState({
      repos: [
        makeLocalRepo({
          plansDir: "docs/plans/",
          movePlansToCompleted: true,
        } as Partial<RepoConfig>),
      ],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    emitSessionEvent("oneshot-abc", {
      kind: "design_phase_complete",
      plan_file: "docs/plans/my-plan.md",
    });

    emitSessionEvent("oneshot-abc", { kind: "one_shot_complete" });

    expect(mockInvoke).toHaveBeenCalledWith("move_plan_to_completed", {
      repo: { type: "local", path: "/home/beth/repos/yarr" },
      plansDir: "docs/plans/",
      filename: "my-plan.md",
    });
  });
});

// ===========================================================================
// 13. 1-shot persistence
// ===========================================================================

describe("1-shot persistence", () => {
  it("saveOneShotEntries persists to store", async () => {
    const entry = makeOneShotEntry({ id: "oneshot-abc", status: "completed" });
    useAppStore.setState({
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    await useAppStore.getState().saveOneShotEntries();

    // The mock LazyStore saves to mockData — check the key
    const saved = mockData.get("oneshot-entries") as [string, OneShotEntry][];
    expect(saved).toBeDefined();
    // Should be an array of [key, value] pairs (Map serialization)
    const restoredMap = new Map(saved);
    expect(restoredMap.has("oneshot-abc")).toBe(true);
    expect(restoredMap.get("oneshot-abc")!.status).toBe("completed");
  });

  it("loadOneShotEntries restores from store", async () => {
    const entry = makeOneShotEntry({ id: "oneshot-abc", status: "completed" });
    // Pre-populate the mock store with serialized entries
    mockData.set("oneshot-entries", [["oneshot-abc", entry]]);

    await useAppStore.getState().loadOneShotEntries();

    const entries = useAppStore.getState().oneShotEntries;
    expect(entries.has("oneshot-abc")).toBe(true);
    expect(entries.get("oneshot-abc")!.id).toBe("oneshot-abc");
    expect(entries.get("oneshot-abc")!.status).toBe("completed");
  });
});

// ===========================================================================
// 13b. one_shot_started event: saves worktreePath and branch
// ===========================================================================

describe("one_shot_started event", () => {
  beforeEach(() => {
    useAppStore.getState().initialize();
  });

  it("saves worktreePath and branch from one_shot_started event", () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "running",
    });
    useAppStore.setState({
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    emitSessionEvent("oneshot-abc", {
      kind: "one_shot_started",
      worktree_path: "/tmp/wt",
      branch: "oneshot/fix",
    });

    const entries = useAppStore.getState().oneShotEntries;
    const updated = entries.get("oneshot-abc")!;
    expect(updated.worktreePath).toBe("/tmp/wt");
    expect(updated.branch).toBe("oneshot/fix");
  });

  it("persists entry after saving worktreePath and branch", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "running",
    });
    useAppStore.setState({
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    emitSessionEvent("oneshot-abc", {
      kind: "one_shot_started",
      worktree_path: "/tmp/wt",
      branch: "oneshot/fix",
    });

    // Wait for the async persistence to complete
    await vi.waitFor(() => {
      const saved = mockData.get("oneshot-entries") as
        | [string, OneShotEntry][]
        | undefined;
      expect(saved).toBeDefined();
      const restoredMap = new Map(saved!);
      expect(restoredMap.get("oneshot-abc")!.worktreePath).toBe("/tmp/wt");
      expect(restoredMap.get("oneshot-abc")!.branch).toBe("oneshot/fix");
    });
  });

  it("ignores one_shot_started for unknown oneshot IDs", () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "running",
    });
    useAppStore.setState({
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    // Emit for an unknown ID — should not throw or modify existing entries
    emitSessionEvent("oneshot-unknown", {
      kind: "one_shot_started",
      worktree_path: "/tmp/wt",
      branch: "oneshot/fix",
    });

    const entries = useAppStore.getState().oneShotEntries;
    expect(entries.size).toBe(1);
    const existing = entries.get("oneshot-abc")!;
    expect(existing.worktreePath).toBeUndefined();
    expect(existing.branch).toBeUndefined();
  });
});

// ===========================================================================
// 13c. One-shot event recovery on startup
// ===========================================================================

describe("one-shot event recovery on startup", () => {
  it("recovers events for one-shot entries with session_id on initialize", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "completed",
      session_id: "sess-123",
    });
    mockData.set("oneshot-entries", [["oneshot-abc", entry]]);

    const recoveredEvents: SessionEvent[] = [
      { kind: "iteration_start", iteration: 1 },
      { kind: "tool_use", tool_name: "Bash" },
    ];

    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "get_trace_events") {
        const typedArgs = args as { repoId: string; sessionId: string };
        expect(typedArgs.repoId).toBe("oneshot-abc");
        expect(typedArgs.sessionId).toBe("sess-123");
        return recoveredEvents;
      }
      return undefined;
    });

    useAppStore.getState().initialize();

    await vi.waitFor(() => {
      const session = useAppStore.getState().sessions.get("oneshot-abc");
      expect(session).toBeDefined();
      expect(session!.events).toEqual(recoveredEvents);
    });
  });

  it("recovers trace for one-shot entries with session_id on initialize", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "completed",
      session_id: "sess-123",
    });
    mockData.set("oneshot-entries", [["oneshot-abc", entry]]);

    const trace = makeTrace({
      session_id: "sess-123",
      repo_id: "oneshot-abc",
      outcome: "completed",
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_trace_events") return [];
      if (cmd === "get_trace") return trace;
      return undefined;
    });

    useAppStore.getState().initialize();

    await vi.waitFor(() => {
      const session = useAppStore.getState().sessions.get("oneshot-abc");
      expect(session).toBeDefined();
      expect(session!.trace).toEqual(trace);
    });
  });

  it("updates entry status to completed when trace outcome is completed", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "failed",
      session_id: "sess-123",
    });
    mockData.set("oneshot-entries", [["oneshot-abc", entry]]);

    const trace = makeTrace({
      session_id: "sess-123",
      repo_id: "oneshot-abc",
      outcome: "completed",
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_trace_events") return [];
      if (cmd === "get_trace") return trace;
      return undefined;
    });

    useAppStore.getState().initialize();

    await vi.waitFor(() => {
      const entries = useAppStore.getState().oneShotEntries;
      const updated = entries.get("oneshot-abc");
      expect(updated).toBeDefined();
      expect(updated!.status).toBe("completed");
    });
  });

  it("updates entry status to failed when trace outcome is failed", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "running",
      session_id: "sess-123",
    });
    mockData.set("oneshot-entries", [["oneshot-abc", entry]]);

    const trace = makeTrace({
      session_id: "sess-123",
      repo_id: "oneshot-abc",
      outcome: "failed",
    });

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_trace_events") return [];
      if (cmd === "get_trace") return trace;
      return undefined;
    });

    useAppStore.getState().initialize();

    await vi.waitFor(() => {
      const entries = useAppStore.getState().oneShotEntries;
      const updated = entries.get("oneshot-abc");
      expect(updated).toBeDefined();
      expect(updated!.status).toBe("failed");
    });
  });

  it("skips entries without session_id", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "running",
      // no session_id
    });
    mockData.set("oneshot-entries", [["oneshot-abc", entry]]);

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_trace_events") {
        throw new Error("get_trace_events should not have been called");
      }
      if (cmd === "get_trace") {
        throw new Error("get_trace should not have been called");
      }
      return undefined;
    });

    useAppStore.getState().initialize();

    // Wait for loadOneShotEntries to complete
    await vi.waitFor(() => {
      const entries = useAppStore.getState().oneShotEntries;
      expect(entries.has("oneshot-abc")).toBe(true);
    });

    // Verify get_trace_events was never called for this entry
    const traceEventCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "get_trace_events",
    );
    expect(traceEventCalls).toHaveLength(0);

    const traceCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "get_trace",
    );
    expect(traceCalls).toHaveLength(0);
  });

  it("handles get_trace_events failure gracefully", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "completed",
      session_id: "sess-123",
    });
    mockData.set("oneshot-entries", [["oneshot-abc", entry]]);

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_trace_events") {
        throw new Error("disk read failed");
      }
      if (cmd === "get_trace") return null;
      return undefined;
    });

    useAppStore.getState().initialize();

    // Wait for loadOneShotEntries to complete
    await vi.waitFor(() => {
      const entries = useAppStore.getState().oneShotEntries;
      expect(entries.has("oneshot-abc")).toBe(true);
    });

    // Entry should remain unchanged — no crash
    const entries = useAppStore.getState().oneShotEntries;
    const unchanged = entries.get("oneshot-abc")!;
    expect(unchanged.status).toBe("completed");
  });

  it("handles get_trace failure gracefully", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "completed",
      session_id: "sess-123",
    });
    mockData.set("oneshot-entries", [["oneshot-abc", entry]]);

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_trace_events") return [];
      if (cmd === "get_trace") {
        throw new Error("trace not found");
      }
      return undefined;
    });

    useAppStore.getState().initialize();

    // Wait for loadOneShotEntries to complete
    await vi.waitFor(() => {
      const entries = useAppStore.getState().oneShotEntries;
      expect(entries.has("oneshot-abc")).toBe(true);
    });

    // Entry should remain unchanged — no crash
    const entries = useAppStore.getState().oneShotEntries;
    const unchanged = entries.get("oneshot-abc")!;
    expect(unchanged.status).toBe("completed");
  });

  it("does not update entry status when trace has no outcome", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "running",
      session_id: "sess-123",
    });
    mockData.set("oneshot-entries", [["oneshot-abc", entry]]);

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_trace_events") return [];
      if (cmd === "get_trace") return null;
      return undefined;
    });

    useAppStore.getState().initialize();

    // Wait for loadOneShotEntries to complete and recovery to run
    await vi.waitFor(() => {
      const entries = useAppStore.getState().oneShotEntries;
      expect(entries.has("oneshot-abc")).toBe(true);
    });

    // Status should remain unchanged since trace was null
    const entries = useAppStore.getState().oneShotEntries;
    const unchanged = entries.get("oneshot-abc")!;
    expect(unchanged.status).toBe("running");
  });
});

// ===========================================================================
// Env warning listener (Task 7: surface shell env snapshot warnings)
// ===========================================================================

describe("env-warning listener", () => {
  it("initialize sets up a listener for env-warning events", () => {
    useAppStore.getState().initialize();
    expect(mockListen).toHaveBeenCalledWith(
      "env-warning",
      expect.any(Function),
    );
  });
});

// ===========================================================================
// 14. gitStatus initial state
// ===========================================================================

describe("gitStatus initial state", () => {
  it("gitStatus starts as empty object", () => {
    const state = useAppStore.getState();
    expect(state.gitStatus).toEqual({});
  });
});

// ===========================================================================
// 15. fetchGitStatus
// ===========================================================================

describe("fetchGitStatus", () => {
  it("happy path — local repo", async () => {
    const localRepo = makeLocalRepo();
    const mockStatus = {
      branchName: "main",
      dirtyCount: 3,
      ahead: 2,
      behind: 1,
    };
    mockInvoke.mockResolvedValue(mockStatus);

    useAppStore.getState().fetchGitStatus("repo-1", localRepo, true);

    await vi.waitFor(() => {
      const gs = useAppStore.getState().gitStatus["repo-1"];
      expect(gs?.loading).toBe(false);
      expect(gs?.status).toEqual(mockStatus);
    });

    expect(mockInvoke).toHaveBeenCalledWith("get_repo_git_status", {
      repo: { type: "local", path: "/home/beth/repos/yarr" },
      fetch: true,
    });

    const gs = useAppStore.getState().gitStatus["repo-1"];
    expect(gs.status).toEqual(mockStatus);
    expect(gs.lastChecked).toBeInstanceOf(Date);
    expect(gs.loading).toBe(false);
    expect(gs.error).toBeNull();
  });

  it("happy path — SSH repo", async () => {
    const sshRepo = makeSshRepo();
    const mockStatus = {
      branchName: "develop",
      dirtyCount: 0,
      ahead: null,
      behind: null,
    };
    mockInvoke.mockResolvedValue(mockStatus);

    useAppStore.getState().fetchGitStatus("repo-2", sshRepo, false);

    await vi.waitFor(() => {
      const gs = useAppStore.getState().gitStatus["repo-2"];
      expect(gs?.loading).toBe(false);
      expect(gs?.status).toEqual(mockStatus);
    });

    expect(mockInvoke).toHaveBeenCalledWith("get_repo_git_status", {
      repo: {
        type: "ssh",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/other",
      },
      fetch: false,
    });

    const gs = useAppStore.getState().gitStatus["repo-2"];
    expect(gs.status).toEqual(mockStatus);
    expect(gs.lastChecked).toBeInstanceOf(Date);
    expect(gs.loading).toBe(false);
    expect(gs.error).toBeNull();
  });

  it("sets loading state while invoke is pending", async () => {
    const localRepo = makeLocalRepo();
    let resolve: (value: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });
    mockInvoke.mockReturnValue(pending);

    // Call the action (don't await it)
    useAppStore.getState().fetchGitStatus("repo-1", localRepo, true);

    // Check loading state immediately
    await vi.waitFor(() => {
      expect(
        useAppStore.getState().gitStatus["repo-1"]?.loading,
      ).toBe(true);
    });

    // Resolve the promise
    resolve!({
      branchName: "main",
      dirtyCount: 0,
      ahead: null,
      behind: null,
    });

    // Wait for state to settle
    await vi.waitFor(() => {
      expect(
        useAppStore.getState().gitStatus["repo-1"]?.loading,
      ).toBe(false);
    });
  });

  it("error handling — sets error and null status", async () => {
    const localRepo = makeLocalRepo();
    mockInvoke.mockRejectedValue(new Error("git not found"));

    useAppStore.getState().fetchGitStatus("repo-1", localRepo, true);

    await vi.waitFor(() => {
      const gs = useAppStore.getState().gitStatus["repo-1"];
      expect(gs?.loading).toBe(false);
      expect(gs?.error).toBe("git not found");
    });

    const gs = useAppStore.getState().gitStatus["repo-1"];
    expect(gs.status).toBeNull();
    expect(gs.loading).toBe(false);
  });

  it("error preserves previous status", async () => {
    const localRepo = makeLocalRepo();
    const mockStatus = {
      branchName: "main",
      dirtyCount: 1,
      ahead: 0,
      behind: 0,
    };

    // First: successful fetch
    mockInvoke.mockResolvedValue(mockStatus);
    useAppStore.getState().fetchGitStatus("repo-1", localRepo, true);

    await vi.waitFor(() => {
      const gs = useAppStore.getState().gitStatus["repo-1"];
      expect(gs?.loading).toBe(false);
      expect(gs?.status).toEqual(mockStatus);
    });

    // Second: failed fetch
    mockInvoke.mockRejectedValue(new Error("network timeout"));
    useAppStore.getState().fetchGitStatus("repo-1", localRepo, true);

    await vi.waitFor(() => {
      const gs = useAppStore.getState().gitStatus["repo-1"];
      expect(gs?.loading).toBe(false);
      expect(gs?.error).toBe("network timeout");
    });

    // Previous status should be preserved
    const gs = useAppStore.getState().gitStatus["repo-1"];
    expect(gs.status).toEqual(mockStatus);
  });
});

// ===========================================================================
// 16. clearGitStatusError
// ===========================================================================

describe("clearGitStatusError", () => {
  it("clears error for a repo", async () => {
    // Set up state with an error
    const localRepo = makeLocalRepo();
    mockInvoke.mockRejectedValue(new Error("git not found"));
    useAppStore.getState().fetchGitStatus("repo-1", localRepo, false);

    await vi.waitFor(() => {
      const gs = useAppStore.getState().gitStatus["repo-1"];
      expect(gs?.error).toBe("git not found");
    });

    // Clear the error
    useAppStore.getState().clearGitStatusError("repo-1");

    const gs = useAppStore.getState().gitStatus["repo-1"];
    expect(gs.error).toBeNull();
    // Other fields should be unchanged
    expect(gs.status).toBeNull();
    expect(gs.loading).toBe(false);
  });

  it("is a no-op on non-existent repo", () => {
    const before = { ...useAppStore.getState().gitStatus };
    useAppStore.getState().clearGitStatusError("nonexistent");
    const after = useAppStore.getState().gitStatus;
    expect(after).toEqual(before);
  });
});

// ===========================================================================
// 17. resumeOneShot
// ===========================================================================

describe("resumeOneShot", () => {
  it("returns early if entry not found", async () => {
    await useAppStore.getState().resumeOneShot("nonexistent");

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "resume_oneshot",
      expect.anything(),
    );
  });

  it("returns early if parent repo not found", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "failed",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
    });
    useAppStore.setState({
      repos: [],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "resume_oneshot",
      expect.anything(),
    );
    expect(mockToast.error).toHaveBeenCalled();
  });

  it("returns early if entry has no worktreePath", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "failed",
      branch: "oneshot/fix",
      // no worktreePath
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "resume_oneshot",
      expect.anything(),
    );
    expect(mockToast.error).toHaveBeenCalled();
  });

  it("returns early if entry has no branch", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "failed",
      worktreePath: "/tmp/wt",
      // no branch
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "resume_oneshot",
      expect.anything(),
    );
    expect(mockToast.error).toHaveBeenCalled();
  });

  it("calls invoke with correct arguments", async () => {
    const repo = makeLocalRepo({
      envVars: { MY_VAR: "hello" },
      gitSync: { enabled: true, conflictPrompt: undefined, model: undefined, maxPushRetries: 3 },
      plansDir: "custom/plans/",
    });
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-1",
      title: "Fix the bug",
      prompt: "Fix the flaky test in store.test.ts",
      model: "opus",
      mergeStrategy: "fast-forward",
      status: "failed",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
      session_id: "old-sess",
    });
    useAppStore.setState({
      repos: [repo],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-abc", session_id: "new-sess" });

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    expect(mockInvoke).toHaveBeenCalledWith("resume_oneshot", {
      oneshotId: "oneshot-abc",
      repoId: "repo-1",
      repo: { type: "local", path: "/home/beth/repos/yarr" },
      title: "Fix the bug",
      prompt: "Fix the flaky test in store.test.ts",
      model: "opus",
      mergeStrategy: "fast-forward",
      envVars: { MY_VAR: "hello" },
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      checks: [],
      gitSync: { enabled: true, conflictPrompt: undefined, model: undefined, maxPushRetries: 3 },
      plansDir: "custom/plans/",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
      oldSessionId: "old-sess",
    });
  });

  it("on success: updates entry status to running and saves new session_id", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "failed",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
      session_id: "old-sess",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-abc", session_id: "new-sess" });

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    const entries = useAppStore.getState().oneShotEntries;
    const updated = entries.get("oneshot-abc")!;
    expect(updated.status).toBe("running");
    expect(updated.session_id).toBe("new-sess");
  });

  it("on success: sets up session in sessions map", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "failed",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
      session_id: "old-sess",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-abc", session_id: "new-sess" });

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    const session = useAppStore.getState().sessions.get("oneshot-abc");
    expect(session).toBeDefined();
    expect(session!.running).toBe(true);
    expect(session!.events).toEqual([]);
    expect(session!.session_id).toBe("new-sess");
  });

  it("on success: persists to oneShotStore", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "failed",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
      session_id: "old-sess",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-abc", session_id: "new-sess" });

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    const saved = mockData.get("oneshot-entries") as [string, OneShotEntry][];
    expect(saved).toBeDefined();
    const restoredMap = new Map(saved);
    expect(restoredMap.has("oneshot-abc")).toBe(true);
    expect(restoredMap.get("oneshot-abc")!.status).toBe("running");
    expect(restoredMap.get("oneshot-abc")!.session_id).toBe("new-sess");
  });

  it("on error: shows toast.error", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "failed",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
      session_id: "old-sess",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    mockInvoke.mockRejectedValue(new Error("backend crashed"));

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    expect(mockToast.error).toHaveBeenCalledWith(
      expect.stringContaining("backend crashed"),
    );
  });

  it("on error: does not update entry status", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "failed",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
      session_id: "old-sess",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    mockInvoke.mockRejectedValue(new Error("backend crashed"));

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    const entries = useAppStore.getState().oneShotEntries;
    const unchanged = entries.get("oneshot-abc")!;
    expect(unchanged.status).toBe("failed");
  });

  it("defaults plansDir to docs/plans/ when repo has no plansDir", async () => {
    const repo = makeLocalRepo({
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      checks: [],
      // no plansDir
    });
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "failed",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
      session_id: "old-sess",
    });
    useAppStore.setState({
      repos: [repo],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-abc", session_id: "new-sess" });

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    expect(mockInvoke).toHaveBeenCalledWith(
      "resume_oneshot",
      expect.objectContaining({
        plansDir: "docs/plans/",
      }),
    );
  });

  it("returns early if entry is already running", async () => {
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      status: "running",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
    });
    useAppStore.setState({
      repos: [makeLocalRepo()],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "resume_oneshot",
      expect.anything(),
    );
  });

  it("builds correct repo payload for SSH repos", async () => {
    const repo = makeSshRepo();
    const entry = makeOneShotEntry({
      id: "oneshot-abc",
      parentRepoId: "repo-2",
      status: "failed",
      worktreePath: "/tmp/wt",
      branch: "oneshot/fix",
      session_id: "old-sess",
    });
    useAppStore.setState({
      repos: [repo],
      oneShotEntries: new Map([["oneshot-abc", entry]]),
    });

    mockInvoke.mockResolvedValue({ oneshot_id: "oneshot-abc", session_id: "new-sess" });

    await useAppStore.getState().resumeOneShot("oneshot-abc");

    expect(mockInvoke).toHaveBeenCalledWith(
      "resume_oneshot",
      expect.objectContaining({
        repo: { type: "ssh", sshHost: "dev-server", remotePath: "/home/beth/repos/other" },
      }),
    );
  });
});
