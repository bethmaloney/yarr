<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";

  type SessionEvent = {
    kind: string;
    session_id?: string;
    iteration?: number;
    tool_name?: string;
    text?: string;
    result?: Record<string, unknown>;
    outcome?: string;
  };

  type SessionTrace = {
    session_id: string;
    outcome: string;
    total_iterations: number;
    total_cost_usd: number;
  };

  let events = $state<SessionEvent[]>([]);
  let trace = $state<SessionTrace | null>(null);
  let running = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    const unlisten = listen<SessionEvent>("session-event", (e) => {
      events.push(e.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  });

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
</script>

<main>
  <h1>Yarr</h1>
  <p class="subtitle">Claude Orchestrator</p>

  <button onclick={runMockSession} disabled={running}>
    {running ? "Running..." : "Run Mock Session"}
  </button>

  {#if events.length > 0}
    <section class="events">
      <h2>Events</h2>
      <ul>
        {#each events as ev}
          <li class="event {ev.kind}">{eventLabel(ev)}</li>
        {/each}
      </ul>
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

  button {
    margin-top: 1.5rem;
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
  }

  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .event {
    padding: 0.3rem 0;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.85rem;
    border-bottom: 1px solid #222;
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
