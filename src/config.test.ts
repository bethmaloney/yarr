import { describe, it, expect } from "vitest";

import {
  DEFAULTS,
  resolve,
  resolveConfig,
  type YarrYmlConfig,
  type ConfigSource,
} from "./config";
import type { Check, GitSyncConfig } from "./types";

describe("resolve", () => {
  it("override value wins over yarrYml and fallback", () => {
    const result = resolve("override-val", "yml-val", "fallback-val");
    expect(result.value).toBe("override-val");
  });

  it("yarrYml value wins when override is undefined", () => {
    const result = resolve(undefined, "yml-val", "fallback-val");
    expect(result.value).toBe("yml-val");
  });

  it("fallback used when both override and yarrYml are undefined", () => {
    const result = resolve(undefined, undefined, "fallback-val");
    expect(result.value).toBe("fallback-val");
  });

  it('source is "override" when override is set', () => {
    const result = resolve("override-val", "yml-val", "fallback-val");
    expect(result.source).toBe("override" satisfies ConfigSource);
  });

  it('source is "yarr-yml" when yarrYml is set but override is not', () => {
    const result = resolve(undefined, "yml-val", "fallback-val");
    expect(result.source).toBe("yarr-yml" satisfies ConfigSource);
  });

  it('source is "default" when neither is set', () => {
    const result = resolve(undefined, undefined, "fallback-val");
    expect(result.source).toBe("default" satisfies ConfigSource);
  });

  it("handles boolean false as a valid override (not treated as missing)", () => {
    const result = resolve(false, true, true);
    expect(result.value).toBe(false);
    expect(result.source).toBe("override");
  });

  it("handles number 0 as a valid override (not treated as missing)", () => {
    const result = resolve(0, 10, 20);
    expect(result.value).toBe(0);
    expect(result.source).toBe("override");
  });

  it("handles empty string as a valid override (not treated as missing)", () => {
    const result = resolve("", "yml-val", "fallback-val");
    expect(result.value).toBe("");
    expect(result.source).toBe("override");
  });
});

describe("resolveConfig", () => {
  it("returns all defaults when repo and yarrYml are empty", () => {
    const result = resolveConfig({}, null, DEFAULTS);
    expect(result.model.value).toBe("opus");
    expect(result.model.source).toBe("default");
    expect(result.effortLevel.value).toBe("medium");
    expect(result.effortLevel.source).toBe("default");
    expect(result.designEffortLevel.value).toBe("high");
    expect(result.designEffortLevel.source).toBe("default");
    expect(result.maxIterations.value).toBe(40);
    expect(result.maxIterations.source).toBe("default");
    expect(result.completionSignal.value).toBe("ALL TODO ITEMS COMPLETE");
    expect(result.completionSignal.source).toBe("default");
    expect(result.createBranch.value).toBe(true);
    expect(result.createBranch.source).toBe("default");
    expect(result.autoFetch.value).toBe(false);
    expect(result.autoFetch.source).toBe("default");
    expect(result.plansDir.value).toBe("docs/plans/");
    expect(result.plansDir.source).toBe("default");
    expect(result.movePlansToCompleted.value).toBe(true);
    expect(result.movePlansToCompleted.source).toBe("default");
    expect(result.designPromptFile.value).toBe("");
    expect(result.designPromptFile.source).toBe("default");
    expect(result.implementationPromptFile.value).toBe("");
    expect(result.implementationPromptFile.source).toBe("default");
  });

  it("yarrYml values override defaults", () => {
    const yarrYml: YarrYmlConfig = {
      model: "sonnet",
      maxIterations: 10,
      plansDir: "plans/",
    };
    const result = resolveConfig({}, yarrYml, DEFAULTS);
    expect(result.model.value).toBe("sonnet");
    expect(result.model.source).toBe("yarr-yml");
    expect(result.maxIterations.value).toBe(10);
    expect(result.maxIterations.source).toBe("yarr-yml");
    expect(result.plansDir.value).toBe("plans/");
    expect(result.plansDir.source).toBe("yarr-yml");
    // Unset fields still default
    expect(result.effortLevel.value).toBe("medium");
    expect(result.effortLevel.source).toBe("default");
  });

  it("repo values override yarrYml and defaults", () => {
    const yarrYml: YarrYmlConfig = {
      model: "sonnet",
      maxIterations: 10,
    };
    const repo = {
      model: "haiku",
      maxIterations: 5,
    };
    const result = resolveConfig(repo, yarrYml, DEFAULTS);
    expect(result.model.value).toBe("haiku");
    expect(result.model.source).toBe("override");
    expect(result.maxIterations.value).toBe(5);
    expect(result.maxIterations.source).toBe("override");
  });

  it("mixed sources: some from override, some from yarrYml, some from default", () => {
    const yarrYml: YarrYmlConfig = {
      effortLevel: "low",
      completionSignal: "DONE",
    };
    const repo = {
      model: "haiku",
    };
    const result = resolveConfig(repo, yarrYml, DEFAULTS);
    expect(result.model.value).toBe("haiku");
    expect(result.model.source).toBe("override");
    expect(result.effortLevel.value).toBe("low");
    expect(result.effortLevel.source).toBe("yarr-yml");
    expect(result.completionSignal.value).toBe("DONE");
    expect(result.completionSignal.source).toBe("yarr-yml");
    expect(result.maxIterations.value).toBe(40);
    expect(result.maxIterations.source).toBe("default");
  });

  it("null yarrYml works (treated as empty)", () => {
    const repo = { model: "haiku" };
    const result = resolveConfig(repo, null, DEFAULTS);
    expect(result.model.value).toBe("haiku");
    expect(result.model.source).toBe("override");
    expect(result.maxIterations.value).toBe(40);
    expect(result.maxIterations.source).toBe("default");
  });

  it("envVars from repo override with source tracking", () => {
    const repo = {
      envVars: { NODE_ENV: "test", DEBUG: "true" },
    };
    const result = resolveConfig(repo, null, DEFAULTS);
    expect(result.envVars.value).toEqual({ NODE_ENV: "test", DEBUG: "true" });
    expect(result.envVars.source).toBe("override");
  });

  it("envVars from yarrYml when repo has none", () => {
    const yarrYml: YarrYmlConfig = {
      envVars: { API_URL: "http://localhost:3000" },
    };
    const result = resolveConfig({}, yarrYml, DEFAULTS);
    expect(result.envVars.value).toEqual({
      API_URL: "http://localhost:3000",
    });
    expect(result.envVars.source).toBe("yarr-yml");
  });

  it("envVars defaults to undefined when neither repo nor yarrYml has it", () => {
    const result = resolveConfig({}, null, DEFAULTS);
    expect(result.envVars.value).toBeUndefined();
    expect(result.envVars.source).toBe("default");
  });

  it("envVars from repo override wins over yarrYml", () => {
    const repo = {
      envVars: { NODE_ENV: "production" },
    };
    const yarrYml: YarrYmlConfig = {
      envVars: { NODE_ENV: "development", EXTRA: "yes" },
    };
    const result = resolveConfig(repo, yarrYml, DEFAULTS);
    expect(result.envVars.value).toEqual({ NODE_ENV: "production" });
    expect(result.envVars.source).toBe("override");
  });

  it("checks from yarrYml with source tracking", () => {
    const checks: Check[] = [
      {
        name: "lint",
        command: "npm run lint",
        when: "each_iteration",
        timeoutSecs: 30,
        maxRetries: 2,
      },
    ];
    const yarrYml: YarrYmlConfig = { checks };
    const result = resolveConfig({}, yarrYml, DEFAULTS);
    expect(result.checks.value).toEqual(checks);
    expect(result.checks.source).toBe("yarr-yml");
  });

  it("checks from repo override with source tracking", () => {
    const repoChecks: Check[] = [
      {
        name: "test",
        command: "npm test",
        when: "post_completion",
        timeoutSecs: 60,
        maxRetries: 0,
      },
    ];
    const result = resolveConfig({ checks: repoChecks }, null, DEFAULTS);
    expect(result.checks.value).toEqual(repoChecks);
    expect(result.checks.source).toBe("override");
  });

  it("checks defaults to undefined when neither repo nor yarrYml has it", () => {
    const result = resolveConfig({}, null, DEFAULTS);
    expect(result.checks.value).toBeUndefined();
    expect(result.checks.source).toBe("default");
  });

  it("gitSync from repo override wins over yarrYml with source tracking", () => {
    const repoGitSync: GitSyncConfig = {
      enabled: true,
      maxPushRetries: 5,
    };
    const ymlGitSync: GitSyncConfig = {
      enabled: false,
      maxPushRetries: 1,
    };
    const yarrYml: YarrYmlConfig = { gitSync: ymlGitSync };
    const repo = { gitSync: repoGitSync };
    const result = resolveConfig(repo, yarrYml, DEFAULTS);
    expect(result.gitSync.value).toEqual(repoGitSync);
    expect(result.gitSync.source).toBe("override");
  });

  it("gitSync from yarrYml when repo has none", () => {
    const ymlGitSync: GitSyncConfig = {
      enabled: true,
      maxPushRetries: 3,
    };
    const yarrYml: YarrYmlConfig = { gitSync: ymlGitSync };
    const result = resolveConfig({}, yarrYml, DEFAULTS);
    expect(result.gitSync.value).toEqual(ymlGitSync);
    expect(result.gitSync.source).toBe("yarr-yml");
  });

  it("gitSync defaults to undefined when neither repo nor yarrYml has it", () => {
    const result = resolveConfig({}, null, DEFAULTS);
    expect(result.gitSync.value).toBeUndefined();
    expect(result.gitSync.source).toBe("default");
  });
});


describe("DEFAULTS", () => {
  it('has expected model value "opus"', () => {
    expect(DEFAULTS.model).toBe("opus");
  });

  it("has expected maxIterations value 40", () => {
    expect(DEFAULTS.maxIterations).toBe(40);
  });

  it("has expected completionSignal value", () => {
    expect(DEFAULTS.completionSignal).toBe("ALL TODO ITEMS COMPLETE");
  });

  it('has expected effortLevel value "medium"', () => {
    expect(DEFAULTS.effortLevel).toBe("medium");
  });

  it('has expected designEffortLevel value "high"', () => {
    expect(DEFAULTS.designEffortLevel).toBe("high");
  });

  it("has all expected keys", () => {
    const keys = Object.keys(DEFAULTS).sort();
    expect(keys).toEqual(
      [
        "model",
        "effortLevel",
        "designEffortLevel",
        "maxIterations",
        "completionSignal",
        "createBranch",
        "autoFetch",
        "plansDir",
        "movePlansToCompleted",
        "designPromptFile",
        "implementationPromptFile",
      ].sort(),
    );
  });
});
