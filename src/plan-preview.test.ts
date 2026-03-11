import { describe, it, expect } from "vitest";
import { parsePlanPreview, planDisplayName } from "./plan-preview";

describe("parsePlanPreview", () => {
  it("extracts H1 heading as name and following text as excerpt", () => {
    const content = "# My Plan\nThis is the first paragraph of the plan.";
    const result = parsePlanPreview(content);
    expect(result.name).toBe("My Plan");
    expect(result.excerpt).toBe("This is the first paragraph of the plan.");
  });

  it("stops excerpt at the first blank line", () => {
    const content =
      "# Authentication Refactor\nExtract auth into middleware.\nUse JWT tokens.\n\nThis should not be included.";
    const result = parsePlanPreview(content);
    expect(result.name).toBe("Authentication Refactor");
    expect(result.excerpt).toBe(
      "Extract auth into middleware.\nUse JWT tokens.",
    );
  });

  it("returns empty name and excerpt for empty string", () => {
    const result = parsePlanPreview("");
    expect(result.name).toBe("");
    expect(result.excerpt).toBe("");
  });

  it("returns name with empty excerpt when content has heading only", () => {
    const result = parsePlanPreview("# Solo Heading");
    expect(result.name).toBe("Solo Heading");
    expect(result.excerpt).toBe("");
  });

  it("returns name with empty excerpt when body is only blank lines", () => {
    const result = parsePlanPreview("# Title\n\n\n");
    expect(result.name).toBe("Title");
    expect(result.excerpt).toBe("");
  });

  it("treats ## sub-heading as excerpt content, not a name", () => {
    const content = "## Sub-heading\nSome details here.";
    const result = parsePlanPreview(content);
    expect(result.name).toBe("");
    expect(result.excerpt).toBe("## Sub-heading\nSome details here.");
  });

  it("returns first non-blank lines as excerpt when no H1 heading is found", () => {
    const content = "No heading here.\nJust plain text.";
    const result = parsePlanPreview(content);
    expect(result.name).toBe("");
    expect(result.excerpt).toBe("No heading here.\nJust plain text.");
  });

  it("skips leading blank lines when there is no heading", () => {
    const content = "\n\nActual content starts here.";
    const result = parsePlanPreview(content);
    expect(result.name).toBe("");
    expect(result.excerpt).toBe("Actual content starts here.");
  });

  it("truncates long paragraph to approximately 200 characters", () => {
    const longText = "A".repeat(300);
    const content = `# Long Plan\n${longText}`;
    const result = parsePlanPreview(content);
    expect(result.name).toBe("Long Plan");
    expect(result.excerpt.length).toBeLessThanOrEqual(200);
  });

  it("truncates excerpt without heading to approximately 200 characters", () => {
    const longText = "B".repeat(300);
    const result = parsePlanPreview(longText);
    expect(result.name).toBe("");
    expect(result.excerpt.length).toBeLessThanOrEqual(200);
  });

  it("preserves content that is exactly 200 characters", () => {
    const exactText = "C".repeat(200);
    const content = `# Exact\n${exactText}`;
    const result = parsePlanPreview(content);
    expect(result.name).toBe("Exact");
    expect(result.excerpt).toBe(exactText);
  });

  it("handles heading with extra whitespace after #", () => {
    const content = "#   Spaced Heading\nBody text.";
    const result = parsePlanPreview(content);
    expect(result.name).toBe("Spaced Heading");
    expect(result.excerpt).toBe("Body text.");
  });

  it("does not treat # inside text as a heading", () => {
    const content = "This has a # character mid-line.";
    const result = parsePlanPreview(content);
    expect(result.name).toBe("");
    expect(result.excerpt).toBe("This has a # character mid-line.");
  });

  it("handles heading followed immediately by blank line then text", () => {
    const content = "# Heading\n\nText after blank line.";
    const result = parsePlanPreview(content);
    expect(result.name).toBe("Heading");
    // Excerpt should be empty because the first line after the heading is blank
    expect(result.excerpt).toBe("");
  });
});

describe("planDisplayName", () => {
  it("returns parsed name when parsedName is provided and non-empty", () => {
    expect(
      planDisplayName("/path/to/2026-03-11-auth-plan.md", "Auth Plan"),
    ).toBe("Auth Plan");
  });

  it("strips .md and date prefix from filename when no parsedName", () => {
    expect(planDisplayName("/home/user/plans/2026-03-11-auth-refactor.md")).toBe(
      "auth-refactor",
    );
  });

  it("strips .md only when filename has no date prefix", () => {
    expect(planDisplayName("/home/user/plans/my-plan.md")).toBe("my-plan");
  });

  it('returns em dash when planFile is null', () => {
    expect(planDisplayName(null)).toBe("\u2014");
  });

  it("ignores empty parsedName and falls back to filename", () => {
    expect(planDisplayName("/path/to/2026-01-15-deploy.md", "")).toBe("deploy");
  });

  it("handles filename without .md extension", () => {
    expect(planDisplayName("/path/to/readme.txt")).toBe("readme.txt");
  });

  it("handles deeply nested path", () => {
    expect(
      planDisplayName("/a/b/c/d/2025-12-01-nested-plan.md"),
    ).toBe("nested-plan");
  });

  it("handles filename that is only a date prefix with .md", () => {
    expect(planDisplayName("/path/to/2026-03-11-.md")).toBe("");
  });

  it("returns parsedName over filename extraction when both available", () => {
    expect(
      planDisplayName("/path/to/2026-03-11-raw-name.md", "Pretty Name"),
    ).toBe("Pretty Name");
  });

  it("handles Windows-style backslash paths", () => {
    // planDisplayName should handle the last segment regardless of separator
    expect(
      planDisplayName("C:\\Users\\docs\\2026-03-11-plan.md"),
    ).toBe("plan");
  });

  it("strips date prefix matching YYYY-MM-DD- pattern only", () => {
    // Should not strip partial matches
    expect(planDisplayName("/path/to/2026-03-my-plan.md")).toBe(
      "2026-03-my-plan",
    );
  });

  it("handles undefined parsedName same as omitted", () => {
    expect(planDisplayName("/path/to/2026-03-11-design.md", undefined)).toBe(
      "design",
    );
  });
});
