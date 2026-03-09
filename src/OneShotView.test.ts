import { describe, it, expect } from "vitest";
import {
  getPhaseFromEvents,
  phaseLabel,
  buildOneShotArgs,
} from "./oneshot-helpers";
import type { SessionEvent, SessionState } from "./types";
import type { RepoConfig } from "./repos";

/**
 * The OneShotView component uses form validation logic:
 *   disabled={session.running || !title.trim() || !prompt.trim()}
 *
 * We extract and test this as a pure function to verify the same logic
 * the component uses without needing DOM rendering.
 */
function isRunDisabled(
  session: { running: boolean },
  title: string,
  prompt: string,
): boolean {
  return session.running || !title.trim() || !prompt.trim();
}

describe("OneShotView form validation logic", () => {
  it("is disabled when title and prompt are both empty", () => {
    expect(isRunDisabled({ running: false }, "", "")).toBe(true);
  });

  it("is disabled when title is empty and prompt is filled", () => {
    expect(isRunDisabled({ running: false }, "", "Do something")).toBe(true);
  });

  it("is disabled when title is filled and prompt is empty", () => {
    expect(isRunDisabled({ running: false }, "My Task", "")).toBe(true);
  });

  it("is disabled when title is only whitespace", () => {
    expect(isRunDisabled({ running: false }, "   ", "Do something")).toBe(true);
  });

  it("is disabled when prompt is only whitespace", () => {
    expect(isRunDisabled({ running: false }, "My Task", "   ")).toBe(true);
  });

  it("is disabled when both title and prompt are only whitespace", () => {
    expect(isRunDisabled({ running: false }, "  \t  ", "  \n  ")).toBe(true);
  });

  it("is enabled when both title and prompt have content", () => {
    expect(isRunDisabled({ running: false }, "My Task", "Do something")).toBe(
      false,
    );
  });

  it("is disabled when session is running even if title and prompt are filled", () => {
    expect(isRunDisabled({ running: true }, "My Task", "Do something")).toBe(
      true,
    );
  });

  it("is disabled when session is running and fields are empty", () => {
    expect(isRunDisabled({ running: true }, "", "")).toBe(true);
  });

  it("is enabled with minimal non-whitespace content", () => {
    expect(isRunDisabled({ running: false }, "x", "y")).toBe(false);
  });

  it("is enabled when title and prompt have leading/trailing whitespace but non-empty content", () => {
    expect(isRunDisabled({ running: false }, "  title  ", "  prompt  ")).toBe(
      false,
    );
  });
});

describe("OneShotView phase derivation from session state", () => {
  /**
   * The component computes: phase = getPhaseFromEvents(session.events)
   * Then shows/hides the phase indicator based on phase !== "idle".
   * These tests verify the integration of session state with phase display logic.
   */

  function makeSession(events: Partial<SessionEvent>[]): SessionState {
    return {
      running: true,
      events: events.map((e) => ({ kind: "unknown", ...e })),
      trace: null,
      error: null,
    };
  }

  it("idle phase means no phase indicator should be shown", () => {
    const session = makeSession([]);
    const phase = getPhaseFromEvents(session.events);
    expect(phase).toBe("idle");
    // Component logic: {#if phase !== "idle"} — so phase indicator is hidden
    expect(phase !== "idle").toBe(false);
  });

  it("non-idle phase means phase indicator should be shown", () => {
    const session = makeSession([{ kind: "one_shot_started" }]);
    const phase = getPhaseFromEvents(session.events);
    expect(phase).not.toBe("idle");
    expect(phase !== "idle").toBe(true);
  });

  it("phase label for active session shows human-readable text", () => {
    const session = makeSession([
      { kind: "one_shot_started" },
      { kind: "design_phase_started" },
    ]);
    const phase = getPhaseFromEvents(session.events);
    expect(phaseLabel(phase)).toBe("Design Phase");
  });

  it("failed phase gets the correct label and would have failed CSS class", () => {
    const session = makeSession([
      { kind: "one_shot_started" },
      { kind: "one_shot_failed" },
    ]);
    const phase = getPhaseFromEvents(session.events);
    expect(phase).toBe("failed");
    expect(phaseLabel(phase)).toBe("Failed");
    // Component logic: class:failed={phase === "failed"}
    expect(phase === "failed").toBe(true);
  });

  it("complete phase gets the correct label and would have complete CSS class", () => {
    const session = makeSession([
      { kind: "one_shot_started" },
      { kind: "one_shot_complete" },
    ]);
    const phase = getPhaseFromEvents(session.events);
    expect(phase).toBe("complete");
    expect(phaseLabel(phase)).toBe("Complete");
    // Component logic: class:complete={phase === "complete"}
    expect(phase === "complete").toBe(true);
  });
});

describe("OneShotView buildOneShotArgs integration", () => {
  /**
   * The component calls: invoke("run_oneshot", buildOneShotArgs(repo, title, prompt, model, mergeStrategy))
   * These tests verify the args are correctly assembled from typical component state.
   */

  const repo: RepoConfig = {
    type: "local",
    id: "repo-1",
    path: "/home/user/projects/my-app",
    name: "my-app",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
  };

  it("builds correct args with default merge strategy (merge_to_main)", () => {
    const args = buildOneShotArgs(
      repo,
      "Add auth",
      "Implement OAuth2 login",
      "opus",
      "merge_to_main",
    );
    expect(args.repoId).toBe("repo-1");
    expect(args.title).toBe("Add auth");
    expect(args.prompt).toBe("Implement OAuth2 login");
    expect(args.model).toBe("opus");
    expect(args.mergeStrategy).toBe("merge_to_main");
    expect(args.repo).toEqual({
      type: "local",
      path: "/home/user/projects/my-app",
    });
  });

  it("builds correct args with branch merge strategy", () => {
    const args = buildOneShotArgs(
      repo,
      "Fix bug",
      "Fix the login timeout",
      "sonnet",
      "branch",
    );
    expect(args.mergeStrategy).toBe("branch");
    expect(args.model).toBe("sonnet");
  });

  it("model defaults to repo.model in the component (tested as pass-through)", () => {
    // In the component, model is initialized to repo.model.
    // We verify that passing repo.model through buildOneShotArgs preserves it.
    const args = buildOneShotArgs(
      repo,
      "Task",
      "Prompt text",
      repo.model,
      "merge_to_main",
    );
    expect(args.model).toBe("opus");
  });
});
