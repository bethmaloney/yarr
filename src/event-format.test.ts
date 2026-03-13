import { describe, it, expect } from "vitest";
import {
  eventEmoji,
  eventLabel,
  toolSummary,
  relativePath,
  toWslPath,
} from "./event-format";
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
      expect(eventEmoji("git_sync_conflict_resolve_complete")).toBe(
        "\u{1F3C1}",
      );
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
      expect(label).toContain("$0.42");
    });

    it("returns session complete label with outcome", () => {
      const ev = makeEvent({
        kind: "session_complete",
        outcome: "completed",
      });
      const label = eventLabel(ev);
      expect(label).toBe("Session complete: completed");
    });

    it("returns tool use label with Bash description when both command and description present", () => {
      const ev = makeEvent({
        kind: "tool_use",
        iteration: 2,
        tool_name: "Bash",
        tool_input: {
          command: "npm run typecheck 2>&1 || npx tsc --noEmit 2>&1",
          description: "Try alternative TypeScript check commands",
        },
      });
      const label = eventLabel(ev);
      expect(label).toBe(
        "[2] Bash: Try alternative TypeScript check commands",
      );
    });

    it("returns tool use label with Bash description when only description present", () => {
      const ev = makeEvent({
        kind: "tool_use",
        iteration: 1,
        tool_name: "Bash",
        tool_input: { description: "Check project status" },
      });
      const label = eventLabel(ev);
      expect(label).toBe("[1] Bash: Check project status");
    });
  });

  describe("tool_use with repoPath shows relative paths", () => {
    it("shows relative path for Read tool", () => {
      const ev = makeEvent({
        kind: "tool_use",
        iteration: 1,
        tool_name: "Read",
        tool_input: { file_path: "/home/user/myrepo/src/main.ts" },
      });
      const label = eventLabel(ev, "/home/user/myrepo");
      expect(label).toBe("[1] Read: src/main.ts");
    });

    it("shows absolute path when repoPath is undefined", () => {
      const ev = makeEvent({
        kind: "tool_use",
        iteration: 1,
        tool_name: "Edit",
        tool_input: { file_path: "/home/user/myrepo/src/main.ts" },
      });
      const label = eventLabel(ev);
      expect(label).toBe("[1] Edit: /home/user/myrepo/src/main.ts");
    });

    it("shows absolute path when it does not match repoPath", () => {
      const ev = makeEvent({
        kind: "tool_use",
        iteration: 1,
        tool_name: "Write",
        tool_input: { file_path: "/tmp/scratch.ts" },
      });
      const label = eventLabel(ev, "/home/user/myrepo");
      expect(label).toBe("[1] Write: /tmp/scratch.ts");
    });
  });
});

describe("eventEmoji for tool_result", () => {
  it("returns clipboard emoji for tool_result", () => {
    expect(eventEmoji("tool_result")).toBe("\u{1F4CB}");
  });
});

describe("eventLabel for tool_result", () => {
  it("includes tool_name in label for tool_result event", () => {
    const ev = makeEvent({
      kind: "tool_result",
      tool_name: "Bash",
      tool_use_id: "tu_456",
      tool_output: "hello world",
    });
    const label = eventLabel(ev);
    expect(label).toContain("Bash");
  });
});

describe("relativePath", () => {
  it("strips Unix repo prefix", () => {
    expect(relativePath("/home/user/repo/src/file.ts", "/home/user/repo")).toBe(
      "src/file.ts",
    );
  });

  it("strips repo prefix with trailing slash", () => {
    expect(
      relativePath("/home/user/repo/src/file.ts", "/home/user/repo/"),
    ).toBe("src/file.ts");
  });

  it("returns original when no match", () => {
    expect(relativePath("/other/path/file.ts", "/home/user/repo")).toBe(
      "/other/path/file.ts",
    );
  });

  it("returns original when repoPath is undefined", () => {
    expect(relativePath("/home/user/repo/file.ts", undefined)).toBe(
      "/home/user/repo/file.ts",
    );
  });

  it("handles Windows-style backslash paths", () => {
    expect(
      relativePath(
        "C:\\Users\\beth\\repo\\src\\file.ts",
        "C:\\Users\\beth\\repo",
      ),
    ).toBe("src/file.ts");
  });

  it("handles mixed separators (SSH/WSL)", () => {
    expect(
      relativePath(
        "/mnt/c/Users/beth/repo/src/file.ts",
        "/mnt/c/Users/beth/repo",
      ),
    ).toBe("src/file.ts");
  });

  it("does not strip partial directory matches", () => {
    // /home/user/repo-extra should NOT match /home/user/repo
    expect(
      relativePath("/home/user/repo-extra/file.ts", "/home/user/repo"),
    ).toBe("/home/user/repo-extra/file.ts");
  });

  it("handles UNC wsl.localhost repoPath with Unix filePath", () => {
    expect(
      relativePath(
        "/home/beth/repos/yarr/src/file.ts",
        "\\\\wsl.localhost\\Ubuntu-24.04\\home\\beth\\repos\\yarr",
      ),
    ).toBe("src/file.ts");
  });

  it("handles UNC wsl$ repoPath with Unix filePath", () => {
    expect(
      relativePath(
        "/home/beth/repos/yarr/src/file.ts",
        "\\\\wsl$\\Ubuntu-24.04\\home\\beth\\repos\\yarr",
      ),
    ).toBe("src/file.ts");
  });

  it("handles drive letter repoPath with /mnt/ filePath", () => {
    expect(
      relativePath(
        "/mnt/c/Users/beth/repo/src/file.ts",
        "C:\\Users\\beth\\repo",
      ),
    ).toBe("src/file.ts");
  });

  it("strips worktree prefix for 1-shot sessions", () => {
    expect(
      relativePath(
        "/home/beth/.yarr/worktrees/209caef3-oneshot-b775c9/src/components/Foo.tsx",
        "/home/beth/.yarr/worktrees/209caef3-oneshot-b775c9",
      ),
    ).toBe("src/components/Foo.tsx");
  });
});

describe("toolSummary with repoPath", () => {
  it("shows relative path for file tools", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Read",
      tool_input: { file_path: "/home/user/repo/src/main.ts" },
    });
    expect(toolSummary(ev, "/home/user/repo")).toBe("Read: src/main.ts");
  });

  it("does not affect non-file tools", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    expect(toolSummary(ev, "/home/user/repo")).toBe("Bash: npm test");
  });

  it("prefers description over command for Bash tool", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Bash",
      tool_input: { command: "npm test", description: "Run unit tests" },
    });
    expect(toolSummary(ev, "/home/user/repo")).toBe("Bash: Run unit tests");
  });

  it("shows Bash description when command is absent", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Bash",
      tool_input: { description: "Check git status" },
    });
    expect(toolSummary(ev, "/home/user/repo")).toBe("Bash: Check git status");
  });

  it("shows relative path for Read tool with UNC repoPath", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Read",
      tool_input: { file_path: "/home/beth/repos/yarr/src/main.ts" },
    });
    expect(
      toolSummary(
        ev,
        "\\\\wsl.localhost\\Ubuntu-24.04\\home\\beth\\repos\\yarr",
      ),
    ).toBe("Read: src/main.ts");
  });

  it("returns Agent with description when description is present", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Agent",
      tool_input: { description: "Review working_dir changes" },
    });
    expect(toolSummary(ev, "/home/user/repo")).toBe(
      "Agent: Review working_dir changes",
    );
  });

  it("returns bare Agent when description is absent", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Agent",
      tool_input: { prompt: "Do something" },
    });
    expect(toolSummary(ev, "/home/user/repo")).toBe("Agent");
  });

  it("returns bare Agent when description is empty string", () => {
    const ev = makeEvent({
      kind: "tool_use",
      tool_name: "Agent",
      tool_input: { description: "" },
    });
    expect(toolSummary(ev, "/home/user/repo")).toBe("Agent");
  });
});

describe("toWslPath", () => {
  it("converts UNC //wsl.localhost/Distro/path to /path", () => {
    expect(
      toWslPath("//wsl.localhost/Ubuntu-24.04/home/beth/repos/yarr"),
    ).toBe("/home/beth/repos/yarr");
  });

  it("converts UNC //wsl$/Distro/path to /path", () => {
    expect(toWslPath("//wsl$/Ubuntu-24.04/home/beth/repos/yarr")).toBe(
      "/home/beth/repos/yarr",
    );
  });

  it("converts drive letter C:/path to /mnt/c/path", () => {
    expect(toWslPath("C:/Users/beth/repo")).toBe("/mnt/c/Users/beth/repo");
  });

  it("converts lowercase drive letter d:/path to /mnt/d/path", () => {
    expect(toWslPath("d:/projects/foo")).toBe("/mnt/d/projects/foo");
  });

  it("passes through Unix paths unchanged", () => {
    expect(toWslPath("/home/user/repo")).toBe("/home/user/repo");
  });

  it("returns / for UNC path with only distro and no further path", () => {
    expect(toWslPath("//wsl.localhost/Ubuntu-24.04")).toBe("/");
  });
});

// ===========================================================================
// plan_content_updated event
// ===========================================================================

describe("eventEmoji — plan_content_updated", () => {
  it("returns chart emoji for plan_content_updated", () => {
    expect(eventEmoji("plan_content_updated")).toBe("\u{1F4CA}");
  });
});

describe("eventLabel — plan_content_updated", () => {
  it("returns 'Plan progress updated' for plan_content_updated", () => {
    const ev = makeEvent({ kind: "plan_content_updated" });
    expect(eventLabel(ev)).toBe("Plan progress updated");
  });
});
