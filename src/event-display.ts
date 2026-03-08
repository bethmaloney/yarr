import type { SessionEvent } from "./types";

export function eventEmoji(kind: string): string {
  switch (kind) {
    case "session_started":
      return "\u{1F680}";
    case "iteration_started":
      return "\u{1F504}";
    case "tool_use":
      return "\u{1F527}";
    case "assistant_text":
      return "\u{1F4AC}";
    case "iteration_complete":
      return "\u2705";
    case "session_complete":
      return "\u{1F3C1}";
    case "check_started":
      return "\u{1F50D}";
    case "check_passed":
      return "\u2705";
    case "check_failed":
      return "\u274C";
    case "check_fix_started":
      return "\u{1F6E0}\uFE0F";
    case "check_fix_complete":
      return "\u{1F504}";
    default:
      return "\u{1F4CB}";
  }
}

export function toolSummary(ev: SessionEvent): string {
  const name = ev.tool_name ?? "unknown";
  const input = ev.tool_input;
  if (!input) return name;
  switch (name) {
    case "Bash":
      return input.command ? `${name}: ${input.command}` : name;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return input.file_path ? `${name}: ${input.file_path}` : name;
    case "Grep":
    case "Glob":
      return input.pattern ? `${name}: ${input.pattern}` : name;
    default:
      return name;
  }
}

export function eventLabel(ev: SessionEvent): string {
  switch (ev.kind) {
    case "session_started":
      return `Session started: ${ev.session_id}`;
    case "iteration_started":
      return `Iteration ${ev.iteration} started`;
    case "tool_use":
      return `[${ev.iteration}] ${toolSummary(ev)}`;
    case "assistant_text":
      return `[${ev.iteration}] ${ev.text}`;
    case "iteration_complete":
      return `Iteration ${ev.iteration} complete (cost: $${(ev.result as Record<string, number> | undefined)?.total_cost_usd?.toFixed(4) ?? "?"})`;
    case "session_complete":
      return `Session complete: ${ev.outcome}`;
    case "check_started":
      return `Check started: ${ev.check_name}`;
    case "check_passed":
      return `Check passed: ${ev.check_name}`;
    case "check_failed":
      return `Check failed: ${ev.check_name}`;
    case "check_fix_started":
      return `Fix attempt ${ev.attempt}: ${ev.check_name}`;
    case "check_fix_complete":
      return `Fix attempt ${ev.attempt} ${ev.success ? "succeeded" : "failed"}: ${ev.check_name}`;
    default:
      return JSON.stringify(ev);
  }
}
