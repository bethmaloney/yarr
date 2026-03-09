<script lang="ts">
  import type { RepoConfig } from "./repos";
  import type { RepoStatus, SessionTrace } from "./types";
  import { timeAgo } from "./time";
  import { sessionContextColor } from "./context-bar";

  let {
    repo,
    status,
    lastTrace,
    branchName,
    onclick,
  }: {
    repo: RepoConfig;
    status: RepoStatus;
    lastTrace?: SessionTrace;
    branchName?: string;
    onclick: () => void;
  } = $props();

  const repoFullPath =
    repo.type === "local"
      ? repo.path
      : `${repo.sshHost}:${repo.remotePath}`;

  const statusColors: Record<RepoStatus, string> = {
    idle: "#888",
    running: "#e8d44d",
    completed: "#34d399",
    failed: "#f87171",
    disconnected: "#f59e0b",
  };

  const statusLabels: Record<RepoStatus, string> = {
    idle: "Idle",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    disconnected: "Disconnected",
  };
</script>

<button
  class="repo-card"
  {onclick}
  aria-label="{repo.name} — {statusLabels[status]}"
>
  <div class="repo-info">
    <span class="repo-name">{repo.name}</span>
    <span class="repo-path">{repoFullPath}</span>
    {#if branchName}
      <span class="branch-label">{branchName}</span>
    {/if}
  </div>
  {#if lastTrace}
    <div class="last-run">
      {#if lastTrace.plan_file}
        <span class="plan-name">{lastTrace.plan_file.split(/[\\/]/).pop()}</span
        >
        <span class="separator"> · </span>
      {/if}
      <span>${(lastTrace.total_cost_usd ?? 0).toFixed(2)}</span>
      {#if lastTrace.context_window}
        {@const ctxPct = Math.round(((lastTrace.final_context_tokens ?? 0) / lastTrace.context_window) * 100)}
        <span class="separator"> · </span>
        <span style="color: {sessionContextColor(ctxPct)}">{ctxPct}%</span>
      {/if}
      <span class="separator"> · </span>
      <span>{timeAgo(lastTrace.start_time)}</span>
    </div>
  {/if}
  <div class="repo-status">
    <span
      class="status-dot"
      class:running={status === "running"}
      class:disconnected={status === "disconnected"}
      style="background: {statusColors[status]}"
    ></span>
    <span class="status-label" style="color: {statusColors[status]}"
      >{statusLabels[status]}</span
    >
  </div>
</button>

<style>
  .repo-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
    background: #16213e;
    border: 1px solid #333;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    color: inherit;
    width: 100%;
    transition:
      border-color 0.15s,
      background 0.15s;
  }

  .repo-card:hover {
    border-color: #e8d44d;
    background: #1a2744;
  }

  .repo-card:focus-visible {
    outline: 2px solid #e8d44d;
    outline-offset: 2px;
  }

  .repo-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .repo-name {
    font-size: 1.1rem;
    font-weight: 600;
    color: #e0e0e0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repo-path {
    font-size: 0.8rem;
    color: #888;
    font-family: "SF Mono", "Fira Code", monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .branch-label {
    font-size: 0.75rem;
    color: #6b7280;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .last-run {
    font-size: 0.8rem;
    color: #888;
  }

  .last-run .plan-name {
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .repo-status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.running {
    animation: pulse 1.5s ease-in-out infinite;
  }

  .status-label {
    font-size: 0.8rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-dot.disconnected {
    animation: blink 1s step-end infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
</style>
