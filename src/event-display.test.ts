import { describe, it, expect } from "vitest";
import { eventEmoji, eventLabel, toolSummary } from "./event-display";
import type { SessionEvent } from "./types";

function makeEvent(overrides: Partial<SessionEvent>): SessionEvent {
  return { kind: "unknown", ...overrides };
}

describe("eventEmoji", () => {
  describe("existing event kinds", () => {
    it("returns rocket for session_started", () => {
      expect(eventEmoji("session_started")).toBe("\u{1F680}");
    });

    it("returns arrows for iteration_started", () => {
      expect(eventEmoji("iteration_started")).toBe("\u{1F504}");
    });

    it("returns wrench for tool_use", () => {
      expect(eventEmoji("tool_use")).toBe("\u{1F527}");
    });

    it("returns speech bubble for assistant_text", () => {
      expect(eventEmoji("assistant_text")).toBe("\u{1F4AC}");
    });

    it("returns check mark for iteration_complete", () => {
      expect(eventEmoji("iteration_complete")).toBe("\u2705");
    });

    it("returns flag for session_complete", () => {
      expect(eventEmoji("session_complete")).toBe("\u{1F3C1}");
    });

    it("returns clipboard for unknown event kinds", () => {
      expect(eventEmoji("something_else")).toBe("\u{1F4CB}");
    });
  });

  describe("check event kinds", () => {
    it("returns magnifying glass for check_started", () => {
      expect(eventEmoji("check_started")).toBe("\u{1F50D}");
    });

    it("returns green check for check_passed", () => {
      expect(eventEmoji("check_passed")).toBe("\u2705");
    });

    it("returns red X for check_failed", () => {
      expect(eventEmoji("check_failed")).toBe("\u274C");
    });

    it("returns hammer and wrench for check_fix_started", () => {
      expect(eventEmoji("check_fix_started")).toBe("\u{1F6E0}\uFE0F");
    });

    it("returns arrows/cycle for check_fix_complete", () => {
      expect(eventEmoji("check_fix_complete")).toBe("\u{1F504}");
    });
  });
});

describe("eventLabel", () => {
  describe("existing event kinds", () => {
    it("formats session_started with session_id", () => {
      const ev = makeEvent({ kind: "session_started", session_id: "sess-1" });
      expect(eventLabel(ev)).toBe("Session started: sess-1");
    });

    it("formats iteration_started with iteration number", () => {
      const ev = makeEvent({ kind: "iteration_started", iteration: 3 });
      expect(eventLabel(ev)).toBe("Iteration 3 started");
    });

    it("formats iteration_complete with cost from result", () => {
      const ev = makeEvent({
        kind: "iteration_complete",
        iteration: 2,
        result: { total_cost_usd: 0.1234 },
      });
      expect(eventLabel(ev)).toBe("Iteration 2 complete (cost: $0.1234)");
    });

    it("formats session_complete with outcome", () => {
      const ev = makeEvent({
        kind: "session_complete",
        outcome: "completed",
      });
      expect(eventLabel(ev)).toBe("Session complete: completed");
    });
  });

  describe("check event kinds", () => {
    it("formats check_started with check name", () => {
      const ev = makeEvent({
        kind: "check_started",
        check_name: "clippy",
        iteration: 1,
      });
      expect(eventLabel(ev)).toBe("Check started: clippy");
    });

    it("formats check_passed with check name", () => {
      const ev = makeEvent({
        kind: "check_passed",
        check_name: "clippy",
        iteration: 1,
      });
      expect(eventLabel(ev)).toBe("Check passed: clippy");
    });

    it("formats check_failed with check name (output not included in label)", () => {
      const ev = makeEvent({
        kind: "check_failed",
        check_name: "clippy",
        iteration: 1,
        output: "error[E0308]: mismatched types",
      });
      expect(eventLabel(ev)).toBe("Check failed: clippy");
    });

    it("formats check_fix_started with attempt and check name", () => {
      const ev = makeEvent({
        kind: "check_fix_started",
        check_name: "clippy",
        iteration: 1,
        attempt: 1,
      });
      expect(eventLabel(ev)).toBe("Fix attempt 1: clippy");
    });

    it("formats check_fix_complete with success true", () => {
      const ev = makeEvent({
        kind: "check_fix_complete",
        check_name: "clippy",
        iteration: 1,
        attempt: 1,
        success: true,
      });
      expect(eventLabel(ev)).toBe("Fix attempt 1 succeeded: clippy");
    });

    it("formats check_fix_complete with success false", () => {
      const ev = makeEvent({
        kind: "check_fix_complete",
        check_name: "clippy",
        iteration: 1,
        attempt: 2,
        success: false,
      });
      expect(eventLabel(ev)).toBe("Fix attempt 2 failed: clippy");
    });
  });
});

describe("toolSummary", () => {
  it("returns tool name when no tool_input is provided", () => {
    const ev = makeEvent({ kind: "tool_use", tool_name: "Bash" });
    expect(toolSummary(ev)).toBe("Bash");
  });

  it("returns 'unknown' when tool_name is not provided", () => {
    const ev = makeEvent({ kind: "tool_use" });
    expect(toolSummary(ev)).toBe("unknown");
  });

  it("formats Bash with command", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    expect(toolSummary(ev)).toBe("Bash: ls -la");
  });

  it("formats Bash without command as just the name", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Bash",
      tool_input: {},
    });
    expect(toolSummary(ev)).toBe("Bash");
  });

  it("formats Read with file_path", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Read",
      tool_input: { file_path: "/src/main.rs" },
    });
    expect(toolSummary(ev)).toBe("Read: /src/main.rs");
  });

  it("formats Grep with pattern", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Grep",
      tool_input: { pattern: "TODO" },
    });
    expect(toolSummary(ev)).toBe("Grep: TODO");
  });

  it("returns just tool name for unknown tool types", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "CustomTool",
      tool_input: { some_field: "value" },
    });
    expect(toolSummary(ev)).toBe("CustomTool");
  });
});
