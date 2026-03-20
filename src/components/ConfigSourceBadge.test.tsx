import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfigSourceBadge } from "./ConfigSourceBadge";

afterEach(() => {
  cleanup();
});

// ===========================================================================
// ConfigSourceBadge
// ===========================================================================

describe("ConfigSourceBadge", () => {
  // =========================================================================
  // 1. Renders nothing when source is "default"
  // =========================================================================

  it("renders nothing when source is 'default'", () => {
    const { container } = render(<ConfigSourceBadge source="default" />);
    expect(container.innerHTML).toBe("");
  });

  // =========================================================================
  // 2. Renders "repo config" text when source is "yarr-yml"
  // =========================================================================

  it("renders 'repo config' text when source is 'yarr-yml'", () => {
    render(<ConfigSourceBadge source="yarr-yml" />);
    expect(screen.getByText("repo config")).toBeTruthy();
  });

  // =========================================================================
  // 3. "repo config" span has correct classes
  // =========================================================================

  it("'repo config' span has text-xs, font-mono, and text-info classes", () => {
    render(<ConfigSourceBadge source="yarr-yml" />);
    const span = screen.getByText("repo config");
    expect(span.classList.contains("text-xs")).toBe(true);
    expect(span.classList.contains("font-mono")).toBe(true);
    expect(span.classList.contains("text-info")).toBe(true);
  });

  // =========================================================================
  // 4. Renders "custom" text when source is "override"
  // =========================================================================

  it("renders 'custom' text when source is 'override'", () => {
    render(<ConfigSourceBadge source="override" onReset={() => {}} />);
    expect(screen.getByText("custom")).toBeTruthy();
  });

  // =========================================================================
  // 5. "custom" span has correct classes
  // =========================================================================

  it("'custom' span has text-xs, font-mono, and text-primary classes", () => {
    render(<ConfigSourceBadge source="override" onReset={() => {}} />);
    const span = screen.getByText("custom");
    expect(span.classList.contains("text-xs")).toBe(true);
    expect(span.classList.contains("font-mono")).toBe(true);
    expect(span.classList.contains("text-primary")).toBe(true);
  });

  // =========================================================================
  // 6. Shows reset button with aria-label when source is "override"
  // =========================================================================

  it("shows a reset button with correct aria-label when source is 'override'", () => {
    render(<ConfigSourceBadge source="override" onReset={() => {}} />);
    const button = screen.getByLabelText("Reset to default");
    expect(button).toBeTruthy();
  });

  // =========================================================================
  // 7. Calls onReset when reset button is clicked
  // =========================================================================

  it("calls onReset when the reset button is clicked", async () => {
    const onReset = vi.fn();
    render(<ConfigSourceBadge source="override" onReset={onReset} />);
    const button = screen.getByLabelText("Reset to default");
    await userEvent.click(button);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // 8. Does not render reset button when source is "yarr-yml"
  // =========================================================================

  it("does not render a reset button when source is 'yarr-yml'", () => {
    render(<ConfigSourceBadge source="yarr-yml" />);
    const button = screen.queryByLabelText("Reset to default");
    expect(button).toBeNull();
  });

  // =========================================================================
  // 9. Does not render reset button when source is "default"
  // =========================================================================

  it("does not render a reset button when source is 'default'", () => {
    render(<ConfigSourceBadge source="default" />);
    const button = screen.queryByLabelText("Reset to default");
    expect(button).toBeNull();
  });
});
