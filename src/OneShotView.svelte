<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import type { RepoConfig } from "./repos";
  import type { SessionState } from "./types";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import EventsList from "./EventsList.svelte";
  import {
    getPhaseFromEvents,
    phaseLabel,
    buildOneShotArgs,
  } from "./oneshot-helpers";

  let {
    repo,
    session,
    onBack,
    onHome,
  }: {
    repo: RepoConfig;
    session: SessionState;
    onBack: () => void;
    onHome: () => void;
  } = $props();

  let title = $state("");
  let prompt = $state("");
  let model = $state(repo.model);
  let mergeStrategy = $state("merge_to_main");

  $effect(() => {
    model = repo.model;
  });

  let phase = $derived(getPhaseFromEvents(session.events));

  function runOneShot() {
    invoke(
      "run_oneshot",
      buildOneShotArgs(repo, title, prompt, model, mergeStrategy),
    ).catch((e) => {
      console.error("Failed to start 1-shot:", e);
    });
  }

  async function stopSession() {
    try {
      await invoke("stop_session", { repoId: repo.id });
    } catch (e) {
      console.error("Failed to stop session:", e);
    }
  }
</script>

<main>
  <Breadcrumbs
    crumbs={[
      { label: "Home", onclick: onHome },
      { label: repo.name, onclick: onBack },
      { label: "1-Shot" },
    ]}
  />

  <header>
    <h1>{repo.name} — 1-Shot</h1>
    <p class="repo-path">
      {repo.type === "local"
        ? repo.path
        : `${repo.sshHost}:${repo.remotePath}`}
    </p>
  </header>

  {#if !session.running}
    <section class="form-section">
      <label>
        Title
        <input type="text" bind:value={title} />
      </label>
      <label>
        Prompt
        <textarea bind:value={prompt}></textarea>
      </label>
      <label>
        Model
        <input type="text" bind:value={model} />
      </label>
      <label>
        Merge Strategy
        <div class="radio-group">
          <label>
            <input
              type="radio"
              bind:group={mergeStrategy}
              value="merge_to_main"
            />
            Merge to main
          </label>
          <label>
            <input type="radio" bind:group={mergeStrategy} value="branch" />
            Create branch
          </label>
        </div>
      </label>
    </section>
  {/if}

  <div class="actions">
    <button
      type="button"
      disabled={session.running || !title.trim() || !prompt.trim()}
      onclick={runOneShot}
    >
      {session.running ? "Running..." : "Run"}
    </button>
    {#if session.running}
      <button type="button" onclick={stopSession} class="danger">Stop</button>
    {/if}
  </div>

  {#if phase !== "idle"}
    <div
      class="phase-indicator"
      class:failed={phase === "failed"}
      class:complete={phase === "complete"}
    >
      {phaseLabel(phase)}
    </div>
  {/if}

  <EventsList events={session.events} isLive={session.running} />

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
        {#if session.trace.failure_reason}
          <dt>Reason</dt>
          <dd class="failure-reason">{session.trace.failure_reason}</dd>
        {/if}
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

  .form-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
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

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: #888;
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

  textarea {
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    background: #16213e;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 4px;
    font-family: "SF Mono", "Fira Code", monospace;
    min-height: 6rem;
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
  }

  textarea:disabled {
    opacity: 0.5;
  }

  textarea:focus {
    outline: none;
    border-color: #e8d44d;
  }

  .radio-group {
    display: flex;
    gap: 1.5rem;
    margin-top: 0.25rem;
  }

  .radio-group label {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    color: #e0e0e0;
    font-size: 0.9rem;
  }

  .radio-group input[type="radio"] {
    accent-color: #e8d44d;
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

  button.danger {
    background: #dc2626;
    color: #fff;
  }

  button.danger:hover:not(:disabled) {
    background: #ef4444;
  }

  .phase-indicator {
    margin-top: 1rem;
    padding: 0.75rem;
    background: #16213e;
    border: 1px solid #333;
    border-radius: 4px;
    color: #e8d44d;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.9rem;
  }

  .phase-indicator.failed {
    color: #f87171;
    border-color: #f87171;
  }

  .phase-indicator.complete {
    color: #34d399;
    border-color: #34d399;
  }

  .failure-reason {
    color: #f87171;
    white-space: pre-wrap;
    word-break: break-word;
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
