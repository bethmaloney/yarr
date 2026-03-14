import { describe, it, expect } from "vitest";
import {
  formatTokenCount,
  contextBarColor,
  sessionContextColor,
  contextTokensColor,
} from "./context-bar";

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
  it("returns success token for 0%", () => {
    expect(contextBarColor(0)).toBe("var(--success)");
  });

  it("returns success token for 49%", () => {
    expect(contextBarColor(49)).toBe("var(--success)");
  });

  it("returns warning token for 50%", () => {
    expect(contextBarColor(50)).toBe("var(--warning)");
  });

  it("returns warning token for 79%", () => {
    expect(contextBarColor(79)).toBe("var(--warning)");
  });

  it("returns destructive token for 80%", () => {
    expect(contextBarColor(80)).toBe("var(--destructive)");
  });

  it("returns destructive token for 100%", () => {
    expect(contextBarColor(100)).toBe("var(--destructive)");
  });
});

describe("sessionContextColor", () => {
  it("returns success token for 0%", () => {
    expect(sessionContextColor(0)).toBe("var(--success)");
  });

  it("returns success token for 59%", () => {
    expect(sessionContextColor(59)).toBe("var(--success)");
  });

  it("returns warning token for 60%", () => {
    expect(sessionContextColor(60)).toBe("var(--warning)");
  });

  it("returns warning token for 85%", () => {
    expect(sessionContextColor(85)).toBe("var(--warning)");
  });

  it("returns destructive token for 86%", () => {
    expect(sessionContextColor(86)).toBe("var(--destructive)");
  });

  it("returns destructive token for 100%", () => {
    expect(sessionContextColor(100)).toBe("var(--destructive)");
  });
});

describe("contextTokensColor", () => {
  it("returns green for 0 tokens", () => {
    expect(contextTokensColor(0)).toBe("#34d399");
  });

  it("returns green for 79,999 tokens", () => {
    expect(contextTokensColor(79_999)).toBe("#34d399");
  });

  it("returns yellow for 80,000 tokens", () => {
    expect(contextTokensColor(80_000)).toBe("#fbbf24");
  });

  it("returns yellow for 140,000 tokens", () => {
    expect(contextTokensColor(140_000)).toBe("#fbbf24");
  });

  it("returns red for 140,001 tokens", () => {
    expect(contextTokensColor(140_001)).toBe("#f87171");
  });

  it("returns red for 200,000 tokens", () => {
    expect(contextTokensColor(200_000)).toBe("#f87171");
  });
});
