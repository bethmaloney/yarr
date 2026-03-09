import type { IterationGroup } from "../iteration-groups";
import { eventEmoji, eventLabel } from "../event-format";
import { formatTokenCount, contextBarColor } from "../context-bar";

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
      <button className="iteration-header" onClick={onToggle}>
        <span className="iteration-toggle">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span className="iteration-title">Iteration {group.iteration}</span>
        <span className="iteration-stats">
          — {group.events.length} events · ${group.cost.toFixed(4)}
          {(group.inputTokens || group.outputTokens) ? (
            <> · {group.inputTokens.toLocaleString()} in / {group.outputTokens.toLocaleString()} out</>
          ) : null}
          {group.startTs && group.endTs ? (
            <> · {formatDuration(group.endTs - group.startTs)}</>
          ) : null}
        </span>
      </button>

      {group.contextWindow > 0 && (
        <div className="context-bar">
          <div className="context-bar-track">
            <div
              className="context-bar-fill"
              style={{
                width: `${Math.min(percentage, 100)}%`,
                background: contextBarColor(percentage),
              }}
            />
          </div>
          <span className="context-bar-label">
            {formatTokenCount(group.inputTokens)} / {formatTokenCount(group.contextWindow)} ({percentage}%)
          </span>
        </div>
      )}

      {expanded && (
        <ul className="iteration-events">
          {group.events.map((ev, i) => {
            const globalIndex = globalStartIndex + i;
            const isExpanded = expandedEvents.has(globalIndex);
            const colorClass = eventKindColor[ev.kind] ?? "";

            return (
              <li
                key={i}
                className={`event ${ev.kind}${isExpanded ? " expanded" : ""} ${colorClass}`}
              >
                <button
                  className="event-btn"
                  onClick={() => toggleEvent(globalIndex)}
                >
                  <span className="event-emoji">{eventEmoji(ev.kind)}</span>
                  <span className="event-text">{eventLabel(ev, repoPath)}</span>
                  <span className="event-time">{formatTime(ev._ts)}</span>
                </button>

                {isExpanded && ev.kind === "tool_use" && ev.tool_input && (
                  <pre className="tool-input-detail">
                    {JSON.stringify(ev.tool_input, null, 2)}
                  </pre>
                )}

                {isExpanded && ev.kind === "check_failed" && ev.output && (
                  <pre className="tool-input-detail">{ev.output}</pre>
                )}

                {isExpanded && ev.kind === "git_sync_failed" && ev.error && (
                  <pre className="tool-input-detail">{ev.error}</pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
