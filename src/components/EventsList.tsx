import { useState, useRef, useEffect, useMemo } from "react";
import type { SessionEvent } from "../types";
import type { PlanProgress } from "../plan-progress";
import { groupEventsByIteration } from "../iteration-groups";
import { eventEmoji, eventLabel } from "../event-format";
import { IterationGroupComponent } from "./IterationGroup";
import { PlanProgressBar } from "./PlanProgressBar";

interface EventsListProps {
  events: SessionEvent[];
  isLive?: boolean;
  repoPath?: string;
  planProgress?: PlanProgress | null;
}

const eventKindColor: Record<string, string> = {
  session_started: "text-info",
  iteration_started: "text-muted-foreground",
  tool_use: "text-primary",
  assistant_text: "text-foreground",
  iteration_complete: "text-success",
  session_complete: "text-primary font-semibold",
  check_started: "text-info",
  check_passed: "text-success",
  check_failed: "text-destructive",
  check_fix_started: "text-warning",
  check_fix_complete: "text-primary",
  git_sync_started: "text-muted-foreground",
  git_sync_push_succeeded: "text-success",
  git_sync_conflict: "text-warning",
  git_sync_conflict_resolve_started: "text-primary",
  git_sync_conflict_resolve_complete: "text-success",
  git_sync_failed: "text-destructive",
};

export function EventsList({
  events,
  isLive = false,
  repoPath,
  planProgress,
}: EventsListProps) {
  const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set());
  const [expandedIterations, setExpandedIterations] = useState<Set<number>>(
    new Set(),
  );
  const [autoScroll, setAutoScroll] = useState(true);
  const lastExpandedIterRef = useRef(-1);
  const eventsContainerRef = useRef<HTMLDivElement>(null);

  const grouped = useMemo(() => groupEventsByIteration(events), [events]);

  // Compute global index mapping
  const { iterationGlobalStartIndices, afterStartIndex } = useMemo(() => {
    const map = new Map<number, number>();
    const beforeCount = grouped.standaloneEvents.filter(
      (s) => s.index === "before",
    ).length;
    let offset = beforeCount;
    for (const iter of grouped.iterations) {
      map.set(iter.iteration, offset);
      offset += iter.events.length;
    }
    return { iterationGlobalStartIndices: map, afterStartIndex: offset };
  }, [grouped]);

  // Auto-expand latest iteration when live
  useEffect(() => {
    if (isLive && grouped.iterations.length > 0) {
      const lastIter =
        grouped.iterations[grouped.iterations.length - 1].iteration;
      if (lastIter !== lastExpandedIterRef.current) {
        lastExpandedIterRef.current = lastIter;
        setExpandedIterations((prev) => {
          const next = new Set(prev);
          next.add(lastIter);
          return next;
        });
      }
    }
  }, [isLive, grouped.iterations]);

  // Auto-scroll on new events
  useEffect(() => {
    if (events.length > 0 && autoScroll) {
      requestAnimationFrame(() => {
        eventsContainerRef.current?.scrollTo({
          top: eventsContainerRef.current.scrollHeight,
          behavior: "smooth",
        });
      });
    }
  }, [events.length, autoScroll]);

  if (events.length === 0) return null;

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

  function toggleIteration(iteration: number) {
    setExpandedIterations((prev) => {
      const next = new Set(prev);
      if (next.has(iteration)) next.delete(iteration);
      else next.add(iteration);
      return next;
    });
  }

  function toggleEvent(globalIndex: number) {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(globalIndex)) next.delete(globalIndex);
      else next.add(globalIndex);
      return next;
    });
  }

  function formatTime(ts?: number): string {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function handleEventsScroll() {
    const el = eventsContainerRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  }

  function jumpToBottom() {
    eventsContainerRef.current?.scrollTo({
      top: eventsContainerRef.current.scrollHeight,
      behavior: "smooth",
    });
    setAutoScroll(true);
  }

  return (
    <section className="events relative">
      <div className="events-header flex items-center gap-2 mb-2">
        <h2 className="text-base text-muted-foreground uppercase tracking-wider border-b border-border pb-1 m-0">
          Events
        </h2>
        <span className="event-count bg-secondary text-muted-foreground text-xs px-2 py-0.5 rounded-[10px] font-mono">
          {events.length}
        </span>
      </div>
      {planProgress && <PlanProgressBar progress={planProgress} />}
      <div
        ref={eventsContainerRef}
        className="events-scroll max-h-[350px] overflow-y-auto border border-border rounded-md bg-card-inset py-1"
        onScroll={handleEventsScroll}
      >
        <ul className="list-none p-0 m-0">
          {/* Before standalones */}
          {grouped.standaloneEvents
            .filter((s) => s.index === "before")
            .map((standalone, i) => {
              const isExpanded = expandedEvents.has(i);
              const colorClass = eventKindColor[standalone.event.kind] ?? "";
              return (
                <li
                  key={`before-${i}`}
                  className={`event ${standalone.event.kind}${isExpanded ? " expanded" : ""} ${colorClass} border-b border-border last:border-b-0`}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    className="event-btn flex items-baseline gap-2 w-full px-3 py-1 font-mono text-sm bg-transparent border-none text-inherit cursor-pointer text-left select-text"
                    onClick={handleSelectableClick(() => toggleEvent(i))}
                    onKeyDown={handleKeyDown(() => toggleEvent(i))}
                  >
                    <span className="event-emoji shrink-0">
                      {eventEmoji(standalone.event.kind)}
                    </span>
                    <span
                      className={`event-text flex-1 min-w-0 ${isExpanded ? "whitespace-pre-wrap break-words" : "overflow-hidden text-ellipsis whitespace-nowrap"}`}
                    >
                      {eventLabel(standalone.event, repoPath)}
                    </span>
                    <span className="event-time shrink-0 text-muted-foreground/60 text-xs">
                      {formatTime(standalone.event._ts)}
                    </span>
                  </div>
                  {isExpanded &&
                    standalone.event.kind === "git_sync_failed" &&
                    standalone.event.error && (
                      <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-card-inset border border-border rounded font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto">
                        {standalone.event.error}
                      </pre>
                    )}
                </li>
              );
            })}

          {/* Iteration groups */}
          {grouped.iterations.map((iter) => (
            <IterationGroupComponent
              key={iter.iteration}
              group={iter}
              expanded={expandedIterations.has(iter.iteration)}
              onToggle={() => toggleIteration(iter.iteration)}
              formatTime={formatTime}
              expandedEvents={expandedEvents}
              toggleEvent={toggleEvent}
              globalStartIndex={
                iterationGlobalStartIndices.get(iter.iteration) ?? 0
              }
              repoPath={repoPath}
            />
          ))}

          {/* After standalones */}
          {grouped.standaloneEvents
            .filter((s) => s.index === "after")
            .map((standalone, i) => {
              const globalIndex = afterStartIndex + i;
              const isExpanded = expandedEvents.has(globalIndex);
              const colorClass = eventKindColor[standalone.event.kind] ?? "";
              return (
                <li
                  key={`after-${i}`}
                  className={`event ${standalone.event.kind}${isExpanded ? " expanded" : ""} ${colorClass} border-b border-border last:border-b-0`}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    className="event-btn flex items-baseline gap-2 w-full px-3 py-1 font-mono text-sm bg-transparent border-none text-inherit cursor-pointer text-left select-text"
                    onClick={handleSelectableClick(() =>
                      toggleEvent(globalIndex),
                    )}
                    onKeyDown={handleKeyDown(() => toggleEvent(globalIndex))}
                  >
                    <span className="event-emoji shrink-0">
                      {eventEmoji(standalone.event.kind)}
                    </span>
                    <span
                      className={`event-text flex-1 min-w-0 ${isExpanded ? "whitespace-pre-wrap break-words" : "overflow-hidden text-ellipsis whitespace-nowrap"}`}
                    >
                      {eventLabel(standalone.event, repoPath)}
                    </span>
                    <span className="event-time shrink-0 text-muted-foreground/60 text-xs">
                      {formatTime(standalone.event._ts)}
                    </span>
                  </div>
                  {isExpanded &&
                    standalone.event.kind === "git_sync_failed" &&
                    standalone.event.error && (
                      <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-card-inset border border-border rounded font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto">
                        {standalone.event.error}
                      </pre>
                    )}
                </li>
              );
            })}
        </ul>
      </div>
      {!autoScroll && (
        <button
          className="jump-bottom absolute bottom-2 left-1/2 -translate-x-1/2 px-4 py-1 text-xs bg-primary text-primary-foreground border-none rounded-xl cursor-pointer font-semibold shadow-md z-10 hover:bg-primary/90"
          onClick={jumpToBottom}
        >
          ↓ New events
        </button>
      )}
    </section>
  );
}
