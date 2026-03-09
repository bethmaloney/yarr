import { describe, it, expect } from "vitest";
import type { RepoConfig } from "./repos";

/**
 * Mirrors the saveSettings() logic in RepoDetail.svelte.
 * Takes the current repo config and local settings state, returns the updated config.
 */
function buildSettingsUpdate(
  repo: RepoConfig,
  settings: {
    model: string;
    maxIterations: number;
    completionSignal: string;
    envVars: { key: string; value: string }[];
    checks: {
      name: string;
      command: string;
      when: "each_iteration" | "post_completion";
      timeoutSecs: number;
      maxRetries: number;
    }[];
    createBranch: boolean;
    plansDir: string;
    gitSyncEnabled: boolean;
    gitSyncModel: string;
    gitSyncMaxRetries: number;
    gitSyncPrompt: string;
  },
): RepoConfig {
  const envVarsRecord: Record<string, string> = {};
  for (const { key, value } of settings.envVars) {
    if (key.trim()) envVarsRecord[key.trim()] = value;
  }
  return {
    ...repo,
    model: settings.model,
    maxIterations: settings.maxIterations,
    completionSignal: settings.completionSignal,
    envVars: envVarsRecord,
    checks: settings.checks,
    createBranch: settings.createBranch,
    plansDir: settings.plansDir || undefined,
    gitSync: {
      enabled: settings.gitSyncEnabled,
      model: settings.gitSyncModel || undefined,
      maxPushRetries: settings.gitSyncMaxRetries,
      conflictPrompt: settings.gitSyncPrompt || undefined,
    },
  } as RepoConfig;
}

/** Helper to create a minimal RepoConfig for testing. */
function makeRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    type: "local",
    id: "repo-1",
    path: "/home/user/projects/my-app",
    name: "my-app",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

/** Helper to create default settings state for testing. */
function makeSettings(
  overrides: Partial<Parameters<typeof buildSettingsUpdate>[1]> = {},
): Parameters<typeof buildSettingsUpdate>[1] {
  return {
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    envVars: [],
    checks: [],
    createBranch: true,
    plansDir: "",
    gitSyncEnabled: false,
    gitSyncModel: "",
    gitSyncMaxRetries: 3,
    gitSyncPrompt: "",
    ...overrides,
  };
}

describe("createBranch ?? true defaults", () => {
  it("defaults to true when repo.createBranch is undefined", () => {
    const repo = makeRepo(); // createBranch not set, so undefined
    const defaulted = repo.createBranch ?? true;
    expect(defaulted).toBe(true);
  });

  it("preserves false when repo.createBranch is false", () => {
    const repo = makeRepo({ createBranch: false });
    const defaulted = repo.createBranch ?? true;
    expect(defaulted).toBe(false);
  });

  it("preserves true when repo.createBranch is true", () => {
    const repo = makeRepo({ createBranch: true });
    const defaulted = repo.createBranch ?? true;
    expect(defaulted).toBe(true);
  });
});

describe("buildSettingsUpdate createBranch handling", () => {
  it("includes createBranch: true in result when settings has createBranch true", () => {
    const repo = makeRepo();
    const result = buildSettingsUpdate(
      repo,
      makeSettings({ createBranch: true }),
    );
    expect(result.createBranch).toBe(true);
  });

  it("includes createBranch: false in result when settings has createBranch false", () => {
    const repo = makeRepo();
    const result = buildSettingsUpdate(
      repo,
      makeSettings({ createBranch: false }),
    );
    expect(result.createBranch).toBe(false);
  });

  it("preserves all other repo fields while adding createBranch", () => {
    const repo = makeRepo({
      id: "repo-42",
      name: "special-project",
      model: "sonnet",
      maxIterations: 20,
      completionSignal: "DONE",
      envVars: { EXISTING: "var" },
    });

    const result = buildSettingsUpdate(
      repo,
      makeSettings({
        model: "haiku",
        maxIterations: 10,
        completionSignal: "FINISHED",
        createBranch: false,
        envVars: [{ key: "API_KEY", value: "secret" }],
        checks: [
          {
            name: "lint",
            command: "npm run lint",
            when: "each_iteration",
            timeoutSecs: 60,
            maxRetries: 2,
          },
        ],
        gitSyncEnabled: true,
        gitSyncModel: "sonnet",
        gitSyncMaxRetries: 5,
        gitSyncPrompt: "resolve conflicts",
      }),
    );

    // Repo identity fields preserved from the original repo
    expect(result.id).toBe("repo-42");
    expect(result.name).toBe("special-project");
    expect(result.type).toBe("local");
    if (result.type === "local") {
      expect(result.path).toBe("/home/user/projects/my-app");
    }

    // Settings fields updated from the settings input
    expect(result.model).toBe("haiku");
    expect(result.maxIterations).toBe(10);
    expect(result.completionSignal).toBe("FINISHED");
    expect(result.createBranch).toBe(false);
    expect(result.envVars).toEqual({ API_KEY: "secret" });
    expect(result.checks).toEqual([
      {
        name: "lint",
        command: "npm run lint",
        when: "each_iteration",
        timeoutSecs: 60,
        maxRetries: 2,
      },
    ]);
    expect(result.gitSync).toEqual({
      enabled: true,
      model: "sonnet",
      maxPushRetries: 5,
      conflictPrompt: "resolve conflicts",
    });
  });
});

describe("buildSettingsUpdate plansDir handling", () => {
  it("includes plansDir in result when non-empty", () => {
    const repo = makeRepo();
    const result = buildSettingsUpdate(
      repo,
      makeSettings({ plansDir: "docs/plans/" }),
    );
    expect(result.plansDir).toBe("docs/plans/");
  });

  it("sets plansDir to undefined when empty string", () => {
    const repo = makeRepo();
    const result = buildSettingsUpdate(repo, makeSettings({ plansDir: "" }));
    expect(result.plansDir).toBeUndefined();
  });

  it("includes custom plansDir path", () => {
    const repo = makeRepo();
    const result = buildSettingsUpdate(
      repo,
      makeSettings({ plansDir: ".yarr/plans/" }),
    );
    expect(result.plansDir).toBe(".yarr/plans/");
  });

  it("preserves all other fields when plansDir is set", () => {
    const repo = makeRepo({
      id: "repo-pd-all",
      name: "pd-project",
    });
    const result = buildSettingsUpdate(
      repo,
      makeSettings({
        model: "sonnet",
        maxIterations: 15,
        completionSignal: "FINISHED",
        createBranch: false,
        plansDir: "plans/",
        gitSyncEnabled: true,
        gitSyncModel: "haiku",
        gitSyncMaxRetries: 2,
        gitSyncPrompt: "fix conflicts",
      }),
    );

    expect(result.id).toBe("repo-pd-all");
    expect(result.name).toBe("pd-project");
    expect(result.model).toBe("sonnet");
    expect(result.maxIterations).toBe(15);
    expect(result.completionSignal).toBe("FINISHED");
    expect(result.createBranch).toBe(false);
    expect(result.plansDir).toBe("plans/");
    expect(result.gitSync).toEqual({
      enabled: true,
      model: "haiku",
      maxPushRetries: 2,
      conflictPrompt: "fix conflicts",
    });
  });
});
