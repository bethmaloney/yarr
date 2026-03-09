import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Badge, badgeVariants } from "@/components/ui/badge";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Render a Badge with the given variant and return the element. */
function renderBadge(variant: string, text?: string) {
  const label = text ?? `badge-${variant}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { getByText } = render(
    <Badge variant={variant as any}>{label}</Badge>,
  );
  return getByText(label);
}

/** Call badgeVariants with a variant string, bypassing the narrow union type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function variantClasses(variant: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return badgeVariants({ variant } as any);
}

// ---------------------------------------------------------------------------
// 1. New variants render without error
// ---------------------------------------------------------------------------

describe("Badge — new variant rendering", () => {
  it.each([
    "warning",
    "success",
    "completed",
    "failed",
    "maxiters",
    "cancelled",
  ])("renders the '%s' variant without error", (variant) => {
    const el = renderBadge(variant, `render-${variant}`);
    expect(el).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. data-variant attribute is set correctly
// ---------------------------------------------------------------------------

describe("Badge — data-variant attribute", () => {
  it.each([
    "warning",
    "success",
    "completed",
    "failed",
    "maxiters",
    "cancelled",
  ])("sets data-variant='%s'", (variant) => {
    const el = renderBadge(variant, `dv-${variant}`);
    expect(el).toHaveAttribute("data-variant", variant);
  });
});

// ---------------------------------------------------------------------------
// 3. badgeVariants returns expected CSS classes per variant
// ---------------------------------------------------------------------------

describe("Badge — badgeVariants CSS classes", () => {
  it("warning variant includes amber styling classes", () => {
    const classes = variantClasses("warning");
    expect(classes).toMatch(/amber/);
  });

  it("success variant includes green/emerald styling classes", () => {
    const classes = variantClasses("success");
    expect(classes).toMatch(/green|emerald/);
  });

  it("completed variant includes green/emerald styling classes (same as success)", () => {
    const classes = variantClasses("completed");
    expect(classes).toMatch(/green|emerald/);
  });

  it("failed variant includes destructive styling classes", () => {
    const classes = variantClasses("failed");
    expect(classes).toMatch(/bg-destructive/);
  });

  it("maxiters variant includes amber/warning styling classes (same as warning)", () => {
    const classes = variantClasses("maxiters");
    expect(classes).toMatch(/amber/);
  });

  it("cancelled variant includes gray styling classes", () => {
    const classes = variantClasses("cancelled");
    expect(classes).toMatch(/gray/);
  });
});

// ---------------------------------------------------------------------------
// 4. Existing variants still work
// ---------------------------------------------------------------------------

describe("Badge — existing variants still work", () => {
  it("renders default variant", () => {
    const el = renderBadge("default", "existing-default");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("data-variant", "default");
    expect(el).toHaveAttribute("data-slot", "badge");
  });

  it("renders secondary variant", () => {
    const el = renderBadge("secondary", "existing-secondary");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("data-variant", "secondary");
  });

  it("renders destructive variant", () => {
    const el = renderBadge("destructive", "existing-destructive");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("data-variant", "destructive");
  });

  it("default variant has primary classes", () => {
    const classes = variantClasses("default");
    expect(classes).toMatch(/bg-primary/);
  });

  it("secondary variant has secondary classes", () => {
    const classes = variantClasses("secondary");
    expect(classes).toMatch(/bg-secondary/);
  });

  it("destructive variant has destructive classes", () => {
    const classes = variantClasses("destructive");
    expect(classes).toMatch(/bg-destructive/);
  });
});
