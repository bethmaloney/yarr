<script lang="ts">
  import type { IterationGroup } from "./iteration-groups";
  import { formatTokenCount, contextBarColor } from "./context-bar";
  import { eventEmoji, eventLabel } from "./event-format";

  let {
    group,
    expanded,
    onToggle,
    formatTime,
    expandedEvents,
    toggleEvent,
    globalStartIndex,
  }: {
    group: IterationGroup;
    expanded: boolean;
    onToggle: () => void;
    formatTime: (ts?: number) => string;
    expandedEvents: Set<number>;
    toggleEvent: (globalIndex: number) => void;
    globalStartIndex: number;
  } = $props();

  function formatDuration(ms: number): string {
    const secs = Math.round(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ${secs % 60}s`;
  }
</script>

<div class="iteration-group" class:expanded>
  <button class="iteration-header" onclick={onToggle}>
    <span class="iteration-toggle">{expanded ? "\u25BC" : "\u25B6"}</span>
    <span class="iteration-title">Iteration {group.iteration}</span>
    <span class="iteration-stats">
      — {group.events.length} events &middot; ${group.cost.toFixed(4)}
      {#if group.inputTokens || group.outputTokens}
        &middot; {group.inputTokens.toLocaleString()} in / {group.outputTokens.toLocaleString()}
        out
      {/if}
      {#if group.startTs && group.endTs}
        &middot; {formatDuration(group.endTs - group.startTs)}
      {/if}
    </span>
  </button>
  {#if group.contextWindow > 0}
    {@const percentage = Math.round(
      (group.inputTokens / group.contextWindow) * 100,
    )}
    <div class="context-bar">
      <div class="context-bar-track">
        <div
          class="context-bar-fill"
          style="width: {Math.min(
            percentage,
            100,
          )}%; background: {contextBarColor(percentage)}"
        ></div>
      </div>
      <span class="context-bar-label">
        {formatTokenCount(group.inputTokens)} / {formatTokenCount(
          group.contextWindow,
        )} ({percentage}%)
      </span>
    </div>
  {/if}
  {#if expanded}
    <ul class="iteration-events">
      {#each group.events as ev, i (i)}
        {@const globalIndex = globalStartIndex + i}
        <li
          class="event {ev.kind}"
          class:expanded={expandedEvents.has(globalIndex)}
        >
          <button class="event-btn" onclick={() => toggleEvent(globalIndex)}>
            <span class="event-emoji">{eventEmoji(ev.kind)}</span>
            <span class="event-text">{eventLabel(ev)}</span>
            <span class="event-time">{formatTime(ev._ts)}</span>
          </button>
          {#if expandedEvents.has(globalIndex) && ev.kind === "tool_use" && ev.tool_input}
            <pre class="tool-input-detail">{JSON.stringify(
                ev.tool_input,
                null,
                2,
              )}</pre>
          {/if}
          {#if expandedEvents.has(globalIndex) && ev.kind === "check_failed" && ev.output}
            <pre class="tool-input-detail">{ev.output}</pre>
          {/if}
          {#if expandedEvents.has(globalIndex) && ev.kind === "git_sync_failed" && ev.error}
            <pre class="tool-input-detail">{ev.error}</pre>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .iteration-group {
    border-bottom: 1px solid #1e1e38;
  }

  .iteration-group:last-child {
    border-bottom: none;
  }

  .iteration-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: #12122a;
    border: none;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .iteration-header:hover {
    background: #1a1a35;
  }

  .iteration-toggle {
    color: #666;
    font-size: 0.7rem;
    flex-shrink: 0;
    width: 1rem;
  }

  .iteration-title {
    font-weight: bold;
    font-size: 0.9rem;
    color: #ccc;
    flex-shrink: 0;
  }

  .iteration-stats {
    color: #888;
    font-size: 0.75rem;
    margin-left: 0.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .iteration-events {
    list-style: none;
    padding: 0;
    margin: 0;
    padding-left: 1rem;
  }

  .event {
    border-bottom: 1px solid #1e1e38;
  }

  .event:last-child {
    border-bottom: none;
  }

  .event-btn {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    width: 100%;
    padding: 0.35rem 0.75rem;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.85rem;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  .event-emoji {
    flex-shrink: 0;
    font-size: 0.9rem;
    font-family:
      "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
  }

  .event-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .event.expanded .event-btn .event-text {
    white-space: pre-wrap;
    overflow: visible;
    word-break: break-word;
  }

  .event-time {
    flex-shrink: 0;
    color: #555;
    font-size: 0.75rem;
  }

  .event.session_started {
    color: #4ecdc4;
  }

  .event.iteration_started {
    color: #888;
  }

  .event.tool_use {
    color: #a78bfa;
  }

  .event.assistant_text {
    color: #e0e0e0;
  }

  .event.iteration_complete {
    color: #34d399;
  }

  .event.session_complete {
    color: #e8d44d;
    font-weight: 600;
  }

  .event.check_started {
    color: #60a5fa;
  }

  .event.check_passed {
    color: #34d399;
  }

  .event.check_failed {
    color: #f87171;
  }

  .event.check_fix_started {
    color: #fbbf24;
  }

  .event.check_fix_complete {
    color: #a78bfa;
  }

  .event.git_sync_started {
    color: #888;
  }

  .event.git_sync_push_succeeded {
    color: #34d399;
  }

  .event.git_sync_conflict {
    color: #f59e0b;
  }

  .event.git_sync_conflict_resolve_started {
    color: #a78bfa;
  }

  .event.git_sync_conflict_resolve_complete {
    color: #34d399;
  }

  .event.git_sync_failed {
    color: #ef4444;
  }

  .context-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.15rem 0.75rem 0.35rem 2.25rem;
    /* 2.25rem left padding = toggle width (1rem) + gap (0.5rem) + button left pad (0.75rem) */
  }

  .context-bar-track {
    flex: 1;
    height: 4px;
    background: #1e1e38;
    border-radius: 2px;
    overflow: hidden;
  }

  .context-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .context-bar-label {
    font-size: 0.65rem;
    color: #666;
    font-family: "SF Mono", "Fira Code", monospace;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .tool-input-detail {
    margin: 0 0.75rem 0.5rem 2.2rem;
    padding: 0.5rem 0.75rem;
    background: #1a1a35;
    border: 1px solid #2a2a3e;
    border-radius: 4px;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.78rem;
    color: #9ca3af;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }
</style>
