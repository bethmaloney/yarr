import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

function makeSshRepo(overrides: Record<string, unknown> = {}): RepoConfig {
  return {
    type: "ssh",
    id: "repo-1",
    sshHost: "dev-server",
    remotePath: "/home/beth/repos/remote-project",
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

function makeSessionState(
  overrides: Partial<SessionState> = {},
): SessionState {
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
}

function setupMockState(overrides: Partial<MockState> = {}): MockState {
  const state: MockState = {
    repos: [],
    sessions: new Map(),
    oneShotEntries: new Map(),
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
    it('shows "Not found" when oneshotId does not match any entry', () => {
      setupMockState({
        oneShotEntries: new Map([["oneshot-other", makeEntry({ id: "oneshot-other" })]]),
      });
      renderOneShotDetail("oneshot-nonexistent");

      expect(screen.getByText(/not found/i)).toBeInTheDocument();
    });

    it('shows "Not found" when oneShotEntries is empty', () => {
      setupMockState({ oneShotEntries: new Map() });
      renderOneShotDetail();

      expect(screen.getByText(/not found/i)).toBeInTheDocument();
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
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry()],
        ]),
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
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry()],
        ]),
      });
      renderOneShotDetail();

      expect(screen.getByText("1-Shot")).toBeInTheDocument();
    });

    it('shows "from {parentRepoName}" subtitle', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({ parentRepoName: "awesome-repo" }),
          ],
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
              prompt: "Fix the login bug where users get redirected incorrectly",
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

      expect(
        screen.getByRole("button", { name: /stop/i }),
      ).toBeInTheDocument();
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
            makeSessionState({ running: true, events: [] }),
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

      expect(
        screen.getByText("Design phase timed out"),
      ).toBeInTheDocument();
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
            makeSessionState({ running: false, events: [] }),
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
      expect(phaseEl.className).toContain("text-red-400");
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
      expect(phaseEl.className).toContain("text-emerald-400");
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

    it("passes correct repoPath derived from parent local repo", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({ parentRepoId: "repo-1" }),
          ],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ events: [] })],
        ]),
      });
      renderOneShotDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute(
        "data-repo-path",
        "/home/beth/repos/my-project",
      );
    });

    it("passes remotePath as repoPath for SSH parent repo", () => {
      setupMockState({
        repos: [makeSshRepo()],
        oneShotEntries: new Map([
          [
            "oneshot-abc123",
            makeEntry({ parentRepoId: "repo-1" }),
          ],
        ]),
        sessions: new Map([
          ["oneshot-abc123", makeSessionState({ events: [] })],
        ]),
      });
      renderOneShotDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute(
        "data-repo-path",
        "/home/beth/repos/remote-project",
      );
    });
  });

  // =========================================================================
  // Error section
  // =========================================================================

  describe("error section", () => {
    it("is not shown when session.error is null", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry()],
        ]),
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
        oneShotEntries: new Map([
          ["oneshot-abc123", makeEntry()],
        ]),
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
          [
            "oneshot-abc123",
            makeSessionState({ running: true }),
          ],
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
});
