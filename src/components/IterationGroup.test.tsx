import { vi, describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { IterationGroupComponent } from "./IterationGroup";
import type { IterationGroup } from "../iteration-groups";
import type { SessionEvent } from "../types";
import { eventEmoji, eventLabel } from "../event-format";
import { formatTokenCount, contextBarColor } from "../context-bar";

afterEach(() => {
  cleanup();
});

// ===========================================================================
// Test helpers
// ===========================================================================

/** Convert a hex colour like "#34d399" to the "rgb(52, 211, 153)" form that jsdom serialises. */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    kind: "tool_use",
    session_id: "sess-1",
    iteration: 1,
    _ts: 1700000000000,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<IterationGroup> = {}): IterationGroup {
  return {
    iteration: 1,
    events: [
      makeEvent({ kind: "iteration_started", iteration: 1 }),
      makeEvent({ kind: "tool_use", tool_name: "Read", tool_input: { file_path: "/home/beth/repos/yarr/src/main.ts" }, iteration: 1 }),
      makeEvent({ kind: "iteration_complete", iteration: 1, result: { total_cost_usd: 0.05 } }),
    ],
    cost: 0.05,
    inputTokens: 10000,
    outputTokens: 5000,
    contextWindow: 200000,
    startTs: 1700000000000,
    endTs: 1700000030000,
    ...overrides,
  };
}

function formatTime(ts?: number): string {
  if (ts === undefined) return "";
  return new Date(ts).toLocaleTimeString();
}

const defaultProps = {
  group: makeGroup(),
  expanded: false,
  onToggle: vi.fn(),
  formatTime,
  expandedEvents: new Set<number>(),
  toggleEvent: vi.fn(),
  globalStartIndex: 0,
  repoPath: "/home/beth/repos/yarr",
};

function renderComponent(overrides: Record<string, unknown> = {}) {
  const props = { ...defaultProps, ...overrides };
  return render(
    <IterationGroupComponent
      group={props.group as IterationGroup}
      expanded={props.expanded as boolean}
      onToggle={props.onToggle as () => void}
      formatTime={props.formatTime as (ts?: number) => string}
      expandedEvents={props.expandedEvents as Set<number>}
      toggleEvent={props.toggleEvent as (globalIndex: number) => void}
      globalStartIndex={props.globalStartIndex as number}
      repoPath={props.repoPath as string | undefined}
    />,
  );
}

// ===========================================================================
// IterationGroupComponent
// ===========================================================================

describe("IterationGroupComponent", () => {
  // =========================================================================
  // 1. Header rendering: Shows iteration number, event count, cost
  // =========================================================================

  it("renders the iteration number in the header", () => {
    renderComponent({ group: makeGroup({ iteration: 3 }) });
    expect(screen.getByText(/Iteration 3/)).toBeInTheDocument();
  });

  it("shows the event count in the header", () => {
    const group = makeGroup({
      events: [
        makeEvent({ kind: "iteration_started" }),
        makeEvent({ kind: "tool_use" }),
        makeEvent({ kind: "tool_use" }),
        makeEvent({ kind: "iteration_complete" }),
      ],
    });
    renderComponent({ group });
    expect(screen.getByText(/4 events/)).toBeInTheDocument();
  });

  it("shows the cost in the header", () => {
    renderComponent({ group: makeGroup({ cost: 0.1234 }) });
    expect(screen.getByText(/\$0\.12/)).toBeInTheDocument();
  });

  // =========================================================================
  // 2. Toggle arrow: Shows correct arrow based on expanded state
  // =========================================================================

  it("shows collapsed arrow when not expanded", () => {
    renderComponent({ expanded: false });
    expect(screen.getByText(/\u25B6/)).toBeInTheDocument();
  });

  it("shows expanded arrow when expanded", () => {
    renderComponent({ expanded: true });
    expect(screen.getByText(/\u25BC/)).toBeInTheDocument();
  });

  // =========================================================================
  // 3. Header click: Calls onToggle
  // =========================================================================

  it("calls onToggle when the header is clicked", () => {
    const onToggle = vi.fn();
    renderComponent({ onToggle });
    const header = screen.getByText(/Iteration/).closest("button")!;
    fireEvent.click(header);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("does not call onToggle before clicking", () => {
    const onToggle = vi.fn();
    renderComponent({ onToggle });
    expect(onToggle).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 4. Stats with tokens: Shows input/output tokens when present
  // =========================================================================

  it("shows token counts when inputTokens and outputTokens are present", () => {
    renderComponent({ group: makeGroup({ inputTokens: 50000, outputTokens: 12000 }) });
    // inputTokens uses toLocaleString() in the header stats
    expect(screen.getByText(/50,000/)).toBeInTheDocument();
    // outputTokens also uses toLocaleString() in the header stats
    expect(screen.getByText(/12,000/)).toBeInTheDocument();
  });

  it("does not show tokens text when both are zero", () => {
    renderComponent({ group: makeGroup({ inputTokens: 0, outputTokens: 0 }) });
    // There should be no token display when tokens are 0
    expect(screen.queryByText(/\d+k in/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 5. Stats with duration: Shows duration when startTs and endTs are present
  // =========================================================================

  it("shows duration when startTs and endTs are present", () => {
    // 30 seconds
    renderComponent({
      group: makeGroup({ startTs: 1700000000000, endTs: 1700000030000 }),
    });
    expect(screen.getByText(/30s/)).toBeInTheDocument();
  });

  it("does not show duration when endTs is undefined", () => {
    renderComponent({
      group: makeGroup({ startTs: 1700000000000, endTs: undefined }),
    });
    // No duration should be shown
    expect(screen.queryByText(/\ds$/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 6. Duration formatting: Seconds-only and minutes+seconds
  // =========================================================================

  it("formats duration as seconds when less than 60s", () => {
    renderComponent({
      group: makeGroup({ startTs: 1700000000000, endTs: 1700000045000 }),
    });
    expect(screen.getByText(/45s/)).toBeInTheDocument();
  });

  it("formats duration as minutes and seconds when 60s or more", () => {
    // 2 minutes and 15 seconds = 135 seconds
    renderComponent({
      group: makeGroup({ startTs: 1700000000000, endTs: 1700000135000 }),
    });
    expect(screen.getByText(/2m 15s/)).toBeInTheDocument();
  });

  it("formats duration with 0 remaining seconds correctly", () => {
    // exactly 3 minutes = 180 seconds
    renderComponent({
      group: makeGroup({ startTs: 1700000000000, endTs: 1700000180000 }),
    });
    expect(screen.getByText(/3m 0s/)).toBeInTheDocument();
  });

  // =========================================================================
  // 7. Context bar: Shown when contextWindow > 0, hidden when 0
  // =========================================================================

  it("shows context bar when contextWindow is greater than 0", () => {
    renderComponent({ group: makeGroup({ contextWindow: 200000, inputTokens: 100000 }) });
    expect(screen.getByText(/200k/)).toBeInTheDocument();
  });

  it("does not show context bar when contextWindow is 0", () => {
    renderComponent({ group: makeGroup({ contextWindow: 0, inputTokens: 0 }) });
    // No context window label should appear
    expect(screen.queryByText(/\d+%\)/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 8. Context bar percentage: Correct width and label
  // =========================================================================

  it("shows correct percentage in the context bar label", () => {
    renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 100000 }),
    });
    // 100000/200000 = 50%
    expect(screen.getByText(/50%/)).toBeInTheDocument();
  });

  it("caps the context bar fill width at 100% when percentage exceeds 100", () => {
    // 125% usage (250k / 200k)
    const { container } = renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 250000 }),
    });
    // The fill bar should be capped at 100% width
    const fillBar = container.querySelector(".context-bar-fill") as HTMLElement;
    expect(fillBar).not.toBeNull();
    expect(fillBar.style.width).toBe("100%");
  });

  it("shows formatted token counts in the context bar label", () => {
    renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 100000 }),
    });
    // Should show "100k / 200k (50%)" or similar
    expect(screen.getByText(new RegExp(`${formatTokenCount(100000)}`))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${formatTokenCount(200000)}`))).toBeInTheDocument();
  });

  // =========================================================================
  // 9. Context bar color: Green/yellow/red based on percentage
  // =========================================================================

  it("uses green color when percentage is below 50%", () => {
    // 20% usage
    const { container } = renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 40000 }),
    });
    const fillBar = container.querySelector(".context-bar-fill") as HTMLElement;
    expect(fillBar).not.toBeNull();
    // jsdom normalises hex to rgb, so compare against the parsed value
    expect(fillBar.style.background).toBe(hexToRgb(contextBarColor(20)));
  });

  it("uses yellow color when percentage is between 50% and 80%", () => {
    // 60% usage
    const { container } = renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 120000 }),
    });
    const fillBar = container.querySelector(".context-bar-fill") as HTMLElement;
    expect(fillBar).not.toBeNull();
    expect(fillBar.style.background).toBe(hexToRgb(contextBarColor(60)));
  });

  it("uses red color when percentage is 80% or above", () => {
    // 90% usage
    const { container } = renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 180000 }),
    });
    const fillBar = container.querySelector(".context-bar-fill") as HTMLElement;
    expect(fillBar).not.toBeNull();
    expect(fillBar.style.background).toBe(hexToRgb(contextBarColor(90)));
  });

  // =========================================================================
  // 10. Events list hidden: Not shown when collapsed
  // =========================================================================

  it("does not show events when collapsed", () => {
    const group = makeGroup();
    renderComponent({ expanded: false, group });
    // Event labels should not be visible
    for (const ev of group.events) {
      const label = eventLabel(ev, "/home/beth/repos/yarr");
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  // =========================================================================
  // 11. Events list shown: Shown when expanded with correct number of events
  // =========================================================================

  it("shows events when expanded", () => {
    const group = makeGroup();
    renderComponent({ expanded: true, group });
    // Each event should render a button
    const buttons = screen.getAllByRole("button");
    // At least one button per event (plus the header button)
    expect(buttons.length).toBeGreaterThanOrEqual(group.events.length + 1);
  });

  // =========================================================================
  // 12. Event emoji and label: Each event shows correct emoji and label
  // =========================================================================

  it("shows the correct emoji for each event kind", () => {
    const events = [
      makeEvent({ kind: "iteration_started", iteration: 1 }),
      makeEvent({ kind: "tool_use", tool_name: "Bash", tool_input: { command: "ls" }, iteration: 1 }),
      makeEvent({ kind: "iteration_complete", iteration: 1, result: { total_cost_usd: 0.05 } }),
    ];
    const group = makeGroup({ events });
    renderComponent({ expanded: true, group });

    for (const ev of events) {
      const emoji = eventEmoji(ev.kind);
      expect(screen.getByText(new RegExp(emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    }
  });

  it("shows the correct label for each event", () => {
    const events = [
      makeEvent({ kind: "iteration_started", iteration: 2 }),
      makeEvent({ kind: "tool_use", tool_name: "Read", tool_input: { file_path: "/home/beth/repos/yarr/src/main.ts" }, iteration: 2 }),
    ];
    const group = makeGroup({ events, iteration: 2 });
    renderComponent({ expanded: true, group, repoPath: "/home/beth/repos/yarr" });

    for (const ev of events) {
      const label = eventLabel(ev, "/home/beth/repos/yarr");
      expect(screen.getByText(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    }
  });

  // =========================================================================
  // 13. Event time: Each event shows formatted time
  // =========================================================================

  it("shows formatted time for each event", () => {
    const ts = 1700000000000;
    const events = [
      makeEvent({ kind: "iteration_started", _ts: ts }),
      makeEvent({ kind: "tool_use", tool_name: "Read", _ts: ts + 5000 }),
    ];
    const group = makeGroup({ events });
    const mockFormatTime = vi.fn((t?: number) => (t ? `T:${t}` : ""));
    renderComponent({ expanded: true, group, formatTime: mockFormatTime });

    expect(screen.getByText(`T:${ts}`)).toBeInTheDocument();
    expect(screen.getByText(`T:${ts + 5000}`)).toBeInTheDocument();
  });

  // =========================================================================
  // 14. Event click: Calls toggleEvent with correct global index
  // =========================================================================

  it("calls toggleEvent with the correct global index when an event is clicked", () => {
    const toggleEvent = vi.fn();
    const events = [
      makeEvent({ kind: "iteration_started" }),
      makeEvent({ kind: "tool_use", tool_name: "Bash" }),
      makeEvent({ kind: "iteration_complete" }),
    ];
    const group = makeGroup({ events });
    renderComponent({
      expanded: true,
      group,
      toggleEvent,
      globalStartIndex: 10,
    });

    // Find event buttons (excluding the header button)
    const label0 = eventLabel(events[0]!);
    const button0 = screen.getByText(new RegExp(label0.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).closest("button");
    if (button0) fireEvent.click(button0);
    expect(toggleEvent).toHaveBeenCalledWith(10);

    const label1 = eventLabel(events[1]!);
    const button1 = screen.getByText(new RegExp(label1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).closest("button");
    if (button1) fireEvent.click(button1);
    expect(toggleEvent).toHaveBeenCalledWith(11);
  });

  // =========================================================================
  // 15. Tool use detail: Shows JSON when event is expanded and kind is tool_use
  // =========================================================================

  it("shows tool_input JSON when a tool_use event is expanded", () => {
    const toolInput = { file_path: "/home/beth/repos/yarr/src/main.ts", content: "hello" };
    const events = [
      makeEvent({ kind: "tool_use", tool_name: "Write", tool_input: toolInput, iteration: 1 }),
    ];
    const group = makeGroup({ events });
    const expandedEvents = new Set([5]);

    renderComponent({
      expanded: true,
      group,
      expandedEvents,
      globalStartIndex: 5,
    });

    const expectedJson = JSON.stringify(toolInput, null, 2);
    // The pre element should contain the JSON
    const preElements = document.querySelectorAll("pre");
    const found = Array.from(preElements).some((pre) =>
      pre.textContent?.includes(expectedJson),
    );
    expect(found).toBe(true);
  });

  // =========================================================================
  // 16. Check failed detail: Shows output when event is expanded
  // =========================================================================

  it("shows check output when a check_failed event is expanded", () => {
    const events = [
      makeEvent({
        kind: "check_failed",
        check_name: "lint",
        output: "Error: missing semicolon on line 42",
      }),
    ];
    const group = makeGroup({ events });
    const expandedEvents = new Set([0]);

    renderComponent({
      expanded: true,
      group,
      expandedEvents,
      globalStartIndex: 0,
    });

    const preElements = document.querySelectorAll("pre");
    const found = Array.from(preElements).some((pre) =>
      pre.textContent?.includes("Error: missing semicolon on line 42"),
    );
    expect(found).toBe(true);
  });

  // =========================================================================
  // 17. Git sync failed detail: Shows error when event is expanded
  // =========================================================================

  it("shows error when a git_sync_failed event is expanded", () => {
    const events = [
      makeEvent({
        kind: "git_sync_failed",
        error: "fatal: remote origin not found",
        iteration: 1,
      }),
    ];
    const group = makeGroup({ events });
    const expandedEvents = new Set([3]);

    renderComponent({
      expanded: true,
      group,
      expandedEvents,
      globalStartIndex: 3,
    });

    const preElements = document.querySelectorAll("pre");
    const found = Array.from(preElements).some((pre) =>
      pre.textContent?.includes("fatal: remote origin not found"),
    );
    expect(found).toBe(true);
  });

  // =========================================================================
  // 18. Detail hidden when collapsed: Not shown when event not in expandedEvents
  // =========================================================================

  it("does not show tool_input JSON when the tool_use event is not expanded", () => {
    const toolInput = { file_path: "/src/main.ts" };
    const events = [
      makeEvent({ kind: "tool_use", tool_name: "Read", tool_input: toolInput }),
    ];
    const group = makeGroup({ events });
    const expandedEvents = new Set<number>(); // none expanded

    renderComponent({
      expanded: true,
      group,
      expandedEvents,
      globalStartIndex: 0,
    });

    const expectedJson = JSON.stringify(toolInput, null, 2);
    const preElements = document.querySelectorAll("pre");
    const found = Array.from(preElements).some((pre) =>
      pre.textContent?.includes(expectedJson),
    );
    expect(found).toBe(false);
  });

  it("does not show check_failed output when the event is not expanded", () => {
    const events = [
      makeEvent({
        kind: "check_failed",
        check_name: "lint",
        output: "Error: missing semicolon",
      }),
    ];
    const group = makeGroup({ events });
    const expandedEvents = new Set<number>();

    renderComponent({
      expanded: true,
      group,
      expandedEvents,
      globalStartIndex: 0,
    });

    const preElements = document.querySelectorAll("pre");
    const found = Array.from(preElements).some((pre) =>
      pre.textContent?.includes("Error: missing semicolon"),
    );
    expect(found).toBe(false);
  });

  it("does not show git_sync_failed error when the event is not expanded", () => {
    const events = [
      makeEvent({
        kind: "git_sync_failed",
        error: "fatal: remote origin not found",
      }),
    ];
    const group = makeGroup({ events });
    const expandedEvents = new Set<number>();

    renderComponent({
      expanded: true,
      group,
      expandedEvents,
      globalStartIndex: 0,
    });

    const preElements = document.querySelectorAll("pre");
    const found = Array.from(preElements).some((pre) =>
      pre.textContent?.includes("fatal: remote origin not found"),
    );
    expect(found).toBe(false);
  });

  // =========================================================================
  // 19. repoPath passed to eventLabel: Verify relative paths
  // =========================================================================

  it("passes repoPath to eventLabel so file paths are relative", () => {
    const events = [
      makeEvent({
        kind: "tool_use",
        tool_name: "Read",
        tool_input: { file_path: "/home/beth/repos/yarr/src/main.ts" },
        iteration: 1,
      }),
    ];
    const group = makeGroup({ events });
    renderComponent({
      expanded: true,
      group,
      repoPath: "/home/beth/repos/yarr",
    });

    // With repoPath set, eventLabel should show relative path "src/main.ts"
    // rather than the full absolute path
    const expectedLabel = eventLabel(events[0]!, "/home/beth/repos/yarr");
    expect(screen.getByText(new RegExp(expectedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    expect(expectedLabel).toContain("src/main.ts");
  });

  it("shows full path when repoPath is not provided", () => {
    const events = [
      makeEvent({
        kind: "tool_use",
        tool_name: "Read",
        tool_input: { file_path: "/home/beth/repos/yarr/src/main.ts" },
        iteration: 1,
      }),
    ];
    const group = makeGroup({ events });
    renderComponent({
      expanded: true,
      group,
      repoPath: undefined,
    });

    const expectedLabel = eventLabel(events[0]!, undefined);
    expect(screen.getByText(new RegExp(expectedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    expect(expectedLabel).toContain("/home/beth/repos/yarr/src/main.ts");
  });
});
