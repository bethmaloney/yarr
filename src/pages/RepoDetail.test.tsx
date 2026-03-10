import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import type { RepoConfig } from "../repos";
import type {
  SessionState,
  SessionTrace,
  SessionEvent,
  Check,
  GitSyncConfig,
} from "../types";

// ---------------------------------------------------------------------------
// Polyfill ResizeObserver for jsdom (needed by cmdk inside Command popover)
// ---------------------------------------------------------------------------
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
}));

const { mockOpen } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
}));

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

const { mockListen } = vi.hoisted(() => ({
  mockListen: vi.fn(),
}));

const { mockUseAppStore } = vi.hoisted(() => ({
  mockUseAppStore: vi.fn(),
}));

const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpen,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("../store", () => ({
  useAppStore: mockUseAppStore,
}));

vi.mock("sonner", () => ({
  toast: mockToast,
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
    >
      {events.length} events
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Import the component under test (after mocks are registered)
// ---------------------------------------------------------------------------

import RepoDetail from "./RepoDetail";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLocalRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    type: "local",
    id: "test-repo",
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
    id: "test-repo",
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

function makeCheck(overrides: Partial<Check> = {}): Check {
  return {
    name: "lint",
    command: "npm run lint",
    when: "each_iteration",
    timeoutSecs: 60,
    maxRetries: 2,
    ...overrides,
  };
}

function makeGitSync(overrides: Partial<GitSyncConfig> = {}): GitSyncConfig {
  return {
    enabled: false,
    maxPushRetries: 3,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    session_id: "sess-1",
    repo_path: "/home/beth/repos/my-project",
    prompt: "test prompt",
    plan_file: null,
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    outcome: "completed",
    failure_reason: null,
    total_iterations: 5,
    total_cost_usd: 1.2345,
    total_input_tokens: 10000,
    total_output_tokens: 5000,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
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
  runSession: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
  reconnectSession: ReturnType<typeof vi.fn>;
  updateRepo: ReturnType<typeof vi.fn>;
}

function setupMockState(overrides: Partial<MockState> = {}): MockState {
  const state: MockState = {
    repos: [],
    sessions: new Map(),
    runSession: vi.fn(),
    stopSession: vi.fn(),
    reconnectSession: vi.fn(),
    updateRepo: vi.fn(),
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

function renderRepoDetail(repoId = "test-repo") {
  return render(
    <MemoryRouter initialEntries={[`/repo/${repoId}`]}>
      <Routes>
        <Route path="/repo/:repoId" element={<RepoDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockOpen.mockResolvedValue(null);
  mockInvoke.mockResolvedValue(null);
  mockListen.mockResolvedValue(() => {});
  setupMockState();
});

afterEach(() => {
  cleanup();
});

// ===========================================================================
// 1. Basic rendering
// ===========================================================================

describe("RepoDetail", () => {
  describe("basic rendering", () => {
    it("shows breadcrumbs with Home and repo name", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      expect(screen.getByText("Home")).toBeInTheDocument();
      expect(screen.getAllByText("my-project").length).toBeGreaterThanOrEqual(
        1,
      );
    });

    it("shows repo name as heading", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      expect(
        screen.getByRole("heading", { name: /my-project/i }),
      ).toBeInTheDocument();
    });

    it("shows repo path for local repo", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      expect(
        screen.getByText("/home/beth/repos/my-project"),
      ).toBeInTheDocument();
    });

    it("shows sshHost:remotePath for SSH repo", () => {
      setupMockState({ repos: [makeSshRepo()] });
      renderRepoDetail();

      expect(
        screen.getByText(/dev-server.*\/home\/beth\/repos\/remote-project/),
      ).toBeInTheDocument();
    });

    it('shows "Repo not found" when repo ID does not match', () => {
      setupMockState({
        repos: [makeLocalRepo({ id: "other-id" } as Partial<RepoConfig>)],
      });
      renderRepoDetail("non-existent-id");

      expect(screen.getByText(/repo not found/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 2. Name editing
  // =========================================================================

  describe("name editing", () => {
    it("clicking the name enters edit mode (shows input)", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      const nameHeading = screen.getByRole("heading", {
        name: /my-project/i,
      });
      fireEvent.click(nameHeading);

      expect(screen.getByDisplayValue("my-project")).toBeInTheDocument();
    });

    it("Enter key saves the name (calls updateRepo)", () => {
      const state = setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      const nameHeading = screen.getByRole("heading", {
        name: /my-project/i,
      });
      fireEvent.click(nameHeading);

      const input = screen.getByDisplayValue("my-project");
      fireEvent.change(input, { target: { value: "renamed-project" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(state.updateRepo).toHaveBeenCalledWith(
        expect.objectContaining({ name: "renamed-project" }),
      );
    });

    it("Escape key cancels editing", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      const nameHeading = screen.getByRole("heading", {
        name: /my-project/i,
      });
      fireEvent.click(nameHeading);

      const input = screen.getByDisplayValue("my-project");
      fireEvent.change(input, { target: { value: "renamed-project" } });
      fireEvent.keyDown(input, { key: "Escape" });

      // Should revert to original name, no input visible
      expect(
        screen.queryByDisplayValue("renamed-project"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /my-project/ }),
      ).toBeInTheDocument();
    });

    it("blur saves the name", () => {
      const state = setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      const nameHeading = screen.getByRole("heading", {
        name: /my-project/i,
      });
      fireEvent.click(nameHeading);

      const input = screen.getByDisplayValue("my-project");
      fireEvent.change(input, { target: { value: "blur-saved" } });
      fireEvent.blur(input);

      expect(state.updateRepo).toHaveBeenCalledWith(
        expect.objectContaining({ name: "blur-saved" }),
      );
    });
  });

  // =========================================================================
  // 3. Branch selector
  // =========================================================================

  describe("branch selector", () => {
    it("shows branch chip when branchInfo is available", async () => {
      setupMockState({ repos: [makeLocalRepo()] });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "get_branch_info") {
          return Promise.resolve({ name: "main", ahead: 0, behind: 0 });
        }
        return Promise.resolve(null);
      });

      renderRepoDetail();

      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
      });
    });

    it("shows ahead/behind counts", async () => {
      setupMockState({ repos: [makeLocalRepo()] });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "get_branch_info") {
          return Promise.resolve({ name: "feat/branch", ahead: 3, behind: 2 });
        }
        return Promise.resolve(null);
      });

      renderRepoDetail();

      await waitFor(() => {
        expect(screen.getByText(/3/)).toBeInTheDocument();
        expect(screen.getByText(/2/)).toBeInTheDocument();
      });
    });

    it("branch chip is disabled when session is running", async () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([["test-repo", makeSessionState({ running: true })]]),
      });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "get_branch_info") {
          return Promise.resolve({ name: "main", ahead: 0, behind: 0 });
        }
        return Promise.resolve(null);
      });

      renderRepoDetail();

      await waitFor(() => {
        const branchChip = screen.getByText("main").closest("button");
        expect(branchChip).toBeDisabled();
      });
    });

    it("shows success toast when branch switch succeeds", async () => {
      setupMockState({ repos: [makeLocalRepo()] });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "get_branch_info")
          return Promise.resolve({ name: "main", ahead: 0, behind: 0 });
        if (cmd === "list_local_branches")
          return Promise.resolve(["main", "develop"]);
        if (cmd === "switch_branch") return Promise.resolve(null);
        return Promise.resolve(null);
      });

      renderRepoDetail();

      // Wait for branch chip to appear, then click it to open popover
      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
      });
      const branchChip = screen.getByText("main").closest("button")!;
      fireEvent.click(branchChip);

      // Wait for branch list to appear, then click "develop"
      await waitFor(() => {
        expect(screen.getByText("develop")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("develop"));

      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith(
          expect.stringContaining("develop"),
        );
      });
    });

    it("shows error toast when branch switch fails", async () => {
      setupMockState({ repos: [makeLocalRepo()] });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "get_branch_info")
          return Promise.resolve({ name: "main", ahead: 0, behind: 0 });
        if (cmd === "list_local_branches")
          return Promise.resolve(["main", "develop"]);
        if (cmd === "switch_branch")
          return Promise.reject("Branch switch failed");
        return Promise.resolve(null);
      });

      renderRepoDetail();

      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
      });
      const branchChip = screen.getByText("main").closest("button")!;
      fireEvent.click(branchChip);

      await waitFor(() => {
        expect(screen.getByText("develop")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("develop"));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalled();
      });
    });

    it("shows success toast when fast-forward succeeds", async () => {
      setupMockState({ repos: [makeLocalRepo()] });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "get_branch_info")
          return Promise.resolve({ name: "main", ahead: 0, behind: 5 });
        if (cmd === "list_local_branches")
          return Promise.resolve(["main"]);
        if (cmd === "fast_forward_branch") return Promise.resolve(null);
        return Promise.resolve(null);
      });

      renderRepoDetail();

      // Wait for branch chip to appear (behind > 0 so fast-forward will be available)
      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
      });
      const branchChip = screen.getByText("main").closest("button")!;
      fireEvent.click(branchChip);

      // Wait for the Fast-forward button inside the popover
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /fast-forward/i }),
        ).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: /fast-forward/i }));

      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalled();
      });
    });

    it("shows error toast when fast-forward fails", async () => {
      setupMockState({ repos: [makeLocalRepo()] });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "get_branch_info")
          return Promise.resolve({ name: "main", ahead: 0, behind: 5 });
        if (cmd === "list_local_branches")
          return Promise.resolve(["main"]);
        if (cmd === "fast_forward_branch")
          return Promise.reject("Fast-forward failed");
        return Promise.resolve(null);
      });

      renderRepoDetail();

      await waitFor(() => {
        expect(screen.getByText("main")).toBeInTheDocument();
      });
      const branchChip = screen.getByText("main").closest("button")!;
      fireEvent.click(branchChip);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /fast-forward/i }),
        ).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: /fast-forward/i }));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // 4. Settings section
  // =========================================================================

  describe("settings section", () => {
    it("shows model and max iterations in the trigger text", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      expect(screen.getByText(/opus/i)).toBeInTheDocument();
      expect(screen.getByText(/40/)).toBeInTheDocument();
    });

    it("SSH repos show readonly SSH Host and Remote Path fields", async () => {
      setupMockState({ repos: [makeSshRepo()] });
      renderRepoDetail();

      // Click the settings trigger to expand
      const settingsTrigger = screen.getByText(/settings/i);
      fireEvent.click(settingsTrigger);

      await waitFor(() => {
        expect(screen.getByDisplayValue("dev-server")).toBeInTheDocument();
        expect(
          screen.getByDisplayValue("/home/beth/repos/remote-project"),
        ).toBeInTheDocument();
      });
    });

    it("Save button calls updateRepo with current values", async () => {
      const state = setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      // Open settings
      const settingsTrigger = screen.getByText(/settings/i);
      fireEvent.click(settingsTrigger);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /save/i }),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      expect(state.updateRepo).toHaveBeenCalled();
    });

    it("Test Connection button appears for SSH repos", async () => {
      setupMockState({ repos: [makeSshRepo()] });
      renderRepoDetail();

      // Open settings
      const settingsTrigger = screen.getByText(/settings/i);
      fireEvent.click(settingsTrigger);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /test connection/i }),
        ).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 5. Checks section
  // =========================================================================

  describe("checks section", () => {
    it("shows checks count in trigger", () => {
      const repo = makeLocalRepo({
        checks: [makeCheck(), makeCheck({ name: "test" })],
      } as Partial<RepoConfig>);
      setupMockState({ repos: [repo] });
      renderRepoDetail();

      expect(screen.getByText(/checks/i)).toBeInTheDocument();
      expect(screen.getByText(/2/)).toBeInTheDocument();
    });

    it("Add Check button adds a new check entry", async () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      // Open checks section
      const checksTrigger = screen.getByText(/checks/i);
      fireEvent.click(checksTrigger);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /add check/i }),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /add check/i }));

      // Should now have a new check entry (empty fields)
      await waitFor(() => {
        expect(screen.getByDisplayValue("")).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 6. Git Sync section
  // =========================================================================

  describe("git sync section", () => {
    it("shows enabled/disabled in trigger", () => {
      const repo = makeLocalRepo({
        gitSync: makeGitSync({ enabled: true }),
      } as Partial<RepoConfig>);
      setupMockState({ repos: [repo] });
      renderRepoDetail();

      expect(screen.getByText(/git sync/i)).toBeInTheDocument();
      expect(screen.getByText(/enabled/i)).toBeInTheDocument();
    });

    it("shows disabled when git sync is not enabled", () => {
      const repo = makeLocalRepo({
        gitSync: makeGitSync({ enabled: false }),
      } as Partial<RepoConfig>);
      setupMockState({ repos: [repo] });
      renderRepoDetail();

      expect(screen.getByText(/git sync/i)).toBeInTheDocument();
      expect(screen.getByText(/disabled/i)).toBeInTheDocument();
    });

    it("enable toggle changes state", async () => {
      const repo = makeLocalRepo({
        gitSync: makeGitSync({ enabled: false }),
      } as Partial<RepoConfig>);
      setupMockState({ repos: [repo] });
      renderRepoDetail();

      // Open git sync section
      const gitSyncTrigger = screen.getByText(/git sync/i);
      fireEvent.click(gitSyncTrigger);

      await waitFor(() => {
        const toggle = screen.getByRole("checkbox");
        expect(toggle).toBeInTheDocument();
      });

      const toggle = screen.getByRole("checkbox");
      fireEvent.click(toggle);

      // After toggling, the state should change
      await waitFor(() => {
        expect(toggle).toBeChecked();
      });
    });
  });

  // =========================================================================
  // 7. Plan section
  // =========================================================================

  describe("plan section", () => {
    it('shows "Plan" heading', () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      expect(screen.getByText(/plan/i)).toBeInTheDocument();
    });

    it("prompt file input accepts text", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      const input = screen.getByPlaceholderText(/plan|prompt|file/i);
      fireEvent.change(input, { target: { value: "/path/to/plan.md" } });

      expect(screen.getByDisplayValue("/path/to/plan.md")).toBeInTheDocument();
    });

    it("Browse button exists and triggers file dialog", async () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      const browseButton = screen.getByRole("button", { name: /browse/i });
      expect(browseButton).toBeInTheDocument();

      fireEvent.click(browseButton);

      await waitFor(() => {
        expect(mockOpen).toHaveBeenCalled();
      });
    });

    it("preview shows content when file is set", async () => {
      setupMockState({ repos: [makeLocalRepo()] });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === "read_file_preview") {
          return Promise.resolve("# My Plan\nDo something cool");
        }
        return Promise.resolve(null);
      });

      renderRepoDetail();

      const input = screen.getByPlaceholderText(/plan|prompt|file/i);
      fireEvent.change(input, { target: { value: "/path/to/plan.md" } });

      await waitFor(() => {
        expect(screen.getByText(/My Plan/)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 8. Action buttons
  // =========================================================================

  describe("action buttons", () => {
    it("shows Run button (disabled when no plan file)", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      const runButton = screen.getByRole("button", { name: /^run$/i });
      expect(runButton).toBeDisabled();
    });

    it("Run button is enabled when plan file is set", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      const input = screen.getByPlaceholderText(/plan|prompt|file/i);
      fireEvent.change(input, { target: { value: "/path/to/plan.md" } });

      const runButton = screen.getByRole("button", { name: /^run$/i });
      expect(runButton).toBeEnabled();
    });

    it("Run button calls runSession with repoId and planFile", () => {
      const state = setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      const input = screen.getByPlaceholderText(/plan|prompt|file/i);
      fireEvent.change(input, { target: { value: "/path/to/plan.md" } });

      const runButton = screen.getByRole("button", { name: /^run$/i });
      fireEvent.click(runButton);

      expect(state.runSession).toHaveBeenCalledWith(
        "test-repo",
        "/path/to/plan.md",
      );
    });

    it("shows Stop button (destructive variant) when running", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([["test-repo", makeSessionState({ running: true })]]),
      });
      renderRepoDetail();

      const stopButton = screen.getByRole("button", { name: /stop/i });
      expect(stopButton).toBeInTheDocument();
    });

    it("Stop button calls stopSession", () => {
      const state = setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([["test-repo", makeSessionState({ running: true })]]),
      });
      renderRepoDetail();

      const stopButton = screen.getByRole("button", { name: /stop/i });
      fireEvent.click(stopButton);

      expect(state.stopSession).toHaveBeenCalledWith("test-repo");
    });

    it('shows "Running..." disabled indicator when running', () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([["test-repo", makeSessionState({ running: true })]]),
      });
      renderRepoDetail();

      expect(screen.getByText(/running/i)).toBeInTheDocument();
    });

    it("shows 1-Shot button", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      expect(
        screen.getByRole("button", { name: /1-shot/i }),
      ).toBeInTheDocument();
    });

    it("1-Shot navigates to /repo/{repoId}/oneshot", () => {
      setupMockState({ repos: [makeLocalRepo()] });
      renderRepoDetail();

      const oneshotButton = screen.getByRole("button", { name: /1-shot/i });
      fireEvent.click(oneshotButton);

      expect(mockNavigate).toHaveBeenCalledWith("/repo/test-repo/oneshot");
    });

    it("shows Reconnect button when disconnected", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({ running: true, disconnected: true }),
          ],
        ]),
      });
      renderRepoDetail();

      expect(
        screen.getByRole("button", { name: /reconnect/i }),
      ).toBeInTheDocument();
    });

    it("Reconnect calls reconnectSession", () => {
      const state = setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({ running: true, disconnected: true }),
          ],
        ]),
      });
      renderRepoDetail();

      const reconnectButton = screen.getByRole("button", {
        name: /reconnect/i,
      });
      fireEvent.click(reconnectButton);

      expect(state.reconnectSession).toHaveBeenCalledWith("test-repo");
    });
  });

  // =========================================================================
  // 9. Disconnected banner
  // =========================================================================

  describe("disconnected banner", () => {
    it("shows disconnected banner when session.disconnected is true", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({ running: true, disconnected: true }),
          ],
        ]),
      });
      renderRepoDetail();

      expect(screen.getByText(/connection lost/i)).toBeInTheDocument();
    });

    it("shows disconnect reason if provided", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({
              running: true,
              disconnected: true,
              disconnectReason: "SSH connection lost",
            }),
          ],
        ]),
      });
      renderRepoDetail();

      expect(screen.getByText(/SSH connection lost/)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 10. Error section
  // =========================================================================

  describe("error section", () => {
    it("shows error section when session.error is set", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["test-repo", makeSessionState({ error: "Process crashed" })],
        ]),
      });
      renderRepoDetail();

      expect(screen.getByText(/error/i)).toBeInTheDocument();
    });

    it("shows the error message", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({ error: "Claude exited with code 1" }),
          ],
        ]),
      });
      renderRepoDetail();

      expect(screen.getByText("Claude exited with code 1")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 11. Trace/Result section
  // =========================================================================

  describe("trace/result section", () => {
    it("shows outcome when trace exists", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({ trace: makeTrace({ outcome: "completed" }) }),
          ],
        ]),
      });
      renderRepoDetail();

      expect(screen.getByText(/completed/i)).toBeInTheDocument();
    });

    it("shows iterations count", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({
              trace: makeTrace({ total_iterations: 12 }),
            }),
          ],
        ]),
      });
      renderRepoDetail();

      expect(screen.getByText(/12/)).toBeInTheDocument();
    });

    it("shows total cost formatted as $X.XXXX", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({
              trace: makeTrace({ total_cost_usd: 2.5678 }),
            }),
          ],
        ]),
      });
      renderRepoDetail();

      expect(screen.getByText(/\$2\.5678/)).toBeInTheDocument();
    });

    it("shows context percentage with color", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({
              trace: makeTrace({
                context_window: 200000,
                final_context_tokens: 160000,
              }),
            }),
          ],
        ]),
      });
      renderRepoDetail();

      // 160000/200000 = 80%
      expect(screen.getByText(/80%/)).toBeInTheDocument();
    });

    it("shows failure reason when present", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({
              trace: makeTrace({
                outcome: "failed",
                failure_reason: "Max iterations exceeded",
              }),
            }),
          ],
        ]),
      });
      renderRepoDetail();

      expect(screen.getByText(/Max iterations exceeded/)).toBeInTheDocument();
    });

    it("shows session ID", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          [
            "test-repo",
            makeSessionState({
              trace: makeTrace({ session_id: "sess-abc-123" }),
            }),
          ],
        ]),
      });
      renderRepoDetail();

      expect(screen.getByText(/sess-abc-123/)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 12. EventsList integration
  // =========================================================================

  describe("EventsList integration", () => {
    it("passes session events to EventsList", () => {
      const events: SessionEvent[] = [
        { kind: "session_started" },
        { kind: "iteration_started", iteration: 1 },
        { kind: "session_complete" },
      ];
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([["test-repo", makeSessionState({ events })]]),
      });
      renderRepoDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveTextContent("3 events");
    });

    it("passes isLive=true when running", () => {
      const events: SessionEvent[] = [{ kind: "session_started" }];
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([
          ["test-repo", makeSessionState({ running: true, events })],
        ]),
      });
      renderRepoDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute("data-is-live", "true");
    });

    it("passes repoPath", () => {
      const events: SessionEvent[] = [{ kind: "session_started" }];
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map([["test-repo", makeSessionState({ events })]]),
      });
      renderRepoDetail();

      const eventsList = screen.getByTestId("events-list");
      expect(eventsList).toHaveAttribute(
        "data-repo-path",
        "/home/beth/repos/my-project",
      );
    });
  });
});
