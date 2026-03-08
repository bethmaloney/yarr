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
  import OneShotView from "./OneShotView.svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { SessionTrace, SessionState, TaggedSessionEvent } from "./types";

  let currentView:
    | { kind: "home" }
    | { kind: "repo"; repoId: string }
    | { kind: "history"; repoId?: string }
    | { kind: "run"; repoId: string; sessionId: string; fromRepoId?: string }
    | { kind: "oneshot"; repoId: string } =
    $state({ kind: "home" });
  let repos: RepoConfig[] = $state([]);
  let sessions = new SvelteMap<string, SessionState>();
  let latestTraces: Map<string, SessionTrace> = $state(new Map());
  let addMode: null | "choosing" | "ssh-form" = $state(null);
  let sshHost = $state("");
  let sshRemotePath = $state("");

  async function syncActiveSession() {
    const activeRepoIds = await invoke<string[]>("get_active_sessions");
    const activeSet = new Set(activeRepoIds);
    let changed = false;

    // Mark sessions that completed during sleep as no longer running
    for (const [repoId, session] of sessions) {
      if (session.running && !activeSet.has(repoId)) {
        sessions.set(repoId, { ...session, running: false });
        changed = true;
      }
    }

    // Mark sessions that are active but frontend doesn't know about
    for (const activeRepoId of activeRepoIds) {
      const existing = sessions.get(activeRepoId);
      if (!existing || !existing.running) {
        sessions.set(activeRepoId, {
          running: true,
          events: existing?.events ?? [],
          trace: null,
          error: null,
        });
        changed = true;
      }
    }

    if (changed) {
      sessions = new SvelteMap(sessions);
    }
  }

  onMount(() => {
    loadRepos().then((r) => {
      repos = r;
    });

    invoke<SessionTrace[]>("list_latest_traces")
      .then((traces) => {
        const m = new SvelteMap<string, SessionTrace>();
        for (const t of traces) {
          if (t.repo_id) m.set(t.repo_id, t);
        }
        latestTraces = m;
      })
      .catch(() => {});

    // Register event listener BEFORE syncing so we don't miss events
    const unlisten = listen<TaggedSessionEvent>("session-event", (e) => {
      const { repo_id, event } = e.payload;
      event._ts = Date.now();
      const session = sessions.get(repo_id) ?? {
        running: true,
        disconnected: false,
        reconnecting: false,
        events: [],
        trace: null,
        error: null,
      };
      const updates: Partial<SessionState> = {
        events: [...session.events, event],
      };
      if (event.kind === "disconnected") {
        updates.disconnected = true;
        updates.reconnecting = false;
      } else if (event.kind === "reconnecting") {
        updates.reconnecting = true;
        updates.disconnected = false;
      } else if (event.kind === "session_complete") {
        // Authoritatively mark session as not running when backend says it's done.
        // This covers the case where the invoke promise was lost (e.g. webview reload).
        updates.running = false;
        updates.disconnected = false;
        updates.reconnecting = false;
      } else if (session.disconnected || session.reconnecting) {
        updates.disconnected = false;
        updates.reconnecting = false;
      }
      sessions.set(repo_id, { ...session, ...updates });
    });

    // Check if a session was already running (e.g. after webview reload)
    syncActiveSession();

    // Periodically reconcile frontend state with backend.
    // Catches drift from sleep/wake, missed events, or lost invoke promises.
    const syncInterval = setInterval(() => {
      syncActiveSession();
    }, 5_000);

    return () => {
      unlisten.then((fn) => fn());
      clearInterval(syncInterval);
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

  function goOneShot(repoId: string) {
    currentView = { kind: "oneshot", repoId };
  }

  async function handleRunSession(repoId: string, planFile: string) {
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) return;

    sessions.set(repoId, {
      running: true,
      disconnected: false,
      reconnecting: false,
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
        envVars: repo.envVars ?? {},
        checks: repo.checks ?? [],
        gitSync: repo.gitSync,
      });
      const session = sessions.get(repoId)!;
      sessions.set(repoId, { ...session, trace });
      latestTraces = new SvelteMap(latestTraces).set(repoId, trace);
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
      disconnected: false,
      reconnecting: false,
      events: [],
      trace: null,
      error: null,
    });

    try {
      const trace = await invoke<SessionTrace>("run_mock_session", { repoId });
      const session = sessions.get(repoId)!;
      sessions.set(repoId, { ...session, trace });
      latestTraces = new SvelteMap(latestTraces).set(repoId, trace);
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

  async function handleReconnect(repoId: string) {
    const session = sessions.get(repoId);
    if (session) {
      sessions.set(repoId, {
        ...session,
        reconnecting: true,
        disconnected: false,
      });
    }
    try {
      await invoke("reconnect_session", { repoId });
    } catch (e) {
      const session = sessions.get(repoId);
      if (session) {
        sessions.set(repoId, {
          ...session,
          error: String(e),
          reconnecting: false,
          disconnected: true,
        });
      }
    }
  }
</script>

{#if currentView.kind === "home"}
  <HomeView
    {repos}
    {sessions}
    {latestTraces}
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
{:else if currentView.kind === "oneshot"}
  {@const repoId = currentView.repoId}
  {@const repo = repos.find((r) => r.id === repoId)}
  {#if repo}
    {@const sessionState = sessions.get(repoId) ?? {
      running: false,
      disconnected: false,
      reconnecting: false,
      events: [],
      trace: null,
      error: null,
    }}
    <OneShotView
      {repo}
      session={sessionState}
      onBack={() => selectRepo(repoId)}
      onHome={goHome}
    />
  {/if}
{:else if currentView.kind === "repo"}
  {@const repoId = currentView.repoId}
  {@const repo = repos.find((r) => r.id === repoId)}
  {#if repo}
    {@const sessionState = sessions.get(repoId) ?? {
      running: false,
      disconnected: false,
      reconnecting: false,
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
      onReconnect={() => handleReconnect(repoId)}
      onOneShot={() => goOneShot(repoId)}
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
