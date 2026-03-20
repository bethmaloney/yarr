import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { IterationGroup } from "../iteration-groups";
import { eventEmoji, eventLabel } from "../event-format";
import {
  formatTokenCount,
  contextBarColor,
  contextTokensColor,
} from "../context-bar";
import Markdown from "react-markdown";
import { parseAnsi } from "../lib/ansi";

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
  session_started: "text-info",
  iteration_started: "text-muted-foreground",
  tool_use: "text-primary",
  assistant_text: "text-foreground",
  iteration_complete: "text-success",
  iteration_failed: "text-destructive",
  session_complete: "text-primary font-semibold",
  check_started: "text-info",
  check_passed: "text-success",
  check_failed: "text-destructive",
  check_fix_started: "text-warning",
  check_fix_tool_use: "text-primary",
  check_fix_tool_result: "text-muted-foreground",
  check_fix_assistant_text: "text-foreground",
  check_fix_complete: "text-primary",
  git_sync_started: "text-muted-foreground",
  git_sync_push_succeeded: "text-success",
  git_sync_conflict: "text-warning",
  git_sync_conflict_resolve_started: "text-primary",
  git_sync_conflict_resolve_complete: "text-success",
  git_sync_failed: "text-destructive",
  rate_limited: "text-warning",
  compacted: "text-[#60a5fa]",
};

function handleSelectableClick(callback: () => void) {
  return () => {
    if (window.getSelection()?.isCollapsed === false) return;
    callback();
  };
}

function handleKeyDown(callback: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      callback();
    }
  };
}

interface ToolOutputSectionProps {
  toolOutput: string;
  toolName: string;
  globalIndex: number;
  expandedOutputs: Set<number>;
  setExpandedOutputs: React.Dispatch<React.SetStateAction<Set<number>>>;
}

function ToolOutputSection({
  toolOutput,
  toolName,
  globalIndex,
  expandedOutputs,
  setExpandedOutputs,
}: ToolOutputSectionProps) {
  const lines = toolOutput.split("\n");
  const isOutputExpanded = expandedOutputs.has(globalIndex);
  const needsTruncation = lines.length > 20;
  const displayedLines =
    needsTruncation && !isOutputExpanded ? lines.slice(0, 20) : lines;
  const remainingLines = lines.length - 20;

  return (
    <div className="mx-3 mb-2 ml-9 p-2 bg-card-inset border border-border rounded text-xs text-muted-foreground">
      <div className="text-primary mb-1">Output</div>
      {toolName === "Agent" ? (
        <Markdown>
          {needsTruncation && !isOutputExpanded
            ? displayedLines.join("\n")
            : toolOutput}
        </Markdown>
      ) : (
        <pre className="font-mono whitespace-pre-wrap break-words overflow-x-auto">
          {displayedLines.map((line, li) => (
            <span key={li}>
              {parseAnsi(line).map((seg, j) =>
                seg.classes ? (
                  <span key={j} className={seg.classes}>
                    {seg.text}
                  </span>
                ) : (
                  seg.text
                ),
              )}
              {li < displayedLines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </pre>
      )}
      {needsTruncation && !isOutputExpanded && (
        <button
          className="mt-1 text-primary hover:underline cursor-pointer bg-transparent border-none text-xs p-0"
          onClick={() => {
            setExpandedOutputs((prev) => {
              const next = new Set(prev);
              next.add(globalIndex);
              return next;
            });
          }}
        >
          Show more ({remainingLines} more lines)
        </button>
      )}
    </div>
  );
}

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
  const [expandedOutputs, setExpandedOutputs] = useState<Set<number>>(
    () => new Set(),
  );

  const percentage =
    group.contextWindow > 0
      ? Math.round((group.inputTokens / group.contextWindow) * 100)
      : 0;

  return (
    <div className={`iteration-group${expanded ? " expanded" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        className="iteration-header flex items-center gap-2 w-full px-3 py-1.5 font-mono text-sm bg-transparent border-none text-inherit cursor-pointer text-left border-b border-border select-text hover:bg-background/50 transition-colors duration-150"
        onClick={handleSelectableClick(onToggle)}
        onKeyDown={handleKeyDown(onToggle)}
      >
        <ChevronRight
          className={`iteration-toggle shrink-0 size-4 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
        />
        <span className="iteration-title">Iteration {group.iteration}</span>
        <span className="iteration-stats text-muted-foreground">
          — {group.events.length} events · ${group.cost.toFixed(2)}
          {group.inputTokens || group.outputTokens ? (
            <>
              {" "}
              ·{" "}
              <span
                title={`${group.inputTokens.toLocaleString()} in / ${group.outputTokens.toLocaleString()} out`}
              >
                {formatTokenCount(group.inputTokens)} in /{" "}
                {formatTokenCount(group.outputTokens)} out
              </span>
            </>
          ) : null}
          {group.contextTokens > 0 ? (
            <>
              {" "}
              ·{" "}
              <span
                style={{ color: contextTokensColor(group.contextTokens) }}
              >
                {formatTokenCount(group.contextTokens)} ctx
                {group.compacted ? " \u27F3" : ""}
              </span>
            </>
          ) : null}
          {group.subAgentPeakContext > 0 ? (
            <>
              {" "}·{" "}
              <span className="text-muted-foreground">
                sub-agents peak:{" "}
                {formatTokenCount(group.subAgentPeakContext)}/
                {formatTokenCount(group.contextWindow)}
              </span>
            </>
          ) : null}
          {group.startTs && group.endTs ? (
            <> · {formatDuration(group.endTs - group.startTs)}</>
          ) : null}
        </span>
      </div>

      {group.contextWindow > 0 && (
        <div className="context-bar flex items-center gap-2 px-3 py-1">
          <div className="context-bar-track flex-1 h-1.5 bg-card-inset rounded-full overflow-hidden">
            <div
              className="context-bar-fill h-full rounded-full transition-colors duration-150"
              style={{
                width: `${Math.min(percentage, 100)}%`,
                background: contextBarColor(percentage),
              }}
            />
          </div>
          <span className="context-bar-label text-xs text-muted-foreground font-mono whitespace-nowrap">
            {formatTokenCount(group.inputTokens)} /{" "}
            {formatTokenCount(group.contextWindow)}
          </span>
        </div>
      )}

      {expanded && (
        <ul className="iteration-events list-none p-0 m-0">
          {group.events
            .map((ev, i) => ({ ev, origIndex: i }))
            .filter(({ ev }) => ev.kind !== "context_updated" && ev.kind !== "sub_agent_context_updated")
            .map(({ ev, origIndex }) => {
            const globalIndex = globalStartIndex + origIndex;
            const isExpanded = expandedEvents.has(globalIndex);
            const colorClass = eventKindColor[ev.kind] ?? "";

            return (
              <li
                key={origIndex}
                className={`event ${ev.kind}${isExpanded ? " expanded" : ""} ${colorClass} border-b border-border last:border-b-0`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  className="event-btn flex items-baseline gap-2 w-full px-3 py-1 pl-8 font-mono text-sm bg-transparent border-none text-inherit cursor-pointer text-left select-text hover:bg-background/50 transition-colors duration-150"
                  onClick={handleSelectableClick(() =>
                    toggleEvent(globalIndex),
                  )}
                  onKeyDown={handleKeyDown(() => toggleEvent(globalIndex))}
                >
                  <span className="event-emoji shrink-0">
                    {eventEmoji(ev.kind)}
                  </span>
                  <span
                    className={`event-text flex-1 min-w-0 ${isExpanded ? "whitespace-pre-wrap break-words" : "overflow-hidden text-ellipsis whitespace-nowrap"}`}
                  >
                    {eventLabel(ev, repoPath)}
                  </span>
                  <span className="event-time shrink-0 text-muted-foreground text-xs">
                    {formatTime(ev._ts)}
                  </span>
                </div>

                {isExpanded &&
                  (ev.kind === "tool_use" || ev.kind === "check_fix_tool_use") &&
                  ev.tool_input &&
                  ev.tool_name === "Agent" && (
                    <div className="agent-detail mx-3 mb-2 ml-9 p-2 bg-card-inset border border-border rounded text-xs text-muted-foreground">
                      {Object.entries(ev.tool_input)
                        .filter(([key]) => key !== "prompt")
                        .map(([key, value]) => (
                          <div key={key} className="flex gap-2 py-0.5">
                            <span className="font-semibold text-primary">
                              {key}:
                            </span>
                            <span>
                              {typeof value === "object"
                                ? JSON.stringify(value)
                                : String(value)}
                            </span>
                          </div>
                        ))}
                      {(() => {
                        const peakCtx = group.events
                          .filter(
                            (e) =>
                              e.kind === "sub_agent_context_updated" &&
                              e.parent_tool_use_id === ev.tool_use_id,
                          )
                          .reduce(
                            (max, e) =>
                              Math.max(max, e.context_tokens ?? 0),
                            0,
                          );
                        if (peakCtx === 0) return null;
                        return (
                          <div className="flex gap-2 py-0.5">
                            <span className="font-semibold text-primary">
                              context:
                            </span>
                            <span>
                              {formatTokenCount(peakCtx)} /{" "}
                              {formatTokenCount(group.contextWindow)}
                            </span>
                          </div>
                        );
                      })()}
                      {typeof ev.tool_input.prompt === "string" && (
                        <div className="mt-2 border-t border-border pt-2">
                          <Markdown>{ev.tool_input.prompt}</Markdown>
                        </div>
                      )}
                    </div>
                  )}

                {isExpanded &&
                  (ev.kind === "tool_use" || ev.kind === "check_fix_tool_use") &&
                  ev.tool_input &&
                  ev.tool_name !== "Agent" && (
                    <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-card-inset border border-border rounded font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto">
                      {JSON.stringify(ev.tool_input, null, 2)}
                    </pre>
                  )}

                {isExpanded && (ev.kind === "tool_use" || ev.kind === "check_fix_tool_use") && ev.tool_output && (
                  <ToolOutputSection
                    toolOutput={ev.tool_output}
                    toolName={ev.tool_name ?? ""}
                    globalIndex={globalIndex}
                    expandedOutputs={expandedOutputs}
                    setExpandedOutputs={setExpandedOutputs}
                  />
                )}

                {isExpanded && ev.kind === "check_failed" && ev.output && (
                  <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-card-inset border border-border rounded font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto">
                    {ev.output}
                  </pre>
                )}

                {isExpanded && ev.kind === "git_sync_failed" && ev.error && (
                  <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-card-inset border border-border rounded font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto">
                    {ev.error}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
