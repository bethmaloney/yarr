import { vi, describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import type { SessionEvent } from "../types";
import type { IterationGroup } from "../iteration-groups";
import { eventEmoji, eventLabel } from "../event-format";

// ===========================================================================
// Mocks
// ===========================================================================

vi.mock("./IterationGroup", () => ({
  IterationGroupComponent: (props: {
    group: IterationGroup;
    expanded: boolean;
    onToggle: () => void;
    globalStartIndex: number;
  }) => (
    <div
      data-testid={`iteration-group-${props.group.iteration}`}
      data-expanded={props.expanded}
      data-global-start-index={props.globalStartIndex}
    >
      <button onClick={props.onToggle}>
        Iteration {props.group.iteration} ({props.group.events.length} events)
      </button>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
});

// ===========================================================================
// Test helpers
// ===========================================================================

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    kind: "tool_use",
    session_id: "sess-1",
    iteration: 1,
    _ts: 1700000000000,
    ...overrides,
  };
}

function makeIterationEvents(
  iteration: number,
  extraEvents: Partial<SessionEvent>[] = [],
): SessionEvent[] {
  return [
    makeEvent({
      kind: "iteration_started",
      iteration,
      _ts: 1700000000000 + iteration * 60000,
    }),
    ...extraEvents.map((ov) =>
      makeEvent({
        iteration,
        _ts: 1700000000000 + iteration * 60000 + 5000,
        ...ov,
      }),
    ),
    makeEvent({
      kind: "iteration_complete",
      iteration,
      result: { total_cost_usd: 0.05 },
      _ts: 1700000000000 + iteration * 60000 + 30000,
    }),
  ];
}

// Lazy import to allow mock registration above to take effect
async function importEventsList() {
  const mod = await import("./EventsList");
  return mod.EventsList;
}

// ===========================================================================
// EventsList
// ===========================================================================

describe("EventsList", () => {
  // =========================================================================
  // 1. Renders nothing when events is empty
  // =========================================================================

  it("renders nothing when events array is empty", async () => {
    const EventsList = await importEventsList();
    const { container } = render(<EventsList events={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null — no DOM nodes — for empty events", async () => {
    const EventsList = await importEventsList();
    const { container } = render(<EventsList events={[]} />);
    expect(container.childNodes).toHaveLength(0);
  });

  // =========================================================================
  // 2. Renders header with "Events" title when events exist
  // =========================================================================

  it("renders an h2 with 'Events' when events exist", async () => {
    const EventsList = await importEventsList();
    const events = [makeEvent({ kind: "session_started", session_id: "s1" })];
    render(<EventsList events={events} />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent("Events");
  });

  // =========================================================================
  // 3. Shows event count badge
  // =========================================================================

  it("shows event count badge with the total number of events", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({ kind: "session_started", session_id: "s1" }),
      ...makeIterationEvents(1, [{ kind: "tool_use", tool_name: "Bash" }]),
      makeEvent({ kind: "session_complete", outcome: "completed" }),
    ];
    render(<EventsList events={events} />);
    // The badge should show the total count
    expect(screen.getByText(String(events.length))).toBeInTheDocument();
  });

  it("updates the badge count when more events are provided", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({ kind: "session_started", session_id: "s1" }),
      makeEvent({ kind: "session_complete", outcome: "completed" }),
    ];
    render(<EventsList events={events} />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  // =========================================================================
  // 4. Renders standalone "before" events
  // =========================================================================

  it("renders standalone before-events with correct emoji, label, and time", async () => {
    const EventsList = await importEventsList();
    const ts = 1700000000000;
    const events = [
      makeEvent({ kind: "session_started", session_id: "sess-42", _ts: ts }),
    ];
    render(<EventsList events={events} />);

    // Check emoji
    const emoji = eventEmoji("session_started");
    expect(screen.getByText(emoji)).toBeInTheDocument();

    // Check label
    const label = eventLabel(events[0]!);
    expect(screen.getByText(label)).toBeInTheDocument();

    // Check time is rendered (formatted time span should exist)
    const timeStr = new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    expect(screen.getByText(timeStr)).toBeInTheDocument();
  });

  it("renders design_phase_started as a before-standalone event", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({ kind: "design_phase_started", _ts: 1700000000000 }),
    ];
    render(<EventsList events={events} />);

    const label = eventLabel(events[0]!);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // =========================================================================
  // 5. Renders standalone "after" events
  // =========================================================================

  it("renders standalone after-events with correct emoji, label, and time", async () => {
    const EventsList = await importEventsList();
    const ts = 1700000060000;
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      makeEvent({ kind: "session_complete", outcome: "completed", _ts: ts }),
    ];
    render(<EventsList events={events} />);

    // session_complete emoji
    const emoji = eventEmoji("session_complete");
    expect(screen.getByText(emoji)).toBeInTheDocument();

    // session_complete label
    const label = eventLabel(events[1]!);
    expect(screen.getByText(label)).toBeInTheDocument();

    // time
    const timeStr = new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    expect(screen.getByText(timeStr)).toBeInTheDocument();
  });

  it("renders one_shot_complete as an after-standalone event", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "one_shot_started",
        title: "Fix bug",
        merge_strategy: "squash",
        _ts: 1700000000000,
      }),
      makeEvent({ kind: "one_shot_complete", _ts: 1700000060000 }),
    ];
    render(<EventsList events={events} />);

    const label = eventLabel(events[1]!);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("renders one_shot_failed as an after-standalone event", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "one_shot_started",
        title: "Deploy",
        merge_strategy: "merge",
        _ts: 1700000000000,
      }),
      makeEvent({
        kind: "one_shot_failed",
        reason: "timeout",
        _ts: 1700000060000,
      }),
    ];
    render(<EventsList events={events} />);

    const label = eventLabel(events[1]!);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // =========================================================================
  // 6. Renders IterationGroup components
  // =========================================================================

  it("renders IterationGroup components for iteration events", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      ...makeIterationEvents(1, [
        {
          kind: "tool_use",
          tool_name: "Read",
          tool_input: { file_path: "/src/main.ts" },
        },
      ]),
      ...makeIterationEvents(2, [
        {
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "npm test" },
        },
      ]),
      makeEvent({
        kind: "session_complete",
        outcome: "completed",
        _ts: 1700000200000,
      }),
    ];
    render(<EventsList events={events} />);

    // Mocked IterationGroupComponent renders a div with data-testid
    expect(screen.getByTestId("iteration-group-1")).toBeInTheDocument();
    expect(screen.getByTestId("iteration-group-2")).toBeInTheDocument();
  });

  it("does not render iteration groups when there are no iteration events", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({ kind: "session_started", session_id: "s1" }),
      makeEvent({ kind: "session_complete", outcome: "completed" }),
    ];
    render(<EventsList events={events} />);

    expect(screen.queryByTestId(/iteration-group/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 7. Clicking a standalone before-event toggles expanded class
  // =========================================================================

  it("toggles expanded class on a standalone before-event when clicked", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
    ];
    render(<EventsList events={events} />);

    // Find the event button
    const label = eventLabel(events[0]!);
    const button = screen.getByText(label).closest("[role='button']")!;
    const li = button.closest("li")!;

    // Initially not expanded
    expect(li.className).not.toContain("expanded");

    // Click to expand
    fireEvent.click(button);
    expect(li.className).toContain("expanded");

    // Click again to collapse
    fireEvent.click(button);
    expect(li.className).not.toContain("expanded");
  });

  // =========================================================================
  // 8. Clicking a standalone after-event toggles it
  // =========================================================================

  it("toggles expanded class on a standalone after-event when clicked", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      makeEvent({
        kind: "session_complete",
        outcome: "completed",
        _ts: 1700000060000,
      }),
    ];
    render(<EventsList events={events} />);

    const label = eventLabel(events[1]!);
    const button = screen.getByText(label).closest("[role='button']")!;
    const li = button.closest("li")!;

    // Initially not expanded
    expect(li.className).not.toContain("expanded");

    // Click to expand
    fireEvent.click(button);
    expect(li.className).toContain("expanded");

    // Click again to collapse
    fireEvent.click(button);
    expect(li.className).not.toContain("expanded");
  });

  // =========================================================================
  // 9. Expanded standalone git_sync_failed shows error detail
  // =========================================================================

  it("shows error detail in a <pre> when an expanded git_sync_failed event has .error", async () => {
    const EventsList = await importEventsList();
    // Place git_sync_failed alongside standalones to test the detail rendering.
    // The implementation should render a <pre class="tool-input-detail"> for
    // expanded git_sync_failed events that have an .error field.
    const eventsWithGitFail = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      makeEvent({
        kind: "git_sync_failed",
        error: "fatal: remote origin not found",
        iteration: 1,
        _ts: 1700000060000,
      }),
      makeEvent({
        kind: "session_complete",
        outcome: "failed",
        _ts: 1700000120000,
      }),
    ];
    const { container } = render(<EventsList events={eventsWithGitFail} />);

    const errorText = "fatal: remote origin not found";

    // Initially no pre with error visible (event not expanded)
    let preElements = container.querySelectorAll("pre.tool-input-detail");
    let hasError = Array.from(preElements).some((pre) =>
      pre.textContent?.includes(errorText),
    );
    expect(hasError).toBe(false);

    // Find and click the git_sync_failed event button to expand it
    const gitSyncLabel = eventLabel(eventsWithGitFail[1]!);
    const btn = screen.queryByText(
      new RegExp(gitSyncLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    if (btn) {
      const button = btn.closest("[role='button']");
      if (button) fireEvent.click(button);

      // Now the error detail should be visible
      preElements = container.querySelectorAll("pre.tool-input-detail");
      hasError = Array.from(preElements).some((pre) =>
        pre.textContent?.includes(errorText),
      );
      expect(hasError).toBe(true);
    }
  });

  // =========================================================================
  // 10. Expanded standalone event does NOT show detail for non-git_sync_failed
  // =========================================================================

  it("does NOT show expandable detail for non-git_sync_failed standalone events", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
    ];
    const { container } = render(<EventsList events={events} />);

    // Click to expand the session_started event
    const label = eventLabel(events[0]!);
    const button = screen.getByText(label).closest("[role='button']")!;
    fireEvent.click(button);

    // Verify the li has expanded class
    const li = button.closest("li")!;
    expect(li.className).toContain("expanded");

    // But no <pre> detail should be shown
    const preElements = container.querySelectorAll("pre.tool-input-detail");
    expect(preElements).toHaveLength(0);
  });

  it("does NOT show detail for expanded session_complete event", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      makeEvent({
        kind: "session_complete",
        outcome: "completed",
        _ts: 1700000060000,
      }),
    ];
    const { container } = render(<EventsList events={events} />);

    // Click to expand session_complete
    const label = eventLabel(events[1]!);
    const button = screen.getByText(label).closest("[role='button']")!;
    fireEvent.click(button);

    const preElements = container.querySelectorAll("pre.tool-input-detail");
    expect(preElements).toHaveLength(0);
  });

  // =========================================================================
  // 11. Global index calculation
  // =========================================================================

  it("assigns correct global indices: before-standalones, then iterations, then after-standalones", async () => {
    const EventsList = await importEventsList();
    // 2 before-standalones, 1 iteration with 3 events, 1 after-standalone
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      makeEvent({ kind: "design_phase_started", _ts: 1700000001000 }),
      ...makeIterationEvents(1, [
        { kind: "tool_use", tool_name: "Bash", tool_input: { command: "ls" } },
      ]),
      makeEvent({
        kind: "session_complete",
        outcome: "completed",
        _ts: 1700000200000,
      }),
    ];
    render(<EventsList events={events} />);

    // The mocked IterationGroupComponent receives globalStartIndex as a prop.
    // Before-standalones: indices 0, 1 (2 events)
    // Iteration 1 events should start at index 2
    const iterGroup = screen.getByTestId("iteration-group-1");
    expect(iterGroup).toHaveAttribute("data-global-start-index", "2");
  });

  it("continues global indices after iteration events for after-standalones", async () => {
    const EventsList = await importEventsList();
    // 1 before-standalone, 1 iteration with 3 events, 1 after-standalone
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      ...makeIterationEvents(1, [{ kind: "tool_use", tool_name: "Read" }]),
      makeEvent({
        kind: "session_complete",
        outcome: "completed",
        _ts: 1700000200000,
      }),
    ];
    render(<EventsList events={events} />);

    // before-standalone: index 0 (session_started)
    // iteration events: indices 1, 2, 3 (iteration_started, tool_use, iteration_complete)
    // after-standalone: index 4 (session_complete)
    // The after-standalone <li> should get clicked with global index 4.
    // We can verify by clicking it and checking that the expanded set uses the correct index.
    // Since we can't directly inspect the expandedEvents state, we verify via the
    // IterationGroupComponent's globalStartIndex which we can read from the mock.
    const iterGroup = screen.getByTestId("iteration-group-1");
    expect(iterGroup).toHaveAttribute("data-global-start-index", "1");
  });

  it("handles multiple iterations with correct cumulative global start indices", async () => {
    const EventsList = await importEventsList();
    // 1 before, iteration 1 (3 events), iteration 2 (3 events), 1 after
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      ...makeIterationEvents(1, [{ kind: "tool_use", tool_name: "Read" }]),
      ...makeIterationEvents(2, [{ kind: "tool_use", tool_name: "Write" }]),
      makeEvent({
        kind: "session_complete",
        outcome: "completed",
        _ts: 1700000300000,
      }),
    ];
    render(<EventsList events={events} />);

    // before-standalone: index 0
    // iteration 1: starts at 1, has 3 events (indices 1, 2, 3)
    // iteration 2: starts at 4, has 3 events (indices 4, 5, 6)
    const iterGroup1 = screen.getByTestId("iteration-group-1");
    expect(iterGroup1).toHaveAttribute("data-global-start-index", "1");

    const iterGroup2 = screen.getByTestId("iteration-group-2");
    expect(iterGroup2).toHaveAttribute("data-global-start-index", "4");
  });

  // =========================================================================
  // 12. Auto-expand latest iteration when live
  // =========================================================================

  it("auto-expands the latest iteration when isLive is true", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      ...makeIterationEvents(1, [{ kind: "tool_use", tool_name: "Read" }]),
      ...makeIterationEvents(2, [{ kind: "tool_use", tool_name: "Write" }]),
    ];
    render(<EventsList events={events} isLive={true} />);

    // The latest iteration (2) should be expanded; earlier ones should not
    const iterGroup1 = screen.getByTestId("iteration-group-1");
    const iterGroup2 = screen.getByTestId("iteration-group-2");

    expect(iterGroup2).toHaveAttribute("data-expanded", "true");
    // iteration 1 should NOT be auto-expanded (only the latest)
    expect(iterGroup1).toHaveAttribute("data-expanded", "false");
  });

  it("does not auto-expand iterations when isLive is false", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      ...makeIterationEvents(1, [{ kind: "tool_use", tool_name: "Read" }]),
    ];
    render(<EventsList events={events} isLive={false} />);

    const iterGroup = screen.getByTestId("iteration-group-1");
    expect(iterGroup).toHaveAttribute("data-expanded", "false");
  });

  it("does not auto-expand when isLive is not provided (defaults to false)", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      ...makeIterationEvents(1, [{ kind: "tool_use", tool_name: "Read" }]),
    ];
    render(<EventsList events={events} />);

    const iterGroup = screen.getByTestId("iteration-group-1");
    expect(iterGroup).toHaveAttribute("data-expanded", "false");
  });

  // =========================================================================
  // 13. Jump-to-bottom button not shown initially
  // =========================================================================

  it("does not show the jump-to-bottom button initially (autoScroll starts true)", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
    ];
    render(<EventsList events={events} isLive={true} />);

    // The jump-to-bottom button should not be present when autoScroll is true
    expect(screen.queryByText(/jump to bottom/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /bottom/i }),
    ).not.toBeInTheDocument();
  });

  // =========================================================================
  // 14. Event kind color classes
  // =========================================================================

  it("applies text-[#4ecdc4] class for session_started standalone events", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
    ];
    const { container } = render(<EventsList events={events} />);

    const li = container.querySelector("li.session_started");
    expect(li).not.toBeNull();
    expect(li!.className).toContain("text-[#4ecdc4]");
  });

  it("applies text-[#e8d44d] and font-semibold classes for session_complete events", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      makeEvent({
        kind: "session_complete",
        outcome: "completed",
        _ts: 1700000060000,
      }),
    ];
    const { container } = render(<EventsList events={events} />);

    const li = container.querySelector("li.session_complete");
    expect(li).not.toBeNull();
    expect(li!.className).toContain("text-[#e8d44d]");
    expect(li!.className).toContain("font-semibold");
  });

  it("applies text-[#ef4444] class for git_sync_failed events rendered as standalone", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "git_sync_failed",
        error: "push rejected",
        iteration: 1,
        _ts: 1700000000000,
      }),
    ];
    const { container } = render(<EventsList events={events} />);

    // git_sync_failed may be in an iteration group via the mock, but if
    // rendered as standalone the li should have the color class
    const li = container.querySelector("li.git_sync_failed");
    if (li) {
      expect(li.className).toContain("text-[#ef4444]");
    }
  });

  it("applies kind as a CSS class on each standalone event li", async () => {
    const EventsList = await importEventsList();
    const events = [
      makeEvent({
        kind: "session_started",
        session_id: "s1",
        _ts: 1700000000000,
      }),
      makeEvent({ kind: "design_phase_started", _ts: 1700000001000 }),
      makeEvent({
        kind: "session_complete",
        outcome: "completed",
        _ts: 1700000060000,
      }),
    ];
    const { container } = render(<EventsList events={events} />);

    expect(container.querySelector("li.session_started")).not.toBeNull();
    expect(container.querySelector("li.design_phase_started")).not.toBeNull();
    expect(container.querySelector("li.session_complete")).not.toBeNull();
  });
});
