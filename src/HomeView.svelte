<script lang="ts">
  import type { RepoConfig } from "./repos";
  import type {
    SessionState,
    SessionTrace,
    RepoStatus,
    BranchInfo,
  } from "./types";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import RepoCard from "./RepoCard.svelte";

  let {
    repos,
    sessions,
    latestTraces,
    branchInfos,
    addMode,
    sshHost,
    sshRemotePath,
    onSelectRepo,
    onAddRepo,
    onChooseLocal,
    onChooseSsh,
    onSshHostChange,
    onSshRemotePathChange,
    onAddSshRepo,
    onCancelAdd,
    onHistory,
  }: {
    repos: RepoConfig[];
    sessions: Map<string, SessionState>;
    latestTraces: Map<string, SessionTrace>;
    branchInfos: Map<string, BranchInfo>;
    addMode: null | "choosing" | "ssh-form";
    sshHost: string;
    sshRemotePath: string;
    onSelectRepo: (id: string) => void;
    onAddRepo: () => void;
    onChooseLocal: () => void;
    onChooseSsh: () => void;
    onSshHostChange: (value: string) => void;
    onSshRemotePathChange: (value: string) => void;
    onAddSshRepo: () => void;
    onCancelAdd: () => void;
    onHistory: () => void;
  } = $props();

  function deriveStatus(repoId: string): RepoStatus {
    const session = sessions.get(repoId);
    if (!session) return "idle";
    if (session.disconnected) return "disconnected";
    if (session.reconnecting) return "running";
    if (session.error) return "failed";
    if (session.running) return "running";
    if (session.trace) return "completed";
    return "idle";
  }
</script>

<main>
  <Breadcrumbs crumbs={[{ label: "Home" }]} />
  <header class="toolbar-header">
    <div class="title-group">
      <h1>Yarr</h1>
      <p class="subtitle">Claude Orchestrator</p>
    </div>
    <div class="toolbar-actions">
      <button class="secondary" onclick={onHistory}>History</button>
      {#if addMode === null}
        <button class="add-btn" onclick={onAddRepo}>+ Add repo</button>
      {:else if addMode === "choosing"}
        <button class="add-btn" onclick={onChooseLocal}>Local</button>
        <button class="add-btn" onclick={onChooseSsh}>SSH</button>
        <button class="secondary" onclick={onCancelAdd}>Cancel</button>
      {/if}
    </div>
  </header>

  {#if addMode === "ssh-form"}
    <div class="ssh-form">
      <label>
        SSH Host
        <input
          type="text"
          value={sshHost}
          oninput={(e) => onSshHostChange((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        Remote Path
        <input
          type="text"
          value={sshRemotePath}
          oninput={(e) =>
            onSshRemotePathChange((e.target as HTMLInputElement).value)}
        />
      </label>
      <div class="ssh-form-actions">
        <button class="add-btn" onclick={onAddSshRepo}>Add</button>
        <button class="secondary" onclick={onCancelAdd}>Cancel</button>
      </div>
    </div>
  {/if}

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
          lastTrace={latestTraces.get(repo.id)}
          branchName={branchInfos.get(repo.id)?.name}
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

  .toolbar-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
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

  .toolbar-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding-top: 0.5rem;
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

  .ssh-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding: 1rem;
    background: #16213e;
    border: 1px solid #333;
    border-radius: 8px;
  }

  .ssh-form label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: #888;
  }

  .ssh-form input {
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    background: #1a1a2e;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 4px;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .ssh-form input:focus {
    outline: none;
    border-color: #e8d44d;
  }

  .ssh-form-actions {
    display: flex;
    gap: 0.5rem;
  }
</style>
