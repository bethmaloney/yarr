<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { open } from "@tauri-apps/plugin-dialog";
  import { onMount } from "svelte";
  import { loadRecents, saveRecent } from "./recents";

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

  type SessionTrace = {
    session_id: string;
    outcome: string;
    total_iterations: number;
    total_cost_usd: number;
  };

  let repoPath = $state("");
  let planFile = $state("");
  let events = $state<SessionEvent[]>([]);
  let trace = $state<SessionTrace | null>(null);
  let running = $state(false);
  let error = $state<string | null>(null);
  let recentRepoPaths = $state<string[]>([]);
  let recentPromptFiles = $state<string[]>([]);
  let eventsContainer: HTMLElement | undefined = $state();
  let autoScroll = $state(true);
  let expandedEvents = $state<Set<number>>(new Set());

  onMount(() => {
    const unlisten = listen<SessionEvent>("session-event", (e) => {
      e.payload._ts = Date.now();
      events.push(e.payload);
      if (autoScroll) {
        requestAnimationFrame(() => {
          eventsContainer?.scrollTo({ top: eventsContainer.scrollHeight, behavior: "smooth" });
        });
      }
    });

    loadRecents().then((r) => {
      recentRepoPaths = r.repoPaths;
      recentPromptFiles = r.promptFiles;
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  });

  async function browseRepo() {
    try {
      const result = await open({ directory: true, title: "Select repository" });
      if (result !== null) {
        repoPath = result;
      }
    } catch (e) {
      error = String(e);
    }
  }

  async function browsePrompt() {
    try {
      const result = await open({
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "All", extensions: ["*"] },
        ],
        title: "Select prompt file",
      });
      if (result !== null) {
        planFile = result;
      }
    } catch (e) {
      error = String(e);
    }
  }

  async function runSession() {
    if (!repoPath || !planFile) return;
    events = [];
    trace = null;
    error = null;
    running = true;

    try {
      trace = await invoke<SessionTrace>("run_session", {
        repoPath: repoPath,
        planFile: planFile,
      });
      await saveRecent("repoPaths", repoPath);
      await saveRecent("promptFiles", planFile);
      const recents = await loadRecents();
      recentRepoPaths = recents.repoPaths;
      recentPromptFiles = recents.promptFiles;
    } catch (e) {
      error = String(e);
    } finally {
      running = false;
    }
  }

  async function runMockSession() {
    events = [];
    trace = null;
    error = null;
    running = true;

    try {
      trace = await invoke<SessionTrace>("run_mock_session");
    } catch (e) {
      error = String(e);
    } finally {
      running = false;
    }
  }

  async function stopSession() {
    try {
      await invoke("stop_session");
    } catch (e) {
      error = String(e);
    }
  }

  function eventEmoji(kind: string): string {
    switch (kind) {
      case "session_started": return "🚀";
      case "iteration_started": return "🔄";
      case "tool_use": return "🔧";
      case "assistant_text": return "💬";
      case "iteration_complete": return "✅";
      case "session_complete": return "🏁";
      default: return "📋";
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
</script>

<main>
  <h1>Yarr</h1>
  <p class="subtitle">Claude Orchestrator</p>

  <form onsubmit={e => { e.preventDefault(); runSession(); }} class="session-form">
    <label>
      Repo path
      <div class="input-row">
        {#if recentRepoPaths.length > 0}
          <select
            disabled={running}
            onchange={(e) => {
              const val = (e.target as HTMLSelectElement).value;
              if (val) repoPath = val;
              (e.target as HTMLSelectElement).value = "";
            }}
          >
            <option value="">Recents</option>
            {#each recentRepoPaths as p}
              <option value={p}>{p}</option>
            {/each}
          </select>
        {/if}
        <input type="text" bind:value={repoPath} placeholder="/home/user/repos/my-project" disabled={running} />
        <button type="button" class="secondary" onclick={browseRepo} disabled={running}>Browse</button>
      </div>
    </label>
    <label>
      Plan file
      <div class="input-row">
        {#if recentPromptFiles.length > 0}
          <select
            disabled={running}
            onchange={(e) => {
              const val = (e.target as HTMLSelectElement).value;
              if (val) planFile = val;
              (e.target as HTMLSelectElement).value = "";
            }}
          >
            <option value="">Recents</option>
            {#each recentPromptFiles as p}
              <option value={p}>{p}</option>
            {/each}
          </select>
        {/if}
        <input type="text" bind:value={planFile} placeholder="docs/plans/my-feature-design.md" disabled={running} />
        <button type="button" class="secondary" onclick={browsePrompt} disabled={running}>Browse</button>
      </div>
    </label>
    <div class="actions">
      <button type="submit" disabled={running || !repoPath || !planFile}>
        {running ? "Running..." : "Run"}
      </button>
      {#if running}
        <button type="button" onclick={stopSession} class="danger">
          Stop
        </button>
      {:else}
        <button type="button" onclick={runMockSession} disabled={running} class="secondary">
          Mock
        </button>
      {/if}
    </div>
  </form>

  {#if events.length > 0}
    <section class="events">
      <div class="events-header">
        <h2>Events</h2>
        <span class="event-count">{events.length}</span>
      </div>
      <div class="events-scroll" bind:this={eventsContainer} onscroll={handleEventsScroll}>
        <ul>
          {#each events as ev, i}
            <li
              class="event {ev.kind}"
              class:expanded={expandedEvents.has(i)}
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
            </li>
          {/each}
        </ul>
      </div>
      {#if !autoScroll}
        <button class="jump-bottom" onclick={jumpToBottom}>↓ New events</button>
      {/if}
    </section>
  {/if}

  {#if error}
    <section class="error">
      <h2>Error</h2>
      <pre>{error}</pre>
    </section>
  {/if}

  {#if trace}
    <section class="trace">
      <h2>Result</h2>
      <dl>
        <dt>Outcome</dt>
        <dd>{trace.outcome}</dd>
        <dt>Iterations</dt>
        <dd>{trace.total_iterations}</dd>
        <dt>Total Cost</dt>
        <dd>${trace.total_cost_usd.toFixed(4)}</dd>
        <dt>Session ID</dt>
        <dd>{trace.session_id}</dd>
      </dl>
    </section>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
  }

  main {
    max-width: 700px;
    margin: 0 auto;
    padding: 2rem;
  }

  h1 {
    font-size: 2rem;
    margin-bottom: 0;
    color: #e8d44d;
  }

  .subtitle {
    margin-top: 0.25rem;
    color: #888;
    font-size: 0.9rem;
  }

  .session-form {
    margin-top: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: #888;
  }

  .input-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .input-row input {
    flex: 1;
  }

  select {
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    background: #16213e;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 4px;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  select:disabled {
    opacity: 0.5;
  }

  input {
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    background: #16213e;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 4px;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  input:disabled {
    opacity: 0.5;
  }

  input:focus {
    outline: none;
    border-color: #e8d44d;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  button {
    padding: 0.6rem 1.5rem;
    font-size: 1rem;
    background: #e8d44d;
    color: #1a1a2e;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 600;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button:hover:not(:disabled) {
    background: #f0e060;
  }

  button.secondary {
    background: #333;
    color: #888;
    font-weight: 400;
  }

  button.secondary:hover:not(:disabled) {
    background: #444;
    color: #ccc;
  }

  button.danger {
    background: #dc2626;
    color: #fff;
  }

  button.danger:hover:not(:disabled) {
    background: #ef4444;
  }

  section {
    margin-top: 1.5rem;
  }

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
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.85rem;
    border-bottom: 1px solid #1e1e38;
    cursor: pointer;
  }

  .event:last-child {
    border-bottom: none;
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

  .event.expanded .event-text {
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

  .error pre {
    background: #2d1b1b;
    color: #f87171;
    padding: 0.75rem;
    border-radius: 4px;
    overflow-x: auto;
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 1rem;
  }

  dt {
    color: #888;
    font-size: 0.85rem;
  }

  dd {
    margin: 0;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.85rem;
  }
</style>
