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
import type { SessionState, SessionTrace, SessionEvent } from "../types";

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

import OneShot from "./OneShot";

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

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    session_id: "sess-abc-123",
    repo_path: "/home/beth/repos/my-project",
    prompt: "Implement feature X",
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
}

function setupMockState(overrides: Partial<MockState> = {}): MockState {
  const state: MockState = {
    repos: [],
    sessions: new Map(),
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

function renderOneShot(repoId = "repo-1") {
  return render(
    <MemoryRouter initialEntries={[`/repo/${repoId}/oneshot`]}>
      <Routes>
        <Route path="/repo/:repoId/oneshot" element={<OneShot />} />
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

describe("OneShot", () => {
  // =========================================================================
  // 1. Not found state
  // =========================================================================

  describe("not found state", () => {
    it('shows "Repo not found" when repoId does not match any repo', () => {
      setupMockState({ repos: [makeLocalRepo({ id: "other-id" } as Partial<RepoConfig>)] });
      renderOneShot("non-existent-id");

      expect(screen.getByText(/repo not found/i)).toBeInTheDocument();
    });

    it('shows "Repo not found" when repos list is empty', () => {
      setupMockState({ repos: [] });
      renderOneShot();

      expect(screen.getByText(/repo not found/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 2. Breadcrumbs
  // =========================================================================

  describe("breadcrumbs", () => {
    it("renders Home > RepoName > 1-Shot breadcrumbs", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      expect(screen.getByText("Home")).toBeInTheDocument();
      expect(screen.getAllByText("my-project").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("1-Shot")).toBeInTheDocument();
    });

    it('clicking "Home" navigates to "/"', () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      fireEvent.click(screen.getByText("Home"));

      expect(mockNavigate).toHaveBeenCalledWith("/");
    });

    it('clicking repo name navigates to "/repo/{repoId}"', () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      // The breadcrumb repo name link — find the one that is clickable
      // There may be multiple "my-project" (breadcrumb + header), so find the breadcrumb one
      const breadcrumbLinks = screen.getAllByText("my-project");
      // Click the first one (breadcrumb)
      fireEvent.click(breadcrumbLinks[0]);

      expect(mockNavigate).toHaveBeenCalledWith("/repo/repo-1");
    });
  });

  // =========================================================================
  // 3. Header
  // =========================================================================

  describe("header", () => {
    it('shows repo name with "-- 1-Shot" suffix', () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      expect(screen.getByText(/my-project.*1-Shot/)).toBeInTheDocument();
    });

    it("shows repo path for local repo", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      expect(
        screen.getByText("/home/beth/repos/my-project"),
      ).toBeInTheDocument();
    });

    it("shows sshHost:remotePath for SSH repo", () => {
      setupMockState({ repos: [makeSshRepo()] });
      renderOneShot();

      expect(
        screen.getByText(/dev-server.*\/home\/beth\/repos\/remote-project/),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 4. Form (when not running)
  // =========================================================================

  describe("form (when not running)", () => {
    it("shows title input field", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      expect(screen.getByText("Title")).toBeInTheDocument();
    });

    it("shows prompt textarea field", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      expect(screen.getByText("Prompt")).toBeInTheDocument();
    });

    it("shows model input field", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      expect(screen.getByText("Model")).toBeInTheDocument();
    });

    it("model defaults to repo's model value", () => {
      setupMockState({
        repos: [makeLocalRepo({ model: "sonnet" } as Partial<RepoConfig>)],
      });
      renderOneShot();

      expect(screen.getByDisplayValue("sonnet")).toBeInTheDocument();
    });

    it("shows merge strategy radio buttons", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      expect(screen.getByText(/merge strategy/i)).toBeInTheDocument();
      expect(screen.getByText(/merge to main/i)).toBeInTheDocument();
      expect(screen.getByText(/create branch/i)).toBeInTheDocument();
    });

    it("merge strategy defaults to merge_to_main", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      const mergeToMainRadio = screen.getByDisplayValue("merge_to_main");
      expect(mergeToMainRadio).toBeChecked();
    });

    it("form is hidden when session is running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ running: true })],
        ]),
      });
      renderOneShot();

      // Title label/input should not be visible when running
      expect(screen.queryByText("Title")).not.toBeInTheDocument();
      expect(screen.queryByText("Prompt")).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // 5. Run button
  // =========================================================================

  describe("run button", () => {
    it("is disabled when title is empty", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      // Fill only prompt, not title
      const promptArea = screen.getByRole("textbox", { name: /prompt/i });
      fireEvent.change(promptArea, { target: { value: "some prompt" } });

      const runButton = screen.getByRole("button", { name: /^run$/i });
      expect(runButton).toBeDisabled();
    });

    it("is disabled when prompt is empty", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      // Fill only title, not prompt
      const titleInput = screen.getByRole("textbox", { name: /title/i });
      fireEvent.change(titleInput, { target: { value: "some title" } });

      const runButton = screen.getByRole("button", { name: /^run$/i });
      expect(runButton).toBeDisabled();
    });

    it("is enabled when title AND prompt are non-empty", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      const titleInput = screen.getByRole("textbox", { name: /title/i });
      fireEvent.change(titleInput, { target: { value: "My Feature" } });

      const promptArea = screen.getByRole("textbox", { name: /prompt/i });
      fireEvent.change(promptArea, { target: { value: "Implement the feature" } });

      const runButton = screen.getByRole("button", { name: /^run$/i });
      expect(runButton).toBeEnabled();
    });

    it('shows "Running..." text when session is running', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ running: true })],
        ]),
      });
      renderOneShot();

      expect(screen.getByText(/running/i)).toBeInTheDocument();
    });

    it("is disabled when session is running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ running: true })],
        ]),
      });
      renderOneShot();

      const runButton = screen.getByRole("button", { name: /running/i });
      expect(runButton).toBeDisabled();
    });

    it('on click, calls invoke("run_oneshot", buildOneShotArgs(...))', () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      const titleInput = screen.getByRole("textbox", { name: /title/i });
      fireEvent.change(titleInput, { target: { value: "Add tests" } });

      const promptArea = screen.getByRole("textbox", { name: /prompt/i });
      fireEvent.change(promptArea, {
        target: { value: "Write unit tests for parser" },
      });

      const runButton = screen.getByRole("button", { name: /^run$/i });
      fireEvent.click(runButton);

      expect(mockInvoke).toHaveBeenCalledWith("run_oneshot", {
        repoId: "repo-1",
        repo: { type: "local", path: "/home/beth/repos/my-project" },
        title: "Add tests",
        prompt: "Write unit tests for parser",
        model: "opus",
        mergeStrategy: "merge_to_main",
        envVars: {},
      });
    });

    it("passes SSH repo details when repo is SSH type", () => {
      setupMockState({ repos: [makeSshRepo()] });
      renderOneShot();

      const titleInput = screen.getByRole("textbox", { name: /title/i });
      fireEvent.change(titleInput, { target: { value: "Fix deploy" } });

      const promptArea = screen.getByRole("textbox", { name: /prompt/i });
      fireEvent.change(promptArea, {
        target: { value: "Fix the deploy script" },
      });

      const runButton = screen.getByRole("button", { name: /^run$/i });
      fireEvent.click(runButton);

      expect(mockInvoke).toHaveBeenCalledWith("run_oneshot", {
        repoId: "repo-1",
        repo: {
          type: "ssh",
          sshHost: "dev-server",
          remotePath: "/home/beth/repos/remote-project",
        },
        title: "Fix deploy",
        prompt: "Fix the deploy script",
        model: "opus",
        mergeStrategy: "merge_to_main",
        envVars: {},
      });
    });

    it("uses the selected merge strategy in invoke", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      const titleInput = screen.getByRole("textbox", { name: /title/i });
      fireEvent.change(titleInput, { target: { value: "Feature" } });

      const promptArea = screen.getByRole("textbox", { name: /prompt/i });
      fireEvent.change(promptArea, { target: { value: "Do something" } });

      // Switch to branch strategy
      const branchRadio = screen.getByDisplayValue("branch");
      fireEvent.click(branchRadio);

      const runButton = screen.getByRole("button", { name: /^run$/i });
      fireEvent.click(runButton);

      expect(mockInvoke).toHaveBeenCalledWith(
        "run_oneshot",
        expect.objectContaining({ mergeStrategy: "branch" }),
      );
    });

    it("uses the entered model value in invoke", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      const titleInput = screen.getByRole("textbox", { name: /title/i });
      fireEvent.change(titleInput, { target: { value: "Feature" } });

      const promptArea = screen.getByRole("textbox", { name: /prompt/i });
      fireEvent.change(promptArea, { target: { value: "Do something" } });

      // Change model
      const modelInput = screen.getByDisplayValue("opus");
      fireEvent.change(modelInput, { target: { value: "sonnet" } });

      const runButton = screen.getByRole("button", { name: /^run$/i });
      fireEvent.click(runButton);

      expect(mockInvoke).toHaveBeenCalledWith(
        "run_oneshot",
        expect.objectContaining({ model: "sonnet" }),
      );
    });
  });

  // =========================================================================
  // 6. Stop button
  // =========================================================================

  describe("stop button", () => {
    it("is not visible when not running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ running: false })],
        ]),
      });
      renderOneShot();

      expect(
        screen.queryByRole("button", { name: /stop/i }),
      ).not.toBeInTheDocument();
    });

    it("is visible when running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ running: true })],
        ]),
      });
      renderOneShot();

      expect(
        screen.getByRole("button", { name: /stop/i }),
      ).toBeInTheDocument();
    });

    it('on click, calls invoke("stop_session", { repoId })', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ running: true })],
        ]),
      });
      renderOneShot();

      const stopButton = screen.getByRole("button", { name: /stop/i });
      fireEvent.click(stopButton);

      expect(mockInvoke).toHaveBeenCalledWith("stop_session", {
        repoId: "repo-1",
      });
    });
  });

  // =========================================================================
  // 7. Phase indicator
  // =========================================================================

  describe("phase indicator", () => {
    it('is not shown when phase is "idle" (no oneshot events)', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              events: [{ kind: "session_started" }],
            }),
          ],
        ]),
      });
      renderOneShot();

      // "Ready" is the label for idle, but it should not be shown
      expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    });

    it("shows phase label for design phase", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
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
      renderOneShot();

      expect(screen.getByText("Design Phase")).toBeInTheDocument();
    });

    it("shows phase label for implementation phase", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
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
      renderOneShot();

      expect(screen.getByText("Implementation Phase")).toBeInTheDocument();
    });

    it("shows phase label for starting phase", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              running: true,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
        ]),
      });
      renderOneShot();

      expect(screen.getByText("Starting...")).toBeInTheDocument();
    });

    it("has failed styling for failed phase", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              events: [
                { kind: "one_shot_started" },
                { kind: "one_shot_failed" },
              ],
            }),
          ],
        ]),
      });
      renderOneShot();

      const phaseEl = screen.getByText("Failed");
      expect(phaseEl).toBeInTheDocument();
      // Check for CSS class indicating failed state
      expect(phaseEl.className).toContain("text-red-400");
    });

    it("has complete styling for complete phase", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              events: [
                { kind: "one_shot_started" },
                { kind: "one_shot_complete" },
              ],
            }),
          ],
        ]),
      });
      renderOneShot();

      const phaseEl = screen.getByText("Complete");
      expect(phaseEl).toBeInTheDocument();
      // Check for CSS class indicating complete state
      expect(phaseEl.className).toContain("text-emerald-400");
    });

    it("shows finalizing phase label", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              running: true,
              events: [
                { kind: "one_shot_started" },
                { kind: "design_phase_started" },
                { kind: "design_phase_complete" },
                { kind: "implementation_phase_started" },
                { kind: "implementation_phase_complete" },
                { kind: "git_finalize_started" },
              ],
            }),
          ],
        ]),
      });
      renderOneShot();

      expect(screen.getByText("Finalizing...")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 8. EventsList integration
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
        sessions: new Map([
          ["repo-1", makeSessionState({ events })],
        ]),
      });
      renderOneShot();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute("data-event-count", "3");
    });

    it("passes repoPath for local repo", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ events: [] })],
        ]),
      });
      renderOneShot();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute(
        "data-repo-path",
        "/home/beth/repos/my-project",
      );
    });

    it("passes remotePath as repoPath for SSH repo", () => {
      setupMockState({
        repos: [makeSshRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ events: [] })],
        ]),
      });
      renderOneShot();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute(
        "data-repo-path",
        "/home/beth/repos/remote-project",
      );
    });

    it("passes isLive=true when session is running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ running: true, events: [] })],
        ]),
      });
      renderOneShot();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute("data-is-live", "true");
    });

    it("passes isLive=false when session is not running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ running: false, events: [] })],
        ]),
      });
      renderOneShot();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute("data-is-live", "false");
    });
  });

  // =========================================================================
  // 9. Error section
  // =========================================================================

  describe("error section", () => {
    it("is not shown when session.error is null", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ error: null })],
        ]),
      });
      renderOneShot();

      // No "Error" heading should appear
      expect(screen.queryByText("Error")).not.toBeInTheDocument();
    });

    it("shows error message in a pre block when session.error exists", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({ error: "Process crashed with signal SIGKILL" }),
          ],
        ]),
      });
      renderOneShot();

      expect(screen.getByText("Error")).toBeInTheDocument();
      const errorText = screen.getByText(
        "Process crashed with signal SIGKILL",
      );
      expect(errorText).toBeInTheDocument();
      expect(errorText.tagName).toBe("PRE");
    });
  });

  // =========================================================================
  // 10. Trace result section
  // =========================================================================

  describe("trace result section", () => {
    it("is not shown when session.trace is null", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ trace: null })],
        ]),
      });
      renderOneShot();

      expect(screen.queryByText("Result")).not.toBeInTheDocument();
    });

    it("shows outcome when trace exists", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              trace: makeTrace({ outcome: "completed" }),
            }),
          ],
        ]),
      });
      renderOneShot();

      expect(screen.getByText("Result")).toBeInTheDocument();
      expect(screen.getByText("completed")).toBeInTheDocument();
    });

    it("shows iteration count", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              trace: makeTrace({ total_iterations: 7 }),
            }),
          ],
        ]),
      });
      renderOneShot();

      expect(screen.getByText("7")).toBeInTheDocument();
    });

    it("shows cost formatted to 4 decimal places", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              trace: makeTrace({ total_cost_usd: 2.3456 }),
            }),
          ],
        ]),
      });
      renderOneShot();

      expect(screen.getByText(/\$2\.3456/)).toBeInTheDocument();
    });

    it("shows session_id", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              trace: makeTrace({ session_id: "sess-xyz-789" }),
            }),
          ],
        ]),
      });
      renderOneShot();

      expect(screen.getByText("sess-xyz-789")).toBeInTheDocument();
    });

    it("shows failure_reason when present", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              trace: makeTrace({
                outcome: "failed",
                failure_reason: "Design phase timed out",
              }),
            }),
          ],
        ]),
      });
      renderOneShot();

      expect(screen.getByText("Reason")).toBeInTheDocument();
      expect(
        screen.getByText("Design phase timed out"),
      ).toBeInTheDocument();
    });

    it("does NOT show failure_reason row when failure_reason is null", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "repo-1",
            makeSessionState({
              trace: makeTrace({
                outcome: "completed",
                failure_reason: null,
              }),
            }),
          ],
        ]),
      });
      renderOneShot();

      expect(screen.getByText("Result")).toBeInTheDocument();
      expect(screen.queryByText("Reason")).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // 11. Invoke rejection handling
  // =========================================================================

  describe("invoke rejection handling", () => {
    it("does not crash when run_oneshot invoke rejects", () => {
      mockInvoke.mockRejectedValue(new Error("Command failed"));
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map(),
      });
      renderOneShot();

      // Fill in required fields
      const titleInput = screen.getByRole("textbox", { name: /title/i });
      fireEvent.change(titleInput, { target: { value: "Test" } });

      const promptArea = screen.getByRole("textbox", { name: /prompt/i });
      fireEvent.change(promptArea, { target: { value: "Do something" } });

      // Click run — should not throw
      fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

      expect(mockInvoke).toHaveBeenCalledWith("run_oneshot", expect.anything());
    });

    it("does not crash when stop_session invoke rejects", () => {
      mockInvoke.mockRejectedValue(new Error("Stop failed"));
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["repo-1", makeSessionState({ running: true })],
        ]),
      });
      renderOneShot();

      // Click stop — should not throw
      fireEvent.click(screen.getByRole("button", { name: /stop/i }));

      expect(mockInvoke).toHaveBeenCalledWith("stop_session", {
        repoId: "repo-1",
      });
    });
  });

  // =========================================================================
  // 12. Default state (no session yet)
  // =========================================================================

  describe("default state (no session in store)", () => {
    it("renders form and disabled run button when no session exists", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      expect(screen.getByText("Title")).toBeInTheDocument();
      expect(screen.getByText("Prompt")).toBeInTheDocument();
      const runButton = screen.getByRole("button", { name: /^run$/i });
      expect(runButton).toBeDisabled();
    });

    it("does not show stop button when no session exists", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      expect(
        screen.queryByRole("button", { name: /stop/i }),
      ).not.toBeInTheDocument();
    });

    it("does not show error or trace sections when no session exists", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderOneShot();

      expect(screen.queryByText("Error")).not.toBeInTheDocument();
      expect(screen.queryByText("Result")).not.toBeInTheDocument();
    });
  });
});
