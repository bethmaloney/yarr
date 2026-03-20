import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockData } = vi.hoisted(() => {
  return { mockData: new Map<string, unknown>() };
});

vi.mock("@tauri-apps/plugin-store", () => {
  return {
    LazyStore: class {
      async get<T>(key: string): Promise<T | undefined> {
        return mockData.get(key) as T | undefined;
      }
      async set(key: string, value: unknown): Promise<void> {
        mockData.set(key, value);
      }
      async save(): Promise<void> {}
    },
  };
});

import {
  loadRepos,
  addLocalRepo,
  addSshRepo,
  updateRepo,
  removeRepo,
  type RepoConfig,
} from "./repos";
import type { GitSyncConfig } from "./types";

beforeEach(() => {
  mockData.clear();
});

describe("loadRepos", () => {
  it("returns empty array when no data", async () => {
    const result = await loadRepos();
    expect(result).toEqual([]);
  });

  it("returns stored repos when they exist", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "abc-123",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        checks: [],
      },
      {
        type: "ssh",
        id: "def-456",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/other",
        name: "other",
        model: "sonnet",
        maxIterations: 20,
        completionSignal: "DONE",
        checks: [],
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toEqual(existing);
  });

  it("migrates legacy repos without type field to local", async () => {
    const legacyRepos = [
      {
        id: "legacy-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
      {
        id: "legacy-2",
        path: "/home/beth/repos/other",
        name: "other",
        model: "sonnet",
        maxIterations: 20,
        completionSignal: "DONE",
      },
    ];
    mockData.set("repos", legacyRepos);

    const result = await loadRepos();
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("local");
    expect(result[1].type).toBe("local");
  });

  it("preserves existing type field during migration", async () => {
    const repos = [
      {
        type: "local",
        id: "local-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", repos);

    const result = await loadRepos();
    expect(result[0].type).toBe("local");
  });

  it("does not alter SSH repos that already have type ssh", async () => {
    const repos = [
      {
        type: "ssh",
        id: "ssh-1",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/project",
        name: "project",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", repos);

    const result = await loadRepos();
    expect(result[0].type).toBe("ssh");
    if (result[0].type === "ssh") {
      expect(result[0].sshHost).toBe("dev-server");
      expect(result[0].remotePath).toBe("/home/beth/repos/project");
    }
  });

  it("migrates repos without checks field to have checks: []", async () => {
    const reposWithoutChecks = [
      {
        type: "local",
        id: "no-checks-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
      {
        type: "ssh",
        id: "no-checks-2",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/project",
        name: "project",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", reposWithoutChecks);

    const result = await loadRepos();
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("checks", []);
    expect(result[1]).toHaveProperty("checks", []);
  });
});

describe("addLocalRepo", () => {
  it("generates an id that is a non-empty string", async () => {
    const repo = await addLocalRepo("/home/beth/repos/yarr");
    expect(typeof repo.id).toBe("string");
    expect(repo.id.length).toBeGreaterThan(0);
  });

  it("creates a repo with type local", async () => {
    const repo = await addLocalRepo("/home/beth/repos/yarr");
    expect(repo.type).toBe("local");
  });

  it("creates a repo with path field", async () => {
    const repo = await addLocalRepo("/home/beth/repos/yarr");
    if (repo.type === "local") {
      expect(repo.path).toBe("/home/beth/repos/yarr");
    }
  });

  it("derives name from path basename", async () => {
    const repo = await addLocalRepo("/home/beth/repos/yarr");
    expect(repo.name).toBe("yarr");
  });

  it("derives name correctly from path with trailing slash", async () => {
    const repo = await addLocalRepo("/home/beth/repos/yarr/");
    expect(repo.name).toBe("yarr");
  });

  it("derives name from WSL path with backslashes", async () => {
    const repo = await addLocalRepo(
      "\\\\wsl.localhost\\Ubuntu-24.04\\home\\beth\\repos\\yarr2",
    );
    expect(repo.name).toBe("yarr2");
  });

  it("derives name from Windows path with backslashes", async () => {
    const repo = await addLocalRepo("C:\\Users\\beth\\repos\\project");
    expect(repo.name).toBe("project");
  });

  it("does not include model, maxIterations, or completionSignal", async () => {
    const repo = await addLocalRepo("/home/beth/repos/yarr");
    expect(repo.model).toBeUndefined();
    expect(repo.maxIterations).toBeUndefined();
    expect(repo.completionSignal).toBeUndefined();
  });

  it("appends to existing repos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "existing-id",
        path: "/home/beth/repos/first",
        name: "first",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", existing);

    await addLocalRepo("/home/beth/repos/second");

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(2);
    expect(stored[0].name).toBe("first");
    expect(stored[1].name).toBe("second");
  });

  it("does not include effort level defaults", async () => {
    const repo = await addLocalRepo("/home/beth/repos/yarr");
    expect(repo.effortLevel).toBeUndefined();
    expect(repo.designEffortLevel).toBeUndefined();
  });

  it("returns the created RepoConfig with only identity fields", async () => {
    const repo = await addLocalRepo("/home/beth/repos/yarr");
    expect(repo).toEqual({
      type: "local",
      id: expect.any(String),
      path: "/home/beth/repos/yarr",
      name: "yarr",
    });
  });

  it("does not include checks in defaults", async () => {
    const repo = await addLocalRepo("/home/beth/repos/yarr");
    expect(repo.checks).toBeUndefined();
  });
});

describe("addSshRepo", () => {
  it("generates an id that is a non-empty string", async () => {
    const repo = await addSshRepo("dev-server", "/home/beth/repos/project");
    expect(typeof repo.id).toBe("string");
    expect(repo.id.length).toBeGreaterThan(0);
  });

  it("creates a repo with type ssh", async () => {
    const repo = await addSshRepo("dev-server", "/home/beth/repos/project");
    expect(repo.type).toBe("ssh");
  });

  it("creates a repo with sshHost and remotePath fields", async () => {
    const repo = await addSshRepo("dev-server", "/home/beth/repos/project");
    if (repo.type === "ssh") {
      expect(repo.sshHost).toBe("dev-server");
      expect(repo.remotePath).toBe("/home/beth/repos/project");
    }
  });

  it("derives name from remote path basename", async () => {
    const repo = await addSshRepo("dev-server", "/home/beth/repos/project");
    expect(repo.name).toBe("project");
  });

  it("derives name correctly from remote path with trailing slash", async () => {
    const repo = await addSshRepo("dev-server", "/home/beth/repos/project/");
    expect(repo.name).toBe("project");
  });

  it("does not include model, maxIterations, or completionSignal", async () => {
    const repo = await addSshRepo("dev-server", "/home/beth/repos/project");
    expect(repo.model).toBeUndefined();
    expect(repo.maxIterations).toBeUndefined();
    expect(repo.completionSignal).toBeUndefined();
  });

  it("appends to existing repos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "existing-id",
        path: "/home/beth/repos/first",
        name: "first",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", existing);

    await addSshRepo("dev-server", "/home/beth/repos/second");

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(2);
    expect(stored[0].name).toBe("first");
    expect(stored[1].name).toBe("second");
  });

  it("does not include effort level defaults", async () => {
    const repo = await addSshRepo("dev-server", "/home/beth/repos/project");
    expect(repo.effortLevel).toBeUndefined();
    expect(repo.designEffortLevel).toBeUndefined();
  });

  it("returns the created RepoConfig with only identity fields", async () => {
    const repo = await addSshRepo("dev-server", "/home/beth/repos/project");
    expect(repo).toEqual({
      type: "ssh",
      id: expect.any(String),
      sshHost: "dev-server",
      remotePath: "/home/beth/repos/project",
      name: "project",
    });
  });

  it("does not include checks in defaults", async () => {
    const repo = await addSshRepo("dev-server", "/home/beth/repos/project");
    expect(repo.checks).toBeUndefined();
  });
});

describe("type discrimination", () => {
  it("local repo has path but not sshHost or remotePath", async () => {
    const repo = await addLocalRepo("/home/beth/repos/yarr");
    expect(repo.type).toBe("local");
    if (repo.type === "local") {
      expect(repo.path).toBe("/home/beth/repos/yarr");
      // TypeScript would prevent accessing sshHost/remotePath on a local repo
      // but at runtime we verify these fields are not present
      expect("sshHost" in repo).toBe(false);
      expect("remotePath" in repo).toBe(false);
    }
  });

  it("ssh repo has sshHost and remotePath but not path", async () => {
    const repo = await addSshRepo("dev-server", "/home/beth/repos/project");
    expect(repo.type).toBe("ssh");
    if (repo.type === "ssh") {
      expect(repo.sshHost).toBe("dev-server");
      expect(repo.remotePath).toBe("/home/beth/repos/project");
      // TypeScript would prevent accessing path on an SSH repo
      // but at runtime we verify the field is not present
      expect("path" in repo).toBe(false);
    }
  });
});

describe("updateRepo", () => {
  it("replaces matching repo by id", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", existing);

    const updated: RepoConfig = {
      type: "local",
      id: "repo-1",
      path: "/home/beth/repos/yarr",
      name: "yarr",
      model: "sonnet",
      maxIterations: 10,
      completionSignal: "FINISHED",
    };
    await updateRepo(updated);

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(1);
    expect(stored[0].model).toBe("sonnet");
    expect(stored[0].maxIterations).toBe(10);
    expect(stored[0].completionSignal).toBe("FINISHED");
  });

  it("does not affect other repos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
      {
        type: "ssh",
        id: "repo-2",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/other",
        name: "other",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        checks: [],
      },
    ];
    mockData.set("repos", existing);

    const updated: RepoConfig = {
      type: "local",
      id: "repo-1",
      path: "/home/beth/repos/yarr",
      name: "yarr",
      model: "sonnet",
      maxIterations: 10,
      completionSignal: "FINISHED",
    };
    await updateRepo(updated);

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(2);
    expect(stored[1]).toEqual(existing[1]);
  });
});

describe("removeRepo", () => {
  it("filters out repo by id", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", existing);

    await removeRepo("repo-1");

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toEqual([]);
  });

  it("does not affect other repos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
      {
        type: "ssh",
        id: "repo-2",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/other",
        name: "other",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        checks: [],
      },
    ];
    mockData.set("repos", existing);

    await removeRepo("repo-1");

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe("repo-2");
    expect(stored[0]).toEqual(existing[1]);
  });
});

describe("gitSync on repo configs", () => {
  it("local repo with gitSync round-trips through loadRepos", async () => {
    const gitSync: GitSyncConfig = {
      enabled: true,
      conflictPrompt: "Fix the merge conflicts",
      model: "sonnet",
      maxPushRetries: 3,
    };
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-gs-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        gitSync,
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].gitSync).toEqual(gitSync);
      expect(result[0].gitSync!.enabled).toBe(true);
      expect(result[0].gitSync!.conflictPrompt).toBe("Fix the merge conflicts");
      expect(result[0].gitSync!.model).toBe("sonnet");
      expect(result[0].gitSync!.maxPushRetries).toBe(3);
    }
  });

  it("local repo without gitSync loads fine", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-no-gs",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].gitSync).toBeUndefined();
    }
  });

  it("ssh repo with gitSync round-trips through loadRepos", async () => {
    const gitSync: GitSyncConfig = {
      enabled: true,
      maxPushRetries: 5,
    };
    const existing: RepoConfig[] = [
      {
        type: "ssh",
        id: "repo-gs-ssh",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/project",
        name: "project",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        gitSync,
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "ssh") {
      expect(result[0].gitSync).toEqual(gitSync);
      expect(result[0].gitSync!.enabled).toBe(true);
      expect(result[0].gitSync!.maxPushRetries).toBe(5);
      expect(result[0].gitSync!.conflictPrompt).toBeUndefined();
      expect(result[0].gitSync!.model).toBeUndefined();
    }
  });

  it("updateRepo preserves gitSync config", async () => {
    const gitSync: GitSyncConfig = {
      enabled: true,
      conflictPrompt: "Resolve conflicts",
      maxPushRetries: 2,
    };
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-update-gs",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        gitSync,
      },
    ];
    mockData.set("repos", existing);

    const updated: RepoConfig = {
      type: "local",
      id: "repo-update-gs",
      path: "/home/beth/repos/yarr",
      name: "yarr",
      model: "sonnet",
      maxIterations: 20,
      completionSignal: "DONE",
      gitSync,
    };
    await updateRepo(updated);

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(1);
    expect(stored[0].model).toBe("sonnet");
    if (stored[0].type === "local") {
      expect(stored[0].gitSync).toEqual(gitSync);
      expect(stored[0].gitSync!.enabled).toBe(true);
      expect(stored[0].gitSync!.maxPushRetries).toBe(2);
    }
  });
});

describe("GitSyncConfig type shape", () => {
  it("has the expected shape with all fields populated", () => {
    const config: GitSyncConfig = {
      enabled: true,
      conflictPrompt: "resolve conflicts automatically",
      model: "sonnet",
      maxPushRetries: 3,
    };

    expect(config).toEqual({
      enabled: true,
      conflictPrompt: "resolve conflicts automatically",
      model: "sonnet",
      maxPushRetries: 3,
    });
    expect(typeof config.enabled).toBe("boolean");
    expect(typeof config.conflictPrompt).toBe("string");
    expect(typeof config.model).toBe("string");
    expect(typeof config.maxPushRetries).toBe("number");
  });

  it("works with only required fields (optional fields omitted)", () => {
    const config: GitSyncConfig = {
      enabled: false,
      maxPushRetries: 0,
    };

    expect(config.enabled).toBe(false);
    expect(config.maxPushRetries).toBe(0);
    expect(config.conflictPrompt).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(Object.keys(config)).toEqual(["enabled", "maxPushRetries"]);
  });
});

describe("RepoConfig with gitSync field", () => {
  it("local RepoConfig with gitSync is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-gs-1",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      gitSync: {
        enabled: true,
        conflictPrompt: "fix merge conflicts",
        model: "sonnet",
        maxPushRetries: 5,
      } satisfies GitSyncConfig,
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(repo.gitSync).toBeDefined();
    expect(repo.gitSync.enabled).toBe(true);
    expect(repo.gitSync.conflictPrompt).toBe("fix merge conflicts");
    expect(repo.gitSync.model).toBe("sonnet");
    expect(repo.gitSync.maxPushRetries).toBe(5);
  });

  it("local RepoConfig without gitSync is valid (undefined)", () => {
    const repo = {
      type: "local" as const,
      id: "local-no-gs",
      path: "/home/beth/repos/other",
      name: "other",
      model: "opus",
      maxIterations: 20,
      completionSignal: "DONE",
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(
      (repo as RepoConfig & { gitSync?: GitSyncConfig }).gitSync,
    ).toBeUndefined();
  });

  it("SSH RepoConfig with gitSync is valid", () => {
    const repo = {
      type: "ssh" as const,
      id: "ssh-gs-1",
      sshHost: "dev-server",
      remotePath: "/opt/project",
      name: "project",
      model: "opus",
      maxIterations: 30,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      gitSync: {
        enabled: false,
        maxPushRetries: 2,
      } satisfies GitSyncConfig,
    } satisfies RepoConfig;

    expect(repo.type).toBe("ssh");
    expect(repo.gitSync).toBeDefined();
    expect(repo.gitSync.enabled).toBe(false);
    expect(repo.gitSync.maxPushRetries).toBe(2);
    const gs = repo.gitSync as GitSyncConfig;
    expect(gs.conflictPrompt).toBeUndefined();
    expect(gs.model).toBeUndefined();
  });
});

describe("GitSyncConfig JSON round-trip", () => {
  it("serialize/deserialize preserves all fields", () => {
    const original: GitSyncConfig = {
      enabled: true,
      conflictPrompt: "resolve conflicts using theirs strategy",
      model: "sonnet",
      maxPushRetries: 7,
    };

    const json = JSON.stringify(original);
    const parsed: GitSyncConfig = JSON.parse(json);

    expect(parsed).toEqual(original);
    expect(parsed.enabled).toBe(true);
    expect(parsed.conflictPrompt).toBe(
      "resolve conflicts using theirs strategy",
    );
    expect(parsed.model).toBe("sonnet");
    expect(parsed.maxPushRetries).toBe(7);
  });

  it("serialize/deserialize preserves minimal config (no optional fields)", () => {
    const original: GitSyncConfig = {
      enabled: false,
      maxPushRetries: 0,
    };

    const json = JSON.stringify(original);
    const parsed: GitSyncConfig = JSON.parse(json);

    expect(parsed).toEqual(original);
    expect(parsed.enabled).toBe(false);
    expect(parsed.maxPushRetries).toBe(0);
    expect("conflictPrompt" in parsed).toBe(false);
    expect("model" in parsed).toBe(false);
  });
});

describe("RepoConfig with createBranch field", () => {
  it("local RepoConfig with createBranch: true is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-cb-1",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      createBranch: true,
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(repo.createBranch).toBe(true);
  });

  it("local RepoConfig with createBranch: false is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-cb-2",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      createBranch: false,
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(repo.createBranch).toBe(false);
  });

  it("local RepoConfig without createBranch (undefined) is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-no-cb",
      path: "/home/beth/repos/other",
      name: "other",
      model: "opus",
      maxIterations: 20,
      completionSignal: "DONE",
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(
      (repo as RepoConfig & { createBranch?: boolean }).createBranch,
    ).toBeUndefined();
  });

  it("SSH RepoConfig with createBranch is valid", () => {
    const repo = {
      type: "ssh" as const,
      id: "ssh-cb-1",
      sshHost: "dev-server",
      remotePath: "/opt/project",
      name: "project",
      model: "opus",
      maxIterations: 30,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      createBranch: true,
    } satisfies RepoConfig;

    expect(repo.type).toBe("ssh");
    expect(repo.createBranch).toBe(true);
  });
});

describe("createBranch round-trip through loadRepos", () => {
  it("local repo with createBranch round-trips through loadRepos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-cb-rt-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        createBranch: true,
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].createBranch).toBe(true);
    }
  });

  it("local repo without createBranch loads fine", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-no-cb",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].createBranch).toBeUndefined();
    }
  });

  it("ssh repo with createBranch round-trips through loadRepos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "ssh",
        id: "repo-cb-ssh",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/project",
        name: "project",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        createBranch: false,
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "ssh") {
      expect(result[0].createBranch).toBe(false);
    }
  });
});

describe("updateRepo preserves createBranch", () => {
  it("updateRepo preserves createBranch config", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-update-cb",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        createBranch: true,
      },
    ];
    mockData.set("repos", existing);

    const updated: RepoConfig = {
      type: "local",
      id: "repo-update-cb",
      path: "/home/beth/repos/yarr",
      name: "yarr",
      model: "sonnet",
      maxIterations: 20,
      completionSignal: "DONE",
      createBranch: true,
    };
    await updateRepo(updated);

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(1);
    expect(stored[0].model).toBe("sonnet");
    if (stored[0].type === "local") {
      expect(stored[0].createBranch).toBe(true);
    }
  });
});

describe("RepoConfig with autoFetch field", () => {
  it("local RepoConfig with autoFetch: true is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-af-1",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      autoFetch: true,
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(repo.autoFetch).toBe(true);
  });

  it("local RepoConfig with autoFetch: false is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-af-2",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      autoFetch: false,
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(repo.autoFetch).toBe(false);
  });

  it("local RepoConfig without autoFetch (undefined) is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-no-af",
      path: "/home/beth/repos/other",
      name: "other",
      model: "opus",
      maxIterations: 20,
      completionSignal: "DONE",
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(
      (repo as RepoConfig & { autoFetch?: boolean }).autoFetch,
    ).toBeUndefined();
  });

  it("SSH RepoConfig with autoFetch is valid", () => {
    const repo = {
      type: "ssh" as const,
      id: "ssh-af-1",
      sshHost: "dev-server",
      remotePath: "/opt/project",
      name: "project",
      model: "opus",
      maxIterations: 30,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      autoFetch: true,
    } satisfies RepoConfig;

    expect(repo.type).toBe("ssh");
    expect(repo.autoFetch).toBe(true);
  });
});

describe("autoFetch round-trip through loadRepos", () => {
  it("local repo with autoFetch round-trips through loadRepos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-af-rt-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        autoFetch: true,
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].autoFetch).toBe(true);
    }
  });

  it("local repo without autoFetch loads fine (undefined)", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-no-af",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].autoFetch).toBeUndefined();
    }
  });

  it("ssh repo with autoFetch round-trips through loadRepos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "ssh",
        id: "repo-af-ssh",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/project",
        name: "project",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        autoFetch: false,
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "ssh") {
      expect(result[0].autoFetch).toBe(false);
    }
  });
});

describe("updateRepo preserves autoFetch", () => {
  it("updateRepo preserves autoFetch config", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-update-af",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        autoFetch: true,
      },
    ];
    mockData.set("repos", existing);

    const updated: RepoConfig = {
      type: "local",
      id: "repo-update-af",
      path: "/home/beth/repos/yarr",
      name: "yarr",
      model: "sonnet",
      maxIterations: 20,
      completionSignal: "DONE",
      autoFetch: true,
    };
    await updateRepo(updated);

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(1);
    expect(stored[0].model).toBe("sonnet");
    if (stored[0].type === "local") {
      expect(stored[0].autoFetch).toBe(true);
    }
  });
});

describe("RepoConfig with movePlansToCompleted field", () => {
  it("local RepoConfig with movePlansToCompleted: true is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-mpc-1",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      movePlansToCompleted: true,
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(repo.movePlansToCompleted).toBe(true);
  });

  it("local RepoConfig with movePlansToCompleted: false is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-mpc-2",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      movePlansToCompleted: false,
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(repo.movePlansToCompleted).toBe(false);
  });

  it("local RepoConfig without movePlansToCompleted (undefined) is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-no-mpc",
      path: "/home/beth/repos/other",
      name: "other",
      model: "opus",
      maxIterations: 20,
      completionSignal: "DONE",
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(
      (repo as RepoConfig & { movePlansToCompleted?: boolean })
        .movePlansToCompleted,
    ).toBeUndefined();
  });

  it("SSH RepoConfig with movePlansToCompleted is valid", () => {
    const repo = {
      type: "ssh" as const,
      id: "ssh-mpc-1",
      sshHost: "dev-server",
      remotePath: "/opt/project",
      name: "project",
      model: "opus",
      maxIterations: 30,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      movePlansToCompleted: true,
    } satisfies RepoConfig;

    expect(repo.type).toBe("ssh");
    expect(repo.movePlansToCompleted).toBe(true);
  });
});

describe("movePlansToCompleted round-trip through loadRepos", () => {
  it("local repo with movePlansToCompleted round-trips through loadRepos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-mpc-rt-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        movePlansToCompleted: true,
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].movePlansToCompleted).toBe(true);
    }
  });

  it("local repo without movePlansToCompleted loads fine", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-no-mpc",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].movePlansToCompleted).toBeUndefined();
    }
  });

  it("ssh repo with movePlansToCompleted round-trips through loadRepos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "ssh",
        id: "repo-mpc-ssh",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/project",
        name: "project",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        movePlansToCompleted: false,
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "ssh") {
      expect(result[0].movePlansToCompleted).toBe(false);
    }
  });
});

describe("updateRepo preserves movePlansToCompleted", () => {
  it("updateRepo preserves movePlansToCompleted config", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-update-mpc",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        movePlansToCompleted: true,
      },
    ];
    mockData.set("repos", existing);

    const updated: RepoConfig = {
      type: "local",
      id: "repo-update-mpc",
      path: "/home/beth/repos/yarr",
      name: "yarr",
      model: "sonnet",
      maxIterations: 20,
      completionSignal: "DONE",
      movePlansToCompleted: true,
    };
    await updateRepo(updated);

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(1);
    expect(stored[0].model).toBe("sonnet");
    if (stored[0].type === "local") {
      expect(stored[0].movePlansToCompleted).toBe(true);
    }
  });
});

describe("RepoConfig with effortLevel fields", () => {
  it("local RepoConfig with effortLevel and designEffortLevel is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-eff-1",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      effortLevel: "high",
      designEffortLevel: "max",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
    } satisfies RepoConfig;
    expect(repo.effortLevel).toBe("high");
    expect(repo.designEffortLevel).toBe("max");
  });

  it("local RepoConfig without effort fields (undefined) is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-no-eff",
      path: "/home/beth/repos/other",
      name: "other",
      model: "opus",
      maxIterations: 20,
      completionSignal: "DONE",
    } satisfies RepoConfig;
    expect(repo.type).toBe("local");
    expect(
      (repo as RepoConfig & { effortLevel?: string }).effortLevel,
    ).toBeUndefined();
    expect(
      (repo as RepoConfig & { designEffortLevel?: string }).designEffortLevel,
    ).toBeUndefined();
  });

  it("SSH RepoConfig with effort fields is valid", () => {
    const repo = {
      type: "ssh" as const,
      id: "ssh-eff-1",
      sshHost: "dev-server",
      remotePath: "/opt/project",
      name: "project",
      model: "opus",
      effortLevel: "low",
      designEffortLevel: "medium",
      maxIterations: 30,
      completionSignal: "ALL TODO ITEMS COMPLETE",
    } satisfies RepoConfig;
    expect(repo.type).toBe("ssh");
    expect(repo.effortLevel).toBe("low");
    expect(repo.designEffortLevel).toBe("medium");
  });
});

describe("RepoConfig with designPromptFile field", () => {
  it("local RepoConfig with designPromptFile is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-dpf-1",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      designPromptFile: ".yarr/prompts/design.md",
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(repo.designPromptFile).toBe(".yarr/prompts/design.md");
  });

  it("local RepoConfig without designPromptFile (undefined) is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-no-dpf",
      path: "/home/beth/repos/other",
      name: "other",
      model: "opus",
      maxIterations: 20,
      completionSignal: "DONE",
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(
      (repo as RepoConfig & { designPromptFile?: string }).designPromptFile,
    ).toBeUndefined();
  });

  it("SSH RepoConfig with designPromptFile is valid", () => {
    const repo = {
      type: "ssh" as const,
      id: "ssh-dpf-1",
      sshHost: "dev-server",
      remotePath: "/opt/project",
      name: "project",
      model: "opus",
      maxIterations: 30,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      designPromptFile: ".yarr/prompts/design.md",
    } satisfies RepoConfig;

    expect(repo.type).toBe("ssh");
    expect(repo.designPromptFile).toBe(".yarr/prompts/design.md");
  });

  it("SSH RepoConfig without designPromptFile (undefined) is valid", () => {
    const repo = {
      type: "ssh" as const,
      id: "ssh-no-dpf",
      sshHost: "dev-server",
      remotePath: "/opt/project",
      name: "project",
      model: "opus",
      maxIterations: 30,
      completionSignal: "DONE",
    } satisfies RepoConfig;

    expect(repo.type).toBe("ssh");
    expect(
      (repo as RepoConfig & { designPromptFile?: string }).designPromptFile,
    ).toBeUndefined();
  });
});

describe("designPromptFile round-trip through loadRepos", () => {
  it("local repo with designPromptFile round-trips through loadRepos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-dpf-rt-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        designPromptFile: ".yarr/prompts/design.md",
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].designPromptFile).toBe(".yarr/prompts/design.md");
    }
  });

  it("local repo without designPromptFile loads fine", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-no-dpf",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].designPromptFile).toBeUndefined();
    }
  });

  it("ssh repo with designPromptFile round-trips through loadRepos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "ssh",
        id: "repo-dpf-ssh",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/project",
        name: "project",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        designPromptFile: ".yarr/prompts/design.md",
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "ssh") {
      expect(result[0].designPromptFile).toBe(".yarr/prompts/design.md");
    }
  });
});

describe("updateRepo preserves designPromptFile", () => {
  it("updateRepo preserves designPromptFile config", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-update-dpf",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        designPromptFile: ".yarr/prompts/design.md",
      },
    ];
    mockData.set("repos", existing);

    const updated: RepoConfig = {
      type: "local",
      id: "repo-update-dpf",
      path: "/home/beth/repos/yarr",
      name: "yarr",
      model: "sonnet",
      maxIterations: 20,
      completionSignal: "DONE",
      designPromptFile: ".yarr/prompts/design.md",
    };
    await updateRepo(updated);

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(1);
    expect(stored[0].model).toBe("sonnet");
    if (stored[0].type === "local") {
      expect(stored[0].designPromptFile).toBe(".yarr/prompts/design.md");
    }
  });
});

describe("RepoConfig with implementationPromptFile field", () => {
  it("local RepoConfig with implementationPromptFile is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-ipf-1",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      implementationPromptFile: ".yarr/prompts/implementation.md",
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(repo.implementationPromptFile).toBe(
      ".yarr/prompts/implementation.md",
    );
  });

  it("local RepoConfig without implementationPromptFile (undefined) is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-no-ipf",
      path: "/home/beth/repos/other",
      name: "other",
      model: "opus",
      maxIterations: 20,
      completionSignal: "DONE",
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(
      (repo as RepoConfig & { implementationPromptFile?: string })
        .implementationPromptFile,
    ).toBeUndefined();
  });

  it("SSH RepoConfig with implementationPromptFile is valid", () => {
    const repo = {
      type: "ssh" as const,
      id: "ssh-ipf-1",
      sshHost: "dev-server",
      remotePath: "/opt/project",
      name: "project",
      model: "opus",
      maxIterations: 30,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      implementationPromptFile: ".yarr/prompts/implementation.md",
    } satisfies RepoConfig;

    expect(repo.type).toBe("ssh");
    expect(repo.implementationPromptFile).toBe(
      ".yarr/prompts/implementation.md",
    );
  });

  it("SSH RepoConfig without implementationPromptFile (undefined) is valid", () => {
    const repo = {
      type: "ssh" as const,
      id: "ssh-no-ipf",
      sshHost: "dev-server",
      remotePath: "/opt/project",
      name: "project",
      model: "opus",
      maxIterations: 30,
      completionSignal: "DONE",
    } satisfies RepoConfig;

    expect(repo.type).toBe("ssh");
    expect(
      (repo as RepoConfig & { implementationPromptFile?: string })
        .implementationPromptFile,
    ).toBeUndefined();
  });
});

describe("implementationPromptFile round-trip through loadRepos", () => {
  it("local repo with implementationPromptFile round-trips through loadRepos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-ipf-rt-1",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        implementationPromptFile: ".yarr/prompts/implementation.md",
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].implementationPromptFile).toBe(
        ".yarr/prompts/implementation.md",
      );
    }
  });

  it("local repo without implementationPromptFile loads fine", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-no-ipf",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "local") {
      expect(result[0].implementationPromptFile).toBeUndefined();
    }
  });

  it("ssh repo with implementationPromptFile round-trips through loadRepos", async () => {
    const existing: RepoConfig[] = [
      {
        type: "ssh",
        id: "repo-ipf-ssh",
        sshHost: "dev-server",
        remotePath: "/home/beth/repos/project",
        name: "project",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        implementationPromptFile: ".yarr/prompts/implementation.md",
      },
    ];
    mockData.set("repos", existing);

    const result = await loadRepos();
    expect(result).toHaveLength(1);
    if (result[0].type === "ssh") {
      expect(result[0].implementationPromptFile).toBe(
        ".yarr/prompts/implementation.md",
      );
    }
  });
});

describe("updateRepo preserves implementationPromptFile", () => {
  it("updateRepo preserves implementationPromptFile config", async () => {
    const existing: RepoConfig[] = [
      {
        type: "local",
        id: "repo-update-ipf",
        path: "/home/beth/repos/yarr",
        name: "yarr",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
        implementationPromptFile: ".yarr/prompts/implementation.md",
      },
    ];
    mockData.set("repos", existing);

    const updated: RepoConfig = {
      type: "local",
      id: "repo-update-ipf",
      path: "/home/beth/repos/yarr",
      name: "yarr",
      model: "sonnet",
      maxIterations: 20,
      completionSignal: "DONE",
      implementationPromptFile: ".yarr/prompts/implementation.md",
    };
    await updateRepo(updated);

    const stored = mockData.get("repos") as RepoConfig[];
    expect(stored).toHaveLength(1);
    expect(stored[0].model).toBe("sonnet");
    if (stored[0].type === "local") {
      expect(stored[0].implementationPromptFile).toBe(
        ".yarr/prompts/implementation.md",
      );
    }
  });
});

describe("RepoConfig with both designPromptFile and implementationPromptFile", () => {
  it("local RepoConfig with both prompt file fields is valid", () => {
    const repo = {
      type: "local" as const,
      id: "local-both-pf-1",
      path: "/home/beth/repos/project",
      name: "project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      designPromptFile: ".yarr/prompts/design.md",
      implementationPromptFile: ".yarr/prompts/implementation.md",
    } satisfies RepoConfig;

    expect(repo.type).toBe("local");
    expect(repo.designPromptFile).toBe(".yarr/prompts/design.md");
    expect(repo.implementationPromptFile).toBe(
      ".yarr/prompts/implementation.md",
    );
  });

  it("SSH RepoConfig with both prompt file fields is valid", () => {
    const repo = {
      type: "ssh" as const,
      id: "ssh-both-pf-1",
      sshHost: "dev-server",
      remotePath: "/opt/project",
      name: "project",
      model: "opus",
      maxIterations: 30,
      completionSignal: "ALL TODO ITEMS COMPLETE",
      designPromptFile: ".yarr/prompts/design.md",
      implementationPromptFile: ".yarr/prompts/implementation.md",
    } satisfies RepoConfig;

    expect(repo.type).toBe("ssh");
    expect(repo.designPromptFile).toBe(".yarr/prompts/design.md");
    expect(repo.implementationPromptFile).toBe(
      ".yarr/prompts/implementation.md",
    );
  });
});
