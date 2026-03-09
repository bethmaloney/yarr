<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import type { RepoConfig } from "./repos";
  import type { Check, SessionState } from "./types";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import EventsList from "./EventsList.svelte";
  import { sessionContextColor } from "./context-bar";

  let {
    repo,
    session,
    onBack,
    onRun,
    onMockRun,
    onUpdateRepo,
    onReconnect,
    onOneShot,
  }: {
    repo: RepoConfig;
    session: SessionState;
    onBack: () => void;
    onRun: (planFile: string) => void;
    onMockRun: () => void;
    onUpdateRepo: (repo: RepoConfig) => Promise<void>;
    onReconnect: () => void;
    onOneShot: () => void;
  } = $props();

  // Local settings state, initialized from repo prop
  let editingName = $state(false);
  let nameInput = $state(repo.name);
  let model = $state(repo.model);
  let maxIterations = $state(repo.maxIterations);
  let completionSignal = $state(repo.completionSignal);
  let envVars: { key: string; value: string }[] = $state(
    Object.entries(repo.envVars ?? {}).map(([key, value]) => ({ key, value })),
  );
  let checks: Check[] = $state(repo.checks ?? []);
  let createBranch = $state(repo.createBranch ?? true);
  let checksOpen = $state(false);
  let gitSyncEnabled = $state(false);
  let gitSyncModel = $state("");
  let gitSyncMaxRetries = $state(3);
  let gitSyncPrompt = $state("");

  // Re-sync local state when repo prop changes (e.g., navigating to a different repo)
  $effect(() => {
    nameInput = repo.name;
    editingName = false;
    model = repo.model;
    maxIterations = repo.maxIterations;
    completionSignal = repo.completionSignal;
    envVars = Object.entries(repo.envVars ?? {}).map(([key, value]) => ({
      key,
      value,
    }));
    checks = repo.checks ?? [];
    createBranch = repo.createBranch ?? true;
    gitSyncEnabled = repo.gitSync?.enabled ?? false;
    gitSyncModel = repo.gitSync?.model ?? "";
    gitSyncMaxRetries = repo.gitSync?.maxPushRetries ?? 3;
    gitSyncPrompt = repo.gitSync?.conflictPrompt ?? "";
  });

  let planFile = $state("");
  let previewContent = $state("");
  let previewLoading = $state(false);

  $effect(() => {
    const file = planFile;
    if (!file) {
      previewContent = "";
      previewLoading = false;
      return;
    }
    previewLoading = true;
    invoke("read_file_preview", { path: file })
      .then((result) => {
        if (planFile === file) {
          previewContent = result as string;
          previewLoading = false;
        }
      })
      .catch(() => {
        if (planFile === file) {
          previewContent = "";
          previewLoading = false;
        }
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
    } catch {
      // silently fail
    }
  }

  function saveSettings() {
    const envVarsRecord: Record<string, string> = {};
    for (const { key, value } of envVars) {
      if (key.trim()) envVarsRecord[key.trim()] = value;
    }
    onUpdateRepo({
      ...repo,
      model,
      maxIterations,
      completionSignal,
      envVars: envVarsRecord,
      checks,
      createBranch,
      gitSync: {
        enabled: gitSyncEnabled,
        model: gitSyncModel || undefined,
        maxPushRetries: gitSyncMaxRetries,
        conflictPrompt: gitSyncPrompt || undefined,
      },
    });
  }

  async function saveName() {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== repo.name) {
      await onUpdateRepo({ ...repo, name: trimmed });
    }
    editingName = false;
  }

  function handleNameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      saveName();
    } else if (e.key === "Escape") {
      nameInput = repo.name;
      editingName = false;
    }
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
    crumbs={[{ label: "Home", onclick: onBack }, { label: repo.name }]}
  />

  <header>
    {#if editingName}
      <input
        class="name-input"
        type="text"
        bind:value={nameInput}
        onblur={saveName}
        onkeydown={handleNameKeydown}
        autofocus
      />
    {:else}
      <h1>
        <button class="name-edit" onclick={() => { editingName = true; }}>
          {repo.name}
        </button>
      </h1>
    {/if}
    <p class="repo-path">
      {repo.type === "local" ? repo.path : `${repo.sshHost}:${repo.remotePath}`}
    </p>
  </header>

  <details class="settings">
    <summary>Settings — {model}, {maxIterations} iters</summary>
    <div class="settings-form">
      {#if repo.type === "ssh"}
        <label>
          SSH Host
          <input type="text" value={repo.sshHost} readonly disabled />
        </label>
        <label>
          Remote Path
          <input type="text" value={repo.remotePath} readonly disabled />
        </label>
      {/if}
      <label>
        Model
        <input type="text" bind:value={model} disabled={session.running} />
      </label>
      <label>
        Max Iterations
        <input
          type="number"
          bind:value={maxIterations}
          min="1"
          disabled={session.running}
        />
      </label>
      <label>
        Completion Signal
        <input
          type="text"
          bind:value={completionSignal}
          disabled={session.running}
        />
      </label>
      <label class="create-branch-toggle">
        <input
          type="checkbox"
          bind:checked={createBranch}
          disabled={session.running}
        />
        Create branch on run
      </label>
      <fieldset class="env-vars" disabled={session.running}>
        <legend>Environment Variables</legend>
        {#each envVars as envVar, i}
          <div class="env-var-row">
            <input
              type="text"
              bind:value={envVar.key}
              placeholder="KEY"
              class="env-key"
            />
            <span class="env-eq">=</span>
            <input
              type="text"
              bind:value={envVar.value}
              placeholder="value"
              class="env-value"
            />
            <button
              type="button"
              class="env-remove"
              onclick={() => { envVars = envVars.filter((_, j) => j !== i); }}
            >&times;</button>
          </div>
        {/each}
        <button
          type="button"
          class="secondary env-add"
          onclick={() => { envVars = [...envVars, { key: "", value: "" }]; }}
        >+ Add Variable</button>
      </fieldset>
      <div class="settings-actions">
        <button
          type="button"
          class="secondary"
          onclick={saveSettings}
          disabled={session.running}>Save</button
        >
        {#if repo.type === "ssh"}
          <button type="button" class="secondary">Test Connection</button>
        {/if}
      </div>
    </div>
  </details>

  <details class="checks" bind:open={checksOpen}>
    <summary>Checks — {checks.length} configured</summary>
    {#if checksOpen}
      <div class="checks-form">
        {#each checks as check, i}
          <details class="check-entry">
            <summary>
              <span class="check-summary-text">{check.name || "New Check"}</span>
              <button
                type="button"
                class="check-remove"
                disabled={session.running}
                onclick={(e) => { e.preventDefault(); checks = checks.filter((_, j) => j !== i); }}
              >&times;</button>
            </summary>
            <div class="check-fields">
              <label>
                Name
                <input type="text" bind:value={check.name} disabled={session.running} />
              </label>
              <label>
                Command
                <input type="text" bind:value={check.command} disabled={session.running} />
              </label>
              <label>
                When
                <select bind:value={check.when} disabled={session.running}>
                  <option value="each_iteration">each_iteration</option>
                  <option value="post_completion">post_completion</option>
                </select>
              </label>
              <label>
                Timeout
                <input type="number" bind:value={check.timeoutSecs} min="1" disabled={session.running} />
              </label>
              <label>
                Retries
                <input type="number" bind:value={check.maxRetries} min="0" disabled={session.running} />
              </label>
            </div>
          </details>
        {/each}
        <button
          type="button"
          class="secondary check-add"
          disabled={session.running}
          onclick={() => { checks = [...checks, { name: "", command: "", when: "each_iteration", timeoutSecs: 300, maxRetries: 1 }]; }}
        >Add Check</button>
      </div>
    {/if}
  </details>

  <details class="git-sync">
    <summary>Git Sync — {gitSyncEnabled ? "enabled" : "disabled"}</summary>
    <div class="git-sync-form">
      <label class="git-sync-toggle">
        <input
          type="checkbox"
          bind:checked={gitSyncEnabled}
          disabled={session.running}
        />
        Enable git sync
      </label>
      <div class="git-sync-fields" class:dimmed={!gitSyncEnabled}>
        <label>
          Model
          <input
            type="text"
            bind:value={gitSyncModel}
            placeholder="sonnet"
            disabled={session.running || !gitSyncEnabled}
          />
        </label>
        <label>
          Max Push Retries
          <input
            type="number"
            bind:value={gitSyncMaxRetries}
            min="1"
            disabled={session.running || !gitSyncEnabled}
          />
        </label>
        <label>
          Conflict Resolution Prompt
          <textarea
            bind:value={gitSyncPrompt}
            placeholder="Resolve merge conflicts..."
            disabled={session.running || !gitSyncEnabled}
            rows="3"
          ></textarea>
        </label>
      </div>
    </div>
  </details>

  <section class="plan-section">
    <h2>Plan</h2>
    <label>
      Prompt file
      <div class="input-row">
        <input
          type="text"
          bind:value={planFile}
          placeholder="docs/plans/my-feature-design.md"
          disabled={session.running}
        />
        <button
          type="button"
          class="secondary"
          onclick={browsePrompt}
          disabled={session.running}>Browse</button
        >
      </div>
    </label>
    {#if previewLoading}
      <p class="preview-loading">Loading...</p>
    {:else if previewContent}
      <pre class="plan-preview">{previewContent}</pre>
    {/if}
  </section>

  <div class="actions">
    {#if session.disconnected}
      <button type="button" onclick={onReconnect}> Reconnect </button>
    {:else if session.reconnecting}
      <button type="button" disabled> Reconnecting... </button>
    {:else}
      <button
        type="button"
        disabled={session.running || !planFile}
        onclick={() => onRun(planFile)}
      >
        {session.running ? "Running..." : "Run"}
      </button>
      {#if session.running}
        <button type="button" onclick={stopSession} class="danger">
          Stop
        </button>
      {:else}
        <button
          type="button"
          onclick={onMockRun}
          disabled={session.running}
          class="secondary"
        >
          Test Run
        </button>
      {/if}
      <button
        type="button"
        onclick={onOneShot}
        disabled={session.running}
        class="secondary"
      >
        1-Shot
      </button>
    {/if}
  </div>

  {#if !planFile && !session.running}
    <p class="hint">Select a prompt file to start a run</p>
  {/if}

  {#if session.disconnected}
    <section class="disconnected-banner">
      <p>Connection lost — the remote session may still be running.</p>
    </section>
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
        {#if session.trace.context_window}
          {@const ctxPercent = Math.round((session.trace.final_context_tokens! / session.trace.context_window) * 100)}
          <dt>Context</dt>
          <dd>
            <span style="color: {sessionContextColor(ctxPercent)}" title="{session.trace.final_context_tokens!.toLocaleString()} tokens">
              {ctxPercent}%
            </span>
          </dd>
        {/if}
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

  .name-edit {
    all: unset;
    cursor: pointer;
    border-bottom: 1px dashed transparent;
  }

  .name-edit:hover {
    background: #e8d44d;
    color: #1a1a2e;
    border-bottom-color: transparent;
  }

  .name-input {
    font-size: 2rem;
    font-weight: bold;
    color: #e8d44d;
    background: #16213e;
    border: 1px solid #e8d44d;
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    font-family: inherit;
    width: 100%;
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

  details.settings {
    margin-top: 1.5rem;
  }

  details.git-sync {
    margin-top: 1rem;
  }

  details.git-sync summary {
    font-size: 1rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid #333;
    padding-bottom: 0.3rem;
    cursor: pointer;
  }

  .git-sync-form {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .git-sync-toggle {
    flex-direction: row !important;
    align-items: center;
    gap: 0.5rem !important;
  }

  .git-sync-toggle input[type="checkbox"] {
    width: auto;
  }

  .create-branch-toggle {
    flex-direction: row !important;
    align-items: center;
    gap: 0.5rem !important;
  }

  .create-branch-toggle input[type="checkbox"] {
    width: auto;
  }

  .git-sync-fields.dimmed {
    opacity: 0.5;
  }

  textarea {
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    background: #16213e;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 4px;
    font-family: "SF Mono", "Fira Code", monospace;
    resize: vertical;
  }

  textarea:disabled {
    opacity: 0.5;
  }

  textarea:focus {
    outline: none;
    border-color: #e8d44d;
  }

  details.settings summary {
    font-size: 1rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid #333;
    padding-bottom: 0.3rem;
    cursor: pointer;
  }

  details.checks {
    margin-top: 1.5rem;
  }

  details.checks > summary {
    font-size: 1rem;
    color: #aaa;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid #333;
    padding-bottom: 0.3rem;
    cursor: pointer;
  }

  .checks-form {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  details.check-entry {
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.75rem;
  }

  details.check-entry summary {
    font-size: 0.9rem;
    color: #ccc;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .check-fields {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .check-remove {
    padding: 0.3rem 0.5rem;
    font-size: 1rem;
    line-height: 1;
    background: transparent;
    color: #666;
    border: 1px solid #333;
    border-radius: 4px;
    cursor: pointer;
    align-self: flex-start;
  }

  .check-remove:hover:not(:disabled) {
    color: #f87171;
    border-color: #f87171;
    background: transparent;
  }

  .check-add {
    font-size: 0.8rem;
    padding: 0.3rem 0.6rem;
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

  select:focus {
    outline: none;
    border-color: #e8d44d;
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

  .hint {
    color: #666;
    font-size: 0.8rem;
    margin-top: 0.5rem;
  }

  .settings-form {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  label input[readonly] {
    opacity: 0.7;
  }

  .env-vars {
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.75rem;
    margin: 0;
  }

  .env-vars legend {
    font-size: 0.85rem;
    color: #888;
    padding: 0 0.25rem;
  }

  .env-var-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-bottom: 0.5rem;
  }

  .env-key {
    flex: 2;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .env-eq {
    color: #666;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .env-value {
    flex: 3;
    font-family: "SF Mono", "Fira Code", monospace;
  }

  .env-remove {
    padding: 0.3rem 0.5rem;
    font-size: 1rem;
    line-height: 1;
    background: transparent;
    color: #666;
    border: 1px solid #333;
    border-radius: 4px;
    cursor: pointer;
  }

  .env-remove:hover:not(:disabled) {
    color: #f87171;
    border-color: #f87171;
    background: transparent;
  }

  .env-add {
    font-size: 0.8rem;
    padding: 0.3rem 0.6rem;
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

  .failure-reason {
    color: #f87171;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .disconnected-banner {
    background: #3b2e1a;
    border: 1px solid #f59e0b;
    border-radius: 4px;
    padding: 0.75rem 1rem;
    margin-top: 1.5rem;
  }

  .disconnected-banner p {
    margin: 0;
    color: #f59e0b;
    font-size: 0.9rem;
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

  .preview-loading {
    color: #666;
    font-size: 0.8rem;
    margin-top: 0.5rem;
  }

  .plan-preview {
    margin-top: 0.5rem;
    padding: 0.75rem;
    background: #12122a;
    color: #888;
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.8rem;
    border-radius: 4px;
    border: 1px solid #333;
    overflow-x: auto;
    max-height: 8rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
