import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { saveRecent } from "./recents";
import {
  loadRepos as reposLoadRepos,
  addLocalRepo as reposAddLocalRepo,
  addSshRepo as reposAddSshRepo,
  updateRepo as reposUpdateRepo,
  type RepoConfig,
} from "./repos";
import type { SessionState, SessionTrace, TaggedSessionEvent } from "./types";

export interface AppStore {
  // --- Repos ---
  repos: RepoConfig[];
  loadRepos: () => Promise<void>;
  addLocalRepo: (path: string) => Promise<void>;
  addSshRepo: (host: string, path: string) => Promise<void>;
  updateRepo: (repo: RepoConfig) => Promise<void>;

  // --- Sessions ---
  sessions: Map<string, SessionState>;
  latestTraces: Map<string, SessionTrace>;
  runSession: (repoId: string, planFile: string) => Promise<void>;
  stopSession: (repoId: string) => Promise<void>;
  reconnectSession: (repoId: string) => Promise<void>;

  // --- Init ---
  initialize: () => () => void;
}

export const useAppStore = create<AppStore>((set, get) => {
  async function syncActiveSession() {
    const activeRepoIds = (await invoke<string[]>("get_active_sessions")) ?? [];
    const activeSet = new Set(activeRepoIds);
    const sessions = get().sessions;
    const next = new Map(sessions);

    for (const [repoId, session] of sessions) {
      if (session.running && !activeSet.has(repoId)) {
        next.set(repoId, { ...session, running: false });
      }
    }

    for (const activeRepoId of activeRepoIds) {
      const existing = sessions.get(activeRepoId);
      if (!existing || !existing.running) {
        next.set(activeRepoId, {
          running: true,
          disconnected: false,
          reconnecting: false,
          events: existing?.events ?? [],
          trace: null,
          error: null,
        });
      }
    }

    set({ sessions: next });
  }

  return {
    repos: [],
    sessions: new Map(),
    latestTraces: new Map(),

    initialize: () => {
      // 1. Load repos
      reposLoadRepos()
        .then((repos) => {
          set({ repos });
        })
        .catch(() => {});

      // 2. Load latest traces
      invoke<Record<string, SessionTrace>>("list_latest_traces")
        .then((result) => {
          if (result) {
            const tracesMap = new Map<string, SessionTrace>(
              Object.entries(result),
            );
            set({ latestTraces: tracesMap });
          }
        })
        .catch(() => {});

      // 3. Listen for session events
      const listenPromise = listen<TaggedSessionEvent>(
        "session-event",
        (event) => {
          const { repo_id, event: sessionEvent } = event.payload;
          sessionEvent._ts = Date.now();

          const session = get().sessions.get(repo_id) ?? {
            running: true,
            disconnected: false,
            reconnecting: false,
            events: [],
            trace: null,
            error: null,
          };

          const updates: Partial<SessionState> = {
            events: [...session.events, sessionEvent],
          };

          if (sessionEvent.kind === "disconnected") {
            updates.disconnected = true;
            updates.reconnecting = false;
            updates.disconnectReason = sessionEvent.reason;
          } else if (sessionEvent.kind === "reconnecting") {
            updates.reconnecting = true;
            updates.disconnected = false;
          } else if (sessionEvent.kind === "session_complete") {
            updates.running = false;
            updates.disconnected = false;
            updates.reconnecting = false;
            updates.disconnectReason = undefined;
          } else if (session.disconnected || session.reconnecting) {
            updates.disconnected = false;
            updates.reconnecting = false;
            updates.disconnectReason = undefined;
          }

          const next = new Map(get().sessions);
          next.set(repo_id, { ...session, ...updates });
          set({ sessions: next });
        },
      );

      // 4. Start sync interval
      const intervalId = setInterval(() => {
        syncActiveSession();
      }, 5000);

      // 5. Return cleanup function
      return () => {
        listenPromise.then((fn) => fn());
        clearInterval(intervalId);
      };
    },

    loadRepos: async () => {
      const repos = await reposLoadRepos();
      set({ repos });
    },

    addLocalRepo: async (path: string) => {
      await reposAddLocalRepo(path);
      const repos = await reposLoadRepos();
      set({ repos });
    },

    addSshRepo: async (host: string, path: string) => {
      await reposAddSshRepo(host, path);
      const repos = await reposLoadRepos();
      set({ repos });
    },

    updateRepo: async (repo: RepoConfig) => {
      await reposUpdateRepo(repo);
      const repos = await reposLoadRepos();
      set({ repos });
    },

    runSession: async (repoId: string, planFile: string) => {
      const repo = get().repos.find((r) => r.id === repoId);
      if (!repo) return;

      // Set initial running state
      const next = new Map(get().sessions);
      next.set(repoId, {
        running: true,
        disconnected: false,
        reconnecting: false,
        events: [],
        trace: null,
        error: null,
      });
      set({ sessions: next });

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
          createBranch: repo.createBranch ?? true,
        });

        const s2 = new Map(get().sessions);
        const current = s2.get(repoId);
        if (!current) return;
        s2.set(repoId, { ...current, trace });
        const lt = new Map(get().latestTraces);
        lt.set(repoId, trace);
        set({ sessions: s2, latestTraces: lt });

        await saveRecent("promptFiles", planFile);
      } catch (e) {
        const s2 = new Map(get().sessions);
        const current = s2.get(repoId);
        if (!current) return;
        s2.set(repoId, {
          ...current,
          error: e instanceof Error ? e.message : String(e),
        });
        set({ sessions: s2 });
      } finally {
        const s2 = new Map(get().sessions);
        const current = s2.get(repoId);
        if (current) {
          s2.set(repoId, { ...current, running: false });
          set({ sessions: s2 });
        }
      }
    },

    stopSession: async (repoId: string) => {
      await invoke("stop_session", { repoId });
    },

    reconnectSession: async (repoId: string) => {
      const session = get().sessions.get(repoId);
      if (session) {
        const next = new Map(get().sessions);
        next.set(repoId, {
          ...session,
          reconnecting: true,
          disconnected: false,
          disconnectReason: undefined,
        });
        set({ sessions: next });
      }
      try {
        await invoke("reconnect_session", { repoId });
      } catch (e) {
        const session = get().sessions.get(repoId);
        if (session) {
          const next = new Map(get().sessions);
          next.set(repoId, {
            ...session,
            error: e instanceof Error ? e.message : String(e),
            reconnecting: false,
            disconnected: true,
          });
          set({ sessions: next });
        }
      }
    },
  };
});
