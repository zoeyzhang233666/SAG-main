import { describe, expect, it } from "vitest";
import {
  matchBelongsToChemical,
  resolveChemicalByName,
} from "../web/src/lib/chain-atlas.js";

describe("chain atlas chemical knowledge matching", () => {
  it("resolves known chemicals by Chinese name", () => {
    const hydrogen = resolveChemicalByName("氢气");
    expect(hydrogen?.name).toBeTruthy();
    expect(matchBelongsToChemical("氢气", hydrogen!)).toBe(true);
  });

  it("does not merge unrelated entity names into a chemical", () => {
    const caustic = resolveChemicalByName("烧碱");
    expect(caustic).toBeTruthy();
    expect(matchBelongsToChemical("烧碱", caustic!)).toBe(true);
    expect(matchBelongsToChemical("氢氧化钠装置", caustic!)).toBe(false);
    expect(matchBelongsToChemical("盐化工园区", caustic!)).toBe(false);
  });

  it("accepts chemical aliases when present", () => {
    const caustic = resolveChemicalByName("烧碱");
    expect(caustic).toBeTruthy();
    for (const alias of caustic!.aliases ?? []) {
      expect(matchBelongsToChemical(alias, caustic!)).toBe(true);
    }
  });
});
