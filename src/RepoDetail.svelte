<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import { onMount } from "svelte";
  import { loadRecents } from "./recents";
  import type { RepoConfig } from "./repos";
  import EventsList from "./EventsList.svelte";

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

  let { repo, session, onBack, onRun, onMockRun, onUpdateRepo, onHistory }: {
    repo: RepoConfig;
    session: { running: boolean; events: SessionEvent[]; trace: SessionTrace | null; error: string | null };
    onBack: () => void;
    onRun: (planFile: string) => void;
    onMockRun: () => void;
    onUpdateRepo: (repo: RepoConfig) => void;
    onHistory: () => void;
  } = $props();

  // Local settings state, initialized from repo prop
  let model = $state(repo.model);
  let maxIterations = $state(repo.maxIterations);
  let completionSignal = $state(repo.completionSignal);

  // Re-sync local state when repo prop changes (e.g., navigating to a different repo)
  $effect(() => {
    model = repo.model;
    maxIterations = repo.maxIterations;
    completionSignal = repo.completionSignal;
  });

  let planFile = $state("");
  let recentPromptFiles = $state<string[]>([]);

  onMount(() => {
    loadRecents().then((r) => {
      recentPromptFiles = r.promptFiles;
    });
  });

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
      // silently fail
    }
  }

  function saveSettings() {
    onUpdateRepo({
      ...repo,
      model,
      maxIterations,
      completionSignal,
    });
  }

  async function stopSession() {
    try {
      await invoke("stop_session");
    } catch (e) {
      console.error("Failed to stop session:", e);
    }
  }
</script>

<main>
  <button class="back-btn" type="button" onclick={onBack}>&larr; Back</button>
  <button class="back-btn" type="button" onclick={onHistory}>History</button>

  <header>
    <h1>{repo.name}</h1>
    <p class="repo-path">{repo.path}</p>
  </header>

  <section class="settings">
    <h2>Settings</h2>
    <div class="settings-form">
      <label>
        Model
        <input type="text" bind:value={model} disabled={session.running} />
      </label>
      <label>
        Max Iterations
        <input type="number" bind:value={maxIterations} min="1" disabled={session.running} />
      </label>
      <label>
        Completion Signal
        <input type="text" bind:value={completionSignal} disabled={session.running} />
      </label>
      <div class="settings-actions">
        <button type="button" class="secondary" onclick={saveSettings} disabled={session.running}>Save</button>
      </div>
    </div>
  </section>

  <section class="plan-section">
    <h2>Plan</h2>
    <label>
      Prompt file
      <div class="input-row">
        {#if recentPromptFiles.length > 0}
          <select
            disabled={session.running}
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
        <input type="text" bind:value={planFile} placeholder="docs/plans/my-feature-design.md" disabled={session.running} />
        <button type="button" class="secondary" onclick={browsePrompt} disabled={session.running}>Browse</button>
      </div>
    </label>
  </section>

  <div class="actions">
    <button type="button" disabled={session.running || !planFile} onclick={() => onRun(planFile)}>
      {session.running ? "Running..." : "Run"}
    </button>
    {#if session.running}
      <button type="button" onclick={stopSession} class="danger">
        Stop
      </button>
    {:else}
      <button type="button" onclick={onMockRun} disabled={session.running} class="secondary">
        Mock
      </button>
    {/if}
  </div>

  <EventsList events={session.events} />

  {#if session.error}
    <section class="error">
      <h2>Error</h2>
      <pre>{session.error}</pre>
    </section>
  {/if}

  {#if session.trace}
    <section class="trace">
      <h2>Result</h2>
      <dl>
        <dt>Outcome</dt>
        <dd>{session.trace.outcome}</dd>
        <dt>Iterations</dt>
        <dd>{session.trace.total_iterations}</dd>
        <dt>Total Cost</dt>
        <dd>${session.trace.total_cost_usd.toFixed(4)}</dd>
        <dt>Session ID</dt>
        <dd>{session.trace.session_id}</dd>
      </dl>
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 700px;
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

  .repo-path {
    margin-top: 0.25rem;
    color: #888;
    font-size: 0.85rem;
    font-family: "SF Mono", "Fira Code", monospace;
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

  .settings-form {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .settings-actions {
    display: flex;
    gap: 0.5rem;
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
    margin-top: 1.5rem;
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
    margin-top: 0.75rem;
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
