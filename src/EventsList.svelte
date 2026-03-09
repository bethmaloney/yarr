<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { SessionEvent } from "./types";
  import { groupEventsByIteration } from "./iteration-groups";
  import { eventEmoji, eventLabel } from "./event-format";
  import IterationGroup from "./IterationGroup.svelte";

  let {
    events,
    isLive = false,
    repoPath,
  }: { events: SessionEvent[]; isLive?: boolean; repoPath?: string } = $props();

  let eventsContainer: HTMLElement | undefined = $state();
  let autoScroll = $state(true);
  let expandedEvents = new SvelteSet<number>();
  let expandedIterations = new SvelteSet<number>();

  let grouped = $derived(groupEventsByIteration(events));

  // Compute a mapping: for each iteration group, what is its starting global index in the flat events array.
  // standalone "before" events come first, then iteration groups in order, then standalone "after" events.
  let iterationGlobalStartIndices = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local computation, not reactive state
    const indices = new Map<number, number>();
    let offset = 0;
    // Count "before" standalone events
    for (const s of grouped.standaloneEvents) {
      if (s.index === "before") offset++;
    }
    for (const iter of grouped.iterations) {
      indices.set(iter.iteration, offset);
      offset += iter.events.length;
    }
    return indices;
  });

  let afterStartIndex = $derived.by(() => {
    let offset = 0;
    for (const s of grouped.standaloneEvents) {
      if (s.index === "before") offset++;
    }
    for (const iter of grouped.iterations) {
      offset += iter.events.length;
    }
    return offset;
  });

  let lastExpandedIter = $state(-1);

  $effect(() => {
    if (isLive && grouped.iterations.length > 0) {
      const lastIter =
        grouped.iterations[grouped.iterations.length - 1].iteration;
      if (lastIter !== lastExpandedIter) {
        lastExpandedIter = lastIter;
        expandedIterations.add(lastIter);
      }
    }
  });

  function toggleIteration(iteration: number) {
    if (expandedIterations.has(iteration)) expandedIterations.delete(iteration);
    else expandedIterations.add(iteration);
  }

  function toggleEvent(globalIndex: number) {
    if (expandedEvents.has(globalIndex)) expandedEvents.delete(globalIndex);
    else expandedEvents.add(globalIndex);
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
    if (!eventsContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = eventsContainer;
    autoScroll = scrollHeight - scrollTop - clientHeight < 40;
  }

  function jumpToBottom() {
    eventsContainer?.scrollTo({
      top: eventsContainer.scrollHeight,
      behavior: "smooth",
    });
    autoScroll = true;
  }

  $effect(() => {
    if (events.length > 0 && untrack(() => autoScroll)) {
      requestAnimationFrame(() => {
        eventsContainer?.scrollTo({
          top: eventsContainer.scrollHeight,
          behavior: "smooth",
        });
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
    <div
      class="events-scroll"
      bind:this={eventsContainer}
      onscroll={handleEventsScroll}
    >
      <ul>
        {#each grouped.standaloneEvents.filter((s) => s.index === "before") as standalone, i (i)}
          <li
            class="event {standalone.event.kind}"
            class:expanded={expandedEvents.has(i)}
          >
            <button class="event-btn" onclick={() => toggleEvent(i)}>
              <span class="event-emoji"
                >{eventEmoji(standalone.event.kind)}</span
              >
              <span class="event-text"
                >{eventLabel(standalone.event, repoPath)}</span
              >
              <span class="event-time">{formatTime(standalone.event._ts)}</span>
            </button>
            {#if expandedEvents.has(i) && standalone.event.kind === "git_sync_failed" && standalone.event.error}
              <pre class="tool-input-detail">{standalone.event.error}</pre>
            {/if}
          </li>
        {/each}

        {#each grouped.iterations as iter (iter.iteration)}
          <IterationGroup
            group={iter}
            expanded={expandedIterations.has(iter.iteration)}
            onToggle={() => toggleIteration(iter.iteration)}
            {formatTime}
            {expandedEvents}
            {toggleEvent}
            {repoPath}
            globalStartIndex={iterationGlobalStartIndices.get(iter.iteration) ??
              0}
          />
        {/each}

        {#each grouped.standaloneEvents.filter((s) => s.index === "after") as standalone, i (i)}
          {@const globalIndex = afterStartIndex + i}
          <li
            class="event {standalone.event.kind}"
            class:expanded={expandedEvents.has(globalIndex)}
          >
            <button class="event-btn" onclick={() => toggleEvent(globalIndex)}>
              <span class="event-emoji"
                >{eventEmoji(standalone.event.kind)}</span
              >
              <span class="event-text"
                >{eventLabel(standalone.event, repoPath)}</span
              >
              <span class="event-time">{formatTime(standalone.event._ts)}</span>
            </button>
            {#if expandedEvents.has(globalIndex) && standalone.event.kind === "git_sync_failed" && standalone.event.error}
              <pre class="tool-input-detail">{standalone.event.error}</pre>
            {/if}
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
