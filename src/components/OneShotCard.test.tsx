import { vi, describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { OneShotCard } from "./OneShotCard";
import type { OneShotEntry } from "../types";

afterEach(() => {
  cleanup();
});

// ===========================================================================
// Test helpers
// ===========================================================================

function makeEntry(overrides: Partial<OneShotEntry> = {}): OneShotEntry {
  return {
    id: "oneshot-abc123",
    parentRepoId: "repo-1",
    parentRepoName: "my-project",
    title: "Fix login bug",
    prompt: "Fix the login bug where users get redirected incorrectly",
    model: "opus",
    mergeStrategy: "merge",
    status: "running",
    startedAt: Date.now(),
    ...overrides,
  };
}

// ===========================================================================
// OneShotCard
// ===========================================================================

describe("OneShotCard", () => {
  // =========================================================================
  // 1. Rendering basics
  // =========================================================================

  it("renders as a button element", () => {
    render(
      <OneShotCard
        entry={makeEntry()}
        phase="design"
        onClick={vi.fn()}
      />,
    );
    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
  });

  // =========================================================================
  // 2. Title display
  // =========================================================================

  it("shows the entry title", () => {
    render(
      <OneShotCard
        entry={makeEntry({ title: "Refactor auth module" })}
        phase="design"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("Refactor auth module")).toBeInTheDocument();
  });

  // =========================================================================
  // 3. 1-Shot badge
  // =========================================================================

  it('shows "1-Shot" badge text', () => {
    render(
      <OneShotCard
        entry={makeEntry()}
        phase="design"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("1-Shot")).toBeInTheDocument();
  });

  // =========================================================================
  // 4. Parent repo name
  // =========================================================================

  it('shows "from {parentRepoName}" subtitle', () => {
    render(
      <OneShotCard
        entry={makeEntry({ parentRepoName: "awesome-repo" })}
        phase="design"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("from awesome-repo")).toBeInTheDocument();
  });

  // =========================================================================
  // 5. Phase label
  // =========================================================================

  it("shows the phase label from phaseLabel() helper", () => {
    render(
      <OneShotCard
        entry={makeEntry()}
        phase="implementation"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("Implementation Phase")).toBeInTheDocument();
  });

  it("shows phase label for design phase", () => {
    render(
      <OneShotCard
        entry={makeEntry()}
        phase="design"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("Design Phase")).toBeInTheDocument();
  });

  it("shows phase label for complete phase", () => {
    render(
      <OneShotCard
        entry={makeEntry({ status: "completed" })}
        phase="complete"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("Complete")).toBeInTheDocument();
  });

  it("shows phase label for failed phase", () => {
    render(
      <OneShotCard
        entry={makeEntry({ status: "failed" })}
        phase="failed"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  // =========================================================================
  // 6. Prompt preview
  // =========================================================================

  it("shows the prompt text", () => {
    render(
      <OneShotCard
        entry={makeEntry({
          prompt: "Implement a new caching layer for the API",
        })}
        phase="design"
        onClick={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Implement a new caching layer for the API"),
    ).toBeInTheDocument();
  });

  // =========================================================================
  // 7. Timestamp
  // =========================================================================

  it("shows time ago for startedAt", () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    render(
      <OneShotCard
        entry={makeEntry({ startedAt: twoHoursAgo })}
        phase="design"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("2h ago")).toBeInTheDocument();
  });

  // =========================================================================
  // 8. aria-label
  // =========================================================================

  it('has aria-label in format "{title} — 1-Shot"', () => {
    render(
      <OneShotCard
        entry={makeEntry({ title: "Fix login bug" })}
        phase="design"
        onClick={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Fix login bug — 1-Shot",
    });
    expect(button).toBeInTheDocument();
  });

  it("updates aria-label for different titles", () => {
    render(
      <OneShotCard
        entry={makeEntry({ title: "Add dark mode" })}
        phase="implementation"
        onClick={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Add dark mode — 1-Shot",
    });
    expect(button).toBeInTheDocument();
  });

  // =========================================================================
  // 9. onClick handler
  // =========================================================================

  it("calls onClick when the card is clicked", () => {
    const handleClick = vi.fn();
    render(
      <OneShotCard
        entry={makeEntry()}
        phase="design"
        onClick={handleClick}
      />,
    );
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick before clicking", () => {
    const handleClick = vi.fn();
    render(
      <OneShotCard
        entry={makeEntry()}
        phase="design"
        onClick={handleClick}
      />,
    );
    expect(handleClick).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 10. Dismiss button for failed entries
  // =========================================================================

  it("shows dismiss button when status is failed and onDismiss is provided", () => {
    render(
      <OneShotCard
        entry={makeEntry({ status: "failed" })}
        phase="failed"
        onClick={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const dismissButton = screen.getByRole("button", { name: /dismiss/i });
    expect(dismissButton).toBeInTheDocument();
  });

  // =========================================================================
  // 11. Dismiss button hidden for running
  // =========================================================================

  it("does not show dismiss button when status is running", () => {
    render(
      <OneShotCard
        entry={makeEntry({ status: "running" })}
        phase="design"
        onClick={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /dismiss/i }),
    ).not.toBeInTheDocument();
  });

  // =========================================================================
  // 12. Dismiss button hidden for completed
  // =========================================================================

  it("does not show dismiss button when status is completed", () => {
    render(
      <OneShotCard
        entry={makeEntry({ status: "completed" })}
        phase="complete"
        onClick={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /dismiss/i }),
    ).not.toBeInTheDocument();
  });

  // =========================================================================
  // 13. Dismiss button click — calls onDismiss, not onClick
  // =========================================================================

  it("calls onDismiss and does not call onClick when dismiss button is clicked", () => {
    const handleClick = vi.fn();
    const handleDismiss = vi.fn();
    render(
      <OneShotCard
        entry={makeEntry({ status: "failed" })}
        phase="failed"
        onClick={handleClick}
        onDismiss={handleDismiss}
      />,
    );
    const dismissButton = screen.getByRole("button", { name: /dismiss/i });
    fireEvent.click(dismissButton);
    expect(handleDismiss).toHaveBeenCalledTimes(1);
    expect(handleClick).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 14. No dismiss button when onDismiss not provided
  // =========================================================================

  it("does not show dismiss button when onDismiss is not provided even if status is failed", () => {
    render(
      <OneShotCard
        entry={makeEntry({ status: "failed" })}
        phase="failed"
        onClick={vi.fn()}
      />,
    );
    // Only one button should exist — the card itself
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
  });
});
