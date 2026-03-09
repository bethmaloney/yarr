import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RepoConfig } from "../repos";
import type { BranchInfo } from "../types";

export function useBranchInfo(repos: RepoConfig[]): Map<string, BranchInfo> {
  const [branchInfos, setBranchInfos] = useState<Map<string, BranchInfo>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;

    async function fetchAllBranchInfo() {
      const results = await Promise.allSettled(
        repos.map(async (repo) => {
          const payload =
            repo.type === "local"
              ? { type: "local" as const, path: repo.path }
              : {
                  type: "ssh" as const,
                  sshHost: repo.sshHost,
                  remotePath: repo.remotePath,
                };
          const info = await invoke<BranchInfo>("get_branch_info", {
            repo: payload,
          });
          return { id: repo.id, info };
        }),
      );

      if (cancelled) return;

      const next = new Map<string, BranchInfo>();
      for (const r of results) {
        if (r.status === "fulfilled") {
          next.set(r.value.id, r.value.info);
        }
      }
      setBranchInfos(next);
    }

    fetchAllBranchInfo();
    return () => {
      cancelled = true;
    };
  }, [repos]);

  return branchInfos;
}
