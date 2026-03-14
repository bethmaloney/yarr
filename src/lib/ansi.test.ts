import { describe, it, expect } from "vitest";
import { parseAnsi } from "../lib/ansi";

describe("parseAnsi", () => {
  it("parses basic foreground color", () => {
    const result = parseAnsi("\x1b[31mhello\x1b[0m");
    expect(result).toContainEqual(
      expect.objectContaining({ text: "hello", classes: "ansi-fg-red" }),
    );
  });

  it("parses bright foreground color", () => {
    const result = parseAnsi("\x1b[91mbright red\x1b[0m");
    expect(result).toContainEqual(
      expect.objectContaining({
        text: "bright red",
        classes: "ansi-fg-bright-red",
      }),
    );
  });

  it("parses background color", () => {
    const result = parseAnsi("\x1b[42mgreen bg\x1b[0m");
    expect(result).toContainEqual(
      expect.objectContaining({ text: "green bg", classes: "ansi-bg-green" }),
    );
  });

  it("stacks bold and color into multiple classes", () => {
    const result = parseAnsi("\x1b[1;34mbold blue\x1b[0m");
    const segment = result.find((s) => s.text === "bold blue");
    expect(segment).toBeDefined();
    expect(segment!.classes).toContain("ansi-bold");
    expect(segment!.classes).toContain("ansi-fg-blue");
  });

  describe("text decorations", () => {
    it("parses bold", () => {
      const result = parseAnsi("\x1b[1mbold\x1b[0m");
      expect(result).toContainEqual(
        expect.objectContaining({ text: "bold", classes: "ansi-bold" }),
      );
    });

    it("parses dim", () => {
      const result = parseAnsi("\x1b[2mdim\x1b[0m");
      expect(result).toContainEqual(
        expect.objectContaining({ text: "dim", classes: "ansi-dim" }),
      );
    });

    it("parses italic", () => {
      const result = parseAnsi("\x1b[3mitalic\x1b[0m");
      expect(result).toContainEqual(
        expect.objectContaining({ text: "italic", classes: "ansi-italic" }),
      );
    });

    it("parses underline", () => {
      const result = parseAnsi("\x1b[4munderline\x1b[0m");
      expect(result).toContainEqual(
        expect.objectContaining({
          text: "underline",
          classes: "ansi-underline",
        }),
      );
    });

    it("parses strikethrough", () => {
      const result = parseAnsi("\x1b[9mstrike\x1b[0m");
      expect(result).toContainEqual(
        expect.objectContaining({
          text: "strike",
          classes: "ansi-strikethrough",
        }),
      );
    });
  });

  it("resets styles mid-string", () => {
    const result = parseAnsi("\x1b[31mred\x1b[0m plain");
    const redSegment = result.find((s) => s.text === "red");
    const plainSegment = result.find((s) => s.text === " plain");
    expect(redSegment).toBeDefined();
    expect(redSegment!.classes).toBe("ansi-fg-red");
    expect(plainSegment).toBeDefined();
    expect(plainSegment!.classes).toBe("");
  });

  it("returns single segment with empty classes for plain text", () => {
    const result = parseAnsi("just plain text");
    expect(result).toEqual([{ text: "just plain text", classes: "" }]);
  });

  it("returns empty array for empty string", () => {
    const result = parseAnsi("");
    expect(result).toEqual([]);
  });

  it("strips malformed escape sequences from output text", () => {
    const result = parseAnsi("\x1b[31mhello\x1b[0m");
    for (const segment of result) {
      expect(segment.text).not.toMatch(/\x1b/);
    }
  });

  it("handles multiple simultaneous decorations", () => {
    const result = parseAnsi("\x1b[1;3;4mstacked\x1b[0m");
    const segment = result.find((s) => s.text === "stacked");
    expect(segment).toBeDefined();
    expect(segment!.classes).toContain("ansi-bold");
    expect(segment!.classes).toContain("ansi-italic");
    expect(segment!.classes).toContain("ansi-underline");
  });

  it("combines foreground and background colors", () => {
    const result = parseAnsi("\x1b[31;42mcombined\x1b[0m");
    const segment = result.find((s) => s.text === "combined");
    expect(segment).toBeDefined();
    expect(segment!.classes).toContain("ansi-fg-red");
    expect(segment!.classes).toContain("ansi-bg-green");
  });

  it("strips raw escape chars even with unknown sequences", () => {
    const result = parseAnsi("\x1b[999mweird\x1b[0m");
    for (const segment of result) {
      expect(segment.text).not.toMatch(/\x1b/);
    }
  });
});
