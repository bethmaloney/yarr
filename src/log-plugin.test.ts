import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any vi.mock() calls
// ---------------------------------------------------------------------------

const { mockAttachConsole } = vi.hoisted(() => ({
  mockAttachConsole: vi.fn(),
}));

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/plugin-log", () => ({
  attachConsole: mockAttachConsole,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("@tauri-apps/plugin-log integration", () => {
  beforeEach(() => {
    mockAttachConsole.mockReset();
  });

  it("attachConsole can be called successfully", async () => {
    const mockDetach = vi.fn();
    mockAttachConsole.mockResolvedValue(mockDetach);

    const { attachConsole } = await import("@tauri-apps/plugin-log");
    const detach = await attachConsole();

    expect(attachConsole).toHaveBeenCalledOnce();
    expect(detach).toBe(mockDetach);
  });

  it("attachConsole returns a detach function", async () => {
    const mockDetach = vi.fn();
    mockAttachConsole.mockResolvedValue(mockDetach);

    const { attachConsole } = await import("@tauri-apps/plugin-log");
    const detach = await attachConsole();

    expect(typeof detach).toBe("function");
    // Calling detach should not throw
    detach();
    expect(mockDetach).toHaveBeenCalledOnce();
  });

  it("handles attachConsole rejection gracefully", async () => {
    mockAttachConsole.mockRejectedValue(new Error("no Tauri runtime"));

    const { attachConsole } = await import("@tauri-apps/plugin-log");
    // Simulates the pattern used in main.tsx: attachConsole().catch(() => {})
    await expect(attachConsole().catch(() => {})).resolves.toBeUndefined();
  });
});
