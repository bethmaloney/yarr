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
import type { SessionState, SessionTrace, BranchInfo } from "../types";

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

const { mockUseBranchInfo } = vi.hoisted(() => ({
  mockUseBranchInfo: vi.fn(),
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

vi.mock("../hooks/useBranchInfo", () => ({
  useBranchInfo: mockUseBranchInfo,
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

interface MockState {
  repos: RepoConfig[];
  sessions: Map<string, SessionState>;
  latestTraces: Map<string, SessionTrace>;
  addLocalRepo: ReturnType<typeof vi.fn>;
  addSshRepo: ReturnType<typeof vi.fn>;
}

function setupMockState(overrides: Partial<MockState> = {}): MockState {
  const state: MockState = {
    repos: [],
    sessions: new Map(),
    latestTraces: new Map(),
    addLocalRepo: vi.fn(),
    addSshRepo: vi.fn(),
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
  mockUseBranchInfo.mockReturnValue(new Map<string, BranchInfo>());
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
  // 14. Branch info is passed to RepoCard
  // =========================================================================

  it("passes branch name from useBranchInfo to RepoCard", () => {
    const repo = makeLocalRepo({ id: "r1" } as Partial<RepoConfig>);
    setupMockState({ repos: [repo] });

    const branchMap = new Map<string, BranchInfo>([
      ["r1", { name: "feat/awesome", ahead: 1, behind: 0 }],
    ]);
    mockUseBranchInfo.mockReturnValue(branchMap);

    renderHome();

    expect(screen.getByText("feat/awesome")).toBeInTheDocument();
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
});
