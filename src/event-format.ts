import type { SessionEvent } from "./types";

/**
 * Convert an absolute file path to a relative path by stripping the repo root prefix.
 * Handles both Unix paths (/home/user/repo/src/file.ts) and Windows-style paths
 * (C:\Users\user\repo\src\file.ts), as well as mixed separators that can appear
 * in SSH/WSL contexts.
 */
export function relativePath(
  filePath: string,
  repoPath: string | undefined,
): string {
  if (!repoPath) return filePath;

  // Normalise separators to forward slashes for comparison
  const normFile = filePath.replace(/\\/g, "/");
  const normRepo = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");

  if (normFile.startsWith(normRepo + "/")) {
    return normFile.slice(normRepo.length + 1);
  }

  // No match — return the original path unchanged
  return filePath;
}

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
    case "one_shot_started":
      return "\u{1F3AF}";
    case "design_phase_started":
      return "\u{1F4D0}";
    case "design_phase_complete":
      return "\u{1F4CB}";
    case "implementation_phase_started":
      return "\u{1F528}";
    case "implementation_phase_complete":
      return "\u2705";
    case "git_finalize_started":
      return "\u{1F4E6}";
    case "git_finalize_complete":
      return "\u2705";
    case "one_shot_complete":
      return "\u{1F3C1}";
    case "one_shot_failed":
      return "\u274C";
    case "git_sync_started":
      return "\u{1F504}";
    case "git_sync_push_succeeded":
      return "\u2705";
    case "git_sync_conflict":
      return "\u26A0\uFE0F";
    case "git_sync_conflict_resolve_started":
      return "\u{1F527}";
    case "git_sync_conflict_resolve_complete":
      return "\u{1F3C1}";
    case "git_sync_failed":
      return "\u274C";
    default:
      return "\u{1F4CB}";
  }
}

export function toolSummary(ev: SessionEvent, repoPath?: string): string {
  const name = ev.tool_name ?? "unknown";
  const input = ev.tool_input;
  if (!input) return name;
  switch (name) {
    case "Bash":
      return input.description ? `${name}: ${input.description}` : input.command ? `${name}: ${input.command}` : name;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return input.file_path
        ? `${name}: ${relativePath(String(input.file_path), repoPath)}`
        : name;
    case "Grep":
    case "Glob":
      return input.pattern ? `${name}: ${input.pattern}` : name;
    default:
      return name;
  }
}

export function eventLabel(ev: SessionEvent, repoPath?: string): string {
  switch (ev.kind) {
    case "session_started":
      return `Session started: ${ev.session_id}`;
    case "iteration_started":
      return `Iteration ${ev.iteration} started`;
    case "tool_use":
      return `[${ev.iteration}] ${toolSummary(ev, repoPath)}`;
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
    case "one_shot_started":
      return `1-Shot started: ${ev.title} (${ev.merge_strategy})`;
    case "design_phase_started":
      return "Design phase started";
    case "design_phase_complete":
      return `Design phase complete: ${ev.plan_file}`;
    case "implementation_phase_started":
      return "Implementation phase started";
    case "implementation_phase_complete":
      return "Implementation phase complete";
    case "git_finalize_started":
      return `Git finalize started: ${ev.strategy}`;
    case "git_finalize_complete":
      return "Git finalize complete";
    case "one_shot_complete":
      return "1-Shot complete";
    case "one_shot_failed":
      return `1-Shot failed: ${ev.reason}`;
    case "git_sync_started":
      return `[${ev.iteration}] Git sync`;
    case "git_sync_push_succeeded":
      return `[${ev.iteration}] Pushed to remote`;
    case "git_sync_conflict":
      return `[${ev.iteration}] Merge conflicts: ${ev.files?.join(", ") ?? "unknown files"}`;
    case "git_sync_conflict_resolve_started":
      return `[${ev.iteration}] Conflict resolve started (attempt ${ev.attempt})`;
    case "git_sync_conflict_resolve_complete":
      return ev.success
        ? `[${ev.iteration}] Conflicts resolved (attempt ${ev.attempt})`
        : `[${ev.iteration}] Conflict resolution failed (attempt ${ev.attempt})`;
    case "git_sync_failed":
      return `[${ev.iteration}] Git sync failed${ev.error ? ": " + ev.error : ""}`;
    default:
      return JSON.stringify(ev);
  }
}
