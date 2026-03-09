<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { open } from "@tauri-apps/plugin-dialog";
  import { onMount, onDestroy } from "svelte";
  import type { RepoConfig } from "./repos";
  import type { BranchInfo, Check, SessionState } from "./types";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import EventsList from "./EventsList.svelte";
  import { sessionContextColor } from "./context-bar";

  let {
    repo,
    session,
    onBack,
    onRun,
    onUpdateRepo,
    onReconnect,
    onOneShot,
  }: {
    repo: RepoConfig;
    session: SessionState;
    onBack: () => void;
    onRun: (planFile: string) => void;
    onUpdateRepo: (repo: RepoConfig) => Promise<void>;
    onReconnect: () => void;
    onOneShot: () => void;
  } = $props();

  // Local settings state, initialized from repo prop
  let editingName = $state(false);
  let nameInput = $state("");
  let model = $state("");
  let maxIterations = $state(0);
  let completionSignal = $state("");
  let envVars: { key: string; value: string }[] = $state([]);
  let checks: Check[] = $state([]);
  let createBranch = $state(true);
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

  // Connection test state
  type ConnectionTestStep = { name: string; status: "pending" | "running" | "pass" | "fail"; error?: string };
  type ConnectionTest = { running: boolean; steps: ConnectionTestStep[] };
  let connectionTest: ConnectionTest | null = $state(null);
  let connectionTestCleanup: (() => void) | null = null;

  async function testConnection() {
    const stepNames = ["SSH reachable", "tmux available", "claude available", "Remote path exists"];
    connectionTest = {
      running: true,
      steps: stepNames.map((name, i) => ({ name, status: i === 0 ? "running" as const : "pending" as const })),
    };

    const unlistenStep = await listen<{ step: string; status: string; error?: string }>("ssh-test-step", (e) => {
      if (!connectionTest) return;
      const payload = e.payload;
      const newSteps = connectionTest.steps.map((s) => {
        if (s.name === payload.step) {
          return { ...s, status: payload.status as "pass" | "fail", error: payload.error ?? undefined };
        }
        return s;
      });
      if (payload.status === "pass") {
        const nextPending = newSteps.findIndex((s) => s.status === "pending");
        if (nextPending !== -1) {
          newSteps[nextPending] = { ...newSteps[nextPending], status: "running" };
        }
      }
      connectionTest = { ...connectionTest, steps: newSteps };
    });

    const unlistenComplete = await listen("ssh-test-complete", () => {
      connectionTest = connectionTest ? { ...connectionTest, running: false } : null;
      unlistenStep();
      unlistenComplete();
    });

    connectionTestCleanup = () => { unlistenStep(); unlistenComplete(); };

    invoke("test_ssh_connection_steps", { sshHost: repo.sshHost, remotePath: repo.remotePath }).catch(() => {
      connectionTest = connectionTest ? { ...connectionTest, running: false } : null;
      unlistenStep();
      unlistenComplete();
    });
  }

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

  // Branch display state
  let branchInfo: BranchInfo | null = $state(null);
  let branches: string[] = $state([]);
  let branchDropdownOpen = $state(false);
  let branchSearch = $state("");

  let filteredBranches = $derived(
    branchSearch
      ? branches.filter((b) =>
          b.toLowerCase().includes(branchSearch.toLowerCase()),
        )
      : branches,
  );

  function buildRepoPayload() {
    return repo.type === "local"
      ? { type: "local" as const, path: repo.path }
      : {
          type: "ssh" as const,
          sshHost: repo.sshHost,
          remotePath: repo.remotePath,
        };
  }

  async function fetchBranchInfo() {
    try {
      branchInfo = await invoke<BranchInfo>("get_branch_info", {
        repo: buildRepoPayload(),
      });
    } catch {
      branchInfo = null;
    }
  }

  async function fetchBranches() {
    try {
      branches = await invoke<string[]>("list_local_branches", {
        repo: buildRepoPayload(),
      });
    } catch {
      branches = [];
    }
  }

  async function handleSwitchBranch(branchName: string) {
    try {
      await invoke("switch_branch", {
        repo: buildRepoPayload(),
        branch: branchName,
      });
      branchDropdownOpen = false;
      branchSearch = "";
      await fetchBranchInfo();
    } catch (e) {
      console.error("Failed to switch branch:", e);
    }
  }

  async function handleFastForward() {
    try {
      await invoke("fast_forward_branch", { repo: buildRepoPayload() });
      branchDropdownOpen = false;
      branchSearch = "";
      await fetchBranchInfo();
    } catch (e) {
      console.error("Failed to fast-forward:", e);
    }
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      branchDropdownOpen = false;
      branchSearch = "";
    } else if (event.key === "Enter" && filteredBranches.length > 0) {
      handleSwitchBranch(filteredBranches[0]);
    }
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }

  function handleChipClick() {
    if (session.running) return;
    branchDropdownOpen = !branchDropdownOpen;
    if (branchDropdownOpen) {
      fetchBranches();
    }
  }

  function handleClickOutside(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target.closest(".branch-selector")) {
      branchDropdownOpen = false;
      branchSearch = "";
    }
  }

  // Fetch branch info on mount and when repo changes
  $effect(() => {
    void repo.id;
    fetchBranchInfo();
  });

  // Refresh after session completes
  let wasRunning = $state(false);
  $effect(() => {
    if (wasRunning && !session.running) {
      fetchBranchInfo();
    }
    wasRunning = session.running;
  });

  // Click outside listener
  onMount(() => {
    document.addEventListener("click", handleClickOutside);
  });
  onDestroy(() => {
    document.removeEventListener("click", handleClickOutside);
    if (connectionTestCleanup) connectionTestCleanup();
  });
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
        use:autofocus
      />
    {:else}
      <h1>
        <button
          class="name-edit"
          onclick={() => {
            editingName = true;
          }}
        >
          {repo.name}
        </button>
      </h1>
    {/if}
    <p class="repo-path">
      {repo.type === "local" ? repo.path : `${repo.sshHost}:${repo.remotePath}`}
    </p>
  </header>

  {#if branchInfo}
    <div class="branch-selector">
      <button
        class="branch-chip"
        class:warning={branchInfo.behind != null && branchInfo.behind > 0}
        class:disabled={session.running}
        onclick={handleChipClick}
      >
        {branchInfo.name}
        {#if branchInfo.ahead != null && branchInfo.ahead > 0}
          <span class="ahead">&uarr;{branchInfo.ahead}</span>
        {/if}
        {#if branchInfo.behind != null && branchInfo.behind > 0}
          <span class="behind">&darr;{branchInfo.behind}</span>
        {/if}
      </button>
      {#if branchDropdownOpen}
        <div class="branch-dropdown">
          <input
            class="branch-search"
            type="text"
            placeholder="Search branches..."
            bind:value={branchSearch}
            onkeydown={handleSearchKeydown}
            use:autofocus
          />
          {#if branchInfo.behind != null && branchInfo.behind > 0}
            <button class="fast-forward-btn" onclick={handleFastForward}>
              Fast-forward
            </button>
          {/if}
          {#each filteredBranches as branch (branch)}
            <button
              class="branch-item"
              class:active={branch === branchInfo.name}
              onclick={() => handleSwitchBranch(branch)}
            >
              {branch}
            </button>
          {/each}
          {#if filteredBranches.length === 0}
            <div class="branch-empty">No matching branches</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

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
        {#each envVars as envVar, i (i)}
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
              onclick={() => {
                envVars = envVars.filter((_, j) => j !== i);
              }}>&times;</button
            >
          </div>
        {/each}
        <button
          type="button"
          class="secondary env-add"
          onclick={() => {
            envVars = [...envVars, { key: "", value: "" }];
          }}>+ Add Variable</button
        >
      </fieldset>
      <div class="settings-actions">
        <button
          type="button"
          class="secondary"
          onclick={saveSettings}
          disabled={session.running}>Save</button
        >
        {#if repo.type === "ssh"}
          <button type="button" class="secondary" onclick={testConnection} disabled={connectionTest?.running}>Test Connection</button>
        {/if}
      </div>
      {#if connectionTest}
        <div class="connection-checklist" data-testid="connection-checklist">
          {#each connectionTest.steps as step}
            <div class="checklist-step step-{step.status}">
              <span class="step-icon">
                {#if step.status === "running"}
                  <span class="spinner"></span>
                {:else if step.status === "pass"}
                  ✓
                {:else if step.status === "fail"}
                  ✗
                {:else}
                  ·
                {/if}
              </span>
              <span class="step-name">{step.name}</span>
              {#if step.error}
                <span class="step-error">{step.error}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </details>

  <details class="checks" bind:open={checksOpen}>
    <summary>Checks — {checks.length} configured</summary>
    {#if checksOpen}
      <div class="checks-form">
        {#each checks as check, i (i)}
          <details class="check-entry">
            <summary>
              <span class="check-summary-text">{check.name || "New Check"}</span
              >
              <button
                type="button"
                class="check-remove"
                disabled={session.running}
                onclick={(e) => {
                  e.preventDefault();
                  checks = checks.filter((_, j) => j !== i);
                }}>&times;</button
              >
            </summary>
            <div class="check-fields">
              <label>
                Name
                <input
                  type="text"
                  bind:value={check.name}
                  disabled={session.running}
                />
              </label>
              <label>
                Command
                <input
                  type="text"
                  bind:value={check.command}
                  disabled={session.running}
                />
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
                <input
                  type="number"
                  bind:value={check.timeoutSecs}
                  min="1"
                  disabled={session.running}
                />
              </label>
              <label>
                Retries
                <input
                  type="number"
                  bind:value={check.maxRetries}
                  min="0"
                  disabled={session.running}
                />
              </label>
            </div>
          </details>
        {/each}
        <button
          type="button"
          class="secondary check-add"
          disabled={session.running}
          onclick={() => {
            checks = [
              ...checks,
              {
                name: "",
                command: "",
                when: "each_iteration",
                timeoutSecs: 300,
                maxRetries: 1,
              },
            ];
          }}>Add Check</button
        >
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
      <p>{session.disconnectReason ? `Connection lost: ${session.disconnectReason}` : "Connection lost"}</p>
      <p class="disconnected-sub">The remote session may still be running.</p>
    </section>
  {/if}

  <EventsList
    events={session.events}
    isLive={session.running}
    repoPath={repo.type === "local" ? repo.path : repo.remotePath}
  />

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
          {@const ctxPercent = Math.round(
            (session.trace.final_context_tokens! /
              session.trace.context_window) *
              100,
          )}
          <dt>Context</dt>
          <dd>
            <span
              style="color: {sessionContextColor(ctxPercent)}"
              title="{session.trace.final_context_tokens!.toLocaleString()} tokens"
            >
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

  .disconnected-sub {
    margin-top: 0.25rem !important;
    font-size: 0.85rem !important;
    opacity: 0.8;
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

  .branch-selector {
    position: relative;
    margin-top: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .branch-chip {
    padding: 0.25rem 0.6rem;
    font-size: 0.8rem;
    font-family: "SF Mono", "Fira Code", monospace;
    background: #1e2a45;
    color: #aaa;
    border: 1px solid #333;
    border-radius: 12px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .branch-chip:hover:not(.disabled) {
    border-color: #555;
    color: #ccc;
  }

  .branch-chip.disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .branch-chip.warning {
    border-color: #f59e0b;
    color: #f59e0b;
  }

  .ahead {
    color: #4ade80;
    font-size: 0.75rem;
  }

  .behind {
    color: #f59e0b;
    font-size: 0.75rem;
  }

  .branch-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 0.25rem;
    background: #1a1a2e;
    border: 1px solid #333;
    border-radius: 6px;
    min-width: 200px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    padding: 0.25rem 0;
    max-height: 300px;
    overflow-y: auto;
  }

  .fast-forward-btn {
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    background: transparent;
    color: #f59e0b;
    border: none;
    border-bottom: 1px solid #333;
    cursor: pointer;
    text-align: left;
    font-weight: 600;
  }

  .fast-forward-btn:hover {
    background: #2a2a3e;
  }

  .branch-item {
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    font-family: "SF Mono", "Fira Code", monospace;
    background: transparent;
    color: #aaa;
    border: none;
    cursor: pointer;
    text-align: left;
  }

  .branch-item:hover {
    background: #2a2a3e;
    color: #ccc;
  }

  .branch-item.active {
    color: #e8d44d;
    font-weight: 600;
  }

  .branch-search {
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    font-family: "SF Mono", "Fira Code", monospace;
    background: #12121e;
    color: #ccc;
    border: none;
    border-bottom: 1px solid #333;
    outline: none;
  }

  .branch-search::placeholder {
    color: #666;
  }

  .branch-empty {
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    color: #666;
    font-style: italic;
  }

  .connection-checklist {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.75rem;
  }

  .checklist-step {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
    flex-wrap: wrap;
  }

  .step-icon {
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
  }

  .step-pass .step-icon {
    color: #4ade80;
  }

  .step-fail .step-icon {
    color: #f87171;
  }

  .step-pending .step-name {
    color: #555;
  }

  .step-pass .step-name {
    color: #ccc;
  }

  .step-fail .step-name {
    color: #f87171;
  }

  .step-running .step-name {
    color: #e0e0e0;
  }

  .step-error {
    width: 100%;
    margin-left: 1.5rem;
    color: #f87171;
    font-size: 0.8rem;
  }

  .spinner {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    border: 2px solid #555;
    border-top-color: #e8d44d;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
