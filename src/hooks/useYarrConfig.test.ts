import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup, act, waitFor } from "@testing-library/react";

import type { RepoConfig } from "../repos";

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

import { useYarrConfig } from "./useYarrConfig";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLocalRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    type: "local",
    id: "local-1",
    path: "/home/beth/repos/my-project",
    name: "my-project",
    ...overrides,
  } as RepoConfig;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("useYarrConfig", () => {
  // =========================================================================
  // 1. Returns loading=false, config=null, error=null when repo is null
  // =========================================================================

  it("returns loading=false, config=null, error=null when repo is null", () => {
    const { result } = renderHook(() => useYarrConfig(null));

    expect(result.current.config).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 2. Calls invoke("read_yarr_config", { repo }) on mount
  // =========================================================================

  it("calls invoke with read_yarr_config and repo on mount", async () => {
    const repo = makeLocalRepo();
    mockInvoke.mockResolvedValue({ config: null, error: null });

    renderHook(() => useYarrConfig(repo));

    expect(mockInvoke).toHaveBeenCalledWith("read_yarr_config", { repo });
  });

  // =========================================================================
  // 3. Sets config on successful response
  // =========================================================================

  it("sets config on successful response", async () => {
    const repo = makeLocalRepo();
    const ipcConfig = {
      model: "sonnet",
      maxIterations: 10,
    };
    mockInvoke.mockResolvedValue({ config: ipcConfig, error: null });

    const { result } = renderHook(() => useYarrConfig(repo));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.config).toEqual({ model: "sonnet", maxIterations: 10 });
    expect(result.current.error).toBeNull();
  });

  // =========================================================================
  // 4. Sets error when response has error field (parse failure)
  // =========================================================================

  it("sets error when response has error field", async () => {
    const repo = makeLocalRepo();
    mockInvoke.mockResolvedValue({
      config: null,
      error: "Failed to parse yarr.yml: invalid YAML",
    });

    const { result } = renderHook(() => useYarrConfig(repo));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.config).toBeNull();
    expect(result.current.error).toBe("Failed to parse yarr.yml: invalid YAML");
  });

  // =========================================================================
  // 5. Returns config=null, error=null when file not found (both null)
  // =========================================================================

  it("returns config=null, error=null when file not found", async () => {
    const repo = makeLocalRepo();
    mockInvoke.mockResolvedValue({ config: null, error: null });

    const { result } = renderHook(() => useYarrConfig(repo));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.config).toBeNull();
    expect(result.current.error).toBeNull();
  });

  // =========================================================================
  // 6. Sets error when invoke throws
  // =========================================================================

  it("sets error when invoke throws", async () => {
    const repo = makeLocalRepo();
    mockInvoke.mockRejectedValue(new Error("IPC channel closed"));

    const { result } = renderHook(() => useYarrConfig(repo));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.config).toBeNull();
    expect(result.current.error).toBe("IPC channel closed");
  });

  // =========================================================================
  // 7. Maps env field to envVars in returned config
  // =========================================================================

  it("maps env field to envVars in returned config", async () => {
    const repo = makeLocalRepo();
    const ipcConfig = {
      model: "opus",
      env: { API_KEY: "secret", NODE_ENV: "production" },
    };
    mockInvoke.mockResolvedValue({ config: ipcConfig, error: null });

    const { result } = renderHook(() => useYarrConfig(repo));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.config).toEqual({
      model: "opus",
      envVars: { API_KEY: "secret", NODE_ENV: "production" },
    });
    // The raw "env" key should not be present on the returned config
    expect(result.current.config).not.toHaveProperty("env");
  });

  // =========================================================================
  // 8. Re-fetches when repo changes
  // =========================================================================

  it("re-fetches when repo changes", async () => {
    const repo1 = makeLocalRepo({ id: "repo-1", path: "/path/one" });
    const repo2 = makeLocalRepo({ id: "repo-2", path: "/path/two" });

    mockInvoke.mockResolvedValue({ config: { model: "opus" }, error: null });

    const { rerender, result } = renderHook(
      (props: { repo: RepoConfig | null }) => useYarrConfig(props.repo),
      { initialProps: { repo: repo1 } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockInvoke).toHaveBeenCalledWith("read_yarr_config", { repo: repo1 });

    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue({ config: { model: "sonnet" }, error: null });

    rerender({ repo: repo2 });

    expect(mockInvoke).toHaveBeenCalledWith("read_yarr_config", { repo: repo2 });

    await waitFor(() => {
      expect(result.current.config).toEqual({ model: "sonnet" });
    });
  });

  // =========================================================================
  // 9. refresh() triggers a re-fetch
  // =========================================================================

  it("refresh() triggers a re-fetch", async () => {
    const repo = makeLocalRepo();
    mockInvoke.mockResolvedValue({ config: { model: "opus" }, error: null });

    const { result } = renderHook(() => useYarrConfig(repo));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);

    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue({ config: { model: "sonnet" }, error: null });

    act(() => {
      result.current.refresh();
    });

    expect(mockInvoke).toHaveBeenCalledWith("read_yarr_config", { repo });

    await waitFor(() => {
      expect(result.current.config).toEqual({ model: "sonnet" });
    });
  });

  // =========================================================================
  // 10. Sets loading=true while fetching
  // =========================================================================

  it("sets loading=true while fetching", async () => {
    const repo = makeLocalRepo();

    let resolveInvoke: (value: unknown) => void;
    mockInvoke.mockReturnValue(
      new Promise((resolve) => {
        resolveInvoke = resolve;
      }),
    );

    const { result } = renderHook(() => useYarrConfig(repo));

    // Should be loading while the promise is pending
    expect(result.current.loading).toBe(true);
    expect(result.current.config).toBeNull();
    expect(result.current.error).toBeNull();

    // Resolve the invoke call
    await act(async () => {
      resolveInvoke!({ config: { model: "opus" }, error: null });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.config).toEqual({ model: "opus" });
  });
});
