import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { IterationGroup } from "../iteration-groups";
import type { SessionEvent } from "../types";
import { eventEmoji, eventLabel, toolSummary } from "../event-format";
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

interface SubAgentEventListProps {
  events: SessionEvent[];
  repoPath?: string;
  formatTime: (ts?: number) => string;
}

function SubAgentEventList({
  events,
  repoPath,
  formatTime,
}: SubAgentEventListProps) {
  const [expandedSet, setExpandedSet] = useState<Set<number>>(
    () => new Set(),
  );
  const [expandedOutputs, setExpandedOutputs] = useState<Set<number>>(
    () => new Set(),
  );

  const toggle = (i: number) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div>
      <ul className="list-none p-0 m-0 border-l-2 border-border ml-1">
        {events.map((childEv, ci) => {
          const isExpanded = expandedSet.has(ci);
          const isToolUse = childEv.kind === "tool_use";
          const hasDetail =
            isToolUse ||
            childEv.kind === "assistant_text" ||
            childEv.kind === "tool_result";
          const colorClass = eventKindColor[childEv.kind] ?? "";

          return (
            <li key={ci} className={colorClass}>
              <div
                role={hasDetail ? "button" : undefined}
                tabIndex={hasDetail ? 0 : undefined}
                className={`flex items-baseline gap-1.5 py-0.5 pl-3 pr-1 ${hasDetail ? "cursor-pointer hover:bg-background/40 transition-colors duration-150" : ""}`}
                onClick={
                  hasDetail
                    ? handleSelectableClick(() => toggle(ci))
                    : undefined
                }
                onKeyDown={
                  hasDetail ? handleKeyDown(() => toggle(ci)) : undefined
                }
              >
                {hasDetail && (
                  <ChevronRight
                    className={`shrink-0 size-3 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`}
                  />
                )}
                <span className="shrink-0">
                  {eventEmoji(childEv.kind)}
                </span>
                <span
                  className={`flex-1 min-w-0 ${isExpanded ? "whitespace-pre-wrap break-words" : "overflow-hidden text-ellipsis whitespace-nowrap"}`}
                >
                  {isToolUse
                    ? toolSummary(childEv, repoPath)
                    : eventLabel(childEv, repoPath)}
                </span>
                {childEv._ts && (
                  <span className="shrink-0 text-muted-foreground/60">
                    {formatTime(childEv._ts)}
                  </span>
                )}
              </div>

              {/* Expanded: tool input */}
              {isExpanded && isToolUse && childEv.tool_input && (
                <pre className="ml-8 mr-1 mb-1 p-1.5 bg-background/50 border border-border rounded font-mono text-[11px] text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto">
                  {JSON.stringify(childEv.tool_input, null, 2)}
                </pre>
              )}

              {/* Expanded: tool output */}
              {isExpanded &&
                isToolUse &&
                childEv.tool_output && (
                  <SubAgentToolOutput
                    toolOutput={childEv.tool_output}
                    toolName={childEv.tool_name ?? ""}
                    index={ci}
                    expandedOutputs={expandedOutputs}
                    setExpandedOutputs={setExpandedOutputs}
                  />
                )}

              {/* Expanded: assistant text */}
              {isExpanded && childEv.kind === "assistant_text" && (
                <div className="ml-8 mr-1 mb-1 p-1.5 bg-background/50 border border-border rounded text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
                  <Markdown>{childEv.text ?? ""}</Markdown>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SubAgentToolOutput({
  toolOutput,
  toolName,
  index,
  expandedOutputs,
  setExpandedOutputs,
}: {
  toolOutput: string;
  toolName: string;
  index: number;
  expandedOutputs: Set<number>;
  setExpandedOutputs: React.Dispatch<React.SetStateAction<Set<number>>>;
}) {
  const lines = toolOutput.split("\n");
  const isExpanded = expandedOutputs.has(index);
  const needsTruncation = lines.length > 12;
  const displayedLines =
    needsTruncation && !isExpanded ? lines.slice(0, 12) : lines;
  const remaining = lines.length - 12;

  return (
    <div className="ml-8 mr-1 mb-1 p-1.5 bg-background/50 border border-border rounded text-[11px] text-muted-foreground">
      <div className="text-primary/80 mb-0.5 text-[10px] uppercase tracking-wider font-semibold">
        Output
      </div>
      {toolName === "Agent" ? (
        <Markdown>
          {needsTruncation && !isExpanded
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
      {needsTruncation && !isExpanded && (
        <button
          className="mt-0.5 text-primary hover:underline cursor-pointer bg-transparent border-none text-[11px] p-0"
          onClick={() =>
            setExpandedOutputs((prev) => {
              const next = new Set(prev);
              next.add(index);
              return next;
            })
          }
        >
          Show more ({remaining} more lines)
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
  const [activeAgentTab, setActiveAgentTab] = useState<
    Record<number, string>
  >({});

  const percentage =
    group.contextWindow > 0
      ? Math.round((group.inputTokens / group.contextWindow) * 100)
      : 0;

  return (
    <div className={`iteration-group${expanded ? " expanded" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        className="iteration-header w-full px-3 py-1.5 font-mono text-sm bg-transparent border-none text-inherit cursor-pointer text-left border-b border-border select-text hover:bg-background/50 transition-colors duration-150"
        onClick={handleSelectableClick(onToggle)}
        onKeyDown={handleKeyDown(onToggle)}
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={`iteration-toggle shrink-0 size-4 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
          />
          <span className="iteration-title whitespace-nowrap">
            Iteration {group.iteration}
          </span>
          <span className="iteration-stats text-muted-foreground whitespace-nowrap">
            — {group.events.length} events · ${group.cost.toFixed(2)}
            {group.startTs && group.endTs ? (
              <> · {formatDuration(group.endTs - group.startTs)}</>
            ) : null}
          </span>
        </div>
        {(group.inputTokens > 0 ||
          group.outputTokens > 0 ||
          group.contextTokens > 0 ||
          group.subAgentPeakContext > 0) && (
          <div className="flex items-center gap-1 pl-6 pt-0.5 text-xs text-muted-foreground">
            {group.inputTokens || group.outputTokens ? (
              <span
                title={`${group.inputTokens.toLocaleString()} in / ${group.outputTokens.toLocaleString()} out`}
              >
                {formatTokenCount(group.inputTokens)} in /{" "}
                {formatTokenCount(group.outputTokens)} out
              </span>
            ) : null}
            {group.contextTokens > 0 ? (
              <>
                {(group.inputTokens || group.outputTokens) && <span>·</span>}
                <span
                  style={{ color: contextTokensColor(group.contextTokens) }}
                >
                  {formatTokenCount(group.contextTokens)} ctx
                  {group.compacted ? " \u21BB" : ""}
                </span>
              </>
            ) : null}
            {group.subAgentPeakContext > 0 ? (
              <>
                <span>·</span>
                <span>
                  agents: {formatTokenCount(group.subAgentPeakContext)}/
                  {formatTokenCount(group.contextWindow)}
                </span>
              </>
            ) : null}
          </div>
        )}
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
            .filter(
              ({ ev }) =>
                ev.kind !== "context_updated" &&
                ev.kind !== "sub_agent_context_updated" &&
                !ev.parent_tool_use_id,
            )
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
                    (ev.kind === "tool_use" ||
                      ev.kind === "check_fix_tool_use") &&
                    ev.tool_input &&
                    ev.tool_name === "Agent" &&
                    (() => {
                      const hasPrompt =
                        typeof ev.tool_input?.prompt === "string";
                      const hasOutput = !!ev.tool_output;
                      const childEvents = ev.tool_use_id
                        ? group.events.filter(
                            (e) =>
                              e.parent_tool_use_id === ev.tool_use_id &&
                              e.kind !== "sub_agent_context_updated",
                          )
                        : [];
                      const hasActivity = childEvents.length > 0;

                      const tabs: { id: string; label: string }[] = [];
                      if (hasActivity)
                        tabs.push({ id: "activity", label: "Activity" });
                      if (hasPrompt)
                        tabs.push({ id: "prompt", label: "Prompt" });
                      if (hasOutput)
                        tabs.push({ id: "output", label: "Output" });

                      const currentTab =
                        activeAgentTab[globalIndex] ??
                        (hasActivity ? "activity" : "prompt");

                      return (
                        <div className="agent-detail mx-3 mb-2 ml-9 bg-card-inset border border-border rounded text-xs text-muted-foreground">
                          {/* Metadata */}
                          <div className="p-2 pb-0">
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
                          </div>

                          {/* Tab bar */}
                          {tabs.length > 0 && (
                            <>
                              <div
                                className="flex gap-0 border-b border-border mt-2"
                                role="tablist"
                              >
                                {tabs.map((tab) => (
                                  <button
                                    key={tab.id}
                                    role="tab"
                                    aria-selected={currentTab === tab.id}
                                    className={`px-3 py-1 text-[11px] font-mono uppercase tracking-widest bg-transparent border-none cursor-pointer transition-colors duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
                                      currentTab === tab.id
                                        ? "text-primary border-b-2 border-primary -mb-px"
                                        : "text-muted-foreground hover:text-foreground"
                                    }`}
                                    onClick={() =>
                                      setActiveAgentTab((prev) => ({
                                        ...prev,
                                        [globalIndex]: tab.id,
                                      }))
                                    }
                                  >
                                    {tab.label}
                                  </button>
                                ))}
                              </div>

                              {/* Tab content */}
                              <div className="p-2 overflow-hidden break-words">
                                {currentTab === "activity" && hasActivity && (
                                  <SubAgentEventList
                                    events={childEvents}
                                    repoPath={repoPath}
                                    formatTime={formatTime}
                                  />
                                )}
                                {currentTab === "prompt" && hasPrompt && (
                                  <Markdown>
                                    {ev.tool_input.prompt as string}
                                  </Markdown>
                                )}
                                {currentTab === "output" && hasOutput && (
                                  <Markdown>{ev.tool_output!}</Markdown>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })()}

                  {isExpanded &&
                    (ev.kind === "tool_use" ||
                      ev.kind === "check_fix_tool_use") &&
                    ev.tool_input &&
                    ev.tool_name !== "Agent" && (
                      <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-card-inset border border-border rounded font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto">
                        {JSON.stringify(ev.tool_input, null, 2)}
                      </pre>
                    )}

                  {isExpanded &&
                    (ev.kind === "tool_use" ||
                      ev.kind === "check_fix_tool_use") &&
                    ev.tool_output &&
                    ev.tool_name !== "Agent" && (
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
