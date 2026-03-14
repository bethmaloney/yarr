import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";

import type { RepoConfig } from "../repos";
import type {
  OneShotEntry,
  SessionState,
  SessionTrace,
  SessionEvent,
} from "../types";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
}));

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

const { mockUseAppStore } = vi.hoisted(() => ({
  mockUseAppStore: vi.fn(),
}));

const mockResumeOneShot = vi.fn();

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("../store", () => ({
  useAppStore: mockUseAppStore,
}));

// Mock PlanPanel to avoid Sheet complexity
vi.mock("../PlanPanel", () => ({
  PlanPanel: ({
    open,
    planContent,
    planFile,
  }: {
    open: boolean;
    planContent: string;
    planFile: string;
  }) =>
    open ? (
      <div data-testid="plan-panel" data-plan-file={planFile}>
        {planContent}
      </div>
    ) : null,
}));

// Mock EventsList to avoid complexity
vi.mock("../components/EventsList", () => ({
  EventsList: ({
    events,
    isLive,
    repoPath,
  }: {
    events: unknown[];
    isLive?: boolean;
    repoPath?: string;
  }) => (
    <div
      data-testid="events-list"
      data-is-live={isLive}
      data-repo-path={repoPath}
      data-event-count={events.length}
    >
      {events.length} events
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Import the component under test (after mocks are registered)
// ---------------------------------------------------------------------------

import OneShotDetail from "./OneShotDetail";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLocalRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    type: "local",
    id: "repo-1",
    path: "/home/beth/repos/my-project",
    name: "my-project",
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
    id: "repo-ssh-1",
    sshHost: "devbox",
    remotePath: "/home/user/repos/remote-project",
    name: "remote-project",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeEntry(overrides: Partial<OneShotEntry> = {}): OneShotEntry {
  return {
    id: "oneshot-abc123",
    parentRepoId: "repo-1",
    parentRepoName: "my-project",
    title: "Fix login bug",
    prompt: "Fix the login bug where users get redirected incorrectly",
    model: "opus",
    effortLevel: "medium",
    designEffortLevel: "high",
    mergeStrategy: "merge_to_main",
    status: "running",
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    session_id: "sess-abc-123",
    repo_path: "/home/beth/repos/my-project",
    prompt: "Fix the login bug where users get redirected incorrectly",
    plan_file: null,
    plan_content: null,
    repo_id: "repo-1",
    session_type: "one_shot",
    start_time: "2026-03-10T10:00:00Z",
    end_time: "2026-03-10T10:30:00Z",
    outcome: "completed",
    failure_reason: null,
    total_iterations: 3,
    total_cost_usd: 0.8765,
    total_input_tokens: 8000,
    total_output_tokens: 4000,
    total_cache_read_tokens: 1000,
    total_cache_creation_tokens: 200,
    ...overrides,
  };
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

interface MockState {
  repos: RepoConfig[];
  sessions: Map<string, SessionState>;
  oneShotEntries: Map<string, OneShotEntry>;
  resumeOneShot?: ReturnType<typeof vi.fn>;
}

function setupMockState(overrides: Partial<MockState> = {}): MockState {
  const state: MockState = {
    repos: [],
    sessions: new Map(),
    oneShotEntries: new Map(),
    resumeOneShot: mockResumeOneShot,
    ...overrides,
  };

  mockUseAppStore.mockImplementation((selector: unknown) => {
    if (typeof selector === "function") {
      return (selector as (s: MockState) => unknown)(state);
    }
    return state;
  });

  return state;
}

function renderOneShotDetail(oneshotId = "oneshot-abc123") {
  return render(
    <MemoryRouter initialEntries={[`/oneshot/${oneshotId}`]}>
      <Routes>
        <Route path="/oneshot/:oneshotId" element={<OneShotDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(null);
  setupMockState();
});

afterEach(() => {
  cleanup();
});

describe("OneShotDetail", () => {
  // =========================================================================
  // 1. Not found state
  // =========================================================================

  describe("not found state", () => {
    it('shows "Not found" when oneshotId does not match any entry', async () => {
      setupMockState({
        oneShotEntries: new Map([
          ["oneshot-other", makeEntry({ id: "oneshot-other" })],
        ]),
      });
      renderOneShotDetail("oneshot-nonexistent");

      await waitFor(() => {
        expect(screen.getByText(/not found/i)).toBeInTheDocument();
      });
    });

    it('shows "Not found" when oneShotEntries is empty', async () => {
      setupMockState({ oneShotEntries: new Map() });
      renderOneShotDetail();

      await waitFor(() => {
        expect(screen.getByText(/not found/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 2. Breadcrumbs
  // =========================================================================

  describe("breadcrumbs", () => {
    it("renders Home > {title} > 1-Shot breadcrumbs", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ title: "Fix login bug" })],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("Home")).toBeInTheDocument();
      expect(screen.getByText("1-Shot")).toBeInTheDocument();
      expect(
        screen.getAllByText("Fix login bug").length,
      ).toBeGreaterThanOrEqual(1);
    });

    it('clicking "Home" navigates to "/"', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([["oneshot-abc123", makeEntry()]]),
      });
      renderOneShotDetail();

      fireEvent.click(screen.getByText("Home"));

      expect(mockNavigate).toHaveBeenCalledWith("/");
    });
  });

  // =========================================================================
  // 3. Header
  // =========================================================================

  describe("header", () => {
    it("shows the entry title", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ title: "Refactor auth module" })],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("Refactor auth module")).toBeInTheDocument();
    });

    it('shows "1-Shot" badge', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([["oneshot-abc123", makeEntry()]]),
      });
      renderOneShotDetail();

      expect(screen.getByText("1-Shot")).toBeInTheDocument();
    });

    it('shows "from {parentRepoName}" subtitle', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ parentRepoName: "awesome-repo" })],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText(/from awesome-repo/)).toBeInTheDocument();
    });

    it("prompt is displayed in a read-only block", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({
              prompt:
                "Fix the login bug where users get redirected incorrectly",
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(
        screen.getByText(
          "Fix the login bug where users get redirected incorrectly",
        ),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 4. Active mode (running)
  // =========================================================================

  describe("active mode (running)", () => {
    it("stop button is visible when session is running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ running: true })],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    });

    it('stop button calls invoke("stop_session", { repoId: oneshotId })', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ running: true })],
        ]),
      });
      renderOneShotDetail();

      const stopButton = screen.getByRole("button", { name: /stop/i });
      fireEvent.click(stopButton);

      expect(mockInvoke).toHaveBeenCalledWith("stop_session", {
        repoId: "oneshot-abc123",
      });
    });

    it("trace summary is NOT shown when running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ running: true })],
        ]),
      });
      renderOneShotDetail();

      expect(screen.queryByText("Result")).not.toBeInTheDocument();
      expect(screen.queryByText("Outcome")).not.toBeInTheDocument();
    });

    it("EventsList gets isLive=true when running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: true,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute("data-is-live", "true");
    });
  });

  // =========================================================================
  // 5. Read-only mode (completed/failed)
  // =========================================================================

  describe("read-only mode (completed/failed)", () => {
    it("stop button is NOT visible when not running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace(),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(
        screen.queryByRole("button", { name: /stop/i }),
      ).not.toBeInTheDocument();
    });

    it("trace summary is shown when trace exists (outcome, iterations, cost, session ID)", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace({
                outcome: "completed",
                total_iterations: 5,
                total_cost_usd: 1.2345,
                session_id: "sess-xyz-789",
              }),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("completed")).toBeInTheDocument();
      expect(screen.getByText("5")).toBeInTheDocument();
      expect(screen.getByText(/\$1\.2345/)).toBeInTheDocument();
      expect(screen.getByText("sess-xyz-789")).toBeInTheDocument();
    });

    it("shows failure reason when present", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "failed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace({
                outcome: "failed",
                failure_reason: "Design phase timed out",
              }),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("Design phase timed out")).toBeInTheDocument();
    });

    it("EventsList gets isLive=false when not running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute("data-is-live", "false");
    });
  });

  // =========================================================================
  // 6. Phase indicator
  // =========================================================================

  describe("phase indicator", () => {
    it("shows phase label for design phase", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: true,
              events: [
                { kind: "one_shot_started" },
                { kind: "design_phase_started" },
              ],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("Design Phase")).toBeInTheDocument();
    });

    it("shows phase label for implementation phase", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: true,
              events: [
                { kind: "one_shot_started" },
                { kind: "design_phase_started" },
                { kind: "design_phase_complete" },
                { kind: "implementation_phase_started" },
              ],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("Implementation Phase")).toBeInTheDocument();
    });

    it("has failed styling for failed phase", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "failed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              events: [
                { kind: "one_shot_started" },
                { kind: "one_shot_failed" },
              ],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      const phaseEl = screen.getByText("Failed");
      expect(phaseEl).toBeInTheDocument();
      expect(phaseEl.className).toContain("text-destructive");
    });

    it("has complete styling for complete phase", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              events: [
                { kind: "one_shot_started" },
                { kind: "one_shot_complete" },
              ],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      const phaseEl = screen.getByText("Complete");
      expect(phaseEl).toBeInTheDocument();
      expect(phaseEl.className).toContain("text-success");
    });
  });

  // =========================================================================
  // 7. EventsList integration
  // =========================================================================

  describe("EventsList integration", () => {
    it("passes events to EventsList", () => {
      const events: SessionEvent[] = [
        { kind: "one_shot_started" },
        { kind: "design_phase_started" },
        { kind: "tool_use", tool_name: "Read" },
      ];
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ running: true, events })],
        ]),
      });
      renderOneShotDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute("data-event-count", "3");
    });

    it("passes worktreePath as repoPath for 1-shot sessions", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({
              parentRepoId: "repo-1",
              worktreePath: "/home/beth/.yarr/worktrees/abc123-oneshot-def/",
            }),
          ],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({ events: [{ kind: "one_shot_started" }] }),
          ],
        ]),
      });
      renderOneShotDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute(
        "data-repo-path",
        "/home/beth/.yarr/worktrees/abc123-oneshot-def/",
      );
    });

    it("passes undefined repoPath when worktreePath is not set", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ parentRepoId: "repo-1" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({ events: [{ kind: "one_shot_started" }] }),
          ],
        ]),
      });
      renderOneShotDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).not.toHaveAttribute("data-repo-path");
    });
  });

  // =========================================================================
  // Error section
  // =========================================================================

  describe("error section", () => {
    it("is not shown when session.error is null", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([["oneshot-abc123", makeEntry()]]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ error: null })],
        ]),
      });
      renderOneShotDetail();

      expect(screen.queryByText("Error")).not.toBeInTheDocument();
    });

    it("shows error message in a pre block when session.error exists", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([["oneshot-abc123", makeEntry()]]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({ error: "Process crashed with signal SIGKILL" }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("Error")).toBeInTheDocument();
      const errorText = screen.getByText("Process crashed with signal SIGKILL");
      expect(errorText).toBeInTheDocument();
      expect(errorText.tagName).toBe("PRE");
    });
  });

  // =========================================================================
  // Empty state
  // =========================================================================

  describe("empty state", () => {
    it("shows 'Session starting...' when running with no events", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ running: true, events: [] })],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText(/Session starting/)).toBeInTheDocument();
      expect(screen.queryByTestId("events-list")).not.toBeInTheDocument();
    });

    it("shows 'Session was interrupted' with Resume button when failed with worktreePath", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({
              status: "failed",
              worktreePath: "/tmp/worktrees/oneshot-abc123",
            }),
          ],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ running: false, events: [] })],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText(/Session was interrupted/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /resume/i }),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("events-list")).not.toBeInTheDocument();
    });

    it("Resume button calls resumeOneShot with oneshotId", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({
              status: "failed",
              worktreePath: "/tmp/worktrees/oneshot-abc123",
            }),
          ],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ running: false, events: [] })],
        ]),
      });
      renderOneShotDetail();

      const resumeButton = screen.getByRole("button", { name: /resume/i });
      fireEvent.click(resumeButton);

      expect(mockResumeOneShot).toHaveBeenCalledWith("oneshot-abc123");
    });

    it("shows 'Session failed before starting' when failed without worktreePath", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "failed" })],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ running: false, events: [] })],
        ]),
      });
      renderOneShotDetail();

      expect(
        screen.getByText(/Session failed before starting/),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("events-list")).not.toBeInTheDocument();
    });

    it("shows 'No events recorded' for non-running session with no events and no trace", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({ running: false, events: [], trace: null }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText(/No events recorded/)).toBeInTheDocument();
      expect(screen.queryByTestId("events-list")).not.toBeInTheDocument();
    });

    it("shows EventsList when events exist (no empty state)", () => {
      const events: SessionEvent[] = [
        { kind: "one_shot_started" },
        { kind: "design_phase_started" },
      ];
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ running: true, events })],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByTestId("events-list")).toBeInTheDocument();
      expect(screen.queryByText(/Session starting/)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Session was interrupted/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Session failed before starting/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/No events recorded/)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // 8. Prompt always visible
  // =========================================================================

  describe("prompt always visible", () => {
    it("prompt is visible when running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({
              status: "running",
              prompt: "Implement feature X",
            }),
          ],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ running: true })],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("Implement feature X")).toBeInTheDocument();
    });

    it("prompt is visible when completed", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({
              status: "completed",
              prompt: "Implement feature X",
            }),
          ],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace(),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("Implement feature X")).toBeInTheDocument();
    });

    it("prompt is visible when failed", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({
              status: "failed",
              prompt: "Implement feature X",
            }),
          ],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace({ outcome: "failed" }),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("Implement feature X")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 9. Peak context display
  // =========================================================================

  describe("peak context display", () => {
    it('shows "Peak Context" with percentage when events have context data', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace(),
              events: [
                {
                  kind: "iteration_started",
                  iteration: 1,
                  _ts: Date.now(),
                },
                {
                  kind: "iteration_complete",
                  iteration: 1,
                  _ts: Date.now(),
                  result: {
                    total_cost_usd: 0.15,
                    usage: {
                      input_tokens: 50000,
                      output_tokens: 1000,
                      cache_read_input_tokens: 20000,
                      cache_creation_input_tokens: 5000,
                    },
                    model_usage: {
                      "claude-opus-4-6": {
                        contextWindow: 200000,
                      },
                    },
                  },
                },
              ],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      // inputTokens = 50000 + 20000 + 5000 = 75000; 75000/200000 = 37.5 → 38%
      expect(screen.getByText(/Peak Context/)).toBeInTheDocument();
      expect(screen.getByText(/38%/)).toBeInTheDocument();
    });

    it('does not show "Peak Context" when no context data in events', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace(),
              events: [
                {
                  kind: "iteration_started",
                  iteration: 1,
                  _ts: Date.now(),
                },
                {
                  kind: "iteration_complete",
                  iteration: 1,
                  _ts: Date.now(),
                  result: {
                    total_cost_usd: 0.05,
                    usage: {
                      input_tokens: 5000,
                      cache_read_input_tokens: 0,
                      cache_creation_input_tokens: 0,
                      output_tokens: 500,
                    },
                  },
                },
              ],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      // No model_usage means no contextWindow, so maxContextPercent returns 0
      // and "Peak Context" label should not appear
      expect(screen.queryByText(/Peak Context/)).not.toBeInTheDocument();
    });

    it('does not show "Peak Context" when session is running', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: true,
              events: [
                {
                  kind: "iteration_started",
                  iteration: 1,
                  _ts: Date.now(),
                },
                {
                  kind: "iteration_complete",
                  iteration: 1,
                  _ts: Date.now(),
                  result: {
                    total_cost_usd: 0.15,
                    usage: {
                      input_tokens: 150000,
                      output_tokens: 1000,
                      cache_read_input_tokens: 20000,
                      cache_creation_input_tokens: 5000,
                    },
                    model_usage: {
                      "claude-opus-4-6": {
                        contextWindow: 200000,
                      },
                    },
                  },
                },
              ],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      // Result section (and thus Peak Context) should not show when running
      expect(screen.queryByText("Result")).not.toBeInTheDocument();
      expect(screen.queryByText(/Peak Context/)).not.toBeInTheDocument();
    });

    it("shows the maximum across multiple iterations", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace(),
              events: [
                {
                  kind: "iteration_started",
                  iteration: 1,
                  _ts: Date.now(),
                },
                {
                  kind: "iteration_complete",
                  iteration: 1,
                  _ts: Date.now(),
                  result: {
                    total_cost_usd: 0.1,
                    usage: {
                      input_tokens: 170000,
                      cache_read_input_tokens: 10000,
                      cache_creation_input_tokens: 0,
                      output_tokens: 800,
                    },
                    model_usage: {
                      "claude-opus-4-6": {
                        contextWindow: 200000,
                      },
                    },
                  },
                },
                {
                  kind: "iteration_started",
                  iteration: 2,
                  _ts: Date.now(),
                },
                {
                  kind: "iteration_complete",
                  iteration: 2,
                  _ts: Date.now(),
                  result: {
                    total_cost_usd: 0.08,
                    usage: {
                      input_tokens: 40000,
                      cache_read_input_tokens: 5000,
                      cache_creation_input_tokens: 0,
                      output_tokens: 600,
                    },
                    model_usage: {
                      "claude-opus-4-6": {
                        contextWindow: 200000,
                      },
                    },
                  },
                },
              ],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      // Iteration 1: (170000+10000+0)/200000 = 90%
      // Iteration 2: (40000+5000+0)/200000 = 23%
      // Peak should be 90%, not 23%
      expect(screen.getByText(/90%/)).toBeInTheDocument();
      expect(screen.queryByText(/23%/)).not.toBeInTheDocument();
    });

    it("applies correct color styling based on percentage", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace(),
              events: [
                {
                  kind: "iteration_started",
                  iteration: 1,
                  _ts: Date.now(),
                },
                {
                  kind: "iteration_complete",
                  iteration: 1,
                  _ts: Date.now(),
                  result: {
                    total_cost_usd: 0.15,
                    usage: {
                      input_tokens: 170000,
                      output_tokens: 1000,
                      cache_read_input_tokens: 10000,
                      cache_creation_input_tokens: 0,
                    },
                    model_usage: {
                      "claude-opus-4-6": {
                        contextWindow: 200000,
                      },
                    },
                  },
                },
              ],
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      // inputTokens = 170000 + 10000 + 0 = 180000; 180000/200000 = 90%
      // sessionContextColor(90) → "var(--destructive)" (red, since >85%)
      const percentSpan = screen.getByText(/90%/);
      expect(percentSpan).toHaveStyle({ color: "var(--destructive)" });
    });
  });

  // =========================================================================
  // 10. Disk fallback (no entry in store)
  // =========================================================================

  describe("disk fallback (no entry in store)", () => {
    const diskTrace = makeTrace({
      session_id: "sess-disk-001",
      repo_id: "oneshot-abc123",
      prompt: "Fix the login bug where users get redirected incorrectly",
      outcome: "completed",
      total_iterations: 3,
      total_cost_usd: 0.8765,
    });

    const diskEvents: SessionEvent[] = [
      { kind: "one_shot_started", session_id: "sess-disk-001" },
      { kind: "design_phase_started", session_id: "sess-disk-001" },
      { kind: "design_phase_complete", session_id: "sess-disk-001" },
      { kind: "implementation_phase_started", session_id: "sess-disk-001" },
      { kind: "one_shot_complete", session_id: "sess-disk-001" },
    ];

    function setupDiskFallbackMocks(
      traces: ReturnType<typeof makeTrace>[] = [diskTrace],
      events: SessionEvent[] = diskEvents,
    ) {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "list_traces") return Promise.resolve(traces);
        if (cmd === "get_trace_events") return Promise.resolve(events);
        return Promise.resolve(null);
      });
    }

    it("calls list_traces when entry is missing from store", async () => {
      setupMockState({ oneShotEntries: new Map() });
      setupDiskFallbackMocks();

      renderOneShotDetail("oneshot-abc123");

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("list_traces", {
          repoId: "oneshot-abc123",
        });
      });
    });

    it("calls get_trace_events after list_traces returns traces", async () => {
      setupMockState({ oneShotEntries: new Map() });
      setupDiskFallbackMocks();

      renderOneShotDetail("oneshot-abc123");

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("get_trace_events", {
          repoId: "oneshot-abc123",
          sessionId: "sess-disk-001",
        });
      });
    });

    it("renders trace result section with fallback data", async () => {
      setupMockState({ oneShotEntries: new Map() });
      setupDiskFallbackMocks();

      renderOneShotDetail("oneshot-abc123");

      await waitFor(() => {
        expect(screen.getByText("Result")).toBeInTheDocument();
      });

      expect(screen.getByText("completed")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
      expect(screen.getByText(/\$0\.8765/)).toBeInTheDocument();
      expect(screen.getByText("sess-disk-001")).toBeInTheDocument();
    });

    it("renders events list with fallback events", async () => {
      setupMockState({ oneShotEntries: new Map() });
      setupDiskFallbackMocks();

      renderOneShotDetail("oneshot-abc123");

      await waitFor(() => {
        const eventsList = screen.getByTestId("events-list");
        expect(eventsList).toHaveAttribute(
          "data-event-count",
          String(diskEvents.length),
        );
      });
    });

    it("shows header info from trace data (prompt and derived title)", async () => {
      setupMockState({ oneShotEntries: new Map() });
      setupDiskFallbackMocks([
        makeTrace({
          prompt: "Fix the login bug where users get redirected incorrectly",
        }),
      ]);

      renderOneShotDetail("oneshot-abc123");

      await waitFor(() => {
        expect(
          screen.getByText(
            "Fix the login bug where users get redirected incorrectly",
          ),
        ).toBeInTheDocument();
      });
    });

    it("shows loading state while fetching from disk", () => {
      setupMockState({ oneShotEntries: new Map() });
      // Use a never-resolving promise to keep it in loading state
      mockInvoke.mockImplementation(() => new Promise(() => {}));

      renderOneShotDetail("oneshot-abc123");

      // Should NOT show "Not found" while loading
      expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
    });

    it('shows "Not found" only when list_traces returns empty array', async () => {
      setupMockState({ oneShotEntries: new Map() });
      setupDiskFallbackMocks([], []);

      renderOneShotDetail("oneshot-abc123");

      await waitFor(() => {
        expect(screen.getByText(/not found/i)).toBeInTheDocument();
      });
    });

    it('shows "Not found" when list_traces rejects with an error', async () => {
      setupMockState({ oneShotEntries: new Map() });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "list_traces")
          return Promise.reject(new Error("Disk read failed"));
        return Promise.resolve(null);
      });

      renderOneShotDetail("oneshot-abc123");

      await waitFor(() => {
        expect(screen.getByText(/not found/i)).toBeInTheDocument();
      });
    });

    it("does NOT call list_traces when entry exists in store", () => {
      setupMockState({
        oneShotEntries: new Map([["oneshot-abc123", makeEntry()]]),
      });
      setupDiskFallbackMocks();

      renderOneShotDetail("oneshot-abc123");

      expect(mockInvoke).not.toHaveBeenCalledWith(
        "list_traces",
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // 11. PlanPanel integration
  // =========================================================================

  describe("PlanPanel integration", () => {
    it('"View Plan" button is visible when trace has plan_content', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace({
                plan_content: "# My Plan\nDo the thing.",
                plan_file: "/home/beth/repos/my-project/plan.md",
              }),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(
        screen.getByRole("button", { name: /view plan/i }),
      ).toBeInTheDocument();
    });

    it('"View Plan" button is NOT visible when trace has no plan_content', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace({
                plan_content: null,
                plan_file: null,
              }),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(
        screen.queryByRole("button", { name: /view plan/i }),
      ).not.toBeInTheDocument();
    });

    it('"View Plan" button is NOT visible when session is running', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "running" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: true,
              trace: makeTrace({
                plan_content: "# My Plan\nDo the thing.",
                plan_file: "/home/beth/repos/my-project/plan.md",
              }),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(
        screen.queryByRole("button", { name: /view plan/i }),
      ).not.toBeInTheDocument();
    });

    it('clicking "View Plan" opens PlanPanel', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace({
                plan_content: "# My Plan\nDo the thing.",
                plan_file: "/home/beth/repos/my-project/plan.md",
              }),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      // PlanPanel should not be visible before clicking
      expect(screen.queryByTestId("plan-panel")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /view plan/i }));

      expect(screen.getByTestId("plan-panel")).toBeInTheDocument();
      expect(screen.getByTestId("plan-panel")).toHaveTextContent(
        "# My Plan Do the thing.",
      );
    });

    it("PlanPanel is not rendered when plan_content is null", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace({
                plan_content: null,
                plan_file: null,
              }),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      expect(screen.queryByTestId("plan-panel")).not.toBeInTheDocument();
    });

    it("PlanPanel receives correct planFile and planContent props", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry({ status: "completed" })],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({
              running: false,
              trace: makeTrace({
                plan_content: "## Step 1\nRefactor the module.",
                plan_file: "/home/beth/repos/my-project/design.md",
              }),
            }),
          ],
        ]),
      });
      renderOneShotDetail();

      fireEvent.click(screen.getByRole("button", { name: /view plan/i }));

      const panel = screen.getByTestId("plan-panel");
      expect(panel).toHaveAttribute(
        "data-plan-file",
        "/home/beth/repos/my-project/design.md",
      );
      expect(panel).toHaveTextContent("## Step 1 Refactor the module.");
    });
  });

  // =========================================================================
  // SSH host prefix on worktree path
  // =========================================================================

  describe("SSH host prefix on worktree path", () => {
    it("displays worktree path as-is for local parent repo", () => {
      setupMockState({
        repos: [makeLocalRepo({ id: "repo-1" })],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({
              parentRepoId: "repo-1",
              worktreePath: "/home/beth/.yarr/worktrees/abc123-oneshot-def/",
            }),
          ],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({ events: [{ kind: "one_shot_started" }] }),
          ],
        ]),
      });
      renderOneShotDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute(
        "data-repo-path",
        "/home/beth/.yarr/worktrees/abc123-oneshot-def/",
      );
    });

    it("prefixes worktree path with sshHost: for SSH parent repo", () => {
      setupMockState({
        repos: [makeSshRepo({ id: "repo-ssh-1" })],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({
              parentRepoId: "repo-ssh-1",
              worktreePath: "/home/user/.yarr/worktrees/abc123-oneshot-def/",
            }),
          ],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({ events: [{ kind: "one_shot_started" }] }),
          ],
        ]),
      });
      renderOneShotDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute(
        "data-repo-path",
        "devbox:/home/user/.yarr/worktrees/abc123-oneshot-def/",
      );
    });

    it("displays worktree path as-is when parent repo is not found in repos list", () => {
      setupMockState({
        repos: [], // no repos — parent repo not found
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({
              parentRepoId: "repo-nonexistent",
              worktreePath: "/home/beth/.yarr/worktrees/abc123-oneshot-def/",
            }),
          ],
        ]),
        sessions: new Map([
          [
            "oneshot-abc123",
            makeSessionState({ events: [{ kind: "one_shot_started" }] }),
          ],
        ]),
      });
      renderOneShotDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute(
        "data-repo-path",
        "/home/beth/.yarr/worktrees/abc123-oneshot-def/",
      );
    });
  });
});
