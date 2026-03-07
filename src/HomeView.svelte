<script lang="ts">
  import type { RepoConfig } from "./repos";
  import RepoCard from "./RepoCard.svelte";

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

  type SessionState = {
    running: boolean;
    events: SessionEvent[];
    trace: SessionTrace | null;
    error: string | null;
  };

  type RepoStatus = "idle" | "running" | "completed" | "failed";

  let { repos, sessions, onSelectRepo, onAddRepo }: {
    repos: RepoConfig[];
    sessions: Map<string, SessionState>;
    onSelectRepo: (id: string) => void;
    onAddRepo: () => void;
  } = $props();

  function deriveStatus(repoId: string): RepoStatus {
    const session = sessions.get(repoId);
    if (!session) return "idle";
    if (session.error) return "failed";
    if (session.running) return "running";
    if (session.trace) return "completed";
    return "idle";
  }
</script>

<main>
  <header>
    <h1>Yarr</h1>
    <p class="subtitle">Claude Orchestrator</p>
  </header>

  <div class="toolbar">
    <button class="add-btn" onclick={onAddRepo}>+ Add repo</button>
  </div>

  {#if repos.length === 0}
    <div class="empty-state">
      <p>No repos configured yet.</p>
      <p class="empty-hint">Click "Add repo" to get started.</p>
    </div>
  {:else}
    <div class="repo-grid">
      {#each repos as repo (repo.id)}
        <RepoCard
          {repo}
          status={deriveStatus(repo.id)}
          onclick={() => onSelectRepo(repo.id)}
        />
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

  header {
    margin-bottom: 1.5rem;
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

  .toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 1rem;
  }

  .add-btn {
    padding: 0.6rem 1.5rem;
    font-size: 1rem;
    background: #e8d44d;
    color: #1a1a2e;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 600;
  }

  .add-btn:hover {
    background: #f0e060;
  }

  .repo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }

  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: #888;
  }

  .empty-state p {
    margin: 0.25rem 0;
  }

  .empty-hint {
    font-size: 0.85rem;
    color: #666;
  }
</style>
