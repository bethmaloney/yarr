import type { Check, GitSyncConfig } from "./types";

export const DEFAULTS = {
  model: "opus",
  effortLevel: "medium",
  designEffortLevel: "high",
  maxIterations: 40,
  completionSignal: "<promise>COMPLETE</promise>",
  createBranch: true,
  autoFetch: false,
  plansDir: "docs/plans/",
  movePlansToCompleted: true,
  designPromptFile: "",
  implementationPromptFile: "",
} as const;

export type YarrYmlConfig = {
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
  envVars?: Record<string, string>;
  checks?: Check[];
  gitSync?: GitSyncConfig;
};

export type ConfigSource = "override" | "yarr-yml" | "default";

export type Resolved<T> = {
  value: T;
  source: ConfigSource;
};

export type ResolvedConfig = {
  model: Resolved<string>;
  effortLevel: Resolved<string>;
  designEffortLevel: Resolved<string>;
  maxIterations: Resolved<number>;
  completionSignal: Resolved<string>;
  createBranch: Resolved<boolean>;
  autoFetch: Resolved<boolean>;
  plansDir: Resolved<string>;
  movePlansToCompleted: Resolved<boolean>;
  designPromptFile: Resolved<string>;
  implementationPromptFile: Resolved<string>;
  envVars: Resolved<Record<string, string> | undefined>;
  checks: Resolved<Check[] | undefined>;
  gitSync: Resolved<GitSyncConfig | undefined>;
};

export function resolve<T>(
  override: T | undefined,
  yarrYml: T | undefined,
  fallback: T,
): Resolved<T> {
  if (override !== undefined) {
    return { value: override, source: "override" };
  }
  if (yarrYml !== undefined) {
    return { value: yarrYml, source: "yarr-yml" };
  }
  return { value: fallback, source: "default" };
}

export function resolveConfig(
  repo: Partial<YarrYmlConfig>,
  yarrYml: YarrYmlConfig | null,
  defaults: typeof DEFAULTS,
): ResolvedConfig {
  const yml = yarrYml ?? {};
  return {
    model: resolve(repo.model, yml.model, defaults.model),
    effortLevel: resolve(
      repo.effortLevel,
      yml.effortLevel,
      defaults.effortLevel,
    ),
    designEffortLevel: resolve(
      repo.designEffortLevel,
      yml.designEffortLevel,
      defaults.designEffortLevel,
    ),
    maxIterations: resolve(
      repo.maxIterations,
      yml.maxIterations,
      defaults.maxIterations,
    ),
    completionSignal: resolve(
      repo.completionSignal,
      yml.completionSignal,
      defaults.completionSignal,
    ),
    createBranch: resolve(
      repo.createBranch,
      yml.createBranch,
      defaults.createBranch,
    ),
    autoFetch: resolve(repo.autoFetch, yml.autoFetch, defaults.autoFetch),
    plansDir: resolve(repo.plansDir, yml.plansDir, defaults.plansDir),
    movePlansToCompleted: resolve(
      repo.movePlansToCompleted,
      yml.movePlansToCompleted,
      defaults.movePlansToCompleted,
    ),
    designPromptFile: resolve(
      repo.designPromptFile,
      yml.designPromptFile,
      defaults.designPromptFile,
    ),
    implementationPromptFile: resolve(
      repo.implementationPromptFile,
      yml.implementationPromptFile,
      defaults.implementationPromptFile,
    ),
    envVars: resolve(repo.envVars, yml.envVars, undefined),
    checks: resolve(repo.checks, yml.checks, undefined),
    gitSync: resolve(repo.gitSync, yml.gitSync, undefined),
  };
}
