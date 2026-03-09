import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";

import type { RepoConfig } from "../repos";
import type { BranchInfo } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

// ---------------------------------------------------------------------------
// Import the hook under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { useBranchInfo } from "./useBranchInfo";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLocalRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    type: "local",
    id: "local-1",
    path: "/home/beth/repos/my-project",
    name: "my-project",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeSshRepo(overrides: Record<string, unknown> = {}): RepoConfig {
  return {
    type: "ssh",
    id: "ssh-1",
    sshHost: "dev-server",
    remotePath: "/home/beth/repos/remote-project",
    name: "remote-project",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeBranchInfo(overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name: "main",
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(makeBranchInfo());
});

afterEach(() => {
  cleanup();
});

// ===========================================================================
// 1. Returns empty map when repos is empty
// ===========================================================================

describe("useBranchInfo", () => {
  it("returns an empty map when repos is empty", async () => {
    const { result } = renderHook(() => useBranchInfo([]));

    await waitFor(() => {
      expect(result.current).toBeInstanceOf(Map);
      expect(result.current.size).toBe(0);
    });
  });

  // =========================================================================
  // 2. Calls invoke("get_branch_info") for each repo with correct payload
  // =========================================================================

  it("calls invoke with correct payload for a local repo", async () => {
    const localRepo = makeLocalRepo();
    mockInvoke.mockResolvedValue(makeBranchInfo({ name: "main" }));

    renderHook(() => useBranchInfo([localRepo]));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_branch_info", {
        repo: { type: "local", path: "/home/beth/repos/my-project" },
      });
    });
  });

  it("calls invoke with correct payload for an SSH repo", async () => {
    const sshRepo = makeSshRepo();
    mockInvoke.mockResolvedValue(makeBranchInfo({ name: "develop" }));

    renderHook(() => useBranchInfo([sshRepo]));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_branch_info", {
        repo: {
          type: "ssh",
          sshHost: "dev-server",
          remotePath: "/home/beth/repos/remote-project",
        },
      });
    });
  });

  it("calls invoke once per repo", async () => {
    const repos = [
      makeLocalRepo({ id: "local-1" } as Partial<RepoConfig>),
      makeSshRepo({ id: "ssh-1" }),
      makeLocalRepo({ id: "local-2", path: "/other/path" } as Partial<RepoConfig>),
    ];

    renderHook(() => useBranchInfo(repos));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // 3. Returns map with branch info for all repos on success
  // =========================================================================

  it("returns a map with branch info for all repos on success", async () => {
    const localRepo = makeLocalRepo({ id: "local-1" } as Partial<RepoConfig>);
    const sshRepo = makeSshRepo({ id: "ssh-1" });

    const localBranch = makeBranchInfo({ name: "main", ahead: 2, behind: 0 });
    const sshBranch = makeBranchInfo({ name: "develop", ahead: 0, behind: 3 });

    mockInvoke.mockImplementation(
      async (_cmd: string, args: { repo: { type: string } }) => {
        if (args.repo.type === "local") return localBranch;
        return sshBranch;
      },
    );

    const { result } = renderHook(() => useBranchInfo([localRepo, sshRepo]));

    await waitFor(() => {
      expect(result.current.size).toBe(2);
    });

    expect(result.current.get("local-1")).toEqual(localBranch);
    expect(result.current.get("ssh-1")).toEqual(sshBranch);
  });

  // =========================================================================
  // 4. Handles partial failures (one repo fails, others succeed)
  // =========================================================================

  it("handles partial failures — successful repos still appear in the map", async () => {
    const repo1 = makeLocalRepo({ id: "repo-ok" } as Partial<RepoConfig>);
    const repo2 = makeLocalRepo({
      id: "repo-fail",
      path: "/bad/path",
    } as Partial<RepoConfig>);
    const repo3 = makeSshRepo({ id: "repo-ssh-ok" });

    const okBranch = makeBranchInfo({ name: "main" });
    const sshBranch = makeBranchInfo({ name: "feat/test" });

    mockInvoke.mockImplementation(
      async (_cmd: string, args: { repo: { type: string; path?: string } }) => {
        if (args.repo.type === "local" && args.repo.path === "/bad/path") {
          throw new Error("repo not found");
        }
        if (args.repo.type === "ssh") return sshBranch;
        return okBranch;
      },
    );

    const { result } = renderHook(() =>
      useBranchInfo([repo1, repo2, repo3]),
    );

    await waitFor(() => {
      // Should have 2 entries (the failed one is excluded)
      expect(result.current.size).toBe(2);
    });

    expect(result.current.get("repo-ok")).toEqual(okBranch);
    expect(result.current.has("repo-fail")).toBe(false);
    expect(result.current.get("repo-ssh-ok")).toEqual(sshBranch);
  });

  it("returns empty map when all repos fail", async () => {
    const repo = makeLocalRepo();
    mockInvoke.mockRejectedValue(new Error("all broken"));

    const { result } = renderHook(() => useBranchInfo([repo]));

    await waitFor(() => {
      // The map should remain empty since the only call failed
      expect(result.current.size).toBe(0);
    });
  });

  // =========================================================================
  // 5. Re-fetches when repos change
  // =========================================================================

  it("re-fetches when the repos array changes", async () => {
    const repo1 = makeLocalRepo({ id: "repo-1" } as Partial<RepoConfig>);
    const repo2 = makeLocalRepo({
      id: "repo-2",
      path: "/other",
    } as Partial<RepoConfig>);

    const branch1 = makeBranchInfo({ name: "main" });
    const branch2 = makeBranchInfo({ name: "develop" });

    mockInvoke.mockResolvedValue(branch1);

    const { result, rerender } = renderHook(
      (props: { repos: RepoConfig[] }) => useBranchInfo(props.repos),
      { initialProps: { repos: [repo1] } },
    );

    await waitFor(() => {
      expect(result.current.size).toBe(1);
      expect(result.current.get("repo-1")).toEqual(branch1);
    });

    // Change the repos array
    mockInvoke.mockResolvedValue(branch2);

    await act(async () => {
      rerender({ repos: [repo2] });
    });

    await waitFor(() => {
      expect(result.current.size).toBe(1);
      expect(result.current.get("repo-2")).toEqual(branch2);
    });

    // invoke should have been called more than the initial batch
    expect(mockInvoke.mock.calls.length).toBeGreaterThan(1);
  });
});
