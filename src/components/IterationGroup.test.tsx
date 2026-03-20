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

/** No-op identity — contextBarColor now returns CSS var() references which jsdom stores as-is. */

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
      makeEvent({
        kind: "tool_use",
        tool_name: "Read",
        tool_input: { file_path: "/home/beth/repos/yarr/src/main.ts" },
        iteration: 1,
      }),
      makeEvent({
        kind: "iteration_complete",
        iteration: 1,
        result: { total_cost_usd: 0.05 },
      }),
    ],
    cost: 0.05,
    inputTokens: 10000,
    outputTokens: 5000,
    contextWindow: 200000,
    contextTokens: 0,
    compacted: false,
    compactedPreTokens: 0,
    subAgentPeakContext: 0,
    subAgentCount: 0,
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
    expect(screen.queryByText(/\$0\.1234/)).not.toBeInTheDocument();
  });

  it("formats cost to two decimal places, not four", () => {
    renderComponent({ group: makeGroup({ cost: 0.1 }) });
    // Should render $0.10, not $0.1000
    expect(screen.getByText(/\$0\.10/)).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.1000/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 2. Toggle arrow: Shows correct arrow based on expanded state
  // =========================================================================

  it("shows collapsed arrow when not expanded", () => {
    const { container } = renderComponent({ expanded: false });
    const chevron = container.querySelector(".iteration-toggle");
    expect(chevron).toBeInTheDocument();
    expect(chevron).not.toHaveClass("rotate-90");
  });

  it("shows expanded arrow when expanded", () => {
    const { container } = renderComponent({ expanded: true });
    const chevron = container.querySelector(".iteration-toggle");
    expect(chevron).toBeInTheDocument();
    expect(chevron).toHaveClass("rotate-90");
  });

  // =========================================================================
  // 3. Header click: Calls onToggle
  // =========================================================================

  it("calls onToggle when the header is clicked", () => {
    const onToggle = vi.fn();
    renderComponent({ onToggle });
    const header = screen.getByText(/Iteration/).closest("[role='button']")!;
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
    renderComponent({
      group: makeGroup({ inputTokens: 50000, outputTokens: 12000 }),
    });
    // inputTokens and outputTokens use formatTokenCount() in the header stats
    expect(screen.getByText(/50k in/)).toBeInTheDocument();
    expect(screen.getByText(/12k out/)).toBeInTheDocument();
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
    renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 100000 }),
    });
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

  it("shows context tokens in the iteration header when contextTokens > 0", () => {
    renderComponent({
      group: makeGroup({ contextTokens: 100000 }),
    });
    // 100000 -> "100k ctx"
    expect(screen.getByText(/100k ctx/)).toBeInTheDocument();
  });

  it("shows context tokens with correct formatTokenCount format", () => {
    renderComponent({
      group: makeGroup({ contextTokens: 142000 }),
    });
    // 142000 -> "142k ctx"
    expect(screen.getByText(/142k ctx/)).toBeInTheDocument();
  });

  it("does not show context tokens in header when contextTokens is 0", () => {
    renderComponent({
      group: makeGroup({ contextTokens: 0 }),
    });
    expect(screen.queryByText(/ctx/)).not.toBeInTheDocument();
  });

  it("does not show percentage in the context bar label", () => {
    const { container } = renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 100000 }),
    });
    const barLabel = container.querySelector(".context-bar-label");
    expect(barLabel).not.toBeNull();
    // The bar label should NOT contain a percentage — it's now in the header
    expect(barLabel!.textContent).not.toMatch(/\d+%/);
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
    const { container } = renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 100000 }),
    });
    const barLabel = container.querySelector(".context-bar-label");
    expect(barLabel).not.toBeNull();
    expect(barLabel!.textContent).toContain(formatTokenCount(100000));
    expect(barLabel!.textContent).toContain(formatTokenCount(200000));
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
    expect(fillBar.style.background).toBe(contextBarColor(20));
  });

  it("uses warning color when percentage is between 50% and 80%", () => {
    // 60% usage
    const { container } = renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 120000 }),
    });
    const fillBar = container.querySelector(".context-bar-fill") as HTMLElement;
    expect(fillBar).not.toBeNull();
    expect(fillBar.style.background).toBe(contextBarColor(60));
  });

  it("uses destructive color when percentage is 80% or above", () => {
    // 90% usage
    const { container } = renderComponent({
      group: makeGroup({ contextWindow: 200000, inputTokens: 180000 }),
    });
    const fillBar = container.querySelector(".context-bar-fill") as HTMLElement;
    expect(fillBar).not.toBeNull();
    expect(fillBar.style.background).toBe(contextBarColor(90));
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
      makeEvent({
        kind: "tool_use",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        iteration: 1,
      }),
      makeEvent({
        kind: "iteration_complete",
        iteration: 1,
        result: { total_cost_usd: 0.05 },
      }),
    ];
    const group = makeGroup({ events });
    renderComponent({ expanded: true, group });

    for (const ev of events) {
      const emoji = eventEmoji(ev.kind);
      expect(
        screen.getByText(
          new RegExp(emoji.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        ),
      ).toBeInTheDocument();
    }
  });

  it("shows the correct label for each event", () => {
    const events = [
      makeEvent({ kind: "iteration_started", iteration: 2 }),
      makeEvent({
        kind: "tool_use",
        tool_name: "Read",
        tool_input: { file_path: "/home/beth/repos/yarr/src/main.ts" },
        iteration: 2,
      }),
    ];
    const group = makeGroup({ events, iteration: 2 });
    renderComponent({
      expanded: true,
      group,
      repoPath: "/home/beth/repos/yarr",
    });

    for (const ev of events) {
      const label = eventLabel(ev, "/home/beth/repos/yarr");
      expect(
        screen.getByText(
          new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        ),
      ).toBeInTheDocument();
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
    const button0 = screen
      .getByText(new RegExp(label0.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .closest("[role='button']");
    if (button0) fireEvent.click(button0);
    expect(toggleEvent).toHaveBeenCalledWith(10);

    const label1 = eventLabel(events[1]!);
    const button1 = screen
      .getByText(new RegExp(label1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .closest("[role='button']");
    if (button1) fireEvent.click(button1);
    expect(toggleEvent).toHaveBeenCalledWith(11);
  });

  // =========================================================================
  // 15. Tool use detail: Shows JSON when event is expanded and kind is tool_use
  // =========================================================================

  it("shows tool_input JSON when a tool_use event is expanded", () => {
    const toolInput = {
      file_path: "/home/beth/repos/yarr/src/main.ts",
      content: "hello",
    };
    const events = [
      makeEvent({
        kind: "tool_use",
        tool_name: "Write",
        tool_input: toolInput,
        iteration: 1,
      }),
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
    expect(
      screen.getByText(
        new RegExp(expectedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      ),
    ).toBeInTheDocument();
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
    expect(
      screen.getByText(
        new RegExp(expectedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      ),
    ).toBeInTheDocument();
    expect(expectedLabel).toContain("/home/beth/repos/yarr/src/main.ts");
  });

  // =========================================================================
  // 20. Agent tool_use detail: Structured view instead of raw JSON
  // =========================================================================

  it("renders Agent metadata fields when an Agent tool_use event is expanded", () => {
    const toolInput = {
      description: "Research the codebase structure",
      model: "claude-sonnet-4-20250514",
      subagent_type: "research",
      prompt: "Look at the src/ directory and summarize the architecture.",
    };
    const events = [
      makeEvent({
        kind: "tool_use",
        tool_name: "Agent",
        tool_input: toolInput,
        iteration: 1,
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

    // Metadata fields (model, subagent_type) should be rendered as
    // structured key-value pairs outside of <pre> elements.
    // These values do NOT appear in the event label, so they should
    // only be present in the detail area.
    // Collect text from all leaf-level elements that are not inside <pre>
    function getTextOutsidePre(): string {
      const body = document.body;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          let parent = node.parentElement;
          while (parent) {
            if (parent.tagName === "PRE") return NodeFilter.FILTER_REJECT;
            parent = parent.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const texts: string[] = [];
      while (walker.nextNode()) {
        texts.push(walker.currentNode.textContent ?? "");
      }
      return texts.join(" ");
    }

    const textOutsidePre = getTextOutsidePre();

    // model and subagent_type should appear outside of <pre> blocks
    expect(textOutsidePre).toContain("claude-sonnet-4-20250514");
    expect(textOutsidePre).toContain("research");
  });

  it("renders Agent prompt content when an Agent tool_use event is expanded", () => {
    const toolInput = {
      description: "Analyze code",
      model: "claude-sonnet-4-20250514",
      subagent_type: "research",
      prompt: "Look at the src/ directory and summarize the architecture.",
    };
    const events = [
      makeEvent({
        kind: "tool_use",
        tool_name: "Agent",
        tool_input: toolInput,
        iteration: 1,
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

    // The prompt text should appear outside of the raw JSON <pre> block,
    // rendered as content (e.g. via react-markdown or similar).
    function getTextOutsidePre(): string {
      const body = document.body;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          let parent = node.parentElement;
          while (parent) {
            if (parent.tagName === "PRE") return NodeFilter.FILTER_REJECT;
            parent = parent.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const texts: string[] = [];
      while (walker.nextNode()) {
        texts.push(walker.currentNode.textContent ?? "");
      }
      return texts.join(" ");
    }

    const textOutsidePre = getTextOutsidePre();
    expect(textOutsidePre).toContain(
      "Look at the src/ directory and summarize the architecture.",
    );
  });

  it("does not show raw JSON pre block for expanded Agent tool_use events", () => {
    const toolInput = {
      description: "Research the codebase structure",
      model: "claude-sonnet-4-20250514",
      subagent_type: "research",
      prompt: "Look at the src/ directory and summarize the architecture.",
    };
    const events = [
      makeEvent({
        kind: "tool_use",
        tool_name: "Agent",
        tool_input: toolInput,
        iteration: 1,
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

    // The full JSON.stringify output should NOT appear in any <pre> block
    const expectedJson = JSON.stringify(toolInput, null, 2);
    const preElements = document.querySelectorAll("pre");
    const found = Array.from(preElements).some((pre) =>
      pre.textContent?.includes(expectedJson),
    );
    expect(found).toBe(false);
  });

  it("still shows raw JSON for non-Agent tool_use events when expanded", () => {
    const toolInput = {
      command: "ls -la",
      description: "List files",
    };
    const events = [
      makeEvent({
        kind: "tool_use",
        tool_name: "Bash",
        tool_input: toolInput,
        iteration: 1,
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

    // Non-Agent tools should still render as raw JSON in a <pre> block
    const expectedJson = JSON.stringify(toolInput, null, 2);
    const preElements = document.querySelectorAll("pre");
    const found = Array.from(preElements).some((pre) =>
      pre.textContent?.includes(expectedJson),
    );
    expect(found).toBe(true);
  });

  it("renders Agent tool_use with no prompt field without crashing", () => {
    const toolInput = {
      description: "Quick check",
      model: "opus",
    };
    const events = [
      makeEvent({
        kind: "tool_use",
        tool_name: "Agent",
        tool_input: toolInput,
        iteration: 1,
      }),
    ];
    const group = makeGroup({ events });
    const expandedEvents = new Set([0]);

    const { container } = renderComponent({
      expanded: true,
      group,
      expandedEvents,
      globalStartIndex: 0,
    });

    // The agent-detail div should exist
    const agentDetail = container.querySelector(".agent-detail");
    expect(agentDetail).not.toBeNull();

    // Metadata fields should appear in the DOM
    expect(agentDetail!.textContent).toContain("opus");
    expect(agentDetail!.textContent).toContain("Quick check");
  });

  it("renders Agent tool_use with empty tool_input without crashing", () => {
    const toolInput = {};
    const events = [
      makeEvent({
        kind: "tool_use",
        tool_name: "Agent",
        tool_input: toolInput,
        iteration: 1,
      }),
    ];
    const group = makeGroup({ events });
    const expandedEvents = new Set([0]);

    const { container } = renderComponent({
      expanded: true,
      group,
      expandedEvents,
      globalStartIndex: 0,
    });

    // The agent-detail div should exist even with empty tool_input
    const agentDetail = container.querySelector(".agent-detail");
    expect(agentDetail).not.toBeNull();

    // There should be no key-value pairs rendered inside
    const keyValuePairs = agentDetail!.querySelectorAll(".flex.gap-2.py-0\\.5");
    expect(keyValuePairs.length).toBe(0);
  });

  // =========================================================================
  // 21. Tool output rendering
  // =========================================================================

  describe("tool_output rendering", () => {
    it("renders Bash tool_output in a <pre> element with an Output label when expanded", () => {
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          tool_output: "hello\nworld",
          iteration: 1,
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

      // Should have an "Output" label
      expect(screen.getByText("Output")).toBeInTheDocument();

      // The output text should appear inside a <pre> element
      const preElements = document.querySelectorAll("pre");
      const found = Array.from(preElements).some((pre) =>
        pre.textContent?.includes("hello\nworld"),
      );
      expect(found).toBe(true);
    });

    it("renders Agent tool_output as markdown (not in a <pre> element) when expanded", () => {
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Agent",
          tool_input: { prompt: "Do something" },
          tool_output: "Agent completed the task successfully",
          iteration: 1,
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

      // Should have an "Output" label
      expect(screen.getByText("Output")).toBeInTheDocument();

      // The output text should appear in the document
      expect(
        screen.getByText("Agent completed the task successfully"),
      ).toBeInTheDocument();

      // The output text should NOT be inside a <pre> element
      const preElements = document.querySelectorAll("pre");
      const foundInPre = Array.from(preElements).some((pre) =>
        pre.textContent?.includes("Agent completed the task successfully"),
      );
      expect(foundInPre).toBe(false);
    });

    it("does not show Output section when tool_output is undefined", () => {
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          // no tool_output
          iteration: 1,
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

      expect(screen.queryByText("Output")).not.toBeInTheDocument();
    });

    it("does not show Output section when tool_output is empty string", () => {
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "true" },
          tool_output: "",
          iteration: 1,
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

      expect(screen.queryByText("Output")).not.toBeInTheDocument();
    });

    it("does not show tool_output when event is not expanded", () => {
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          tool_output: "hello",
          iteration: 1,
        }),
      ];
      const group = makeGroup({ events });
      const expandedEvents = new Set<number>(); // none expanded

      renderComponent({
        expanded: true,
        group,
        expandedEvents,
        globalStartIndex: 0,
      });

      expect(screen.queryByText("Output")).not.toBeInTheDocument();
      expect(screen.queryByText("hello")).not.toBeInTheDocument();
    });

    it("truncates output longer than 20 lines and shows a Show more button", () => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "seq 30" },
          tool_output: lines.join("\n"),
          iteration: 1,
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

      // First 20 lines should be visible
      expect(screen.getByText(/line 1$/)).toBeInTheDocument();
      expect(screen.getByText(/line 20$/)).toBeInTheDocument();

      // Line 21 should NOT be visible yet
      expect(screen.queryByText(/line 21$/)).not.toBeInTheDocument();

      // Should show "Show more (10 more lines)" button
      expect(
        screen.getByText(/Show more \(10 more lines\)/),
      ).toBeInTheDocument();
    });

    it("reveals full output when Show more button is clicked", () => {
      const lines = Array.from({ length: 25 }, (_, i) => `output ${i + 1}`);
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "seq 25" },
          tool_output: lines.join("\n"),
          iteration: 1,
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

      // Line 25 should not be visible initially
      expect(screen.queryByText(/output 25$/)).not.toBeInTheDocument();

      // Click "Show more"
      const showMoreButton = screen.getByText(/Show more \(5 more lines\)/);
      fireEvent.click(showMoreButton);

      // Now all lines should be visible
      expect(screen.getByText(/output 25$/)).toBeInTheDocument();

      // Show more button should be gone
      expect(screen.queryByText(/Show more/)).not.toBeInTheDocument();
    });

    it("does not show Show more button when output is 20 lines or fewer", () => {
      const lines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`);
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "seq 15" },
          tool_output: lines.join("\n"),
          iteration: 1,
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

      // All 15 lines should be visible
      expect(screen.getByText(/line 1$/)).toBeInTheDocument();
      expect(screen.getByText(/line 15$/)).toBeInTheDocument();

      // No "Show more" button
      expect(screen.queryByText(/Show more/)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // ANSI color rendering in tool output
  // =========================================================================

  describe("ANSI color rendering in tool output", () => {
    it("renders ANSI color codes as spans with correct classes", () => {
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "echo red" },
          tool_output: "\x1b[31mred text\x1b[0m",
          iteration: 1,
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

      const span = document.querySelector("span.ansi-fg-red");
      expect(span).not.toBeNull();
      expect(span?.textContent).toBe("red text");
    });

    it("renders bold ANSI output with ansi-bold class", () => {
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "echo bold" },
          tool_output: "\x1b[1mbold text\x1b[0m",
          iteration: 1,
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

      const span = document.querySelector("span.ansi-bold");
      expect(span).not.toBeNull();
      expect(span?.textContent).toBe("bold text");
    });

    it("renders plain text tool output without ansi-* spans", () => {
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "echo hello" },
          tool_output: "hello world",
          iteration: 1,
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

      const ansiElements = document.querySelectorAll("[class*='ansi-']");
      expect(ansiElements.length).toBe(0);
    });

    it("strips ANSI escape codes from visible text content", () => {
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "echo colored" },
          tool_output: "\x1b[32mgreen\x1b[0m and \x1b[34mblue\x1b[0m",
          iteration: 1,
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
      for (const pre of preElements) {
        const text = pre.textContent ?? "";
        expect(text).not.toContain("\x1b");
      }
    });

    it("truncates ANSI-colored output at 20 lines and shows Show more", () => {
      const lines = Array.from(
        { length: 30 },
        (_, i) => `\x1b[31mcolored line ${i + 1}\x1b[0m`,
      );
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Bash",
          tool_input: { command: "seq 30" },
          tool_output: lines.join("\n"),
          iteration: 1,
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

      // Line 20 should be visible (last truncated line)
      expect(screen.getByText(/colored line 20/)).toBeInTheDocument();
      // Line 21 should NOT be visible
      expect(screen.queryByText(/colored line 21/)).not.toBeInTheDocument();
      // Show more button should be present
      expect(screen.getByText(/Show more/)).toBeInTheDocument();
    });

    it("does not apply ANSI parsing to Agent tool output", () => {
      const events = [
        makeEvent({
          kind: "tool_use",
          tool_name: "Agent",
          tool_input: { prompt: "do something" },
          tool_output: "\x1b[31mred text\x1b[0m and normal",
          iteration: 1,
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

      // The text content should appear (Agent renders via Markdown)
      expect(screen.getByText(/red text/)).toBeInTheDocument();
      expect(screen.getByText(/normal/)).toBeInTheDocument();

      // No ansi-* styled spans should exist since Agent uses Markdown rendering
      const ansiSpans = document.querySelectorAll('[class*="ansi-"]');
      expect(ansiSpans.length).toBe(0);
    });
  });

  // =========================================================================
  // 22. Token display format, context tokens, and compaction icon
  // =========================================================================

  describe("token display format, context tokens, and compaction", () => {
    it("shows token counts using formatTokenCount format, not toLocaleString", () => {
      renderComponent({
        group: makeGroup({ inputTokens: 50000, outputTokens: 12000 }),
      });
      // Should show "50k in" and "12k out", not "50,000 in" and "12,000 out"
      expect(screen.getByText(/50k in/)).toBeInTheDocument();
      expect(screen.getByText(/12k out/)).toBeInTheDocument();
    });

    it("shows formatTokenCount format for large token counts", () => {
      renderComponent({
        group: makeGroup({ inputTokens: 1500000, outputTokens: 2000000 }),
      });
      // 1500000 -> "1.5M", 2000000 -> "2M"
      expect(screen.getByText(/1\.5M in/)).toBeInTheDocument();
      expect(screen.getByText(/2M out/)).toBeInTheDocument();
    });

    it("shows exact comma-separated counts in hover title attribute", () => {
      const { container } = renderComponent({
        group: makeGroup({ inputTokens: 50000, outputTokens: 12000 }),
      });
      // The token counts are in a sibling div below .iteration-stats
      const header = container.querySelector(".iteration-header");
      expect(header).not.toBeNull();
      const titleSpan = header!.querySelector("span[title]");
      expect(titleSpan).not.toBeNull();
      expect(titleSpan!.getAttribute("title")).toContain(
        (50000).toLocaleString(),
      );
      expect(titleSpan!.getAttribute("title")).toContain(
        (12000).toLocaleString(),
      );
    });

    it("shows context tokens display when contextTokens > 0", () => {
      renderComponent({
        group: makeGroup({ contextTokens: 142000 }),
      });
      expect(screen.getByText(/142k ctx/)).toBeInTheDocument();
    });

    it("applies correct color from contextTokensColor for low token count", () => {
      const { container } = renderComponent({
        group: makeGroup({ contextTokens: 50000 }),
      });
      const header = container.querySelector(".iteration-header");
      expect(header).not.toBeNull();
      // Find the element with "ctx" text that has a style.color
      const allSpans = header!.querySelectorAll("span");
      const ctxSpan = Array.from(allSpans).find(
        (el) =>
          el.textContent?.includes("ctx") &&
          (el as HTMLElement).style.color !== "",
      ) as HTMLElement | undefined;
      expect(ctxSpan).toBeDefined();
      // jsdom converts hex to rgb, so check for rgb equivalent of #34d399
      expect(ctxSpan!.style.color).toBe("rgb(52, 211, 153)");
    });

    it("applies yellow color from contextTokensColor for medium token count", () => {
      const { container } = renderComponent({
        group: makeGroup({ contextTokens: 100000 }),
      });
      const header = container.querySelector(".iteration-header");
      expect(header).not.toBeNull();
      const allSpans = header!.querySelectorAll("span");
      const ctxSpan = Array.from(allSpans).find(
        (el) =>
          el.textContent?.includes("ctx") &&
          (el as HTMLElement).style.color !== "",
      ) as HTMLElement | undefined;
      expect(ctxSpan).toBeDefined();
      // jsdom converts hex to rgb, so check for rgb equivalent of #fbbf24
      expect(ctxSpan!.style.color).toBe("rgb(251, 191, 36)");
    });

    it("applies red color from contextTokensColor for high token count", () => {
      const { container } = renderComponent({
        group: makeGroup({ contextTokens: 150000 }),
      });
      const header = container.querySelector(".iteration-header");
      expect(header).not.toBeNull();
      const allSpans = header!.querySelectorAll("span");
      const ctxSpan = Array.from(allSpans).find(
        (el) =>
          el.textContent?.includes("ctx") &&
          (el as HTMLElement).style.color !== "",
      ) as HTMLElement | undefined;
      expect(ctxSpan).toBeDefined();
      // jsdom converts hex to rgb, so check for rgb equivalent of #f87171
      expect(ctxSpan!.style.color).toBe("rgb(248, 113, 113)");
    });

    it("does not show context tokens when contextTokens is 0", () => {
      renderComponent({
        group: makeGroup({ contextTokens: 0 }),
      });
      expect(screen.queryByText(/ctx/)).not.toBeInTheDocument();
    });

    it("shows compaction icon when group.compacted is true", () => {
      renderComponent({
        group: makeGroup({ contextTokens: 100000, compacted: true }),
      });
      expect(screen.getByText(/⟳/)).toBeInTheDocument();
    });

    it("does not show compaction icon when group.compacted is false", () => {
      renderComponent({
        group: makeGroup({ contextTokens: 100000, compacted: false }),
      });
      expect(screen.queryByText(/⟳/)).not.toBeInTheDocument();
    });

    it("shows both context tokens and compaction icon together", () => {
      renderComponent({
        group: makeGroup({ contextTokens: 142000, compacted: true }),
      });
      // Should show context tokens display
      expect(screen.getByText(/142k ctx/)).toBeInTheDocument();
      // Should also show compaction icon
      expect(screen.getByText(/⟳/)).toBeInTheDocument();
    });

    it("does not show compaction icon when compacted is true but contextTokens is 0", () => {
      // Compaction icon only shows alongside context tokens display
      renderComponent({
        group: makeGroup({ contextTokens: 0, compacted: true }),
      });
      // No ctx display means no compaction icon either (since it follows ctx)
      expect(screen.queryByText(/⟳/)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // 23. Sub-agent peak context in header
  // =========================================================================

  describe("sub-agent peak context in header", () => {
    it("shows sub-agent peak when subAgentPeakContext > 0", () => {
      renderComponent({
        group: makeGroup({
          subAgentPeakContext: 45000,
          contextWindow: 200000,
        }),
      });
      expect(screen.getByText(/agents:/)).toBeInTheDocument();
      expect(screen.getByText(/45k/)).toBeInTheDocument();
      expect(screen.getAllByText(/200k/).length).toBeGreaterThanOrEqual(1);
    });

    it("does not show sub-agent peak when subAgentPeakContext is 0", () => {
      renderComponent({
        group: makeGroup({ subAgentPeakContext: 0 }),
      });
      expect(screen.queryByText(/agents:/)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // 24. Filter sub_agent_context_updated from event list
  // =========================================================================

  describe("filter sub_agent_context_updated from event list", () => {
    it("filters sub_agent_context_updated events from the rendered event list", () => {
      const group = makeGroup({
        events: [
          makeEvent({ kind: "iteration_started", iteration: 1 }),
          makeEvent({
            kind: "tool_use",
            tool_name: "Read",
            tool_input: { file_path: "/home/beth/repos/yarr/src/main.ts" },
            iteration: 1,
          }),
          makeEvent({
            kind: "sub_agent_context_updated",
            parent_tool_use_id: "toolu_abc",
            context_tokens: 45000,
            iteration: 1,
          }),
          makeEvent({
            kind: "iteration_complete",
            iteration: 1,
            result: { total_cost_usd: 0.05 },
          }),
        ],
      });

      renderComponent({ group, expanded: true });

      // The sub_agent_context_updated label should NOT appear
      const subAgentLabel = eventLabel(
        makeEvent({
          kind: "sub_agent_context_updated",
          parent_tool_use_id: "toolu_abc",
          context_tokens: 45000,
          iteration: 1,
        }),
      );
      expect(screen.queryByText(subAgentLabel)).not.toBeInTheDocument();

      // Other events should still appear
      const iterStartLabel = eventLabel(
        makeEvent({ kind: "iteration_started", iteration: 1 }),
      );
      expect(screen.getByText(iterStartLabel)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 25. Per-agent context in Agent tool_use detail
  // =========================================================================

  describe("per-agent context in Agent tool_use detail", () => {
    it("shows per-agent context when expanding an Agent tool_use with matching sub-agent events", () => {
      const events = [
        makeEvent({ kind: "iteration_started", iteration: 1 }),
        makeEvent({
          kind: "tool_use",
          tool_use_id: "toolu_abc",
          tool_name: "Agent",
          tool_input: { description: "research task", prompt: "do research" },
          iteration: 1,
        }),
        makeEvent({
          kind: "sub_agent_context_updated",
          parent_tool_use_id: "toolu_abc",
          context_tokens: 45000,
          iteration: 1,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          result: { total_cost_usd: 0.05 },
        }),
      ];

      // The Agent tool_use is at index 1 in the events array, so globalIndex = 0 + 1 = 1
      const expandedEvents = new Set<number>([1]);

      renderComponent({
        group: makeGroup({ events }),
        expanded: true,
        expandedEvents,
        globalStartIndex: 0,
      });

      // Should show per-agent context info inside the agent-detail panel
      const agentDetail = document.querySelector(".agent-detail");
      expect(agentDetail).toBeInTheDocument();
      expect(agentDetail!.textContent).toMatch(/context:/i);
      expect(agentDetail!.textContent).toMatch(/45k/);
      expect(agentDetail!.textContent).toMatch(/200k/);
    });

    it("does not show per-agent context for Agent tool_use with no matching sub-agent events", () => {
      const events = [
        makeEvent({ kind: "iteration_started", iteration: 1 }),
        makeEvent({
          kind: "tool_use",
          tool_use_id: "toolu_xyz",
          tool_name: "Agent",
          tool_input: { description: "research task", prompt: "do research" },
          iteration: 1,
        }),
        makeEvent({
          kind: "iteration_complete",
          iteration: 1,
          result: { total_cost_usd: 0.05 },
        }),
      ];

      // The Agent tool_use is at index 1
      const expandedEvents = new Set<number>([1]);

      renderComponent({
        group: makeGroup({ events }),
        expanded: true,
        expandedEvents,
        globalStartIndex: 0,
      });

      // The agent-detail panel should exist (Agent is expanded) but no "context:" line
      const agentDetail = document.querySelector(".agent-detail");
      expect(agentDetail).toBeInTheDocument();
      expect(agentDetail!.textContent).not.toMatch(/context:.*\d+k/i);
    });
  });
});
