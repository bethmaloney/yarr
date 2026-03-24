import { describe, it, expect } from "vitest";
import type { RepoConfig } from "./repos";
/** Build the repo payload for invoking get_repo_git_status */
function buildRepoPayload(repo: RepoConfig) {
  return repo.type === "local"
    ? { type: "local" as const, path: repo.path }
    : {
        type: "ssh" as const,
        sshHost: repo.sshHost,
        remotePath: repo.remotePath,
      };
}

/** Determine if a branch name should be displayed */
function shouldShowBranch(branchName: string | undefined): boolean {
  return branchName != null && branchName.length > 0;
}

/** Helper to create a minimal local RepoConfig for testing. */
function makeLocalRepo(
  overrides: Partial<RepoConfig> = {},
): RepoConfig & { type: "local" } {
  return {
    type: "local",
    id: "local-1",
    path: "/home/beth/repos/my-project",
    name: "my-project",
    model: "opus",
    maxIterations: 40,
    completionSignal: "<promise>COMPLETE</promise>",
    checks: [],
    ...overrides,
  } as RepoConfig & { type: "local" };
}

/** Helper to create a minimal SSH RepoConfig for testing. */
function makeSshRepo(
  overrides: Partial<RepoConfig> = {},
): RepoConfig & { type: "ssh" } {
  return {
    type: "ssh",
    id: "ssh-1",
    sshHost: "dev-server",
    remotePath: "/home/beth/repos/remote-project",
    name: "remote-project",
    model: "opus",
    maxIterations: 40,
    completionSignal: "<promise>COMPLETE</promise>",
    checks: [],
    ...overrides,
  } as RepoConfig & { type: "ssh" };
}

describe("shouldShowBranch", () => {
  it("returns true when branchName is a non-empty string", () => {
    expect(shouldShowBranch("main")).toBe(true);
  });

  it("returns true for feature branch names", () => {
    expect(shouldShowBranch("feature/add-branch-label")).toBe(true);
  });

  it("returns false when branchName is undefined", () => {
    expect(shouldShowBranch(undefined)).toBe(false);
  });

  it("returns false when branchName is an empty string", () => {
    expect(shouldShowBranch("")).toBe(false);
  });

  it("returns true for branch names with special characters", () => {
    expect(shouldShowBranch("fix/issue-123")).toBe(true);
    expect(shouldShowBranch("user/beth/experiment")).toBe(true);
  });
});

describe("buildRepoPayload", () => {
  it("returns local payload with path for local repos", () => {
    const repo = makeLocalRepo({ path: "/home/beth/repos/yarr" });
    const payload = buildRepoPayload(repo);

    expect(payload).toEqual({
      type: "local",
      path: "/home/beth/repos/yarr",
    });
  });

  it("returns ssh payload with sshHost and remotePath for ssh repos", () => {
    const repo = makeSshRepo({
      sshHost: "prod-server",
      remotePath: "/opt/app",
    } as Partial<RepoConfig>);
    const payload = buildRepoPayload(repo);

    expect(payload).toEqual({
      type: "ssh",
      sshHost: "prod-server",
      remotePath: "/opt/app",
    });
  });

  it("does not include extra fields like id, name, or model in local payload", () => {
    const repo = makeLocalRepo();
    const payload = buildRepoPayload(repo);

    expect(Object.keys(payload).sort()).toEqual(["path", "type"]);
  });

  it("does not include extra fields like id, name, or model in ssh payload", () => {
    const repo = makeSshRepo();
    const payload = buildRepoPayload(repo);

    expect(Object.keys(payload).sort()).toEqual([
      "remotePath",
      "sshHost",
      "type",
    ]);
  });
});

describe("buildRepoPayload produces correct payloads for branch info fetch", () => {
  it("builds payloads for a mixed list of local and ssh repos", () => {
    const repos: RepoConfig[] = [
      makeLocalRepo({ id: "l1", path: "/home/beth/repos/alpha" }),
      makeSshRepo({
        id: "s1",
        sshHost: "box1",
        remotePath: "/srv/beta",
      } as Partial<RepoConfig>),
      makeLocalRepo({ id: "l2", path: "/home/beth/repos/gamma" }),
    ];

    const payloads = repos.map(buildRepoPayload);

    expect(payloads).toEqual([
      { type: "local", path: "/home/beth/repos/alpha" },
      { type: "ssh", sshHost: "box1", remotePath: "/srv/beta" },
      { type: "local", path: "/home/beth/repos/gamma" },
    ]);
  });
});
