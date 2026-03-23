import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";

import type { RepoConfig } from "../repos";
import type { SessionState } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockFetchGitStatus } = vi.hoisted(() => ({
  mockFetchGitStatus: vi.fn(),
}));

vi.mock("../store", () => ({
  useAppStore: Object.assign(
    // The hook function for selectors
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ fetchGitStatus: mockFetchGitStatus }),
    // Zustand's getState
    { getState: () => ({ fetchGitStatus: mockFetchGitStatus }) },
  ),
}));

// ---------------------------------------------------------------------------
// Import the hook under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { useGitStatus } from "./useGitStatus";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLocalRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    type: "local",
    id: "local-1",
    path: "/home/beth/repos/my-project",
    name: "my-project",
    model: "opus",
    maxIterations: 40,
    completionSignal: "<promise>COMPLETE</promise>",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeSshRepo(overrides: Record<string, unknown> = {}): RepoConfig {
  return {
    type: "ssh",
    id: "ssh-1",
    sshHost: "dev-server",
    remotePath: "/home/beth/repos/remote-project",
    name: "remote-project",
    model: "opus",
    maxIterations: 40,
    completionSignal: "<promise>COMPLETE</promise>",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    running: false,
    events: [],
    trace: null,
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockFetchGitStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useGitStatus", () => {
  // =========================================================================
  // 1. On mount, fetches status for all repos
  // =========================================================================

  it("fetches status for all repos on mount with correct fetch flags", () => {
    const localRepo = makeLocalRepo();
    const sshRepo = makeSshRepo();
    const sessions = new Map<string, SessionState>();

    renderHook(() => useGitStatus([localRepo, sshRepo], sessions));

    // Local repos default autoFetch=true → fetch: true
    expect(mockFetchGitStatus).toHaveBeenCalledWith("local-1", localRepo, true);
    // SSH repos default autoFetch=false → fetch: false
    expect(mockFetchGitStatus).toHaveBeenCalledWith("ssh-1", sshRepo, false);
    expect(mockFetchGitStatus).toHaveBeenCalledTimes(2);
  });

  // =========================================================================
  // 2. Respects explicit autoFetch override
  // =========================================================================

  it("local repo with autoFetch: false passes fetch: false", () => {
    const localRepo = makeLocalRepo({ autoFetch: false });
    const sessions = new Map<string, SessionState>();

    renderHook(() => useGitStatus([localRepo], sessions));

    expect(mockFetchGitStatus).toHaveBeenCalledWith(
      "local-1",
      localRepo,
      false,
    );
  });

  it("SSH repo with autoFetch: true passes fetch: true", () => {
    const sshRepo = makeSshRepo({ autoFetch: true });
    const sessions = new Map<string, SessionState>();

    renderHook(() => useGitStatus([sshRepo], sessions));

    expect(mockFetchGitStatus).toHaveBeenCalledWith("ssh-1", sshRepo, true);
  });

  // =========================================================================
  // 3. Sets up 30-second polling interval
  // =========================================================================

  it("polls eligible repos every 30 seconds", () => {
    const localRepo = makeLocalRepo();
    const sessions = new Map<string, SessionState>();

    renderHook(() => useGitStatus([localRepo], sessions));

    // Initial mount call
    expect(mockFetchGitStatus).toHaveBeenCalledTimes(1);

    // Advance 30 seconds — should trigger another poll
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(mockFetchGitStatus).toHaveBeenCalledTimes(2);

    // Advance another 30 seconds — confirms interval, not just timeout
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(mockFetchGitStatus).toHaveBeenCalledTimes(3);
  });

  // =========================================================================
  // 4. Polling skips repos with active sessions
  // =========================================================================

  it("skips repos with active sessions during interval polling", () => {
    const localRepo1 = makeLocalRepo({ id: "active-repo" });
    const localRepo2 = makeLocalRepo({
      id: "idle-repo",
      path: "/other/path",
    });

    const sessions = new Map<string, SessionState>();
    sessions.set("active-repo", makeSessionState({ running: true }));

    renderHook(() => useGitStatus([localRepo1, localRepo2], sessions));

    // Both are fetched on mount
    expect(mockFetchGitStatus).toHaveBeenCalledTimes(2);
    mockFetchGitStatus.mockClear();

    // Advance 30 seconds — only idle repo should be polled
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(mockFetchGitStatus).toHaveBeenCalledTimes(1);
    expect(mockFetchGitStatus).toHaveBeenCalledWith(
      "idle-repo",
      localRepo2,
      true,
    );
  });

  // =========================================================================
  // 5. Polling skips repos with autoFetch disabled
  // =========================================================================

  it("skips repos with autoFetch disabled during interval polling but fetches on mount", () => {
    const sshRepo = makeSshRepo(); // autoFetch defaults to false for SSH
    const sessions = new Map<string, SessionState>();

    renderHook(() => useGitStatus([sshRepo], sessions));

    // Should be fetched on mount (with fetch: false)
    expect(mockFetchGitStatus).toHaveBeenCalledTimes(1);
    expect(mockFetchGitStatus).toHaveBeenCalledWith("ssh-1", sshRepo, false);

    mockFetchGitStatus.mockClear();

    // Advance 30 seconds — SSH repo should NOT be polled
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(mockFetchGitStatus).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 6. Manual refresh always passes fetch: true
  // =========================================================================

  it("manual refresh always passes fetch: true", () => {
    const sshRepo = makeSshRepo(); // autoFetch defaults to false
    const sessions = new Map<string, SessionState>();

    const { result } = renderHook(() => useGitStatus([sshRepo], sessions));

    mockFetchGitStatus.mockClear();

    act(() => {
      result.current.refresh("ssh-1");
    });

    expect(mockFetchGitStatus).toHaveBeenCalledWith("ssh-1", sshRepo, true);
  });

  // =========================================================================
  // 7. Session completion triggers immediate fetch
  // =========================================================================

  it("triggers immediate fetch when a session transitions from running to not-running", () => {
    const localRepo = makeLocalRepo();

    const runningSessions = new Map<string, SessionState>();
    runningSessions.set("local-1", makeSessionState({ running: true }));

    const stoppedSessions = new Map<string, SessionState>();
    stoppedSessions.set("local-1", makeSessionState({ running: false }));

    const { rerender } = renderHook(
      (props: { repos: RepoConfig[]; sessions: Map<string, SessionState> }) =>
        useGitStatus(props.repos, props.sessions),
      {
        initialProps: { repos: [localRepo], sessions: runningSessions },
      },
    );

    // Initial mount call
    expect(mockFetchGitStatus).toHaveBeenCalledTimes(1);
    mockFetchGitStatus.mockClear();

    // Rerender with session no longer running
    act(() => {
      rerender({ repos: [localRepo], sessions: stoppedSessions });
    });

    // Should trigger an immediate fetch for the repo whose session completed
    expect(mockFetchGitStatus).toHaveBeenCalledWith("local-1", localRepo, true);
  });

  // =========================================================================
  // 8. Cleans up interval on unmount
  // =========================================================================

  it("cleans up interval on unmount", () => {
    const localRepo = makeLocalRepo();
    const sessions = new Map<string, SessionState>();

    const { unmount } = renderHook(() => useGitStatus([localRepo], sessions));

    // Initial mount call
    expect(mockFetchGitStatus).toHaveBeenCalledTimes(1);
    mockFetchGitStatus.mockClear();

    unmount();

    // Advance timers — should NOT trigger any more calls
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(mockFetchGitStatus).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 9. Handles empty repos array
  // =========================================================================

  it("handles empty repos array without errors", () => {
    const sessions = new Map<string, SessionState>();

    renderHook(() => useGitStatus([], sessions));

    expect(mockFetchGitStatus).not.toHaveBeenCalled();
  });
});
