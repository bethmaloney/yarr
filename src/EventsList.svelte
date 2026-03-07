<script lang="ts">
  import { untrack } from "svelte";

  type SessionEvent = {
    kind: string;
    session_id?: string;
    iteration?: number;
    tool_name?: string;
    text?: string;
    result?: Record<string, unknown>;
    outcome?: string;
    _ts?: number;
  };

  let { events }: { events: SessionEvent[] } = $props();

  let eventsContainer: HTMLElement | undefined = $state();
  let autoScroll = $state(true);
  let expandedEvents = $state<Set<number>>(new Set());

  function eventEmoji(kind: string): string {
    switch (kind) {
      case "session_started": return "\u{1F680}";
      case "iteration_started": return "\u{1F504}";
      case "tool_use": return "\u{1F527}";
      case "assistant_text": return "\u{1F4AC}";
      case "iteration_complete": return "\u2705";
      case "session_complete": return "\u{1F3C1}";
      default: return "\u{1F4CB}";
    }
  }

  function eventLabel(ev: SessionEvent): string {
    switch (ev.kind) {
      case "session_started":
        return `Session started: ${ev.session_id}`;
      case "iteration_started":
        return `Iteration ${ev.iteration} started`;
      case "tool_use":
        return `[${ev.iteration}] tool: ${ev.tool_name}`;
      case "assistant_text":
        return `[${ev.iteration}] ${ev.text}`;
      case "iteration_complete":
        return `Iteration ${ev.iteration} complete (cost: $${(ev.result as any)?.total_cost_usd?.toFixed(4) ?? "?"})`;
      case "session_complete":
        return `Session complete: ${ev.outcome}`;
      default:
        return JSON.stringify(ev);
    }
  }

  function formatTime(ts?: number): string {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function handleEventsScroll() {
    if (!eventsContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = eventsContainer;
    autoScroll = scrollHeight - scrollTop - clientHeight < 40;
  }

  function jumpToBottom() {
    eventsContainer?.scrollTo({ top: eventsContainer.scrollHeight, behavior: "smooth" });
    autoScroll = true;
  }

  $effect(() => {
    events.length;
    if (untrack(() => autoScroll)) {
      requestAnimationFrame(() => {
        eventsContainer?.scrollTo({ top: eventsContainer.scrollHeight, behavior: "smooth" });
      });
    }
  });
</script>

{#if events.length > 0}
<section class="events">
  <div class="events-header">
    <h2>Events</h2>
    <span class="event-count">{events.length}</span>
  </div>
  <div class="events-scroll" bind:this={eventsContainer} onscroll={handleEventsScroll}>
    <ul>
      {#each events as ev, i}
        <li class="event {ev.kind}" class:expanded={expandedEvents.has(i)}>
          <button
            class="event-btn"
            onclick={() => {
              const next = new Set(expandedEvents);
              if (next.has(i)) next.delete(i);
              else next.add(i);
              expandedEvents = next;
            }}
          >
            <span class="event-emoji">{eventEmoji(ev.kind)}</span>
            <span class="event-text">{eventLabel(ev)}</span>
            <span class="event-time">{formatTime(ev._ts)}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
  {#if !autoScroll}
    <button class="jump-bottom" onclick={jumpToBottom}>↓ New events</button>
  {/if}
</section>
{/if}

<style>
  h2 {
    font-size: 1rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid #333;
    padding-bottom: 0.3rem;
    margin: 0;
  }

  .events-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .event-count {
    background: #333;
    color: #aaa;
    font-size: 0.75rem;
    padding: 0.1rem 0.5rem;
    border-radius: 10px;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .events-scroll {
    max-height: 350px;
    overflow-y: auto;
    border: 1px solid #2a2a3e;
    border-radius: 6px;
    background: #12122a;
    padding: 0.25rem 0;
  }

  .events-scroll::-webkit-scrollbar {
    width: 6px;
  }

  .events-scroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .events-scroll::-webkit-scrollbar-thumb {
    background: #444;
    border-radius: 3px;
  }

  .events {
    position: relative;
  }

  .jump-bottom {
    position: absolute;
    bottom: 0.5rem;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.3rem 1rem;
    font-size: 0.75rem;
    background: #e8d44d;
    color: #1a1a2e;
    border: none;
    border-radius: 12px;
    cursor: pointer;
    font-weight: 600;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    z-index: 1;
  }

  .jump-bottom:hover {
    background: #f0e060;
  }

  ul {
    list-style: none;
    padding: 0;
    margin: 0;
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
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
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
</style>
