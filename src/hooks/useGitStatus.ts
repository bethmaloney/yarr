import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../store";
import type { RepoConfig } from "../repos";
import type { SessionState } from "../types";

function shouldAutoFetch(repo: RepoConfig): boolean {
  if (repo.autoFetch !== undefined) return repo.autoFetch;
  return repo.type === "local";
}

export function useGitStatus(
  repos: RepoConfig[],
  sessions: Map<string, SessionState>,
): { refresh: (repoId: string) => void } {
  const fetchGitStatus = useAppStore((s) => s.fetchGitStatus);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevSessionsRef = useRef<Map<string, SessionState>>(new Map());
  const reposRef = useRef(repos);
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    reposRef.current = repos;
    sessionsRef.current = sessions;
  });

  // On mount / when repos change: fetch status for all repos
  useEffect(() => {
    for (const repo of repos) {
      fetchGitStatus(repo.id, repo, shouldAutoFetch(repo));
    }
  }, [repos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling interval: every 30s for eligible repos
  useEffect(() => {
    const id = setInterval(() => {
      for (const repo of reposRef.current) {
        if (
          shouldAutoFetch(repo) &&
          !sessionsRef.current.get(repo.id)?.running
        ) {
          fetchGitStatus(repo.id, repo, true);
        }
      }
    }, 30_000);
    intervalRef.current = id;

    return () => {
      clearInterval(id);
      intervalRef.current = null;
    };
  }, [fetchGitStatus]); // truly stable deps only

  // Session completion detection
  useEffect(() => {
    const prev = prevSessionsRef.current;

    for (const repo of repos) {
      const prevSession = prev.get(repo.id);
      const currentSession = sessions.get(repo.id);

      if (
        prevSession?.running &&
        (!currentSession || !currentSession.running)
      ) {
        fetchGitStatus(repo.id, repo, true);
      }
    }

    prevSessionsRef.current = sessions;
  }, [sessions, repos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual refresh
  const refresh = useCallback(
    (repoId: string) => {
      const repo = repos.find((r) => r.id === repoId);
      if (repo) {
        fetchGitStatus(repoId, repo, true);
      }
    },
    [repos, fetchGitStatus],
  );

  return { refresh };
}
