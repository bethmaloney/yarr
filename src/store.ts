import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { toast } from "sonner";
import { saveRecent } from "./recents";
import {
  loadRepos as reposLoadRepos,
  addLocalRepo as reposAddLocalRepo,
  addSshRepo as reposAddSshRepo,
  updateRepo as reposUpdateRepo,
  type RepoConfig,
} from "./repos";
import type {
  OneShotEntry,
  RepoGitStatus,
  SessionEvent,
  SessionState,
  SessionTrace,
  TaggedSessionEvent,
} from "./types";
import { parsePlanProgress } from "./plan-progress";

const oneShotStore = new LazyStore("oneshot-entries.json");

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

  // --- Git Status ---
  gitStatus: Record<
    string,
    {
      status: RepoGitStatus | null;
      lastChecked: Date | null;
      loading: boolean;
      error: string | null;
    }
  >;
  fetchGitStatus: (
    repoId: string,
    repo: RepoConfig,
    fetch: boolean,
  ) => Promise<void>;
  clearGitStatusError: (repoId: string) => void;

  // --- 1-Shot ---
  oneShotEntries: Map<string, OneShotEntry>;
  runOneShot: (
    repoId: string,
    title: string,
    prompt: string,
    model: string,
    mergeStrategy: string,
    effortLevel: string,
    designEffortLevel: string,
  ) => Promise<string | undefined>;
  dismissOneShot: (oneshotId: string) => Promise<void>;
  saveOneShotEntries: () => Promise<void>;
  loadOneShotEntries: () => Promise<void>;
  resumeOneShot: (oneshotId: string) => Promise<void>;

  // --- Init ---
  initialize: () => () => void;
}

export const useAppStore = create<AppStore>((set, get) => {
  const recoveryInFlight = new Set<string>();

  async function syncActiveSession() {
    console.debug("[store] invoking get_active_sessions");
    const activePairs =
      (await invoke<[string, string][]>("get_active_sessions")) ?? [];
    const activeMap = new Map<string, string>(activePairs);
    const sessions = get().sessions;
    const next = new Map(sessions);

    for (const [repoId, session] of sessions) {
      if (session.running && !activeMap.has(repoId)) {
        next.set(repoId, { ...session, running: false });
      }
    }

    for (const [repoId, sessionId] of activeMap) {
      const existing = sessions.get(repoId);
      if (!existing || !existing.running) {
        next.set(repoId, {
          running: true,
          session_id: sessionId,
          disconnected: false,
          reconnecting: false,
          events: existing?.events ?? [],
          trace: null,
          error: null,
        });
      } else if (existing.running && existing.session_id !== sessionId) {
        next.set(repoId, { ...existing, session_id: sessionId });
      }
    }

    set({ sessions: next });

    // One-shot entry reconciliation: mark stale running entries as failed
    const oneShotEntries = get().oneShotEntries;
    const nextOneShot = new Map(oneShotEntries);
    let oneShotChanged = false;
    for (const [key, entry] of oneShotEntries) {
      if (entry.status === "running" && !activeMap.has(key)) {
        nextOneShot.set(key, { ...entry, status: "failed" });
        oneShotChanged = true;
      }
    }
    if (oneShotChanged) {
      set({ oneShotEntries: nextOneShot });
      oneShotStore
        .set("oneshot-entries", [...nextOneShot])
        .then(() => oneShotStore.save())
        .catch((e) =>
          console.warn("[store] failed to persist oneshot entries:", e),
        );
    }

    // Event recovery: load historical events from disk for running sessions
    for (const [repoId, session] of next) {
      if (
        session.running &&
        session.session_id &&
        !recoveryInFlight.has(repoId)
      ) {
        const sessionId = session.session_id;
        recoveryInFlight.add(repoId);
        invoke<SessionEvent[]>("get_trace_events", { repoId, sessionId })
          .then((events) => {
            recoveryInFlight.delete(repoId);
            if (events && events.length > 0) {
              const s = new Map(get().sessions);
              const current = s.get(repoId);
              if (current && events.length > current.events.length) {
                s.set(repoId, { ...current, events });
                set({ sessions: s });
              }
            }
          })
          .catch((e) => {
            recoveryInFlight.delete(repoId);
            console.warn("Failed to load trace events for", repoId, e);
          });
      }
    }
  }

  return {
    repos: [],
    sessions: new Map(),
    latestTraces: new Map(),
    oneShotEntries: new Map(),
    gitStatus: {},

    initialize: () => {
      // 1. Load repos
      reposLoadRepos()
        .then((repos) => {
          set({ repos });
        })
        .catch((e) => console.warn("[store] failed to load repos:", e));

      // 2. Load 1-shot entries, then recover events for entries with session_id
      get()
        .loadOneShotEntries()
        .then(() => {
          const entries = get().oneShotEntries;
          for (const [entryId, entry] of entries) {
            if (!entry.session_id || recoveryInFlight.has(entryId)) continue;
            const sessionId = entry.session_id;
            recoveryInFlight.add(entryId);

            // Recover events
            invoke<SessionEvent[]>("get_trace_events", {
              repoId: entryId,
              sessionId,
            })
              .then((events) => {
                if (events && events.length > 0) {
                  const s = new Map(get().sessions);
                  const current = s.get(entryId) ?? {
                    running: false,
                    session_id: sessionId,
                    disconnected: false,
                    reconnecting: false,
                    events: [],
                    trace: null,
                    error: null,
                  };
                  s.set(entryId, { ...current, events });
                  set({ sessions: s });
                }
              })
              .catch((e) => {
                console.warn(
                  "Failed to load one-shot trace events for",
                  entryId,
                  e,
                );
              })
              .finally(() => {
                recoveryInFlight.delete(entryId);
              });

            // Recover trace (separate call, runs in parallel)
            invoke<SessionTrace>("get_trace", { repoId: entryId, sessionId })
              .then((trace) => {
                if (trace) {
                  const s = new Map(get().sessions);
                  const current = s.get(entryId) ?? {
                    running: false,
                    session_id: sessionId,
                    disconnected: false,
                    reconnecting: false,
                    events: [],
                    trace: null,
                    error: null,
                  };
                  const planProgress = trace.plan_content
                    ? parsePlanProgress(trace.plan_content)
                    : current.planProgress;
                  s.set(entryId, { ...current, trace, planProgress });
                  set({ sessions: s });

                  // Update entry status if trace outcome indicates completed or failed
                  if (
                    trace.outcome === "completed" ||
                    trace.outcome === "failed"
                  ) {
                    const oneshotEntries = new Map(get().oneShotEntries);
                    const currentEntry = oneshotEntries.get(entryId);
                    if (currentEntry && currentEntry.status !== trace.outcome) {
                      oneshotEntries.set(entryId, {
                        ...currentEntry,
                        status: trace.outcome as "completed" | "failed",
                      });
                      set({ oneShotEntries: oneshotEntries });
                      oneShotStore
                        .set("oneshot-entries", [...oneshotEntries])
                        .then(() => oneShotStore.save())
                        .catch((e) =>
                          console.warn(
                            "[store] failed to persist oneshot entries:",
                            e,
                          ),
                        );
                    }
                  }
                }
              })
              .catch((e) => {
                console.warn("Failed to load one-shot trace for", entryId, e);
              });
          }

          // Reconcile: discover oneshot traces on disk not in oneShotEntries
          invoke<SessionTrace[]>("list_traces", { repoId: null })
            .then((traces) => {
              if (!traces || traces.length === 0) return;
              const currentEntries = get().oneShotEntries;
              const reconciled = new Map(currentEntries);
              let changed = false;
              for (const trace of traces) {
                if (
                  trace.session_type !== "one_shot" ||
                  !trace.repo_id ||
                  !trace.repo_id.startsWith("oneshot-") ||
                  reconciled.has(trace.repo_id)
                )
                  continue;
                const stub: OneShotEntry = {
                  id: trace.repo_id,
                  parentRepoId: "unknown",
                  parentRepoName: "Unknown",
                  title: trace.prompt.slice(0, 80),
                  prompt: trace.prompt,
                  model: "unknown",
                  effortLevel: "medium",
                  designEffortLevel: "high",
                  mergeStrategy: "branch",
                  status:
                    trace.outcome === "completed" ? "completed" : "failed",
                  startedAt: new Date(trace.start_time).getTime(),
                  session_id: trace.session_id,
                };
                reconciled.set(trace.repo_id, stub);
                changed = true;
              }
              if (changed) {
                set({ oneShotEntries: reconciled });
                oneShotStore
                  .set("oneshot-entries", [...reconciled])
                  .then(() => oneShotStore.save())
                  .catch((e) =>
                    console.warn(
                      "[store] failed to persist reconciled oneshot entries:",
                      e,
                    ),
                  );
              }
            })
            .catch((e) =>
              console.warn(
                "[store] failed to reconcile oneshot traces from disk:",
                e,
              ),
            );
        })
        .catch((e: unknown) =>
          console.warn("[store] failed to load oneshot entries:", e),
        );

      // 3. Load latest traces
      invoke<Record<string, SessionTrace>>("list_latest_traces")
        .then((result) => {
          if (result) {
            const tracesMap = new Map<string, SessionTrace>(
              Object.entries(result),
            );
            set({ latestTraces: tracesMap });
          }
        })
        .catch((e) => console.warn("[store] failed to load latest traces:", e));

      // 4. Listen for session events
      const listenPromise = listen<TaggedSessionEvent>(
        "session-event",
        (event) => {
          const { repo_id, event: sessionEvent } = event.payload;
          sessionEvent._ts = Date.now();
          console.debug("[store] session-event received", {
            repo_id,
            kind: sessionEvent.kind,
          });

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
            console.debug("[store] session disconnected", { repo_id });
            updates.disconnected = true;
            updates.reconnecting = false;
            updates.disconnectReason = sessionEvent.reason;
          } else if (sessionEvent.kind === "reconnecting") {
            console.debug("[store] session reconnecting", { repo_id });
            updates.reconnecting = true;
            updates.disconnected = false;
          } else if (sessionEvent.kind === "session_complete") {
            console.debug("[store] session complete", { repo_id });
            console.debug("[store] session running state changed", {
              repoId: repo_id,
              running: false,
            });
            updates.running = false;
            updates.disconnected = false;
            updates.reconnecting = false;
            updates.disconnectReason = undefined;

            // Auto-move plan to completed directory on successful completion
            if (
              sessionEvent.outcome === "completed" &&
              sessionEvent.plan_file
            ) {
              const repo = get().repos.find((r) => r.id === repo_id);
              if (repo && (repo.movePlansToCompleted ?? true)) {
                const plansDir = repo.plansDir || "docs/plans/";
                const filename =
                  sessionEvent.plan_file.split("/").pop() ||
                  sessionEvent.plan_file;
                const repoPayload =
                  repo.type === "local"
                    ? { type: "local" as const, path: repo.path }
                    : {
                        type: "ssh" as const,
                        sshHost: (repo as Extract<RepoConfig, { type: "ssh" }>)
                          .sshHost,
                        remotePath: (
                          repo as Extract<RepoConfig, { type: "ssh" }>
                        ).remotePath,
                      };
                console.log("session plan move triggered:", {
                  repo_id,
                  filename,
                  plansDir,
                });
                invoke("move_plan_to_completed", {
                  repo: repoPayload,
                  plansDir,
                  filename,
                }).catch((e) => console.warn("Failed to move plan:", e));
              } else if (!repo) {
                console.log(
                  "session plan move skipped: parent repo not found",
                  { repo_id },
                );
              }
            } else {
              console.log("session plan move skipped:", {
                repo_id,
                reason: !sessionEvent.plan_file
                  ? "no plan_file"
                  : "outcome is not completed",
                outcome: sessionEvent.outcome,
              });
            }

            if (sessionEvent.plan_file) {
              saveRecent("promptFiles", sessionEvent.plan_file);
            }

            const sessionId = session.session_id;
            if (sessionId) {
              invoke<SessionTrace>("get_trace", { repoId: repo_id, sessionId })
                .then((trace) => {
                  const s = new Map(get().sessions);
                  const current = s.get(repo_id);
                  if (current) {
                    const planProgress = trace.plan_content
                      ? parsePlanProgress(trace.plan_content)
                      : current.planProgress;
                    s.set(repo_id, { ...current, trace, planProgress });
                    const lt = new Map(get().latestTraces);
                    lt.set(repo_id, trace);
                    set({ sessions: s, latestTraces: lt });
                  }
                })
                .catch((e) => {
                  console.warn("Failed to fetch trace for", repo_id, e);
                });
            }
          } else if (session.disconnected || session.reconnecting) {
            updates.disconnected = false;
            updates.reconnecting = false;
            updates.disconnectReason = undefined;
          }

          if (
            sessionEvent.kind === "plan_content_updated" &&
            sessionEvent.plan_content
          ) {
            updates.planProgress = parsePlanProgress(sessionEvent.plan_content);
          }

          const next = new Map(get().sessions);
          next.set(repo_id, { ...session, ...updates });
          set({ sessions: next });

          // Save worktree path and branch from one_shot_started event
          if (sessionEvent.kind === "one_shot_started") {
            const oneshotEntries = new Map(get().oneShotEntries);
            const entry = oneshotEntries.get(repo_id);
            if (entry) {
              oneshotEntries.set(repo_id, {
                ...entry,
                worktreePath: sessionEvent.worktree_path,
                branch: sessionEvent.branch,
              });
              set({ oneShotEntries: oneshotEntries });
              oneShotStore
                .set("oneshot-entries", [...oneshotEntries])
                .then(() => oneShotStore.save())
                .catch((e) =>
                  console.warn("[store] failed to persist oneshot entries:", e),
                );
            }
          }

          // Update 1-shot entry status
          if (
            sessionEvent.kind === "one_shot_complete" ||
            sessionEvent.kind === "one_shot_failed"
          ) {
            const oneshotEntries = new Map(get().oneShotEntries);
            const entry = oneshotEntries.get(repo_id);
            if (entry) {
              const newStatus =
                sessionEvent.kind === "one_shot_complete"
                  ? "completed"
                  : "failed";
              console.debug("[store] oneshot status changed", {
                repoId: repo_id,
                status: newStatus,
              });
              oneshotEntries.set(repo_id, {
                ...entry,
                status: newStatus as "completed" | "failed",
              });

              // Fetch trace on oneshot completion
              if (newStatus === "completed") {
                const sessionId = session.session_id ?? entry?.session_id;
                if (sessionId) {
                  invoke<SessionTrace>("get_trace", {
                    repoId: repo_id,
                    sessionId,
                  })
                    .then((trace) => {
                      const s = new Map(get().sessions);
                      const current = s.get(repo_id);
                      if (current) {
                        const planProgress = trace.plan_content
                          ? parsePlanProgress(trace.plan_content)
                          : current.planProgress;
                        s.set(repo_id, { ...current, trace, planProgress });
                        const lt = new Map(get().latestTraces);
                        lt.set(repo_id, trace);
                        set({ sessions: s, latestTraces: lt });
                      }
                    })
                    .catch((e) =>
                      console.warn(
                        "Failed to fetch oneshot trace:",
                        repo_id,
                        e,
                      ),
                    );
                }
              }

              // Prune completed/failed to keep last 50
              const finished = [...oneshotEntries.entries()]
                .filter(
                  ([, e]) => e.status === "completed" || e.status === "failed",
                )
                .sort(([, a], [, b]) => b.startedAt - a.startedAt);
              if (finished.length > 50) {
                for (const [key] of finished.slice(50)) {
                  oneshotEntries.delete(key);
                }
              }

              set({ oneShotEntries: oneshotEntries });
              oneShotStore
                .set("oneshot-entries", [...oneshotEntries])
                .then(() => oneShotStore.save())
                .catch((e) =>
                  console.warn("[store] failed to persist oneshot entries:", e),
                );
            }
          }

          // Plan move for oneshots is handled in the Rust backend (OneShotRunner::run)
          if (sessionEvent.kind === "one_shot_complete") {
            console.debug("1-shot complete", { repo_id });
          }
        },
      );

      // 4b. Listen for env warning events
      const envWarningPromise = listen<string>("env-warning", (event) => {
        console.warn("[store] env-warning received:", event.payload);
        toast.warning(event.payload, { id: "env-warning" });
      });

      // 5. Start sync interval
      const intervalId = setInterval(() => {
        syncActiveSession();
      }, 5000);

      // 6. Return cleanup function
      return () => {
        listenPromise.then((fn) => fn());
        envWarningPromise.then((fn) => fn());
        clearInterval(intervalId);
      };
    },

    fetchGitStatus: async (
      repoId: string,
      repo: RepoConfig,
      fetch: boolean,
    ) => {
      const existing = get().gitStatus[repoId];
      set({
        gitStatus: {
          ...get().gitStatus,
          [repoId]: {
            status: existing?.status ?? null,
            lastChecked: existing?.lastChecked ?? null,
            loading: true,
            error: existing?.error ?? null,
          },
        },
      });

      const repoPayload =
        repo.type === "local"
          ? { type: "local" as const, path: repo.path }
          : {
              type: "ssh" as const,
              sshHost: (repo as Extract<RepoConfig, { type: "ssh" }>).sshHost,
              remotePath: (repo as Extract<RepoConfig, { type: "ssh" }>)
                .remotePath,
            };

      try {
        const status = await invoke<RepoGitStatus>("get_repo_git_status", {
          repo: repoPayload,
          fetch,
        });
        set({
          gitStatus: {
            ...get().gitStatus,
            [repoId]: {
              status,
              lastChecked: new Date(),
              loading: false,
              error: null,
            },
          },
        });
      } catch (e) {
        const prev = get().gitStatus[repoId];
        set({
          gitStatus: {
            ...get().gitStatus,
            [repoId]: {
              status: prev?.status ?? null,
              lastChecked: prev?.lastChecked ?? null,
              loading: false,
              error: e instanceof Error ? e.message : String(e),
            },
          },
        });
      }
    },

    clearGitStatusError: (repoId: string) => {
      const existing = get().gitStatus[repoId];
      if (!existing) return;
      set({
        gitStatus: {
          ...get().gitStatus,
          [repoId]: { ...existing, error: null },
        },
      });
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

    runOneShot: async (
      repoId,
      title,
      prompt,
      model,
      mergeStrategy,
      effortLevel,
      designEffortLevel,
    ) => {
      const repo = get().repos.find((r) => r.id === repoId);
      if (!repo) return undefined;

      // Create a temporary ID for the entry before we get the real oneshot_id back
      const tempId = `temp-${Date.now()}`;
      const entry: OneShotEntry = {
        id: tempId,
        parentRepoId: repoId,
        parentRepoName: repo.name,
        title,
        prompt,
        model,
        effortLevel,
        designEffortLevel,
        mergeStrategy,
        status: "running",
        startedAt: Date.now(),
      };

      // Add to entries with temp key
      const next = new Map(get().oneShotEntries);
      next.set(tempId, entry);
      set({ oneShotEntries: next });

      try {
        const repoPayload =
          repo.type === "local"
            ? { type: "local" as const, path: repo.path }
            : {
                type: "ssh" as const,
                sshHost: (repo as Extract<RepoConfig, { type: "ssh" }>).sshHost,
                remotePath: (repo as Extract<RepoConfig, { type: "ssh" }>)
                  .remotePath,
              };

        console.debug("[store] invoking run_oneshot", { repoId, title });
        const result = await invoke<{ oneshot_id: string; session_id: string }>(
          "run_oneshot",
          {
            repoId,
            repo: repoPayload,
            title,
            prompt,
            model,
            mergeStrategy,
            effortLevel,
            designEffortLevel,
            envVars: repo.envVars ?? {},
            maxIterations: repo.maxIterations,
            completionSignal: repo.completionSignal,
            checks: repo.checks ?? [],
            gitSync: repo.gitSync,
            plansDir: repo.plansDir || "docs/plans/",
            movePlansToCompleted: repo.movePlansToCompleted ?? true,
            designPromptFile: repo.designPromptFile || null,
            implementationPromptFile: repo.implementationPromptFile || null,
          },
        );

        // Replace temp entry with real oneshot_id
        console.debug("[store] oneshot ID swapped", {
          tempId,
          realId: result.oneshot_id,
        });
        const entries = new Map(get().oneShotEntries);
        entries.delete(tempId);
        const realEntry = {
          ...entry,
          id: result.oneshot_id,
          session_id: result.session_id,
        };
        entries.set(result.oneshot_id, realEntry);
        // Initialize session state (matches resumeOneShot pattern)
        const s = new Map(get().sessions);
        s.set(result.oneshot_id, {
          running: true,
          session_id: result.session_id,
          disconnected: false,
          reconnecting: false,
          events: [],
          trace: null,
          error: null,
        });
        set({ oneShotEntries: entries, sessions: s });
        oneShotStore
          .set("oneshot-entries", [...entries])
          .then(() => oneShotStore.save())
          .catch((e) =>
            console.warn("[store] failed to persist oneshot entries:", e),
          );

        return result.oneshot_id;
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        toast.error(`Failed to launch 1-shot: ${errorMsg}`);
        // Mark as failed
        const entries = new Map(get().oneShotEntries);
        const current = entries.get(tempId);
        if (current) {
          entries.set(tempId, { ...current, status: "failed" });
          set({ oneShotEntries: entries });
          oneShotStore
            .set("oneshot-entries", [...entries])
            .then(() => oneShotStore.save())
            .catch((e) =>
              console.warn("[store] failed to persist oneshot entries:", e),
            );
        }
        return undefined;
      }
    },

    saveOneShotEntries: async () => {
      const entries = get().oneShotEntries;
      await oneShotStore.set("oneshot-entries", [...entries]);
      await oneShotStore.save();
    },

    loadOneShotEntries: async () => {
      const raw =
        await oneShotStore.get<[string, OneShotEntry][]>("oneshot-entries");
      if (raw) {
        set({ oneShotEntries: new Map(raw) });
      }
    },

    dismissOneShot: async (oneshotId: string) => {
      const entries = new Map(get().oneShotEntries);
      entries.delete(oneshotId);
      set({ oneShotEntries: entries });
      await oneShotStore.set("oneshot-entries", [...entries]);
      await oneShotStore.save();
    },

    async resumeOneShot(oneshotId: string) {
      const entry = get().oneShotEntries.get(oneshotId);
      if (!entry) return;
      if (entry.status === "running") return;

      const repo = get().repos.find((r) => r.id === entry.parentRepoId);
      if (!repo) {
        toast.error("Parent repo not found");
        return;
      }

      if (!entry.worktreePath || !entry.branch) {
        toast.error("Cannot resume: missing worktree path or branch");
        return;
      }

      const repoPayload =
        repo.type === "local"
          ? { type: "local" as const, path: repo.path }
          : {
              type: "ssh" as const,
              sshHost: (repo as Extract<RepoConfig, { type: "ssh" }>).sshHost,
              remotePath: (repo as Extract<RepoConfig, { type: "ssh" }>)
                .remotePath,
            };

      try {
        console.debug("[store] invoking resume_oneshot", {
          repoId: entry.parentRepoId,
        });
        const result = await invoke<{ oneshot_id: string; session_id: string }>(
          "resume_oneshot",
          {
            oneshotId,
            repoId: entry.parentRepoId,
            repo: repoPayload,
            title: entry.title,
            prompt: entry.prompt,
            model: entry.model,
            effortLevel: entry.effortLevel,
            designEffortLevel: entry.designEffortLevel,
            mergeStrategy: entry.mergeStrategy,
            envVars: repo.envVars ?? {},
            maxIterations: repo.maxIterations,
            completionSignal: repo.completionSignal,
            checks: repo.checks ?? [],
            gitSync: repo.gitSync,
            plansDir: repo.plansDir || "docs/plans/",
            movePlansToCompleted: repo.movePlansToCompleted ?? true,
            worktreePath: entry.worktreePath,
            branch: entry.branch,
            oldSessionId: entry.session_id ?? "",
            designPromptFile: repo.designPromptFile || null,
            implementationPromptFile: repo.implementationPromptFile || null,
          },
        );

        // Update entry status to running with new session_id
        const entries = new Map(get().oneShotEntries);
        const current = entries.get(oneshotId);
        if (current) {
          entries.set(oneshotId, {
            ...current,
            status: "running",
            session_id: result.session_id,
          });
          set({ oneShotEntries: entries });
          oneShotStore
            .set("oneshot-entries", [...entries])
            .then(() => oneShotStore.save())
            .catch((e) =>
              console.warn("[store] failed to persist oneshot entries:", e),
            );
        }

        // Set up session state
        const next = new Map(get().sessions);
        next.set(oneshotId, {
          running: true,
          session_id: result.session_id,
          disconnected: false,
          reconnecting: false,
          events: [],
          trace: null,
          error: null,
        });
        set({ sessions: next });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },

    runSession: async (repoId: string, planFile: string) => {
      const repo = get().repos.find((r) => r.id === repoId);
      if (!repo) return;

      const next = new Map(get().sessions);
      next.set(repoId, {
        running: true,
        disconnected: false,
        reconnecting: false,
        events: [],
        trace: null,
        error: null,
      });
      console.debug("[store] session running state changed", {
        repoId,
        running: true,
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

        console.debug("[store] invoking run_session", { repoId });
        const { session_id } = await invoke<{ session_id: string }>(
          "run_session",
          {
            repoId,
            repo: repoPayload,
            planFile,
            model: repo.model,
            effortLevel: repo.effortLevel ?? "medium",
            maxIterations: repo.maxIterations,
            completionSignal: repo.completionSignal,
            envVars: repo.envVars ?? {},
            checks: repo.checks ?? [],
            gitSync: repo.gitSync,
            createBranch: repo.createBranch ?? true,
            implementationPromptFile: repo.implementationPromptFile || null,
          },
        );

        const s2 = new Map(get().sessions);
        const current = s2.get(repoId);
        if (!current) return;
        s2.set(repoId, { ...current, session_id });
        set({ sessions: s2 });
      } catch (e) {
        const s2 = new Map(get().sessions);
        const current = s2.get(repoId);
        if (!current) return;
        console.debug("[store] session running state changed", {
          repoId,
          running: false,
        });
        s2.set(repoId, {
          ...current,
          running: false,
          error: e instanceof Error ? e.message : String(e),
        });
        set({ sessions: s2 });
      }
    },

    stopSession: async (repoId: string) => {
      console.debug("[store] invoking stop_session", { repoId });
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
        console.debug("[store] invoking reconnect_session", { repoId });
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
