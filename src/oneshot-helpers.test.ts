import { describe, it, expect } from "vitest";
import { getPhaseFromEvents, phaseLabel } from "./oneshot-helpers";
import type { SessionEvent } from "./types";

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
