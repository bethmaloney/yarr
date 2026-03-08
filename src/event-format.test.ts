import { describe, it, expect } from "vitest";
import { eventEmoji, eventLabel } from "./event-format";
import type { SessionEvent } from "./types";

function makeEvent(overrides: Partial<SessionEvent>): SessionEvent {
  return { kind: "unknown", ...overrides };
}

describe("eventEmoji", () => {
  describe("git sync event kinds", () => {
    it("returns sync emoji for git_sync_started", () => {
      expect(eventEmoji("git_sync_started")).toBe("\u{1F504}");
    });

    it("returns checkmark emoji for git_sync_push_succeeded", () => {
      expect(eventEmoji("git_sync_push_succeeded")).toBe("\u2705");
    });

    it("returns warning emoji for git_sync_conflict", () => {
      expect(eventEmoji("git_sync_conflict")).toBe("\u26A0\uFE0F");
    });

    it("returns wrench emoji for git_sync_conflict_resolve_started", () => {
      expect(eventEmoji("git_sync_conflict_resolve_started")).toBe("\u{1F527}");
    });

    it("returns appropriate emoji for git_sync_conflict_resolve_complete", () => {
      expect(eventEmoji("git_sync_conflict_resolve_complete")).toBe("\u{1F3C1}");
    });

    it("returns error emoji for git_sync_failed", () => {
      expect(eventEmoji("git_sync_failed")).toBe("\u274C");
    });
  });

  describe("existing event kinds (regression)", () => {
    it("returns rocket for session_started", () => {
      expect(eventEmoji("session_started")).toBe("\u{1F680}");
    });

    it("returns sync for iteration_started", () => {
      expect(eventEmoji("iteration_started")).toBe("\u{1F504}");
    });

    it("returns wrench for tool_use", () => {
      expect(eventEmoji("tool_use")).toBe("\u{1F527}");
    });

    it("returns speech balloon for assistant_text", () => {
      expect(eventEmoji("assistant_text")).toBe("\u{1F4AC}");
    });

    it("returns checkmark for iteration_complete", () => {
      expect(eventEmoji("iteration_complete")).toBe("\u2705");
    });

    it("returns flag for session_complete", () => {
      expect(eventEmoji("session_complete")).toBe("\u{1F3C1}");
    });

    it("returns clipboard for unknown event kind", () => {
      expect(eventEmoji("something_unknown")).toBe("\u{1F4CB}");
    });
  });
});

describe("eventLabel", () => {
  describe("git sync event labels", () => {
    it("returns label with iteration for git_sync_started", () => {
      const ev = makeEvent({ kind: "git_sync_started", iteration: 3 });
      const label = eventLabel(ev);
      expect(label).toContain("3");
      expect(label.toLowerCase()).toContain("sync");
    });

    it("returns label with iteration for git_sync_push_succeeded", () => {
      const ev = makeEvent({ kind: "git_sync_push_succeeded", iteration: 5 });
      const label = eventLabel(ev);
      expect(label).toContain("5");
      expect(label.toLowerCase()).toContain("push");
    });

    it("returns label with files for git_sync_conflict", () => {
      const ev = makeEvent({
        kind: "git_sync_conflict",
        iteration: 2,
        files: ["src/main.rs", "src/lib.rs"],
      });
      const label = eventLabel(ev);
      expect(label).toContain("2");
      expect(label.toLowerCase()).toContain("conflict");
      // Should mention the files or file count
      expect(label).toMatch(/src\/main\.rs|2 file/i);
    });

    it("returns label with attempt for git_sync_conflict_resolve_started", () => {
      const ev = makeEvent({
        kind: "git_sync_conflict_resolve_started",
        iteration: 4,
        attempt: 2,
      });
      const label = eventLabel(ev);
      expect(label).toContain("4");
      expect(label).toContain("2");
      expect(label.toLowerCase()).toContain("resolve");
    });

    it("returns label with attempt and success for git_sync_conflict_resolve_complete", () => {
      const ev = makeEvent({
        kind: "git_sync_conflict_resolve_complete",
        iteration: 4,
        attempt: 2,
        success: true,
      });
      const label = eventLabel(ev);
      expect(label).toContain("4");
      expect(label.toLowerCase()).toContain("resolve");
      // Should indicate success
      expect(label.toLowerCase()).toMatch(/success|resolved|complete/);
    });

    it("returns label indicating failure for git_sync_conflict_resolve_complete with success=false", () => {
      const ev = makeEvent({
        kind: "git_sync_conflict_resolve_complete",
        iteration: 4,
        attempt: 1,
        success: false,
      });
      const label = eventLabel(ev);
      expect(label.toLowerCase()).toMatch(/fail|unsuccessful/);
    });

    it("returns label with error for git_sync_failed", () => {
      const ev = makeEvent({
        kind: "git_sync_failed",
        iteration: 6,
        error: "push rejected after 3 retries",
      });
      const label = eventLabel(ev);
      expect(label).toContain("6");
      expect(label.toLowerCase()).toContain("fail");
      expect(label).toContain("push rejected after 3 retries");
    });

    it("returns label without error string when error is undefined for git_sync_failed", () => {
      const ev = makeEvent({
        kind: "git_sync_failed",
        iteration: 6,
      });
      const label = eventLabel(ev);
      expect(label).toContain("6");
      expect(label.toLowerCase()).toContain("fail");
    });
  });

  describe("existing event labels (regression)", () => {
    it("returns session started label with session_id", () => {
      const ev = makeEvent({
        kind: "session_started",
        session_id: "sess-001",
      });
      const label = eventLabel(ev);
      expect(label).toContain("sess-001");
      expect(label).toContain("Session started");
    });

    it("returns iteration started label with iteration number", () => {
      const ev = makeEvent({
        kind: "iteration_started",
        iteration: 3,
      });
      const label = eventLabel(ev);
      expect(label).toBe("Iteration 3 started");
    });

    it("returns tool use label with tool summary", () => {
      const ev = makeEvent({
        kind: "tool_use",
        iteration: 2,
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      });
      const label = eventLabel(ev);
      expect(label).toBe("[2] Bash: npm test");
    });

    it("returns assistant text label", () => {
      const ev = makeEvent({
        kind: "assistant_text",
        iteration: 1,
        text: "I will fix the bug",
      });
      const label = eventLabel(ev);
      expect(label).toBe("[1] I will fix the bug");
    });

    it("returns iteration complete label with cost", () => {
      const ev = makeEvent({
        kind: "iteration_complete",
        iteration: 1,
        result: { total_cost_usd: 0.42 },
      });
      const label = eventLabel(ev);
      expect(label).toContain("Iteration 1 complete");
      expect(label).toContain("$0.4200");
    });

    it("returns session complete label with outcome", () => {
      const ev = makeEvent({
        kind: "session_complete",
        outcome: "completed",
      });
      const label = eventLabel(ev);
      expect(label).toBe("Session complete: completed");
    });
  });
});
