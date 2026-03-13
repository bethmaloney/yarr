import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { RepoConfig } from "../repos";
import type {
  OneShotEntry,
  SessionState,
  SessionTrace,
  RepoGitStatus,
} from "../types";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
}));

const { mockOpen } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
}));

const { mockUseAppStore } = vi.hoisted(() => ({
  mockUseAppStore: vi.fn(),
}));

const { mockUseGitStatus } = vi.hoisted(() => ({
  mockUseGitStatus: vi.fn(),
}));

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
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

vi.mock("../store", () => ({
  useAppStore: mockUseAppStore,
}));

vi.mock("../hooks/useGitStatus", () => ({
  useGitStatus: mockUseGitStatus,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

// ---------------------------------------------------------------------------
// Import the component under test (after mocks are registered)
// ---------------------------------------------------------------------------

import Home from "./Home";

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
    completionSignal: "ALL TODO ITEMS COMPLETE",
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
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    session_id: "sess-1",
    repo_path: "/home/beth/repos/my-project",
    prompt: "test prompt",
    plan_file: null,
    plan_content: null,
    start_time: new Date().toISOString(),
    end_time: null,
    outcome: "completed",
    failure_reason: null,
    total_iterations: 5,
    total_cost_usd: 1.23,
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

function makeOneShotEntry(
  overrides: Partial<OneShotEntry> = {},
): OneShotEntry {
  return {
    id: "oneshot-abc",
    parentRepoId: "r1",
    parentRepoName: "my-project",
    title: "Fix login bug",
    prompt: "Fix the login validation issue",
    model: "opus",
    effortLevel: "medium",
    designEffortLevel: "high",
    mergeStrategy: "branch",
    status: "running",
    startedAt: Date.now(),
    ...overrides,
  };
}

type GitStatusEntry = {
  status: RepoGitStatus | null;
  lastChecked: Date | null;
  loading: boolean;
  error: string | null;
};

interface MockState {
  repos: RepoConfig[];
  sessions: Map<string, SessionState>;
  latestTraces: Map<string, SessionTrace>;
  addLocalRepo: ReturnType<typeof vi.fn>;
  addSshRepo: ReturnType<typeof vi.fn>;
  oneShotEntries: Map<string, OneShotEntry>;
  dismissOneShot: ReturnType<typeof vi.fn>;
  gitStatus: Record<string, GitStatusEntry>;
}

function setupMockState(overrides: Partial<MockState> = {}): MockState {
  const state: MockState = {
    repos: [],
    sessions: new Map(),
    latestTraces: new Map(),
    addLocalRepo: vi.fn(),
    addSshRepo: vi.fn(),
    oneShotEntries: new Map(),
    dismissOneShot: vi.fn(),
    gitStatus: {},
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

function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUseGitStatus.mockReturnValue({ refresh: vi.fn() });
  mockOpen.mockResolvedValue(null);
  setupMockState();
});

afterEach(() => {
  cleanup();
});

// ===========================================================================
// 1. Rendering basics
// ===========================================================================

describe("Home", () => {
  it('shows "Yarr" title', () => {
    setupMockState();
    renderHome();
    expect(screen.getByText("Yarr")).toBeInTheDocument();
  });

  it('shows "Claude Orchestrator" subtitle', () => {
    setupMockState();
    renderHome();
    expect(screen.getByText("Claude Orchestrator")).toBeInTheDocument();
  });

  // =========================================================================
  // 2. Breadcrumbs
  // =========================================================================

  it('renders breadcrumbs with "Home" label', () => {
    setupMockState();
    renderHome();
    // Breadcrumbs component renders "Home" as a BreadcrumbPage with aria-current
    expect(screen.getByText("Home")).toBeInTheDocument();
  });

  // =========================================================================
  // 3. Empty state
  // =========================================================================

  it('shows "No repos configured yet." when repos is empty', () => {
    setupMockState({ repos: [] });
    renderHome();
    expect(screen.getByText(/no repos configured yet/i)).toBeInTheDocument();
  });

  // =========================================================================
  // 4. Repo grid — renders RepoCard for each repo
  // =========================================================================

  it("renders a card for each repo", () => {
    const repos = [
      makeLocalRepo({ id: "r1", name: "project-one" } as Partial<RepoConfig>),
      makeSshRepo({ id: "r2", name: "project-two" }),
    ];
    setupMockState({ repos });
    renderHome();

    expect(screen.getByText("project-one")).toBeInTheDocument();
    expect(screen.getByText("project-two")).toBeInTheDocument();
  });

  it("does not show empty state when repos exist", () => {
    setupMockState({ repos: [makeLocalRepo()] });
    renderHome();
    expect(
      screen.queryByText(/no repos configured yet/i),
    ).not.toBeInTheDocument();
  });

  // =========================================================================
  // 5. Status derivation (deriveStatus)
  // =========================================================================

  describe("deriveStatus", () => {
    it("shows idle when no session exists for a repo", () => {
      setupMockState({
        repos: [makeLocalRepo()],
        sessions: new Map(),
      });
      renderHome();
      expect(screen.getByText("IDLE")).toBeInTheDocument();
    });

    it("shows running when session.running is true", () => {
      setupMockState({
        repos: [makeLocalRepo({ id: "r1" } as Partial<RepoConfig>)],
        sessions: new Map([["r1", makeSessionState({ running: true })]]),
      });
      renderHome();
      expect(screen.getByText("RUNNING")).toBeInTheDocument();
    });

    it("shows disconnected when session.disconnected is true", () => {
      setupMockState({
        repos: [makeLocalRepo({ id: "r1" } as Partial<RepoConfig>)],
        sessions: new Map([
          ["r1", makeSessionState({ running: true, disconnected: true })],
        ]),
      });
      renderHome();
      expect(screen.getByText("DISCONNECTED")).toBeInTheDocument();
    });

    it("disconnected takes priority over running", () => {
      setupMockState({
        repos: [makeLocalRepo({ id: "r1" } as Partial<RepoConfig>)],
        sessions: new Map([
          ["r1", makeSessionState({ running: true, disconnected: true })],
        ]),
      });
      renderHome();
      expect(screen.getByText("DISCONNECTED")).toBeInTheDocument();
      expect(screen.queryByText("RUNNING")).not.toBeInTheDocument();
    });

    it("reconnecting shows running (not disconnected)", () => {
      setupMockState({
        repos: [makeLocalRepo({ id: "r1" } as Partial<RepoConfig>)],
        sessions: new Map([
          [
            "r1",
            makeSessionState({
              running: true,
              reconnecting: true,
              disconnected: false,
            }),
          ],
        ]),
      });
      renderHome();
      expect(screen.getByText("RUNNING")).toBeInTheDocument();
    });

    it("shows failed when session.error is set", () => {
      setupMockState({
        repos: [makeLocalRepo({ id: "r1" } as Partial<RepoConfig>)],
        sessions: new Map([
          ["r1", makeSessionState({ error: "something broke" })],
        ]),
      });
      renderHome();
      expect(screen.getByText("FAILED")).toBeInTheDocument();
    });

    it("shows completed when session has a trace and is not running", () => {
      setupMockState({
        repos: [makeLocalRepo({ id: "r1" } as Partial<RepoConfig>)],
        sessions: new Map([
          ["r1", makeSessionState({ running: false, trace: makeTrace() })],
        ]),
      });
      renderHome();
      expect(screen.getByText("COMPLETED")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 6. History button
  // =========================================================================

  it("renders a History button", () => {
    setupMockState();
    renderHome();
    expect(
      screen.getByRole("button", { name: /history/i }),
    ).toBeInTheDocument();
  });

  it("navigates to /history when History button is clicked", () => {
    setupMockState();
    renderHome();
    const historyButton = screen.getByRole("button", { name: /history/i });
    fireEvent.click(historyButton);
    expect(mockNavigate).toHaveBeenCalledWith("/history");
  });

  // =========================================================================
  // 7. Add repo button
  // =========================================================================

  it('shows "+ Add repo" button when addMode is null (initial state)', () => {
    setupMockState();
    renderHome();
    expect(
      screen.getByRole("button", { name: /add repo/i }),
    ).toBeInTheDocument();
  });

  // =========================================================================
  // 8. Add mode "choosing"
  // =========================================================================

  it('shows "Local" and "SSH" buttons when addMode is "choosing"', async () => {
    setupMockState();
    renderHome();

    // Click "+ Add repo" to transition to "choosing"
    const addButton = screen.getByRole("button", { name: /add repo/i });
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /local/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /ssh/i })).toBeInTheDocument();
    });
  });

  it('shows a Cancel button when addMode is "choosing"', async () => {
    setupMockState();
    renderHome();

    fireEvent.click(screen.getByRole("button", { name: /add repo/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /cancel/i }),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 9. SSH form
  // =========================================================================

  it("shows SSH Host and Remote Path inputs when addMode is ssh-form", async () => {
    setupMockState();
    renderHome();

    // Transition: null -> choosing -> ssh-form
    fireEvent.click(screen.getByRole("button", { name: /add repo/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /ssh/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /ssh/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/ssh host/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/remote path/i)).toBeInTheDocument();
    });
  });

  it("shows Add and Cancel buttons in the SSH form", async () => {
    setupMockState();
    renderHome();

    fireEvent.click(screen.getByRole("button", { name: /add repo/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /ssh/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /ssh/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^add$/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /cancel/i }),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 10. Cancel add — returns to addMode null
  // =========================================================================

  it('cancel from "choosing" returns to "+ Add repo" button', async () => {
    setupMockState();
    renderHome();

    // Go to choosing
    fireEvent.click(screen.getByRole("button", { name: /add repo/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /cancel/i }),
      ).toBeInTheDocument();
    });

    // Cancel
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /add repo/i }),
      ).toBeInTheDocument();
    });
  });

  it('cancel from SSH form returns to "+ Add repo" button', async () => {
    setupMockState();
    renderHome();

    // null -> choosing -> ssh-form
    fireEvent.click(screen.getByRole("button", { name: /add repo/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /ssh/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /ssh/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /cancel/i }),
      ).toBeInTheDocument();
    });

    // Cancel
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /add repo/i }),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 11. Click repo card — navigates to /repo/:repoId
  // =========================================================================

  it("navigates to /repo/:repoId when a repo card is clicked", () => {
    setupMockState({
      repos: [makeLocalRepo({ id: "abc-123" } as Partial<RepoConfig>)],
    });
    renderHome();

    // RepoCard renders as a button with the repo name
    const card = screen.getByText("my-project").closest("button");
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    expect(mockNavigate).toHaveBeenCalledWith("/repo/abc-123");
  });

  // =========================================================================
  // 12. Adding a local repo calls open() then store.addLocalRepo
  // =========================================================================

  it("calls open() from dialog when Local button is clicked, then addLocalRepo", async () => {
    const mockState = setupMockState();
    mockOpen.mockResolvedValue("/home/beth/repos/new-project");

    renderHome();

    // null -> choosing
    fireEvent.click(screen.getByRole("button", { name: /add repo/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /local/i }),
      ).toBeInTheDocument();
    });

    // Click Local
    fireEvent.click(screen.getByRole("button", { name: /local/i }));

    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(mockState.addLocalRepo).toHaveBeenCalledWith(
        "/home/beth/repos/new-project",
      );
    });
  });

  it("does not call addLocalRepo when dialog is cancelled (returns null)", async () => {
    const mockState = setupMockState();
    mockOpen.mockResolvedValue(null);

    renderHome();

    fireEvent.click(screen.getByRole("button", { name: /add repo/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /local/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /local/i }));

    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
    });

    // addLocalRepo should NOT be called since dialog was cancelled
    expect(mockState.addLocalRepo).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 13. Adding an SSH repo calls store.addSshRepo
  // =========================================================================

  it("calls addSshRepo with host and path from the SSH form", async () => {
    const mockState = setupMockState();

    renderHome();

    // null -> choosing -> ssh-form
    fireEvent.click(screen.getByRole("button", { name: /add repo/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /ssh/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /ssh/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/ssh host/i)).toBeInTheDocument();
    });

    // Fill in the form
    const hostInput = screen.getByLabelText(/ssh host/i);
    const pathInput = screen.getByLabelText(/remote path/i);

    fireEvent.change(hostInput, { target: { value: "my-server" } });
    fireEvent.change(pathInput, {
      target: { value: "/home/beth/repos/cool-project" },
    });

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      expect(mockState.addSshRepo).toHaveBeenCalledWith(
        "my-server",
        "/home/beth/repos/cool-project",
      );
    });
  });

  // =========================================================================
  // 14. Git status is passed to RepoCard
  // =========================================================================

  it("passes git status from store to RepoCard", () => {
    const repo = makeLocalRepo({ id: "r1" } as Partial<RepoConfig>);
    setupMockState({
      repos: [repo],
      gitStatus: {
        r1: {
          status: {
            branchName: "feat/awesome",
            dirtyCount: 2,
            ahead: 1,
            behind: 0,
          },
          lastChecked: new Date(),
          loading: false,
          error: null,
        },
      },
    });

    renderHome();

    expect(screen.getByText("feat/awesome")).toBeInTheDocument();
  });

  it("shows git status indicators (dirty, ahead) on repo card", () => {
    const repo = makeLocalRepo({ id: "r1" } as Partial<RepoConfig>);
    setupMockState({
      repos: [repo],
      gitStatus: {
        r1: {
          status: {
            branchName: "feat/awesome",
            dirtyCount: 3,
            ahead: 2,
            behind: 0,
          },
          lastChecked: new Date(),
          loading: false,
          error: null,
        },
      },
    });

    renderHome();

    expect(screen.getByText(/3 dirty/)).toBeInTheDocument();
    expect(screen.getByText(/2↑/)).toBeInTheDocument();
  });

  // =========================================================================
  // 15. Latest traces are passed to RepoCard
  // =========================================================================

  it("passes latest trace to RepoCard", () => {
    const repo = makeLocalRepo({ id: "r1" } as Partial<RepoConfig>);
    const trace = makeTrace({ total_cost_usd: 2.5 });

    setupMockState({
      repos: [repo],
      latestTraces: new Map([["r1", trace]]),
    });

    renderHome();

    expect(screen.getByText("$2.50")).toBeInTheDocument();
  });

  // =========================================================================
  // 16. 1-Shot cards
  // =========================================================================

  describe("1-Shot cards", () => {
    it("renders a 1-shot card alongside repo cards in the grid", () => {
      const repo = makeLocalRepo({ id: "r1", name: "my-project" } as Partial<RepoConfig>);
      const entry = makeOneShotEntry({
        id: "oneshot-1",
        title: "Add dark mode",
        parentRepoName: "my-project",
      });

      setupMockState({
        repos: [repo],
        oneShotEntries: new Map([["oneshot-1", entry]]),
        sessions: new Map([
          [
            "oneshot-1",
            makeSessionState({
              running: true,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
        ]),
      });
      renderHome();

      // Repo card is present
      expect(screen.getByText("my-project")).toBeInTheDocument();
      // 1-shot card is present (identified by its aria-label)
      expect(
        screen.getByRole("button", { name: /Add dark mode — 1-Shot/i }),
      ).toBeInTheDocument();
    });

    it("renders multiple 1-shot cards alongside multiple repo cards", () => {
      const repos = [
        makeLocalRepo({ id: "r1", name: "project-one" } as Partial<RepoConfig>),
        makeSshRepo({ id: "r2", name: "project-two" }),
      ];
      const entry1 = makeOneShotEntry({
        id: "oneshot-1",
        title: "Fix bug A",
      });
      const entry2 = makeOneShotEntry({
        id: "oneshot-2",
        title: "Add feature B",
        status: "completed",
      });

      setupMockState({
        repos,
        oneShotEntries: new Map([
          ["oneshot-1", entry1],
          ["oneshot-2", entry2],
        ]),
        sessions: new Map([
          [
            "oneshot-1",
            makeSessionState({
              running: true,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
          [
            "oneshot-2",
            makeSessionState({
              events: [
                { kind: "one_shot_started" },
                { kind: "one_shot_complete" },
              ],
            }),
          ],
        ]),
      });
      renderHome();

      expect(screen.getByText("project-one")).toBeInTheDocument();
      expect(screen.getByText("project-two")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Fix bug A — 1-Shot/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Add feature B — 1-Shot/i }),
      ).toBeInTheDocument();
    });

    it("sorts running items first, then by timestamp newest first", () => {
      const now = Date.now();
      // Repo with a running session — should appear first
      const runningRepo = makeLocalRepo({
        id: "r-running",
        name: "running-repo",
      } as Partial<RepoConfig>);
      // Repo with older trace — should appear last
      const olderRepo = makeLocalRepo({
        id: "r-older",
        name: "older-repo",
      } as Partial<RepoConfig>);
      // 1-shot that is running with newer timestamp — should also be near top
      const runningOneShot = makeOneShotEntry({
        id: "oneshot-running",
        title: "Running 1-Shot",
        status: "running",
        startedAt: now - 1000,
      });
      // 1-shot that is completed with most recent timestamp
      const newerOneShot = makeOneShotEntry({
        id: "oneshot-newer",
        title: "Newer 1-Shot",
        status: "completed",
        startedAt: now - 2000,
      });
      // 1-shot that is completed with oldest timestamp
      const olderOneShot = makeOneShotEntry({
        id: "oneshot-older",
        title: "Older 1-Shot",
        status: "completed",
        startedAt: now - 100000,
      });

      setupMockState({
        repos: [runningRepo, olderRepo],
        oneShotEntries: new Map([
          ["oneshot-running", runningOneShot],
          ["oneshot-newer", newerOneShot],
          ["oneshot-older", olderOneShot],
        ]),
        sessions: new Map([
          ["r-running", makeSessionState({ running: true })],
          ["r-older", makeSessionState({ running: false })],
          [
            "oneshot-running",
            makeSessionState({
              running: true,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
          [
            "oneshot-newer",
            makeSessionState({
              events: [
                { kind: "one_shot_started" },
                { kind: "one_shot_complete" },
              ],
            }),
          ],
          [
            "oneshot-older",
            makeSessionState({
              events: [
                { kind: "one_shot_started" },
                { kind: "one_shot_complete" },
              ],
            }),
          ],
        ]),
        latestTraces: new Map([
          [
            "r-running",
            makeTrace({ start_time: new Date(now).toISOString() }),
          ],
          [
            "r-older",
            makeTrace({
              start_time: new Date(now - 50000).toISOString(),
            }),
          ],
        ]),
      });
      renderHome();

      // Running items should come before the oldest non-running card in DOM order
      const body = document.body.innerHTML;
      const runningRepoIdx = body.indexOf("running-repo");
      const running1ShotIdx = body.indexOf("Running 1-Shot");
      const older1ShotIdx = body.indexOf("Older 1-Shot");

      // Both running items should appear before the oldest non-running item
      expect(runningRepoIdx).toBeLessThan(older1ShotIdx);
      expect(running1ShotIdx).toBeLessThan(older1ShotIdx);
    });

    it("calls dismissOneShot when dismiss button is clicked on a failed 1-shot", () => {
      const entry = makeOneShotEntry({
        id: "oneshot-fail",
        title: "Failed task",
        status: "failed",
      });

      const mockState = setupMockState({
        oneShotEntries: new Map([["oneshot-fail", entry]]),
        sessions: new Map([
          [
            "oneshot-fail",
            makeSessionState({
              events: [
                { kind: "one_shot_started" },
                { kind: "one_shot_failed" },
              ],
            }),
          ],
        ]),
      });
      renderHome();

      // The dismiss button should be present for failed entries
      const dismissButton = screen.getByRole("button", { name: /dismiss/i });
      fireEvent.click(dismissButton);

      expect(mockState.dismissOneShot).toHaveBeenCalledWith("oneshot-fail");
    });

    it("does not show dismiss button for running 1-shot entries", () => {
      const entry = makeOneShotEntry({
        id: "oneshot-run",
        title: "Running task",
        status: "running",
      });

      setupMockState({
        oneShotEntries: new Map([["oneshot-run", entry]]),
        sessions: new Map([
          [
            "oneshot-run",
            makeSessionState({
              running: true,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
        ]),
      });
      renderHome();

      expect(
        screen.queryByRole("button", { name: /dismiss/i }),
      ).not.toBeInTheDocument();
    });

    it('shows empty state when there are no repos AND no 1-shot entries', () => {
      setupMockState({
        repos: [],
        oneShotEntries: new Map(),
      });
      renderHome();

      expect(screen.getByText(/no repos configured yet/i)).toBeInTheDocument();
    });

    it("does not show empty state when there are 1-shot entries but no repos", () => {
      const entry = makeOneShotEntry({
        id: "oneshot-only",
        title: "Solo 1-shot task",
        status: "running",
      });

      setupMockState({
        repos: [],
        oneShotEntries: new Map([["oneshot-only", entry]]),
        sessions: new Map([
          [
            "oneshot-only",
            makeSessionState({
              running: true,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
        ]),
      });
      renderHome();

      expect(
        screen.queryByText(/no repos configured yet/i),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Solo 1-shot task — 1-Shot/i }),
      ).toBeInTheDocument();
    });

    it("navigates to /oneshot/:oneshotId when a 1-shot card is clicked", () => {
      const entry = makeOneShotEntry({
        id: "oneshot-nav",
        title: "Clickable task",
      });

      setupMockState({
        oneShotEntries: new Map([["oneshot-nav", entry]]),
        sessions: new Map([
          [
            "oneshot-nav",
            makeSessionState({
              running: true,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
        ]),
      });
      renderHome();

      const card = screen.getByRole("button", {
        name: /Clickable task — 1-Shot/i,
      });
      fireEvent.click(card);

      expect(mockNavigate).toHaveBeenCalledWith("/oneshot/oneshot-nav");
    });

    it("displays the 1-Shot badge on oneshot cards", () => {
      const entry = makeOneShotEntry({
        id: "oneshot-badge",
        title: "Badge test",
      });

      setupMockState({
        oneShotEntries: new Map([["oneshot-badge", entry]]),
        sessions: new Map([
          [
            "oneshot-badge",
            makeSessionState({
              running: true,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
        ]),
      });
      renderHome();

      expect(screen.getByText("1-Shot")).toBeInTheDocument();
    });

    it("shows parent repo name on 1-shot card", () => {
      const entry = makeOneShotEntry({
        id: "oneshot-parent",
        title: "Parent test",
        parentRepoName: "cool-repo",
      });

      setupMockState({
        oneShotEntries: new Map([["oneshot-parent", entry]]),
        sessions: new Map([
          [
            "oneshot-parent",
            makeSessionState({
              running: true,
              events: [{ kind: "one_shot_started" }],
            }),
          ],
        ]),
      });
      renderHome();

      expect(screen.getByText(/from cool-repo/)).toBeInTheDocument();
    });

    it("shows phase label derived from session events", () => {
      const entry = makeOneShotEntry({
        id: "oneshot-phase",
        title: "Phase test",
        status: "running",
      });

      setupMockState({
        oneShotEntries: new Map([["oneshot-phase", entry]]),
        sessions: new Map([
          [
            "oneshot-phase",
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
      renderHome();

      // "design" phase maps to "Design Phase" label
      expect(screen.getByText("Design Phase")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 17. Plan previews on repo cards
  // =========================================================================

  describe("Plan previews on repo cards", () => {
    it("calls invoke('read_file_preview', ...) for each trace with a plan_file", async () => {
      const repo1 = makeLocalRepo({
        id: "r1",
        name: "project-one",
      } as Partial<RepoConfig>);
      const repo2 = makeLocalRepo({
        id: "r2",
        name: "project-two",
      } as Partial<RepoConfig>);
      const trace1 = makeTrace({
        plan_file: "/home/beth/plans/plan-one.md",
      });
      const trace2 = makeTrace({
        plan_file: "/home/beth/plans/plan-two.md",
      });

      mockInvoke.mockResolvedValue("# Title\nSome excerpt text.");

      setupMockState({
        repos: [repo1, repo2],
        latestTraces: new Map([
          ["r1", trace1],
          ["r2", trace2],
        ]),
      });
      renderHome();

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("read_file_preview", {
          path: "/home/beth/plans/plan-one.md",
          maxLines: 8,
        });
        expect(mockInvoke).toHaveBeenCalledWith("read_file_preview", {
          path: "/home/beth/plans/plan-two.md",
          maxLines: 8,
        });
      });
    });

    it("shows plan excerpt text on the repo card when read_file_preview returns content", async () => {
      const repo = makeLocalRepo({
        id: "r1",
        name: "project-one",
      } as Partial<RepoConfig>);
      const trace = makeTrace({
        plan_file: "/home/beth/plans/deploy-fix.md",
      });

      mockInvoke.mockResolvedValue("# Plan Title\nThis is the excerpt text.");

      setupMockState({
        repos: [repo],
        latestTraces: new Map([["r1", trace]]),
      });
      renderHome();

      await waitFor(() => {
        expect(
          screen.getByText("This is the excerpt text."),
        ).toBeInTheDocument();
      });
    });

    it("does not call invoke for traces without a plan_file", async () => {
      const repo = makeLocalRepo({
        id: "r1",
        name: "project-one",
      } as Partial<RepoConfig>);
      const trace = makeTrace({
        plan_file: null,
    plan_content: null,
      });

      setupMockState({
        repos: [repo],
        latestTraces: new Map([["r1", trace]]),
      });
      renderHome();

      // Give time for any potential async calls
      await waitFor(() => {
        expect(screen.getByText("project-one")).toBeInTheDocument();
      });

      expect(mockInvoke).not.toHaveBeenCalledWith(
        "read_file_preview",
        expect.anything(),
      );
    });

    it("does not show excerpt when read_file_preview rejects", async () => {
      const repo = makeLocalRepo({
        id: "r1",
        name: "project-one",
      } as Partial<RepoConfig>);
      const trace = makeTrace({
        plan_file: "/home/beth/plans/missing-plan.md",
      });

      mockInvoke.mockRejectedValue(new Error("File not found"));

      setupMockState({
        repos: [repo],
        latestTraces: new Map([["r1", trace]]),
      });
      renderHome();

      // Wait for the invoke to have been called and rejected
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("read_file_preview", {
          path: "/home/beth/plans/missing-plan.md",
          maxLines: 8,
        });
      });

      // No excerpt text should appear — the plan filename is shown but no excerpt below it
      expect(screen.queryByText(/excerpt/i)).not.toBeInTheDocument();
    });
  });
});
