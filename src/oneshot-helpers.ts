import type { SessionEvent } from "./types";

const ONE_SHOT_EVENTS = new Set([
  "one_shot_started",
  "design_phase_started",
  "design_phase_complete",
  "implementation_phase_started",
  "implementation_phase_complete",
  "git_finalize_started",
  "git_finalize_complete",
  "one_shot_complete",
  "one_shot_failed",
]);

export function getPhaseFromEvents(events: SessionEvent[]): string {
  const kinds = new Set(events.map((e) => e.kind));

  // Check if any 1-shot events are present
  const hasOneShotEvent = [...kinds].some((k) => ONE_SHOT_EVENTS.has(k));
  if (!hasOneShotEvent) return "idle";

  if (kinds.has("one_shot_failed")) return "failed";
  if (kinds.has("git_finalize_complete") || kinds.has("one_shot_complete"))
    return "complete";
  if (kinds.has("git_finalize_started") && kinds.has("git_sync_conflict"))
    return "finalizing_conflict";
  if (kinds.has("git_finalize_started")) return "finalizing";
  if (kinds.has("implementation_phase_complete"))
    return "implementation_complete";
  if (kinds.has("implementation_phase_started")) return "implementation";
  if (kinds.has("design_phase_complete")) return "design_complete";
  if (kinds.has("design_phase_started")) return "design";
  if (kinds.has("one_shot_started")) return "starting";

  return "idle";
}

const PHASE_LABELS: Record<string, string> = {
  idle: "Ready",
  starting: "Starting...",
  design: "Design Phase",
  design_complete: "Design Complete",
  implementation: "Implementation Phase",
  implementation_complete: "Implementation Complete",
  finalizing: "Finalizing...",
  finalizing_conflict: "Resolving Conflicts...",
  complete: "Complete",
  failed: "Failed",
};

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}
