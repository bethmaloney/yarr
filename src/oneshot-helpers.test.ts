import { describe, it, expect } from "vitest";
import {
  getPhaseFromEvents,
  phaseLabel,
  buildOneShotArgs,
} from "./oneshot-helpers";
import type { SessionEvent } from "./types";
import type { RepoConfig } from "./repos";

function makeEvent(overrides: Partial<SessionEvent>): SessionEvent {
  return { kind: "unknown", ...overrides };
}

describe("getPhaseFromEvents", () => {
  it("returns idle when events list is empty", () => {
    expect(getPhaseFromEvents([])).toBe("idle");
  });

  it("returns idle when no 1-shot events are present", () => {
    const events = [
      makeEvent({ kind: "session_started" }),
      makeEvent({ kind: "iteration_started", iteration: 1 }),
    ];
    expect(getPhaseFromEvents(events)).toBe("idle");
  });

  it("returns starting when one_shot_started is present but design not started", () => {
    const events = [makeEvent({ kind: "one_shot_started" })];
    expect(getPhaseFromEvents(events)).toBe("starting");
  });

  it("returns design when design_phase_started but not complete", () => {
    const events = [
      makeEvent({ kind: "one_shot_started" }),
      makeEvent({ kind: "design_phase_started" }),
    ];
    expect(getPhaseFromEvents(events)).toBe("design");
  });

  it("returns design_complete when design_phase_complete but implementation not started", () => {
    const events = [
      makeEvent({ kind: "one_shot_started" }),
      makeEvent({ kind: "design_phase_started" }),
      makeEvent({ kind: "design_phase_complete" }),
    ];
    expect(getPhaseFromEvents(events)).toBe("design_complete");
  });

  it("returns implementation when implementation_phase_started but not complete", () => {
    const events = [
      makeEvent({ kind: "one_shot_started" }),
      makeEvent({ kind: "design_phase_started" }),
      makeEvent({ kind: "design_phase_complete" }),
      makeEvent({ kind: "implementation_phase_started" }),
    ];
    expect(getPhaseFromEvents(events)).toBe("implementation");
  });

  it("returns implementation_complete when implementation_phase_complete but finalize not started", () => {
    const events = [
      makeEvent({ kind: "one_shot_started" }),
      makeEvent({ kind: "design_phase_started" }),
      makeEvent({ kind: "design_phase_complete" }),
      makeEvent({ kind: "implementation_phase_started" }),
      makeEvent({ kind: "implementation_phase_complete" }),
    ];
    expect(getPhaseFromEvents(events)).toBe("implementation_complete");
  });

  it("returns finalizing when git_finalize_started but not complete", () => {
    const events = [
      makeEvent({ kind: "one_shot_started" }),
      makeEvent({ kind: "design_phase_started" }),
      makeEvent({ kind: "design_phase_complete" }),
      makeEvent({ kind: "implementation_phase_started" }),
      makeEvent({ kind: "implementation_phase_complete" }),
      makeEvent({ kind: "git_finalize_started" }),
    ];
    expect(getPhaseFromEvents(events)).toBe("finalizing");
  });

  it("returns complete when git_finalize_complete is present", () => {
    const events = [
      makeEvent({ kind: "one_shot_started" }),
      makeEvent({ kind: "design_phase_started" }),
      makeEvent({ kind: "design_phase_complete" }),
      makeEvent({ kind: "implementation_phase_started" }),
      makeEvent({ kind: "implementation_phase_complete" }),
      makeEvent({ kind: "git_finalize_started" }),
      makeEvent({ kind: "git_finalize_complete" }),
    ];
    expect(getPhaseFromEvents(events)).toBe("complete");
  });

  it("returns complete when one_shot_complete is present", () => {
    const events = [
      makeEvent({ kind: "one_shot_started" }),
      makeEvent({ kind: "one_shot_complete" }),
    ];
    expect(getPhaseFromEvents(events)).toBe("complete");
  });

  it("returns failed when one_shot_failed is present", () => {
    const events = [
      makeEvent({ kind: "one_shot_started" }),
      makeEvent({ kind: "design_phase_started" }),
      makeEvent({ kind: "one_shot_failed" }),
    ];
    expect(getPhaseFromEvents(events)).toBe("failed");
  });

  it("returns failed even if other phases are also present", () => {
    const events = [
      makeEvent({ kind: "one_shot_started" }),
      makeEvent({ kind: "design_phase_started" }),
      makeEvent({ kind: "design_phase_complete" }),
      makeEvent({ kind: "implementation_phase_started" }),
      makeEvent({ kind: "one_shot_failed" }),
    ];
    expect(getPhaseFromEvents(events)).toBe("failed");
  });

  it("ignores non-1-shot events interspersed with phase events", () => {
    const events = [
      makeEvent({ kind: "one_shot_started" }),
      makeEvent({ kind: "session_started" }),
      makeEvent({ kind: "iteration_started", iteration: 1 }),
      makeEvent({ kind: "design_phase_started" }),
      makeEvent({ kind: "tool_use", tool_name: "Bash" }),
      makeEvent({ kind: "assistant_text", text: "hello" }),
    ];
    expect(getPhaseFromEvents(events)).toBe("design");
  });
});

describe("phaseLabel", () => {
  it("returns Ready for idle", () => {
    expect(phaseLabel("idle")).toBe("Ready");
  });

  it("returns Starting... for starting", () => {
    expect(phaseLabel("starting")).toBe("Starting...");
  });

  it("returns Design Phase for design", () => {
    expect(phaseLabel("design")).toBe("Design Phase");
  });

  it("returns Design Complete for design_complete", () => {
    expect(phaseLabel("design_complete")).toBe("Design Complete");
  });

  it("returns Implementation Phase for implementation", () => {
    expect(phaseLabel("implementation")).toBe("Implementation Phase");
  });

  it("returns Implementation Complete for implementation_complete", () => {
    expect(phaseLabel("implementation_complete")).toBe(
      "Implementation Complete",
    );
  });

  it("returns Finalizing... for finalizing", () => {
    expect(phaseLabel("finalizing")).toBe("Finalizing...");
  });

  it("returns Complete for complete", () => {
    expect(phaseLabel("complete")).toBe("Complete");
  });

  it("returns Failed for failed", () => {
    expect(phaseLabel("failed")).toBe("Failed");
  });

  it("returns the phase string itself for unknown phases", () => {
    expect(phaseLabel("some_unknown_phase")).toBe("some_unknown_phase");
  });
});

describe("buildOneShotArgs", () => {
  describe("local repos", () => {
    const localRepo: RepoConfig = {
      type: "local",
      id: "repo-1",
      path: "/home/beth/repos/myproject",
      name: "myproject",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
    };

    it("builds args with repo type local and path", () => {
      const args = buildOneShotArgs(
        localRepo,
        "Add tests",
        "Write unit tests for the parser module",
        "opus",
        "branch",
      );
      expect(args.repo).toEqual({
        type: "local",
        path: "/home/beth/repos/myproject",
      });
    });

    it("includes repoId from repo.id", () => {
      const args = buildOneShotArgs(
        localRepo,
        "Add tests",
        "Write unit tests",
        "opus",
        "branch",
      );
      expect(args.repoId).toBe("repo-1");
    });

    it("includes title and prompt", () => {
      const args = buildOneShotArgs(
        localRepo,
        "My Title",
        "My detailed prompt",
        "opus",
        "branch",
      );
      expect(args.title).toBe("My Title");
      expect(args.prompt).toBe("My detailed prompt");
    });

    it("includes model", () => {
      const args = buildOneShotArgs(
        localRepo,
        "Title",
        "Prompt",
        "sonnet",
        "branch",
      );
      expect(args.model).toBe("sonnet");
    });

    it("includes mergeStrategy", () => {
      const args = buildOneShotArgs(
        localRepo,
        "Title",
        "Prompt",
        "opus",
        "merge_to_main",
      );
      expect(args.mergeStrategy).toBe("merge_to_main");
    });

    it("defaults envVars to empty object when repo has no envVars", () => {
      const args = buildOneShotArgs(
        localRepo,
        "Title",
        "Prompt",
        "opus",
        "branch",
      );
      expect(args.envVars).toEqual({});
    });

    it("includes envVars from repo when present", () => {
      const repoWithEnv: RepoConfig = {
        ...localRepo,
        envVars: { NODE_ENV: "test", DEBUG: "1" },
      };
      const args = buildOneShotArgs(
        repoWithEnv,
        "Title",
        "Prompt",
        "opus",
        "branch",
      );
      expect(args.envVars).toEqual({ NODE_ENV: "test", DEBUG: "1" });
    });

    it("returns the complete expected structure for local repo", () => {
      const repoWithEnv: RepoConfig = {
        ...localRepo,
        envVars: { KEY: "val" },
      };
      const args = buildOneShotArgs(
        repoWithEnv,
        "Feature X",
        "Implement feature X",
        "opus",
        "merge_to_main",
      );
      expect(args).toEqual({
        repoId: "repo-1",
        repo: { type: "local", path: "/home/beth/repos/myproject" },
        title: "Feature X",
        prompt: "Implement feature X",
        model: "opus",
        mergeStrategy: "merge_to_main",
        envVars: { KEY: "val" },
      });
    });
  });

  describe("SSH repos", () => {
    const sshRepo: RepoConfig = {
      type: "ssh",
      id: "repo-2",
      sshHost: "dev-server",
      remotePath: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
    };

    it("builds args with repo type ssh, sshHost and remotePath", () => {
      const args = buildOneShotArgs(
        sshRepo,
        "Add tests",
        "Write unit tests",
        "opus",
        "branch",
      );
      expect(args.repo).toEqual({
        type: "ssh",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/project",
      });
    });

    it("includes repoId from repo.id", () => {
      const args = buildOneShotArgs(
        sshRepo,
        "Title",
        "Prompt",
        "opus",
        "branch",
      );
      expect(args.repoId).toBe("repo-2");
    });

    it("defaults envVars to empty object when repo has no envVars", () => {
      const args = buildOneShotArgs(
        sshRepo,
        "Title",
        "Prompt",
        "opus",
        "branch",
      );
      expect(args.envVars).toEqual({});
    });

    it("includes envVars from repo when present", () => {
      const repoWithEnv: RepoConfig = {
        ...sshRepo,
        envVars: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
      };
      const args = buildOneShotArgs(
        repoWithEnv,
        "Title",
        "Prompt",
        "opus",
        "branch",
      );
      expect(args.envVars).toEqual({
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      });
    });

    it("returns the complete expected structure for SSH repo", () => {
      const args = buildOneShotArgs(
        sshRepo,
        "Deploy Fix",
        "Fix the deployment script",
        "sonnet",
        "branch",
      );
      expect(args).toEqual({
        repoId: "repo-2",
        repo: {
          type: "ssh",
          sshHost: "dev-server",
          remotePath: "/home/beth/repos/project",
        },
        title: "Deploy Fix",
        prompt: "Fix the deployment script",
        model: "sonnet",
        mergeStrategy: "branch",
        envVars: {},
      });
    });
  });

  describe("does not leak extra repo fields into the args", () => {
    it("local repo args.repo only has type and path", () => {
      const localRepo: RepoConfig = {
        type: "local",
        id: "repo-1",
        path: "/home/beth/repos/myproject",
        name: "myproject",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        checks: [],
      };
      const args = buildOneShotArgs(
        localRepo,
        "Title",
        "Prompt",
        "opus",
        "branch",
      );
      expect(Object.keys(args.repo).sort()).toEqual(["path", "type"]);
    });

    it("SSH repo args.repo only has type, sshHost and remotePath", () => {
      const sshRepo: RepoConfig = {
        type: "ssh",
        id: "repo-2",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/project",
        name: "project",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        checks: [],
      };
      const args = buildOneShotArgs(
        sshRepo,
        "Title",
        "Prompt",
        "opus",
        "branch",
      );
      expect(Object.keys(args.repo).sort()).toEqual([
        "remotePath",
        "sshHost",
        "type",
      ]);
    });
  });
});
