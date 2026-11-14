import { describe, expect, it } from "vitest";
import { findTextMatchOffsets, stepSearchMatchIndex } from "./window-search-match";

describe("findTextMatchOffsets", () => {
  it("returns empty array for empty or whitespace-only queries", () => {
    expect(findTextMatchOffsets("Hello world", "")).toEqual([]);
    expect(findTextMatchOffsets("Hello world", "   ")).toEqual([]);
  });

  it("matches case-insensitively and returns all non-overlapping offsets", () => {
    expect(findTextMatchOffsets("Paseo workspace paseo PASEO", "paseo")).toEqual([
      { start: 0, end: 5 },
      { start: 16, end: 21 },
      { start: 22, end: 27 },
    ]);
  });

  it("handles overlapping pattern candidates non-overlappingly", () => {
    expect(findTextMatchOffsets("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("respects the match limit", () => {
    expect(findTextMatchOffsets("a b a b a", "a", 2)).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ]);
  });
});

describe("stepSearchMatchIndex", () => {
  it("wraps forward and backward around totalMatches", () => {
    expect(stepSearchMatchIndex(0, 1, 3)).toBe(1);
    expect(stepSearchMatchIndex(2, 1, 3)).toBe(0);
    expect(stepSearchMatchIndex(0, -1, 3)).toBe(2);
    expect(stepSearchMatchIndex(1, -1, 3)).toBe(0);
  });

  it("returns 0 when totalMatches is 0", () => {
    expect(stepSearchMatchIndex(2, 1, 0)).toBe(0);
    expect(stepSearchMatchIndex(0, -1, 0)).toBe(0);
  });
});
