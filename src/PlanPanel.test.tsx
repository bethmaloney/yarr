import { vi, describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PlanPanel } from "./PlanPanel";

// Mock react-markdown since it requires ESM and doesn't play well with jsdom.
// Render children as plain text so we can assert on markdown content.
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

afterEach(() => {
  cleanup();
});

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  planContent: "# Hello\n\nSome plan content.",
  planFile: "/home/beth/plans/2026-03-14-auth-redesign.md",
};

describe("PlanPanel", () => {
  // ===========================================================================
  // 1. Renders nothing visible when open is false
  // ===========================================================================

  it("renders nothing visible when open is false", () => {
    render(<PlanPanel {...defaultProps} open={false} />);
    // The sheet title (basename) should not be visible
    expect(
      screen.queryByText("2026-03-14-auth-redesign.md"),
    ).not.toBeInTheDocument();
    // The markdown content should not be visible
    expect(screen.queryByText(/Hello/)).not.toBeInTheDocument();
  });

  // ===========================================================================
  // 2. Shows plan filename (basename only) in the header when open
  // ===========================================================================

  it("shows the plan filename basename in the header when open", () => {
    render(<PlanPanel {...defaultProps} />);
    expect(
      screen.getByText("2026-03-14-auth-redesign.md"),
    ).toBeInTheDocument();
  });

  it("does not show the full path in the header", () => {
    render(<PlanPanel {...defaultProps} />);
    expect(
      screen.queryByText("/home/beth/plans/2026-03-14-auth-redesign.md"),
    ).not.toBeInTheDocument();
  });

  // ===========================================================================
  // 3. Renders markdown content in the body
  // ===========================================================================

  it("renders markdown content in the body", () => {
    render(
      <PlanPanel
        {...defaultProps}
        planContent={"# Heading\n\n- item one\n- item two\n\n```ts\nconst x = 1;\n```"}
      />,
    );
    // Our mock renders children as plain text
    expect(screen.getByText(/Heading/)).toBeInTheDocument();
    expect(screen.getByText(/item one/)).toBeInTheDocument();
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
  });

  // ===========================================================================
  // 4. Handles Windows-style paths correctly (backslash separators)
  // ===========================================================================

  it("extracts basename from Windows-style paths with backslash separators", () => {
    render(
      <PlanPanel
        {...defaultProps}
        planFile="C:\\Users\\beth\\plans\\win-plan.md"
      />,
    );
    expect(screen.getByText("win-plan.md")).toBeInTheDocument();
    expect(
      screen.queryByText("C:\\Users\\beth\\plans\\win-plan.md"),
    ).not.toBeInTheDocument();
  });

  // ===========================================================================
  // 5. Handles a plain filename (no path separators)
  // ===========================================================================

  it("handles a plain filename with no path separators", () => {
    render(
      <PlanPanel {...defaultProps} planFile="standalone-plan.md" />,
    );
    expect(screen.getByText("standalone-plan.md")).toBeInTheDocument();
  });

  // ===========================================================================
  // 6. Calls onOpenChange when close mechanism is triggered
  // ===========================================================================

  it("calls onOpenChange when the close button is clicked", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();

    render(<PlanPanel {...defaultProps} onOpenChange={onOpenChange} />);

    // shadcn Sheet renders a close button with sr-only text "Close"
    const closeButton = screen.getByRole("button", { name: /close/i });
    await user.click(closeButton);

    expect(onOpenChange).toHaveBeenCalled();
  });
});
