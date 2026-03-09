import { vi, describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { Breadcrumbs } from "./Breadcrumbs";

afterEach(() => {
  cleanup();
});

// ===========================================================================
// Breadcrumbs
// ===========================================================================

describe("Breadcrumbs", () => {
  // =========================================================================
  // 1. Renders without crashing with empty crumbs
  // =========================================================================

  it("renders the nav element with an empty crumbs array", () => {
    render(<Breadcrumbs crumbs={[]} />);
    const nav = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(nav).toBeInTheDocument();
  });

  it("renders no list items when crumbs is empty", () => {
    render(<Breadcrumbs crumbs={[]} />);
    const items = screen.queryAllByRole("listitem");
    expect(items).toHaveLength(0);
  });

  // =========================================================================
  // 2. Single crumb renders as BreadcrumbPage (terminal, non-clickable)
  // =========================================================================

  it("renders a single crumb without onClick as BreadcrumbPage with aria-current", () => {
    render(<Breadcrumbs crumbs={[{ label: "Home" }]} />);
    const page = screen.getByText("Home");
    expect(page).toHaveAttribute("aria-current", "page");
  });

  // =========================================================================
  // 3. Single crumb renders no separators
  // =========================================================================

  it("renders no separators for a single crumb", () => {
    render(<Breadcrumbs crumbs={[{ label: "Home" }]} />);
    const separators = document.querySelectorAll(
      '[data-slot="breadcrumb-separator"]',
    );
    expect(separators).toHaveLength(0);
  });

  // =========================================================================
  // 4. Multiple crumbs: clickable crumbs render as links, terminal crumb
  //    renders as page
  // =========================================================================

  it("renders clickable crumbs as links and the terminal crumb as a page", () => {
    const crumbs = [
      { label: "Home", onClick: vi.fn() },
      { label: "Repos", onClick: vi.fn() },
      { label: "Current" },
    ];
    render(<Breadcrumbs crumbs={crumbs} />);

    // Clickable crumbs should be rendered as BreadcrumbLink (anchor elements)
    const homeLink = screen.getByText("Home");
    expect(homeLink.closest('[data-slot="breadcrumb-link"]')).not.toBeNull();

    const reposLink = screen.getByText("Repos");
    expect(reposLink.closest('[data-slot="breadcrumb-link"]')).not.toBeNull();

    // Terminal crumb without onClick renders as BreadcrumbPage
    const currentPage = screen.getByText("Current");
    expect(currentPage).toHaveAttribute("aria-current", "page");
  });

  // =========================================================================
  // 5. Clicking a clickable crumb calls its onClick handler
  // =========================================================================

  it("calls onClick when a clickable crumb is clicked", () => {
    const handleClick = vi.fn();
    const crumbs = [
      { label: "Home", onClick: handleClick },
      { label: "Current" },
    ];
    render(<Breadcrumbs crumbs={crumbs} />);

    const homeLink = screen.getByText("Home");
    fireEvent.click(homeLink);

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // 6. Separators appear between crumbs (count = crumbs.length - 1)
  // =========================================================================

  it("renders the correct number of separators between crumbs", () => {
    const crumbs = [
      { label: "Home", onClick: vi.fn() },
      { label: "Repos", onClick: vi.fn() },
      { label: "Detail", onClick: vi.fn() },
      { label: "Current" },
    ];
    render(<Breadcrumbs crumbs={crumbs} />);

    const separators = document.querySelectorAll(
      '[data-slot="breadcrumb-separator"]',
    );
    expect(separators).toHaveLength(crumbs.length - 1);
  });

  it("renders exactly one separator for two crumbs", () => {
    const crumbs = [
      { label: "Home", onClick: vi.fn() },
      { label: "Current" },
    ];
    render(<Breadcrumbs crumbs={crumbs} />);

    const separators = document.querySelectorAll(
      '[data-slot="breadcrumb-separator"]',
    );
    expect(separators).toHaveLength(1);
  });

  // =========================================================================
  // 7. Middle crumbs with onClick are clickable
  // =========================================================================

  it("calls onClick for a middle crumb when clicked", () => {
    const homeClick = vi.fn();
    const reposClick = vi.fn();
    const crumbs = [
      { label: "Home", onClick: homeClick },
      { label: "Repos", onClick: reposClick },
      { label: "Current" },
    ];
    render(<Breadcrumbs crumbs={crumbs} />);

    fireEvent.click(screen.getByText("Repos"));

    expect(reposClick).toHaveBeenCalledTimes(1);
    expect(homeClick).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 8. Terminal crumb with onClick renders as clickable (BreadcrumbLink),
  //    not as BreadcrumbPage
  // =========================================================================

  it("renders the last crumb as a clickable link when it has onClick", () => {
    const handleClick = vi.fn();
    const crumbs = [
      { label: "Home", onClick: vi.fn() },
      { label: "Final", onClick: handleClick },
    ];
    render(<Breadcrumbs crumbs={crumbs} />);

    const finalLink = screen.getByText("Final");

    // Should be a BreadcrumbLink, NOT a BreadcrumbPage
    expect(finalLink.closest('[data-slot="breadcrumb-link"]')).not.toBeNull();
    expect(finalLink).not.toHaveAttribute("aria-current", "page");

    fireEvent.click(finalLink);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("renders the last crumb as BreadcrumbPage only when it has no onClick", () => {
    const crumbs = [
      { label: "Home", onClick: vi.fn() },
      { label: "Final" },
    ];
    render(<Breadcrumbs crumbs={crumbs} />);

    const finalPage = screen.getByText("Final");
    expect(finalPage).toHaveAttribute("aria-current", "page");
    expect(finalPage.closest('[data-slot="breadcrumb-link"]')).toBeNull();
  });
});
