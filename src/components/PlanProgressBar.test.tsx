import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { PlanProgressBar } from "./PlanProgressBar";
import type { PlanProgress } from "../plan-progress";

afterEach(() => {
  cleanup();
});

// ===========================================================================
// Test helpers
// ===========================================================================

function makeProgress(overrides: Partial<PlanProgress> = {}): PlanProgress {
  return {
    tasks: [
      { number: 1, title: "Setup environment", total: 10, completed: 5 },
      { number: 2, title: "Implement feature", total: 10, completed: 5 },
    ],
    totalItems: 20,
    completedItems: 10,
    currentTask: { number: 1, title: "Setup environment", total: 10, completed: 5 },
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("PlanProgressBar", () => {
  it("renders progress bar with correct percentage width", () => {
    const progress = makeProgress();
    const { container } = render(<PlanProgressBar progress={progress} />);

    // The fill div should have width: 50% (10/20 items)
    const fillDiv = container.querySelector("[style*='width']");
    expect(fillDiv).not.toBeNull();
    expect(fillDiv!.getAttribute("style")).toContain("width: 50%");
  });

  it("shows stats line with percentage and fraction", () => {
    const progress = makeProgress();
    render(<PlanProgressBar progress={progress} />);

    expect(screen.getByText(/50%/)).toBeTruthy();
    expect(screen.getByText(/10\/20 items/)).toBeTruthy();
  });

  it("shows current task name", () => {
    const progress = makeProgress({
      currentTask: { number: 3, title: "Frontend store", total: 5, completed: 2 },
    });
    render(<PlanProgressBar progress={progress} />);

    expect(screen.getByText(/Next: Task 3 — Frontend store/)).toBeTruthy();
  });

  it('shows "All tasks complete" when currentTask is null', () => {
    const progress = makeProgress({
      totalItems: 4,
      completedItems: 4,
      currentTask: null,
      tasks: [
        { number: 1, title: "Done", total: 2, completed: 2 },
        { number: 2, title: "Also done", total: 2, completed: 2 },
      ],
    });
    render(<PlanProgressBar progress={progress} />);

    expect(screen.getByText(/All tasks complete/)).toBeTruthy();
  });

  it("uses green fill color when 100% complete", () => {
    const progress = makeProgress({
      totalItems: 4,
      completedItems: 4,
      currentTask: null,
      tasks: [
        { number: 1, title: "Done", total: 2, completed: 2 },
        { number: 2, title: "Also done", total: 2, completed: 2 },
      ],
    });
    const { container } = render(<PlanProgressBar progress={progress} />);

    const fillDiv = container.querySelector("[style*='width']");
    expect(fillDiv).not.toBeNull();
    expect(fillDiv!.className).toContain("bg-[#34d399]");
  });

  it("uses teal fill color when not complete", () => {
    const progress = makeProgress();
    const { container } = render(<PlanProgressBar progress={progress} />);

    const fillDiv = container.querySelector("[style*='width']");
    expect(fillDiv).not.toBeNull();
    expect(fillDiv!.className).toContain("bg-[#4ecdc4]");
  });
});
