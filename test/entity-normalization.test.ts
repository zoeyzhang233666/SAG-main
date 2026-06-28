import { describe, expect, it } from "vitest";
import { normalizeEntityName } from "../src/db/repositories.js";

describe("entity name normalization", () => {
  it("deduplicates width, whitespace and dash variants without removing chemical punctuation", () => {
    expect(normalizeEntityName(" １，４－丁二醇 ")).toBe("1,4-丁二醇");
    expect(normalizeEntityName("1, 4 - 丁二醇")).toBe("1,4-丁二醇");
  });

  it("normalizes latin case and invisible spaces", () => {
    expect(normalizeEntityName("B\u200BASF")).toBe("basf");
    expect(normalizeEntityName(" basf ")).toBe("basf");
  });
});
