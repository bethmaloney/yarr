import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect, useCallback } from "react";
import type { RepoConfig } from "../repos";
import type { YarrYmlConfig } from "../config";
import type { Check, GitSyncConfig } from "../types";

type IpcYarrConfigResult = {
  config: {
    model?: string;
    effortLevel?: string;
    designEffortLevel?: string;
    maxIterations?: number;
    completionSignal?: string;
    createBranch?: boolean;
    autoFetch?: boolean;
    plansDir?: string;
    movePlansToCompleted?: boolean;
    designPromptFile?: string;
    implementationPromptFile?: string;
    env?: Record<string, string>;
    checks?: Check[];
    gitSync?: GitSyncConfig;
  } | null;
  error: string | null;
};

export function useYarrConfig(repo: RepoConfig | null): {
  config: YarrYmlConfig | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [config, setConfig] = useState<YarrYmlConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [fetchCount, setFetchCount] = useState(0);

  const refresh = useCallback(() => {
    setFetchCount((c) => c + 1);
  }, []);

  useEffect(() => {
    if (!repo) {
      setConfig(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    invoke<IpcYarrConfigResult>("read_yarr_config", { repo })
      .then((result) => {
        if (cancelled) return;
        if (result.config) {
          const { env, ...rest } = result.config;
          const mapped: YarrYmlConfig = {
            ...rest,
            ...(env !== undefined ? { envVars: env } : {}),
          };
          setConfig(mapped);
          setError(null);
        } else {
          setConfig(null);
          setError(result.error);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConfig(null);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [repo?.id, fetchCount]);

  return { config, error, loading, refresh };
}
