<script lang="ts">
  import type { RepoConfig } from "./repos";

  let { repo, status, onclick }: {
    repo: RepoConfig;
    status: "idle" | "running" | "completed" | "failed";
    onclick: () => void;
  } = $props();

  const statusColors: Record<typeof status, string> = {
    idle: "#888",
    running: "#e8d44d",
    completed: "#34d399",
    failed: "#f87171",
  };

  const statusLabels: Record<typeof status, string> = {
    idle: "Idle",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
  };
</script>

<button class="repo-card" onclick={onclick} aria-label="{repo.name} — {statusLabels[status]}">
  <div class="repo-info">
    <span class="repo-name">{repo.name}</span>
    <span class="repo-path">{repo.path}</span>
  </div>
  <div class="repo-status">
    <span
      class="status-dot"
      class:running={status === "running"}
      style="background: {statusColors[status]}"
    ></span>
    <span class="status-label" style="color: {statusColors[status]}">{statusLabels[status]}</span>
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
    transition: border-color 0.15s, background 0.15s;
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

  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
</style>
