import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";

import type { SessionTrace, SessionEvent } from "../types";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

// Mock react-markdown (doesn't work in jsdom)
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

// Mock PlanPanel to simplify testing
vi.mock("../PlanPanel", () => ({
  PlanPanel: (props: {
    open: boolean;
    planContent: string;
    planFile: string;
  }) =>
    props.open ? (
      <div data-testid="plan-panel" data-plan-file={props.planFile}>
        {props.planContent}
      </div>
    ) : null,
}));

// Mock EventsList since we just care that it receives correct props
vi.mock("../components/EventsList", () => ({
  EventsList: (props: Record<string, unknown>) => (
    <div
      data-testid="events-list"
      data-repo-path={props.repoPath}
      data-event-count={Array.isArray(props.events) ? props.events.length : 0}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Import the component under test (after mocks are registered)
// ---------------------------------------------------------------------------

import RunDetail from "./RunDetail";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    session_id: "sess-abc-123",
    repo_path: "/home/beth/repos/my-project",
    prompt: "Fix the login bug",
    plan_file: "/home/beth/plans/fix-bug.md",
    plan_content: null,
    repo_id: "repo-1",
    session_type: "ralph_loop",
    start_time: "2026-03-10T10:00:00Z",
    end_time: "2026-03-10T10:30:00Z",
    outcome: "completed",
    failure_reason: null,
    total_iterations: 5,
    total_cost_usd: 1.2345,
    total_input_tokens: 10000,
    total_output_tokens: 5000,
    total_cache_read_tokens: 2000,
    total_cache_creation_tokens: 500,
    ...overrides,
  };
}

function makeEvents(): SessionEvent[] {
  return [
    { kind: "iteration_start", iteration: 1, _ts: 1000 },
    { kind: "tool_use", tool_name: "Read", iteration: 1, _ts: 2000 },
  ];
}

function renderRunDetail(route = "/run/repo-1/sess-abc-123") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/run/:repoId/:sessionId" element={<RunDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setupDefaultInvoke(
  traceOverrides: Partial<SessionTrace> = {},
  events?: SessionEvent[],
) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "get_trace") return Promise.resolve(makeTrace(traceOverrides));
    if (cmd === "get_trace_events")
      return Promise.resolve(events ?? makeEvents());
    return Promise.resolve(null);
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  setupDefaultInvoke();
});

afterEach(() => {
  cleanup();
});

describe("RunDetail", () => {
  // =========================================================================
  // 1. Loading state
  // =========================================================================

  describe("loading state", () => {
    it('shows "Loading..." while invoke is pending', () => {
      mockInvoke.mockReturnValue(new Promise(() => {}));
      renderRunDetail();

      expect(screen.getByText(/loading/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 2. Error state
  // =========================================================================

  describe("error state", () => {
    it("shows error message when invoke rejects", async () => {
      mockInvoke.mockRejectedValue(new Error("Failed to load trace"));
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText(/failed to load trace/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 3. Breadcrumbs
  // =========================================================================

  describe("breadcrumbs", () => {
    it("renders Home > History > Run {sessionId} breadcrumbs", async () => {
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Home")).toBeInTheDocument();
        expect(screen.getByText("History")).toBeInTheDocument();
        expect(screen.getByText(/sess-abc-123/)).toBeInTheDocument();
      });
    });

    it('clicking "Home" navigates to "/"', async () => {
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Home")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Home"));

      expect(mockNavigate).toHaveBeenCalledWith("/");
    });

    it('clicking "History" navigates to "/history"', async () => {
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("History")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("History"));

      expect(mockNavigate).toHaveBeenCalledWith("/history");
    });
  });

  // =========================================================================
  // 4. Header
  // =========================================================================

  describe("header", () => {
    it('shows "Run Detail" title', async () => {
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText(/Run Detail/)).toBeInTheDocument();
      });
    });

    it("shows formatted date from trace.start_time", async () => {
      setupDefaultInvoke({ start_time: "2026-03-10T10:00:00Z" });
      renderRunDetail();

      await waitFor(() => {
        // The date should be formatted (e.g. "Mar 10, 2026" or similar)
        expect(
          screen.getByText(
            /Mar.*10.*2026|10.*Mar.*2026|2026.*03.*10|3\/10\/2026/,
          ),
        ).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 5. Summary section
  // =========================================================================

  describe("summary section", () => {
    it('shows outcome badge (e.g. "Completed")', async () => {
      setupDefaultInvoke({ outcome: "completed" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Completed")).toBeInTheDocument();
      });
    });

    it("shows plan display name (filename without .md extension)", async () => {
      setupDefaultInvoke({ plan_file: "/home/beth/plans/fix-bug.md" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("fix-bug")).toBeInTheDocument();
      });
    });

    it('shows "\u2014" when plan_file is null', async () => {
      setupDefaultInvoke({ plan_file: null });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("\u2014")).toBeInTheDocument();
      });
    });

    it("shows iteration count", async () => {
      setupDefaultInvoke({ total_iterations: 5 });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("5")).toBeInTheDocument();
      });
    });

    it("shows cost formatted to 4 decimal places", async () => {
      setupDefaultInvoke({ total_cost_usd: 1.2345 });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText(/\$1\.2345/)).toBeInTheDocument();
      });
    });

    it('shows duration (e.g. "30m 0s")', async () => {
      setupDefaultInvoke({
        start_time: "2026-03-10T10:00:00Z",
        end_time: "2026-03-10T10:30:00Z",
      });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText(/30m.*0s/)).toBeInTheDocument();
      });
    });

    it('shows "\u2014" for duration when end_time is null', async () => {
      setupDefaultInvoke({ end_time: null });
      renderRunDetail();

      await waitFor(() => {
        // There should be an em dash for duration.
        // We look for the duration label first to confirm the section loaded,
        // then verify an em dash exists near it.
        expect(screen.getByText(/Duration/)).toBeInTheDocument();
        const dashes = screen.getAllByText("\u2014");
        expect(dashes.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("shows token counts (input + cache_read + cache_creation) / output", async () => {
      setupDefaultInvoke({
        total_input_tokens: 10000,
        total_output_tokens: 5000,
        total_cache_read_tokens: 2000,
        total_cache_creation_tokens: 500,
      });
      renderRunDetail();

      await waitFor(() => {
        // Input tokens: 10000 + 2000 + 500 = 12500
        expect(screen.getByText(/12,?500/)).toBeInTheDocument();
        // Output tokens: 5000
        expect(screen.getByText(/5,?000/)).toBeInTheDocument();
      });
    });

    it("shows session ID", async () => {
      setupDefaultInvoke({ session_id: "sess-abc-123" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText(/sess-abc-123/)).toBeInTheDocument();
      });
    });

    it("shows failure_reason when present (outcome failed)", async () => {
      setupDefaultInvoke({
        outcome: "failed",
        failure_reason: "Check lint failed after 3 retries",
      });
      renderRunDetail();

      await waitFor(() => {
        expect(
          screen.getByText(/Check lint failed after 3 retries/),
        ).toBeInTheDocument();
      });
    });

    it("does NOT show failure_reason row when failure_reason is null", async () => {
      setupDefaultInvoke({ outcome: "completed", failure_reason: null });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Completed")).toBeInTheDocument();
      });

      // "Failure" or "Reason" label should not appear
      expect(screen.queryByText(/failure.reason/i)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // 6. Outcome badges
  // =========================================================================

  describe("outcome badges", () => {
    it('"completed" shows "Completed"', async () => {
      setupDefaultInvoke({ outcome: "completed" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Completed")).toBeInTheDocument();
      });
    });

    it('"failed" shows "Failed"', async () => {
      setupDefaultInvoke({ outcome: "failed" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Failed")).toBeInTheDocument();
      });
    });

    it('"max_iterations_reached" shows "Max Iters"', async () => {
      setupDefaultInvoke({ outcome: "max_iterations_reached" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Max Iters")).toBeInTheDocument();
      });
    });

    it('"cancelled" shows "Cancelled"', async () => {
      setupDefaultInvoke({ outcome: "cancelled" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Cancelled")).toBeInTheDocument();
      });
    });

    it("unknown outcome shows raw string", async () => {
      setupDefaultInvoke({ outcome: "something_unexpected" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("something_unexpected")).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 7. Copy session ID
  // =========================================================================

  describe("copy session ID", () => {
    it('copy button shows "Copy" initially', async () => {
      renderRunDetail();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /copy/i }),
        ).toBeInTheDocument();
      });
    });

    it("clicking Copy calls navigator.clipboard.writeText with session_id", async () => {
      const writeTextSpy = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValue();

      renderRunDetail();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /copy/i }),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /copy/i }));

      expect(writeTextSpy).toHaveBeenCalledWith("sess-abc-123");

      writeTextSpy.mockRestore();
    });

    it('after clicking, shows "Copied!" text', async () => {
      vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

      renderRunDetail();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /copy/i }),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /copy/i }));

      await waitFor(() => {
        expect(screen.getByText(/copied/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 8. EventsList integration
  // =========================================================================

  describe("EventsList integration", () => {
    it("passes events and repoPath to EventsList component", async () => {
      renderRunDetail();

      await waitFor(() => {
        const eventsList = screen.getByTestId("events-list");
        expect(eventsList).toBeInTheDocument();
        expect(eventsList).toHaveAttribute(
          "data-repo-path",
          "/home/beth/repos/my-project",
        );
        expect(eventsList).toHaveAttribute("data-event-count", "2");
      });
    });
  });

  // =========================================================================
  // 9. Invoke calls
  // =========================================================================

  describe("invoke calls", () => {
    it('on mount, calls invoke("get_trace") and invoke("get_trace_events") with correct params', async () => {
      renderRunDetail("/run/repo-1/sess-abc-123");

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("get_trace", {
          repoId: "repo-1",
          sessionId: "sess-abc-123",
        });
        expect(mockInvoke).toHaveBeenCalledWith("get_trace_events", {
          repoId: "repo-1",
          sessionId: "sess-abc-123",
        });
      });
    });
  });

  // =========================================================================
  // 10. PlanPanel integration
  // =========================================================================

  describe("PlanPanel integration", () => {
    const planContent = "# My Plan\n\nPlan details here.";
    const planFile = "/path/to/plan.md";

    it("shows 'View Plan' button when trace.plan_content is present", async () => {
      setupDefaultInvoke({ plan_content: planContent, plan_file: planFile });
      renderRunDetail();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /View Plan/ }),
        ).toBeInTheDocument();
      });
    });

    it("does not show 'View Plan' button when trace.plan_content is null", async () => {
      setupDefaultInvoke({ plan_content: null });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("fix-bug")).toBeInTheDocument();
      });

      expect(
        screen.queryByRole("button", { name: /View Plan/ }),
      ).not.toBeInTheDocument();
    });

    it("clicking 'View Plan' button opens the PlanPanel", async () => {
      setupDefaultInvoke({ plan_content: planContent, plan_file: planFile });
      renderRunDetail();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /View Plan/ }),
        ).toBeInTheDocument();
      });

      // PlanPanel should not be visible yet
      expect(screen.queryByTestId("plan-panel")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /View Plan/ }));

      await waitFor(() => {
        const panel = screen.getByTestId("plan-panel");
        expect(panel).toBeInTheDocument();
        expect(panel).toHaveAttribute("data-plan-file", planFile);
        expect(panel).toHaveTextContent("# My Plan Plan details here.");
      });
    });

    it("clicking plan name opens the PlanPanel when plan_content is present", async () => {
      setupDefaultInvoke({ plan_content: planContent, plan_file: planFile });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("plan")).toBeInTheDocument();
      });

      // Click the plan display name (filename without .md)
      fireEvent.click(screen.getByText("plan"));

      await waitFor(() => {
        expect(screen.getByTestId("plan-panel")).toBeInTheDocument();
      });
    });

    it("plan name is NOT clickable when plan_content is null", async () => {
      setupDefaultInvoke({ plan_content: null, plan_file: "/path/to/plan.md" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("plan")).toBeInTheDocument();
      });

      // Click the plan display name — should NOT open PlanPanel
      fireEvent.click(screen.getByText("plan"));

      // PlanPanel should not appear
      expect(screen.queryByTestId("plan-panel")).not.toBeInTheDocument();
    });
  });
});
