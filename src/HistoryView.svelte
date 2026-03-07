<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import type { RepoConfig } from "./repos";
  import type { SessionTrace } from "./types";

  let { repoId, repos, onBack, onSelectRun }: {
    repoId: string | undefined;
    repos: RepoConfig[];
    onBack: () => void;
    onSelectRun: (repoId: string, sessionId: string) => void;
  } = $props();

  let traces: SessionTrace[] = $state([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      traces = await invoke<SessionTrace[]>("list_traces", { repoId: repoId ?? null });
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  });

  function repoName(trace: SessionTrace): string {
    if (repoId) {
      const repo = repos.find((r) => r.id === repoId);
      return repo?.name ?? repoId;
    }
    // For global mode, derive from repo_path
    const parts = trace.repo_path.split("/");
    return parts[parts.length - 1] || trace.repo_path;
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
      case "completed": return { label: "Completed", cls: "badge-success" };
      case "failed": return { label: "Failed", cls: "badge-error" };
      case "max_iterations_reached": return { label: "Max Iters", cls: "badge-warn" };
      case "cancelled": return { label: "Cancelled", cls: "badge-cancel" };
      default: return { label: outcome, cls: "badge-default" };
    }
  }

  function planFilename(path: string | null): string {
    if (!path) return "\u2014";
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  }

  function traceRepoId(trace: SessionTrace): string {
    if (repoId) return repoId;
    return trace.repo_id ?? "unknown";
  }
</script>

<main>
  <button class="back-btn" type="button" onclick={onBack}>&larr; Back</button>

  <header>
    <h1>{repoId ? `History \u2014 ${repos.find(r => r.id === repoId)?.name ?? repoId}` : "History"}</h1>
  </header>

  {#if loading}
    <div class="empty-state"><p>Loading...</p></div>
  {:else if error}
    <div class="error"><pre>{error}</pre></div>
  {:else if traces.length === 0}
    <div class="empty-state">
      <p>No runs recorded yet.</p>
    </div>
  {:else}
    <div class="trace-list">
      {#each traces as trace}
        {@const badge = outcomeBadge(trace.outcome)}
        <button class="trace-row" onclick={() => onSelectRun(traceRepoId(trace), trace.session_id)}>
          <span class="trace-date">{formatDate(trace.start_time)}</span>
          {#if !repoId}
            <span class="trace-repo">{repoName(trace)}</span>
          {/if}
          <span class="trace-plan">{planFilename(trace.plan_file)}</span>
          <span class="trace-badge {badge.cls}">{badge.label}</span>
          <span class="trace-iters">{trace.total_iterations} iters</span>
          <span class="trace-cost">${trace.total_cost_usd.toFixed(4)}</span>
          <span class="trace-duration">{formatDuration(trace.start_time, trace.end_time)}</span>
        </button>
      {/each}
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 900px;
    margin: 0 auto;
    padding: 2rem;
  }

  .back-btn {
    padding: 0.4rem 1rem;
    font-size: 0.9rem;
    background: #333;
    color: #888;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 400;
  }

  .back-btn:hover {
    background: #444;
    color: #ccc;
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

  .trace-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .trace-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.6rem 0.75rem;
    background: #16213e;
    border: 1px solid #2a2a3e;
    border-radius: 6px;
    cursor: pointer;
    color: #e0e0e0;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.85rem;
    text-align: left;
    width: 100%;
  }

  .trace-row:hover {
    background: #1e2d50;
    border-color: #3a3a5e;
  }

  .trace-date {
    flex-shrink: 0;
    color: #888;
    min-width: 7rem;
  }

  .trace-repo {
    flex-shrink: 0;
    color: #4ecdc4;
    min-width: 6rem;
    max-width: 10rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trace-plan {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #aaa;
  }

  .trace-badge {
    flex-shrink: 0;
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

  .trace-iters, .trace-cost, .trace-duration {
    flex-shrink: 0;
    color: #888;
    min-width: 4rem;
    text-align: right;
  }
</style>
