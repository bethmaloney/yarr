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
import type { SessionTrace } from "../types";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
}));

const { mockUseAppStore } = vi.hoisted(() => ({
  mockUseAppStore: vi.fn(),
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

vi.mock("../store", () => ({
  useAppStore: mockUseAppStore,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

// ---------------------------------------------------------------------------
// Import the component under test (after mocks are registered)
// ---------------------------------------------------------------------------

import History from "./History";

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
    completionSignal: "<promise>COMPLETE</promise>",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    session_id: "sess-1",
    repo_path: "/home/beth/repos/my-project",
    prompt: "Fix the login bug",
    plan_file: null,
    plan_content: null,
    repo_id: "repo-1",
    session_type: "ralph_loop",
    start_time: "2026-03-10T10:00:00Z",
    end_time: "2026-03-10T10:30:00Z",
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

interface MockState {
  repos: RepoConfig[];
}

function setupMockState(overrides: Partial<MockState> = {}): MockState {
  const state: MockState = {
    repos: [],
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

function renderHistory(route = "/history") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/history" element={<History />} />
        <Route path="/history/:repoId" element={<History />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  setupMockState();
  mockInvoke.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("History", () => {
  // =========================================================================
  // 1. Loading state
  // =========================================================================

  describe("loading state", () => {
    it('shows "Loading..." while invoke is pending', () => {
      // Make invoke hang (never resolve)
      mockInvoke.mockReturnValue(new Promise(() => {}));
      setupMockState();
      renderHistory();

      expect(screen.getByText(/loading/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 2. Error state
  // =========================================================================

  describe("error state", () => {
    it("shows error message when invoke rejects", async () => {
      mockInvoke.mockRejectedValue(new Error("Failed to load traces"));
      setupMockState();
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText(/failed to load traces/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 3. Empty state
  // =========================================================================

  describe("empty state", () => {
    it('shows "No runs recorded yet." when traces is empty', async () => {
      mockInvoke.mockResolvedValue([]);
      setupMockState();
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText(/no runs recorded yet/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 4. Breadcrumbs
  // =========================================================================

  describe("breadcrumbs", () => {
    it("global view (no repoId): renders Home > History breadcrumbs", async () => {
      mockInvoke.mockResolvedValue([]);
      setupMockState();
      renderHistory("/history");

      await waitFor(() => {
        expect(screen.getByText("Home")).toBeInTheDocument();
        expect(
          screen.getByRole("heading", { name: "History" }),
        ).toBeInTheDocument();
      });
    });

    it("repo-filtered view (with repoId): renders Home > RepoName > History", async () => {
      mockInvoke.mockResolvedValue([]);
      setupMockState({
        repos: [
          makeLocalRepo({
            id: "repo-1",
            name: "my-project",
          } as Partial<RepoConfig>),
        ],
      });
      renderHistory("/history/repo-1");

      await waitFor(() => {
        expect(screen.getByText("Home")).toBeInTheDocument();
        expect(screen.getByText("my-project")).toBeInTheDocument();
        expect(
          screen.getByRole("heading", { name: "History" }),
        ).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 5. Column headers
  // =========================================================================

  describe("column headers", () => {
    it("renders all column headers (Date, Type, Description, Status, Duration)", async () => {
      mockInvoke.mockResolvedValue([makeTrace()]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText(/^Date$/)).toBeInTheDocument();
        expect(screen.getByText(/^Type$/)).toBeInTheDocument();
        expect(screen.getByText(/^Description$/)).toBeInTheDocument();
        expect(screen.getByText(/^Status$/)).toBeInTheDocument();
        expect(screen.getByText(/^Duration$/)).toBeInTheDocument();
      });
    });

    it('shows "Repo" column only in global view (no repoId)', async () => {
      mockInvoke.mockResolvedValue([makeTrace()]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory("/history");

      await waitFor(() => {
        expect(screen.getByText(/^Repo$/)).toBeInTheDocument();
      });
    });

    it('does NOT show "Repo" column in repo-filtered view', async () => {
      mockInvoke.mockResolvedValue([makeTrace()]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory("/history/repo-1");

      await waitFor(() => {
        expect(screen.queryByText(/^Repo$/)).not.toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 6. Sorting
  // =========================================================================

  describe("sorting", () => {
    it("clicking Date column toggles sort direction (shows arrow indicator)", async () => {
      mockInvoke.mockResolvedValue([makeTrace()]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText(/^Date$/)).toBeInTheDocument();
      });

      // Default sort is start_time desc, so Date column should show down arrow
      const dateHeader =
        screen.getByText(/^Date$/).closest("button") ??
        screen.getByText(/^Date$/);
      expect(dateHeader.textContent).toContain("\u2193"); // ↓ for desc

      // Click to toggle to asc
      fireEvent.click(dateHeader);

      await waitFor(() => {
        const updatedHeader =
          screen.getByText(/^Date$/).closest("button") ??
          screen.getByText(/^Date$/);
        expect(updatedHeader.textContent).toContain("\u2191"); // ↑ for asc
      });
    });

    it("clicking a different column switches sort field", async () => {
      mockInvoke.mockResolvedValue([makeTrace()]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText(/^Duration$/)).toBeInTheDocument();
      });

      const durationHeader =
        screen.getByText(/^Duration$/).closest("button") ??
        screen.getByText(/^Duration$/);
      fireEvent.click(durationHeader);

      await waitFor(() => {
        const updatedHeader =
          screen.getByText(/^Duration$/).closest("button") ??
          screen.getByText(/^Duration$/);
        expect(
          updatedHeader.textContent?.includes("\u2191") ||
            updatedHeader.textContent?.includes("\u2193"),
        ).toBe(true);
      });
    });
  });

  // =========================================================================
  // 7. Trace rows
  // =========================================================================

  describe("trace rows", () => {
    it("renders trace data: date, type, description, outcome badge, duration", async () => {
      const trace = makeTrace({
        session_type: "ralph_loop",
        prompt: "Fix the login bug",
        outcome: "completed",
        total_iterations: 5,
        total_cost_usd: 1.23,
        start_time: "2026-03-10T10:00:00Z",
        end_time: "2026-03-10T10:30:00Z",
      });
      mockInvoke.mockResolvedValue([trace]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText(/Fix the login bug/)).toBeInTheDocument();
        expect(screen.getByText(/Completed/)).toBeInTheDocument();
        expect(screen.getByText(/Ralph Loop/)).toBeInTheDocument();
      });
    });

    it('shows "1-Shot" for session_type "one_shot", "Ralph Loop" otherwise', async () => {
      const traces = [
        makeTrace({
          session_id: "sess-1",
          session_type: "one_shot",
          prompt: "one shot task",
        }),
        makeTrace({
          session_id: "sess-2",
          session_type: "ralph_loop",
          prompt: "loop task",
        }),
      ];
      mockInvoke.mockResolvedValue(traces);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText("1-Shot")).toBeInTheDocument();
        expect(screen.getByText("Ralph Loop")).toBeInTheDocument();
      });
    });

    it("shows plan filename for ralph loops, prompt for 1-shots", async () => {
      const traces = [
        makeTrace({
          session_id: "sess-1",
          session_type: "ralph_loop",
          plan_file: "/home/beth/plans/fix-bug.md",
          prompt: "with plan",
        }),
        makeTrace({
          session_id: "sess-2",
          session_type: "one_shot",
          plan_file: null,
          prompt: "one shot prompt",
        }),
        makeTrace({
          session_id: "sess-3",
          session_type: "ralph_loop",
          plan_file: null,
          prompt: "ralph no plan",
        }),
      ];
      mockInvoke.mockResolvedValue(traces);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        // Ralph loop with plan → shows plan filename
        expect(screen.getByText("fix bug")).toBeInTheDocument();
        // 1-shot → shows prompt
        expect(screen.getByText("one shot prompt")).toBeInTheDocument();
        // Ralph loop without plan → falls back to prompt
        expect(screen.getByText("ralph no plan")).toBeInTheDocument();
      });
    });

    it("shows repo name column in global view", async () => {
      const trace = makeTrace({ repo_id: "repo-1" });
      mockInvoke.mockResolvedValue([trace]);
      setupMockState({
        repos: [
          makeLocalRepo({
            id: "repo-1",
            name: "my-project",
          } as Partial<RepoConfig>),
        ],
      });
      renderHistory("/history");

      await waitFor(() => {
        // The repo name should appear in the row
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });
    });

    it("clicking a trace row navigates to /run/:repoId/:sessionId", async () => {
      const trace = makeTrace({ session_id: "sess-abc", repo_id: "repo-1" });
      mockInvoke.mockResolvedValue([trace]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText(/Fix the login bug/)).toBeInTheDocument();
      });

      // The row should be a clickable button
      const row =
        screen.getByText(/Fix the login bug/).closest("button") ??
        screen.getByText(/Fix the login bug/).closest("tr");
      expect(row).not.toBeNull();
      fireEvent.click(row!);

      expect(mockNavigate).toHaveBeenCalledWith("/run/repo-1/sess-abc");
    });
  });

  // =========================================================================
  // 8. Outcome badges
  // =========================================================================

  describe("outcome badges", () => {
    it('shows "Completed" badge for completed outcome', async () => {
      mockInvoke.mockResolvedValue([makeTrace({ outcome: "completed" })]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText("Completed")).toBeInTheDocument();
      });
    });

    it('shows "Failed" badge for failed outcome', async () => {
      mockInvoke.mockResolvedValue([
        makeTrace({ outcome: "failed", session_id: "sess-fail" }),
      ]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText("Failed")).toBeInTheDocument();
      });
    });

    it('shows "Max Iters" badge for max_iterations_reached outcome', async () => {
      mockInvoke.mockResolvedValue([
        makeTrace({
          outcome: "max_iterations_reached",
          session_id: "sess-max",
        }),
      ]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText("Max Iters")).toBeInTheDocument();
      });
    });

    it('shows "Cancelled" badge for cancelled outcome', async () => {
      mockInvoke.mockResolvedValue([
        makeTrace({ outcome: "cancelled", session_id: "sess-cancel" }),
      ]);
      setupMockState({ repos: [makeLocalRepo()] });
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText("Cancelled")).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 9. Navigation
  // =========================================================================

  describe("navigation", () => {
    it('Home breadcrumb click navigates to "/"', async () => {
      mockInvoke.mockResolvedValue([]);
      setupMockState();
      renderHistory();

      await waitFor(() => {
        expect(screen.getByText("Home")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Home"));

      expect(mockNavigate).toHaveBeenCalledWith("/");
    });

    it("repo breadcrumb click (in repo-filtered view) navigates to /repo/:repoId", async () => {
      mockInvoke.mockResolvedValue([]);
      setupMockState({
        repos: [
          makeLocalRepo({
            id: "repo-1",
            name: "my-project",
          } as Partial<RepoConfig>),
        ],
      });
      renderHistory("/history/repo-1");

      await waitFor(() => {
        expect(screen.getByText("my-project")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("my-project"));

      expect(mockNavigate).toHaveBeenCalledWith("/repo/repo-1");
    });

    // -----------------------------------------------------------------------
    // Oneshot trace navigation
    // -----------------------------------------------------------------------

    describe("oneshot trace navigation", () => {
      it("clicking a one_shot trace navigates to /oneshot/{repo_id} in global view", async () => {
        const trace = makeTrace({
          session_id: "sess-os-1",
          repo_id: "oneshot-abc123",
          session_type: "one_shot",
          prompt: "Run a oneshot task",
        });
        mockInvoke.mockResolvedValue([trace]);
        setupMockState({ repos: [makeLocalRepo()] });
        renderHistory();

        await waitFor(() => {
          expect(screen.getByText(/Run a oneshot task/)).toBeInTheDocument();
        });

        const row =
          screen.getByText(/Run a oneshot task/).closest("button") ??
          screen.getByText(/Run a oneshot task/).closest("tr");
        expect(row).not.toBeNull();
        fireEvent.click(row!);

        expect(mockNavigate).toHaveBeenCalledWith("/oneshot/oneshot-abc123");
      });

      it("clicking a ralph_loop trace still navigates to /run/{repoId}/{sessionId}", async () => {
        const trace = makeTrace({
          session_id: "sess-rl-1",
          repo_id: "repo-1",
          session_type: "ralph_loop",
          prompt: "Run a ralph loop task",
        });
        mockInvoke.mockResolvedValue([trace]);
        setupMockState({ repos: [makeLocalRepo()] });
        renderHistory();

        await waitFor(() => {
          expect(screen.getByText(/Run a ralph loop task/)).toBeInTheDocument();
        });

        const row =
          screen.getByText(/Run a ralph loop task/).closest("button") ??
          screen.getByText(/Run a ralph loop task/).closest("tr");
        expect(row).not.toBeNull();
        fireEvent.click(row!);

        expect(mockNavigate).toHaveBeenCalledWith("/run/repo-1/sess-rl-1");
      });

      it("in repo-filtered view, clicking a oneshot trace navigates using trace.repo_id", async () => {
        const trace = makeTrace({
          session_id: "sess-os-2",
          repo_id: "oneshot-def456",
          session_type: "one_shot",
          prompt: "Repo-filtered oneshot task",
        });
        mockInvoke.mockResolvedValue([trace]);
        setupMockState({
          repos: [makeLocalRepo({ id: "repo-1" } as Partial<RepoConfig>)],
        });
        renderHistory("/history/repo-1");

        await waitFor(() => {
          expect(
            screen.getByText(/Repo-filtered oneshot task/),
          ).toBeInTheDocument();
        });

        const row =
          screen.getByText(/Repo-filtered oneshot task/).closest("button") ??
          screen.getByText(/Repo-filtered oneshot task/).closest("tr");
        expect(row).not.toBeNull();
        fireEvent.click(row!);

        expect(mockNavigate).toHaveBeenCalledWith("/oneshot/oneshot-def456");
      });
    });
  });
});
