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
    it("shows spinner while invoke is pending", () => {
      mockInvoke.mockReturnValue(new Promise(() => {}));
      renderRunDetail();

      // The loading state renders a Loader2 spinner, not text.
      // Verify the breadcrumbs are present (component mounted) but no trace content yet.
      expect(screen.getByText("Home")).toBeInTheDocument();
      expect(screen.queryByText("Completed")).not.toBeInTheDocument();
      expect(document.querySelector(".animate-spin")).toBeInTheDocument();
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
    it("renders Home > History > displayTitle breadcrumbs", async () => {
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Home")).toBeInTheDocument();
        expect(screen.getByText("History")).toBeInTheDocument();
        // displayTitle "fix bug" appears in both breadcrumb and h1
        const matches = screen.getAllByText("fix bug");
        expect(matches.length).toBeGreaterThanOrEqual(1);
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
    it("shows display title from plan file", async () => {
      renderRunDetail();

      await waitFor(() => {
        // plan_file is "/home/beth/plans/fix-bug.md" => planFilename => "fix bug"
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
          "fix bug",
        );
        expect(screen.getAllByText("fix bug").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("falls back to trace.title when plan_file is null", async () => {
      setupDefaultInvoke({ plan_file: null, title: "My custom title" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
          "My custom title",
        );
      });
    });

    it("falls back to prompt text when plan_file is null", async () => {
      setupDefaultInvoke({ plan_file: null, prompt: "Fix the login bug" });
      renderRunDetail();

      await waitFor(() => {
        expect(
          screen.getAllByText("Fix the login bug").length,
        ).toBeGreaterThanOrEqual(1);
      });
    });

    it('falls back to "Run {sessionId}" when plan_file, title, and prompt are unavailable', async () => {
      setupDefaultInvoke({
        plan_file: null,
        title: undefined,
        prompt: undefined as unknown as string,
      });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
          "Run sess-abc-123",
        );
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
        // Badge appears in both header and sidebar
        expect(screen.getAllByText("Completed").length).toBeGreaterThanOrEqual(
          1,
        );
      });
    });

    it("shows plan display name (filename without .md extension)", async () => {
      setupDefaultInvoke({ plan_file: "/home/beth/plans/fix-bug.md" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("fix-bug")).toBeInTheDocument();
      });
    });

    it("does not show Plan row when plan_file and plan_content are both null", async () => {
      setupDefaultInvoke({ plan_file: null, plan_content: null });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Iterations")).toBeInTheDocument();
      });

      // Plan row should not be rendered
      expect(screen.queryByText("Plan")).not.toBeInTheDocument();
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
        // Duration appears in both header badge area and sidebar
        expect(screen.getAllByText(/30m.*0s/).length).toBeGreaterThanOrEqual(1);
      });
    });

    it("does not show Duration row when end_time is null", async () => {
      setupDefaultInvoke({ end_time: null });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getByText("Iterations")).toBeInTheDocument();
      });

      // Duration row should not be rendered when end_time is null
      expect(screen.queryByText("Duration")).not.toBeInTheDocument();
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
        expect(screen.getAllByText("Completed").length).toBeGreaterThanOrEqual(
          1,
        );
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
        // Badge appears in both header and sidebar
        expect(screen.getAllByText("Completed").length).toBeGreaterThanOrEqual(
          1,
        );
      });
    });

    it('"failed" shows "Failed"', async () => {
      setupDefaultInvoke({ outcome: "failed" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getAllByText("Failed").length).toBeGreaterThanOrEqual(1);
      });
    });

    it('"max_iterations_reached" shows "Max Iters"', async () => {
      setupDefaultInvoke({ outcome: "max_iterations_reached" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getAllByText("Max Iters").length).toBeGreaterThanOrEqual(
          1,
        );
      });
    });

    it('"cancelled" shows "Cancelled"', async () => {
      setupDefaultInvoke({ outcome: "cancelled" });
      renderRunDetail();

      await waitFor(() => {
        expect(screen.getAllByText("Cancelled").length).toBeGreaterThanOrEqual(
          1,
        );
      });
    });

    it("unknown outcome shows raw string", async () => {
      setupDefaultInvoke({ outcome: "something_unexpected" });
      renderRunDetail();

      await waitFor(() => {
        expect(
          screen.getAllByText("something_unexpected").length,
        ).toBeGreaterThanOrEqual(1);
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
        // The plan display name in the sidebar is a clickable span with role="button"
        expect(
          screen.getByRole("button", { name: "plan" }),
        ).toBeInTheDocument();
      });

      // Click the plan display name (filename without .md)
      fireEvent.click(screen.getByRole("button", { name: "plan" }));

      await waitFor(() => {
        expect(screen.getByTestId("plan-panel")).toBeInTheDocument();
      });
    });

    it("plan name is NOT clickable when plan_content is null", async () => {
      setupDefaultInvoke({ plan_content: null, plan_file: "/path/to/plan.md" });
      renderRunDetail();

      await waitFor(() => {
        // "plan" appears in multiple places (title, breadcrumb, sidebar)
        expect(screen.getAllByText("plan").length).toBeGreaterThanOrEqual(1);
      });

      // The plan name in the sidebar should NOT be a clickable button when plan_content is null
      // (it renders as plain text, not a span with role="button")
      expect(
        screen.queryByRole("button", { name: "plan" }),
      ).not.toBeInTheDocument();

      // Clicking should not open PlanPanel
      fireEvent.click(screen.getAllByText("plan")[0]);
      expect(screen.queryByTestId("plan-panel")).not.toBeInTheDocument();
    });
  });
});
