<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { open } from "@tauri-apps/plugin-dialog";
  import { onMount } from "svelte";
  import { saveRecent } from "./recents";
  import { loadRepos, addRepo, updateRepo, type RepoConfig } from "./repos";
  import HomeView from "./HomeView.svelte";
  import RepoDetail from "./RepoDetail.svelte";
  import HistoryView from "./HistoryView.svelte";
  import RunDetail from "./RunDetail.svelte";

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

  type TaggedSessionEvent = {
    repo_id: string;
    event: SessionEvent;
  };

  let currentView:
    | { kind: "home" }
    | { kind: "repo"; repoId: string }
    | { kind: "history"; repoId?: string }
    | { kind: "run"; repoId: string; sessionId: string; fromRepoId?: string }
    = $state({ kind: "home" });
  let repos: RepoConfig[] = $state([]);
  let sessions: Map<string, SessionState> = $state(new Map());

  onMount(() => {
    loadRepos().then((r) => {
      repos = r;
    });

    const unlisten = listen<TaggedSessionEvent>("session-event", (e) => {
      const { repo_id, event } = e.payload;
      event._ts = Date.now();
      const session = sessions.get(repo_id);
      if (session) {
        sessions.set(repo_id, { ...session, events: [...session.events, event] });
        sessions = new Map(sessions);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  });

  async function handleAddRepo() {
    const result = await open({ directory: true, title: "Select repository" });
    if (result !== null) {
      await addRepo(result);
      repos = await loadRepos();
    }
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

    sessions.set(repoId, { running: true, events: [], trace: null, error: null });
    sessions = new Map(sessions);

    try {
      const trace = await invoke<SessionTrace>("run_session", {
        repoId,
        repoPath: repo.path,
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
      sessions = new Map(sessions);
    }
  }

  async function handleMockRun(repoId: string) {
    sessions.set(repoId, { running: true, events: [], trace: null, error: null });
    sessions = new Map(sessions);

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
      sessions = new Map(sessions);
    }
  }

  async function handleUpdateRepo(repo: RepoConfig) {
    await updateRepo(repo);
    repos = await loadRepos();
  }
</script>

{#if currentView.kind === "home"}
  <HomeView {repos} {sessions} onSelectRepo={selectRepo} onAddRepo={handleAddRepo} onHistory={() => goHistory()} />
{:else if currentView.kind === "history"}
  <HistoryView
    repoId={currentView.repoId}
    {repos}
    onBack={goHome}
    onSelectRun={(rid, sid) => goRun(rid, sid, currentView.kind === "history" ? currentView.repoId : undefined)}
  />
{:else if currentView.kind === "run"}
  <RunDetail
    repoId={currentView.repoId}
    sessionId={currentView.sessionId}
    onBack={() => goHistory(currentView.kind === "run" ? currentView.fromRepoId : undefined)}
  />
{:else if currentView.kind === "repo"}
  {@const repoId = currentView.repoId}
  {@const repo = repos.find((r) => r.id === repoId)}
  {#if repo}
    {@const sessionState = sessions.get(repoId) ?? { running: false, events: [], trace: null, error: null }}
    <RepoDetail
      {repo}
      session={sessionState}
      onBack={goHome}
      onRun={(planFile) => handleRunSession(repoId, planFile)}
      onMockRun={() => handleMockRun(repoId)}
      onUpdateRepo={handleUpdateRepo}
      onHistory={() => goHistory(repoId)}
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
