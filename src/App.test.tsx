import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockInitialize, mockCleanup, stableStore } = vi.hoisted(() => {
  const mockInitialize = vi.fn();
  const mockCleanup = vi.fn();
  // All store values must be stable references to avoid infinite re-render loops.
  // Creating vi.fn() inside the selector callback would produce a new reference on
  // every render, causing React to re-render indefinitely and OOM.
  const stableStore: Record<string, unknown> = {
    initialize: mockInitialize,
    repos: [],
    sessions: new Map(),
    latestTraces: new Map(),
    oneShotEntries: new Map(),
    addLocalRepo: vi.fn(),
    addSshRepo: vi.fn(),
    dismissOneShot: vi.fn(),
    runSession: vi.fn(),
    stopSession: vi.fn(),
    reconnectSession: vi.fn(),
    updateRepo: vi.fn(),
    runOneShot: vi.fn(),
    gitStatus: {},
    fetchGitStatus: vi.fn(),
  };
  return { mockInitialize, mockCleanup, stableStore };
});

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock("./store", () => ({
  useAppStore: vi.fn((selector?: unknown) => {
    if (typeof selector === "function") {
      return (selector as (s: Record<string, unknown>) => unknown)(stableStore);
    }
    return stableStore;
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

// ---------------------------------------------------------------------------
// Import the component under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { AppRoutes } from "./App";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithRouter(initialEntries: string[] = ["/"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockInitialize.mockReturnValue(mockCleanup);
});

afterEach(() => {
  cleanup();
});

// ===========================================================================
// 1. Renders without crashing
// ===========================================================================

describe("App", () => {
  it("renders without crashing", () => {
    renderWithRouter();
    // If we get here without throwing, the component mounted successfully
    expect(document.body).toBeTruthy();
  });

  // =========================================================================
  // 2. Route: / renders Home placeholder
  // =========================================================================

  describe("route /", () => {
    it("renders Home page", () => {
      renderWithRouter(["/"]);
      expect(screen.getByText("Yarr")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 3. Route: /repo/:repoId renders RepoDetail page
  // =========================================================================

  describe("route /repo/:repoId", () => {
    it("renders RepoDetail page for unknown repo", () => {
      renderWithRouter(["/repo/test-id"]);
      expect(screen.getByText("Repo not found")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 4. Route: /oneshot/:oneshotId renders OneShotDetail page
  // =========================================================================

  describe("route /oneshot/:oneshotId", () => {
    it("renders OneShotDetail page showing not found for unknown oneshotId", async () => {
      renderWithRouter(["/oneshot/oneshot-nonexistent"]);
      await waitFor(() => {
        expect(screen.getByText(/not found/i)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // 4b. Old route /repo/:repoId/oneshot is removed
  // =========================================================================

  describe("route /repo/:repoId/oneshot (removed)", () => {
    it("does not render OneShot page at the old route", () => {
      renderWithRouter(["/repo/test-id/oneshot"]);
      // Old route should no longer match — should not render "Repo not found" from OneShot
      expect(screen.queryByText("Repo not found")).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // 5. Route: /history renders History page
  // =========================================================================

  describe("route /history", () => {
    it("renders History page", () => {
      renderWithRouter(["/history"]);
      expect(
        screen.getByRole("heading", { name: /history/i }),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 6. Route: /history/:repoId renders History page
  // =========================================================================

  describe("route /history/:repoId", () => {
    it("renders History page", () => {
      renderWithRouter(["/history/test-id"]);
      expect(
        screen.getByRole("heading", { name: /history/i }),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 7. Route: /run/:repoId/:sessionId renders RunDetail page
  // =========================================================================

  describe("route /run/:repoId/:sessionId", () => {
    it("renders RunDetail page with loading state", () => {
      renderWithRouter(["/run/test-id/sess-123"]);
      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 8. Store initialization — initialize() is called on mount
  // =========================================================================

  describe("store initialization", () => {
    it("calls initialize() on mount", () => {
      renderWithRouter();
      expect(mockInitialize).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 9. Store cleanup — cleanup function is called on unmount
  // =========================================================================

  describe("store cleanup", () => {
    it("calls the cleanup function returned by initialize() on unmount", () => {
      const { unmount } = renderWithRouter();

      expect(mockInitialize).toHaveBeenCalledTimes(1);
      expect(mockCleanup).not.toHaveBeenCalled();

      unmount();

      expect(mockCleanup).toHaveBeenCalledTimes(1);
    });
  });
});
