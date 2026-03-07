<script lang="ts">
  import type { RepoConfig } from "./repos";
  import type { SessionState, RepoStatus } from "./types";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import RepoCard from "./RepoCard.svelte";

  let { repos, sessions, onSelectRepo, onAddRepo, onHistory }: {
    repos: RepoConfig[];
    sessions: Map<string, SessionState>;
    onSelectRepo: (id: string) => void;
    onAddRepo: () => void;
    onHistory: () => void;
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
  <Breadcrumbs crumbs={[{label: "Home"}]} />
  <header>
    <h1>Yarr</h1>
    <p class="subtitle">Claude Orchestrator</p>
  </header>

  <div class="toolbar">
    <button class="secondary" onclick={onHistory}>History</button>
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
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  button.secondary {
    padding: 0.6rem 1.5rem;
    font-size: 1rem;
    background: #333;
    color: #888;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 400;
  }

  button.secondary:hover {
    background: #444;
    color: #ccc;
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
