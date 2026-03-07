import { describe, it, expect } from "vitest";
import { formatTokenCount, contextBarColor } from "./context-bar";

describe("formatTokenCount", () => {
  it('formats 0 as "0"', () => {
    expect(formatTokenCount(0)).toBe("0");
  });

  it("formats small numbers below 1000 as plain integers", () => {
    expect(formatTokenCount(500)).toBe("500");
  });

  it('formats exactly 1000 as "1k"', () => {
    expect(formatTokenCount(1000)).toBe("1k");
  });

  it('formats 1500 with one decimal place as "1.5k"', () => {
    expect(formatTokenCount(1500)).toBe("1.5k");
  });

  it('formats 62000 as "62k"', () => {
    expect(formatTokenCount(62000)).toBe("62k");
  });

  it('formats 200000 as "200k"', () => {
    expect(formatTokenCount(200000)).toBe("200k");
  });

  it('formats 1500000 as "1.5M"', () => {
    expect(formatTokenCount(1500000)).toBe("1.5M");
  });

  it('formats 1000000 as "1M"', () => {
    expect(formatTokenCount(1000000)).toBe("1M");
  });

  it("rounds non-round numbers to 1 decimal place", () => {
    expect(formatTokenCount(62345)).toBe("62.3k");
    expect(formatTokenCount(1234567)).toBe("1.2M");
  });
});

describe("contextBarColor", () => {
  it("returns green for 0%", () => {
    expect(contextBarColor(0)).toBe("#34d399");
  });

  it("returns green for 49%", () => {
    expect(contextBarColor(49)).toBe("#34d399");
  });

  it("returns yellow for 50%", () => {
    expect(contextBarColor(50)).toBe("#fbbf24");
  });

  it("returns yellow for 79%", () => {
    expect(contextBarColor(79)).toBe("#fbbf24");
  });

  it("returns red for 80%", () => {
    expect(contextBarColor(80)).toBe("#f87171");
  });

  it("returns red for 100%", () => {
    expect(contextBarColor(100)).toBe("#f87171");
  });
});
