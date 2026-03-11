import type { IterationGroup } from "../iteration-groups";
import { eventEmoji, eventLabel } from "../event-format";
import { formatTokenCount, contextBarColor } from "../context-bar";
import Markdown from "react-markdown";

interface IterationGroupProps {
  group: IterationGroup;
  expanded: boolean;
  onToggle: () => void;
  formatTime: (ts?: number) => string;
  expandedEvents: Set<number>;
  toggleEvent: (globalIndex: number) => void;
  globalStartIndex: number;
  repoPath?: string;
}

function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

const eventKindColor: Record<string, string> = {
  session_started: "text-[#4ecdc4]",
  iteration_started: "text-[#888]",
  tool_use: "text-[#a78bfa]",
  assistant_text: "text-[#e0e0e0]",
  iteration_complete: "text-[#34d399]",
  session_complete: "text-[#e8d44d] font-semibold",
  check_started: "text-[#60a5fa]",
  check_passed: "text-[#34d399]",
  check_failed: "text-[#f87171]",
  check_fix_started: "text-[#fbbf24]",
  check_fix_complete: "text-[#a78bfa]",
  git_sync_started: "text-[#888]",
  git_sync_push_succeeded: "text-[#34d399]",
  git_sync_conflict: "text-[#f59e0b]",
  git_sync_conflict_resolve_started: "text-[#a78bfa]",
  git_sync_conflict_resolve_complete: "text-[#34d399]",
  git_sync_failed: "text-[#ef4444]",
};

export function IterationGroupComponent({
  group,
  expanded,
  onToggle,
  formatTime,
  expandedEvents,
  toggleEvent,
  globalStartIndex,
  repoPath,
}: IterationGroupProps) {
  const percentage =
    group.contextWindow > 0
      ? Math.round((group.inputTokens / group.contextWindow) * 100)
      : 0;

  return (
    <div className={`iteration-group${expanded ? " expanded" : ""}`}>
      <button className="iteration-header flex items-baseline gap-2 w-full px-3 py-1.5 font-mono text-sm bg-transparent border-none text-inherit cursor-pointer text-left border-b border-[#1e1e38]" onClick={onToggle}>
        <span className="iteration-toggle shrink-0">
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span className="iteration-title">Iteration {group.iteration}</span>
        <span className="iteration-stats text-muted-foreground">
          — {group.events.length} events · ${group.cost.toFixed(4)}
          {group.inputTokens || group.outputTokens ? (
            <>
              {" "}
              · {group.inputTokens.toLocaleString()} in /{" "}
              {group.outputTokens.toLocaleString()} out
            </>
          ) : null}
          {group.startTs && group.endTs ? (
            <> · {formatDuration(group.endTs - group.startTs)}</>
          ) : null}
        </span>
      </button>

      {group.contextWindow > 0 && (
        <div className="context-bar flex items-center gap-2 px-3 py-1">
          <div className="context-bar-track flex-1 h-1.5 bg-[#1e1e38] rounded-full overflow-hidden">
            <div
              className="context-bar-fill h-full rounded-full transition-all"
              style={{
                width: `${Math.min(percentage, 100)}%`,
                background: contextBarColor(percentage),
              }}
            />
          </div>
          <span className="context-bar-label text-xs text-muted-foreground font-mono whitespace-nowrap">
            {formatTokenCount(group.inputTokens)} /{" "}
            {formatTokenCount(group.contextWindow)} ({percentage}%)
          </span>
        </div>
      )}

      {expanded && (
        <ul className="iteration-events list-none p-0 m-0">
          {group.events.map((ev, i) => {
            const globalIndex = globalStartIndex + i;
            const isExpanded = expandedEvents.has(globalIndex);
            const colorClass = eventKindColor[ev.kind] ?? "";

            return (
              <li
                key={i}
                className={`event ${ev.kind}${isExpanded ? " expanded" : ""} ${colorClass} border-b border-[#1e1e38] last:border-b-0`}
              >
                <button
                  className="event-btn flex items-baseline gap-2 w-full px-3 py-1 pl-8 font-mono text-sm bg-transparent border-none text-inherit cursor-pointer text-left"
                  onClick={() => toggleEvent(globalIndex)}
                >
                  <span className="event-emoji shrink-0">{eventEmoji(ev.kind)}</span>
                  <span className={`event-text flex-1 min-w-0 ${isExpanded ? "whitespace-pre-wrap break-words" : "overflow-hidden text-ellipsis whitespace-nowrap"}`}>{eventLabel(ev, repoPath)}</span>
                  <span className="event-time shrink-0 text-[#555] text-xs">{formatTime(ev._ts)}</span>
                </button>

                {isExpanded && ev.kind === "tool_use" && ev.tool_input && ev.tool_name === "Agent" && (
                  <div className="agent-detail mx-3 mb-2 ml-9 p-2 bg-[#1a1a35] border border-[#2a2a3e] rounded text-xs text-[#9ca3af]">
                    {Object.entries(ev.tool_input)
                      .filter(([key]) => key !== "prompt")
                      .map(([key, value]) => (
                        <div key={key} className="flex gap-2 py-0.5">
                          <span className="font-semibold text-[#a78bfa]">{key}:</span>
                          <span>{typeof value === "object" ? JSON.stringify(value) : String(value)}</span>
                        </div>
                      ))}
                    {typeof ev.tool_input.prompt === "string" && (
                      <div className="mt-2 border-t border-[#2a2a3e] pt-2">
                        <Markdown>{ev.tool_input.prompt}</Markdown>
                      </div>
                    )}
                  </div>
                )}

                {isExpanded && ev.kind === "tool_use" && ev.tool_input && ev.tool_name !== "Agent" && (
                  <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-[#1a1a35] border border-[#2a2a3e] rounded font-mono text-xs text-[#9ca3af] whitespace-pre-wrap break-words overflow-x-auto">
                    {JSON.stringify(ev.tool_input, null, 2)}
                  </pre>
                )}

                {isExpanded && ev.kind === "check_failed" && ev.output && (
                  <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-[#1a1a35] border border-[#2a2a3e] rounded font-mono text-xs text-[#9ca3af] whitespace-pre-wrap break-words overflow-x-auto">{ev.output}</pre>
                )}

                {isExpanded && ev.kind === "git_sync_failed" && ev.error && (
                  <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-[#1a1a35] border border-[#2a2a3e] rounded font-mono text-xs text-[#9ca3af] whitespace-pre-wrap break-words overflow-x-auto">{ev.error}</pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
