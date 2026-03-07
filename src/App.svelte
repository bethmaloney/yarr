<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { open } from "@tauri-apps/plugin-dialog";
  import { onMount } from "svelte";
  import { saveRecent } from "./recents";
  import {
    loadRepos,
    addLocalRepo,
    addSshRepo,
    updateRepo,
    type RepoConfig,
  } from "./repos";
  import HomeView from "./HomeView.svelte";
  import RepoDetail from "./RepoDetail.svelte";
  import HistoryView from "./HistoryView.svelte";
  import RunDetail from "./RunDetail.svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { SessionTrace, SessionState, TaggedSessionEvent } from "./types";

  let currentView:
    | { kind: "home" }
    | { kind: "repo"; repoId: string }
    | { kind: "history"; repoId?: string }
    | { kind: "run"; repoId: string; sessionId: string; fromRepoId?: string } =
    $state({ kind: "home" });
  let repos: RepoConfig[] = $state([]);
  let sessions = new SvelteMap<string, SessionState>();
  let addMode: null | "choosing" | "ssh-form" = $state(null);
  let sshHost = $state("");
  let sshRemotePath = $state("");

  onMount(() => {
    loadRepos().then((r) => {
      repos = r;
    });

    const unlisten = listen<TaggedSessionEvent>("session-event", (e) => {
      const { repo_id, event } = e.payload;
      event._ts = Date.now();
      const session = sessions.get(repo_id);
      if (session) {
        sessions.set(repo_id, {
          ...session,
          events: [...session.events, event],
        });
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  });

  function handleAddRepo() {
    addMode = "choosing";
  }

  async function handleChooseLocal() {
    addMode = null;
    const result = await open({ directory: true, title: "Select repository" });
    if (result !== null) {
      await addLocalRepo(result);
      repos = await loadRepos();
    }
  }

  function handleChooseSsh() {
    sshHost = "";
    sshRemotePath = "";
    addMode = "ssh-form";
  }

  function handleCancelAdd() {
    addMode = null;
  }

  async function handleAddSshRepo() {
    const host = sshHost.trim();
    const path = sshRemotePath.trim();
    if (!host || !path) return;
    await addSshRepo(host, path);
    repos = await loadRepos();
    addMode = null;
  }

  function selectRepo(id: string) {
    currentView = { kind: "repo", repoId: id };
  }

  function goHome() {
    currentView = { kind: "home" };
  }

  function goHistory(repoId?: string) {
    currentView = repoId ? { kind: "history", repoId } : { kind: "history" };
  }

  function goRun(repoId: string, sessionId: string, fromRepoId?: string) {
    currentView = { kind: "run", repoId, sessionId, fromRepoId };
  }

  async function handleRunSession(repoId: string, planFile: string) {
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) return;

    sessions.set(repoId, {
      running: true,
      events: [],
      trace: null,
      error: null,
    });

    try {
      const repoPayload =
        repo.type === "local"
          ? { type: "local" as const, path: repo.path }
          : {
              type: "ssh" as const,
              sshHost: repo.sshHost,
              remotePath: repo.remotePath,
            };
      const trace = await invoke<SessionTrace>("run_session", {
        repoId,
        repo: repoPayload,
        planFile,
        model: repo.model,
        maxIterations: repo.maxIterations,
        completionSignal: repo.completionSignal,
      });
      const session = sessions.get(repoId)!;
      sessions.set(repoId, { ...session, trace });
      await saveRecent("promptFiles", planFile);
    } catch (e) {
      const session = sessions.get(repoId)!;
      sessions.set(repoId, { ...session, error: String(e) });
    } finally {
      const session = sessions.get(repoId)!;
      sessions.set(repoId, { ...session, running: false });
    }
  }

  async function handleMockRun(repoId: string) {
    sessions.set(repoId, {
      running: true,
      events: [],
      trace: null,
      error: null,
    });

    try {
      const trace = await invoke<SessionTrace>("run_mock_session", { repoId });
      const session = sessions.get(repoId)!;
      sessions.set(repoId, { ...session, trace });
    } catch (e) {
      const session = sessions.get(repoId)!;
      sessions.set(repoId, { ...session, error: String(e) });
    } finally {
      const session = sessions.get(repoId)!;
      sessions.set(repoId, { ...session, running: false });
    }
  }

  async function handleUpdateRepo(repo: RepoConfig) {
    await updateRepo(repo);
    repos = await loadRepos();
  }
</script>

{#if currentView.kind === "home"}
  <HomeView
    {repos}
    {sessions}
    {addMode}
    {sshHost}
    {sshRemotePath}
    onSelectRepo={selectRepo}
    onAddRepo={handleAddRepo}
    onChooseLocal={handleChooseLocal}
    onChooseSsh={handleChooseSsh}
    onSshHostChange={(v) => (sshHost = v)}
    onSshRemotePathChange={(v) => (sshRemotePath = v)}
    onAddSshRepo={handleAddSshRepo}
    onCancelAdd={handleCancelAdd}
    onHistory={() => goHistory()}
  />
{:else if currentView.kind === "history"}
  <HistoryView
    repoId={currentView.repoId}
    {repos}
    onBack={goHome}
    onSelectRun={(rid, sid) =>
      goRun(
        rid,
        sid,
        currentView.kind === "history" ? currentView.repoId : undefined,
      )}
  />
{:else if currentView.kind === "run"}
  <RunDetail
    repoId={currentView.repoId}
    sessionId={currentView.sessionId}
    onBack={() =>
      goHistory(
        currentView.kind === "run" ? currentView.fromRepoId : undefined,
      )}
  />
{:else if currentView.kind === "repo"}
  {@const repoId = currentView.repoId}
  {@const repo = repos.find((r) => r.id === repoId)}
  {#if repo}
    {@const sessionState = sessions.get(repoId) ?? {
      running: false,
      events: [],
      trace: null,
      error: null,
    }}
    <RepoDetail
      {repo}
      session={sessionState}
      onBack={goHome}
      onRun={(planFile) => handleRunSession(repoId, planFile)}
      onMockRun={() => handleMockRun(repoId)}
      onUpdateRepo={handleUpdateRepo}
    />
  {/if}
{/if}

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
  }
</style>
