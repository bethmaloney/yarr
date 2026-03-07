<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import type { SessionEvent, SessionTrace } from "./types";
  import EventsList from "./EventsList.svelte";

  let {
    repoId,
    sessionId,
    onBack,
  }: {
    repoId: string;
    sessionId: string;
    onBack: () => void;
  } = $props();

  let trace: SessionTrace | null = $state(null);
  let events: SessionEvent[] = $state([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const [traceData, eventsData] = await Promise.all([
        invoke<SessionTrace>("get_trace", { repoId, sessionId }),
        invoke<SessionEvent[]>("get_trace_events", { repoId, sessionId }),
      ]);
      trace = traceData;
      events = eventsData;
    } catch (err) {
      error = String(err);
    } finally {
      loading = false;
    }
  });

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return (
      d.toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
      }) +
      " " +
      d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    );
  }

  function formatDuration(start: string, end: string | null): string {
    if (!end) return "\u2014";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const secs = Math.round(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ${secs % 60}s`;
  }

  function outcomeBadge(outcome: string): { label: string; cls: string } {
    switch (outcome) {
      case "completed":
        return { label: "Completed", cls: "badge-success" };
      case "failed":
        return { label: "Failed", cls: "badge-error" };
      case "max_iterations_reached":
        return { label: "Max Iters", cls: "badge-warn" };
      case "cancelled":
        return { label: "Cancelled", cls: "badge-cancel" };
      default:
        return { label: outcome, cls: "badge-default" };
    }
  }
</script>

<main>
  <Breadcrumbs
    crumbs={[
      { label: "Home" },
      { label: "History", onclick: onBack },
      { label: "Run " + sessionId },
    ]}
  />

  {#if loading}
    <div class="empty-state"><p>Loading...</p></div>
  {:else if error}
    <div class="error">
      <h1>Run Detail</h1>
      <pre>{error}</pre>
    </div>
  {:else if trace}
    {@const badge = outcomeBadge(trace.outcome)}
    <header>
      <h1>Run Detail</h1>
      <p class="run-date">{formatDate(trace.start_time)}</p>
    </header>

    <section class="summary">
      <h2>Summary</h2>
      <dl>
        <dt>Outcome</dt>
        <dd><span class="trace-badge {badge.cls}">{badge.label}</span></dd>
        {#if trace.failure_reason}
          <dt>Reason</dt>
          <dd class="failure-reason">{trace.failure_reason}</dd>
        {/if}
        <dt>Plan</dt>
        <dd>{trace.plan_file ?? "\u2014"}</dd>
        <dt>Iterations</dt>
        <dd>{trace.total_iterations}</dd>
        <dt>Cost</dt>
        <dd>${trace.total_cost_usd.toFixed(4)}</dd>
        <dt>Duration</dt>
        <dd>{formatDuration(trace.start_time, trace.end_time)}</dd>
        <dt>Tokens (in / out)</dt>
        <dd>
          {trace.total_input_tokens.toLocaleString()} / {trace.total_output_tokens.toLocaleString()}
        </dd>
        <dt>Session ID</dt>
        <dd class="mono">{trace.session_id}</dd>
      </dl>
    </section>

    <section class="events-section">
      <EventsList {events} />
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 700px;
    margin: 0 auto;
    padding: 2rem;
  }

  header {
    margin-top: 1rem;
    margin-bottom: 1.5rem;
  }

  h1 {
    font-size: 2rem;
    margin-bottom: 0;
    color: #e8d44d;
  }

  .run-date {
    margin-top: 0.25rem;
    color: #888;
    font-size: 0.85rem;
  }

  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: #888;
  }

  .error pre {
    background: #2d1b1b;
    color: #f87171;
    padding: 0.75rem;
    border-radius: 4px;
    overflow-x: auto;
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

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 1rem;
    margin-top: 0.75rem;
  }

  dt {
    color: #888;
    font-size: 0.85rem;
  }

  dd {
    margin: 0;
    font-size: 0.85rem;
  }

  .failure-reason {
    color: #f87171;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .mono {
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .trace-badge {
    padding: 0.1rem 0.5rem;
    border-radius: 10px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .badge-success {
    background: #064e3b;
    color: #34d399;
  }

  .badge-error {
    background: #7f1d1d;
    color: #f87171;
  }

  .badge-warn {
    background: #78350f;
    color: #fbbf24;
  }

  .badge-cancel {
    background: #374151;
    color: #9ca3af;
  }

  .badge-default {
    background: #333;
    color: #888;
  }

  .events-section {
    margin-top: 1.5rem;
  }
</style>
