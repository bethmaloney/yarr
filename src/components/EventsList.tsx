import { useState, useRef, useEffect, useMemo } from "react";
import type { SessionEvent } from "../types";
import { groupEventsByIteration } from "../iteration-groups";
import { eventEmoji, eventLabel } from "../event-format";
import { IterationGroupComponent } from "./IterationGroup";

interface EventsListProps {
  events: SessionEvent[];
  isLive?: boolean;
  repoPath?: string;
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

export function EventsList({
  events,
  isLive = false,
  repoPath,
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
        <h2 className="text-base text-[#aaa] uppercase tracking-wider border-b border-[#333] pb-1 m-0">
          Events
        </h2>
        <span className="event-count bg-[#333] text-[#aaa] text-xs px-2 py-0.5 rounded-[10px] font-mono">
          {events.length}
        </span>
      </div>
      <div
        ref={eventsContainerRef}
        className="events-scroll max-h-[350px] overflow-y-auto border border-[#2a2a3e] rounded-md bg-[#12122a] py-1"
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
                  className={`event ${standalone.event.kind}${isExpanded ? " expanded" : ""} ${colorClass} border-b border-[#1e1e38] last:border-b-0`}
                >
                  <button
                    className="event-btn flex items-baseline gap-2 w-full px-3 py-1 font-mono text-sm bg-transparent border-none text-inherit cursor-pointer text-left"
                    onClick={() => toggleEvent(i)}
                  >
                    <span className="event-emoji shrink-0">
                      {eventEmoji(standalone.event.kind)}
                    </span>
                    <span
                      className={`event-text flex-1 min-w-0 ${isExpanded ? "whitespace-pre-wrap break-words" : "overflow-hidden text-ellipsis whitespace-nowrap"}`}
                    >
                      {eventLabel(standalone.event, repoPath)}
                    </span>
                    <span className="event-time shrink-0 text-[#555] text-xs">
                      {formatTime(standalone.event._ts)}
                    </span>
                  </button>
                  {isExpanded &&
                    standalone.event.kind === "git_sync_failed" &&
                    standalone.event.error && (
                      <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-[#1a1a35] border border-[#2a2a3e] rounded font-mono text-xs text-[#9ca3af] whitespace-pre-wrap break-words overflow-x-auto">
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
                  className={`event ${standalone.event.kind}${isExpanded ? " expanded" : ""} ${colorClass} border-b border-[#1e1e38] last:border-b-0`}
                >
                  <button
                    className="event-btn flex items-baseline gap-2 w-full px-3 py-1 font-mono text-sm bg-transparent border-none text-inherit cursor-pointer text-left"
                    onClick={() => toggleEvent(globalIndex)}
                  >
                    <span className="event-emoji shrink-0">
                      {eventEmoji(standalone.event.kind)}
                    </span>
                    <span
                      className={`event-text flex-1 min-w-0 ${isExpanded ? "whitespace-pre-wrap break-words" : "overflow-hidden text-ellipsis whitespace-nowrap"}`}
                    >
                      {eventLabel(standalone.event, repoPath)}
                    </span>
                    <span className="event-time shrink-0 text-[#555] text-xs">
                      {formatTime(standalone.event._ts)}
                    </span>
                  </button>
                  {isExpanded &&
                    standalone.event.kind === "git_sync_failed" &&
                    standalone.event.error && (
                      <pre className="tool-input-detail mx-3 mb-2 ml-9 p-2 bg-[#1a1a35] border border-[#2a2a3e] rounded font-mono text-xs text-[#9ca3af] whitespace-pre-wrap break-words overflow-x-auto">
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
          className="jump-bottom absolute bottom-2 left-1/2 -translate-x-1/2 px-4 py-1 text-xs bg-[#e8d44d] text-[#1a1a2e] border-none rounded-xl cursor-pointer font-semibold shadow-md z-10 hover:bg-[#f0e060]"
          onClick={jumpToBottom}
        >
          ↓ New events
        </button>
      )}
    </section>
  );
}
