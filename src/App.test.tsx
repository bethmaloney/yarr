import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockInitialize, mockCleanup } = vi.hoisted(() => ({
  mockInitialize: vi.fn(),
  mockCleanup: vi.fn(),
}));

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock("./store", () => ({
  useAppStore: vi.fn((selector?: unknown) => {
    if (typeof selector === "function") {
      return (selector as (s: Record<string, unknown>) => unknown)({
        initialize: mockInitialize,
        repos: [],
        sessions: new Map(),
        latestTraces: new Map(),
        addLocalRepo: vi.fn(),
        addSshRepo: vi.fn(),
      });
    }
    return { initialize: mockInitialize };
  }),
}));

vi.mock("./hooks/useBranchInfo", () => ({
  useBranchInfo: () => new Map(),
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
  // 3. Route: /repo/:repoId renders RepoDetail placeholder
  // =========================================================================

  describe("route /repo/:repoId", () => {
    it("renders RepoDetail placeholder text", () => {
      renderWithRouter(["/repo/test-id"]);
      expect(screen.getByText(/repo/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 4. Route: /repo/:repoId/oneshot renders OneShot placeholder
  // =========================================================================

  describe("route /repo/:repoId/oneshot", () => {
    it("renders OneShot placeholder text", () => {
      renderWithRouter(["/repo/test-id/oneshot"]);
      expect(screen.getByText(/oneshot/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 5. Route: /history renders History placeholder
  // =========================================================================

  describe("route /history", () => {
    it("renders History placeholder text", () => {
      renderWithRouter(["/history"]);
      expect(screen.getByText(/history/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 6. Route: /history/:repoId renders History placeholder
  // =========================================================================

  describe("route /history/:repoId", () => {
    it("renders History placeholder text", () => {
      renderWithRouter(["/history/test-id"]);
      expect(screen.getByText(/history/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // 7. Route: /run/:repoId/:sessionId renders RunDetail placeholder
  // =========================================================================

  describe("route /run/:repoId/:sessionId", () => {
    it("renders RunDetail placeholder text", () => {
      renderWithRouter(["/run/test-id/sess-123"]);
      expect(screen.getByText(/run/i)).toBeInTheDocument();
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
