import { describe, expect, it } from "vitest";
import { chainAtlas, type ChainNode, type ChainTrack } from "../web/src/lib/chain-atlas.js";

function branch(track: ChainTrack, ...path: string[]): ChainNode {
  let nodes = chainAtlas[track].roots;
  let selected: ChainNode | undefined;
  for (const segment of path) {
    selected = nodes.find(node => node.label === segment || node.code === segment);
    if (!selected) throw new Error(`Atlas branch is missing: ${path.join(" / ")}`);
    nodes = selected.children;
  }
  return selected!;
}

function children(node: ChainNode) {
  return node.children.map(child => child.label);
}

describe("reviewed atlas routes", () => {
  it("routes atmospheric residue to vacuum distillation and labels FCC and coking outputs separately", () => {
    const vacuum = branch("source", "S-01", "S-01-01", "原油", "常压蒸馏", "常压渣油", "减压蒸馏");
    expect(children(vacuum)).toEqual(["减压瓦斯油", "减压渣油"]);
    expect(vacuum.children[0].children.find(node => node.label === "催化裂化")?.children)
      .toContainEqual(expect.objectContaining({ label: "催化油浆", relation: "byproduct" }));
    expect(vacuum.children[1].children.find(node => node.label === "延迟焦化")?.children)
      .toContainEqual(expect.objectContaining({ label: "石油焦", relation: "product" }));
  });

  it("preserves the original polystyrene grades beneath the corrected ethylbenzene route", () => {
    const polystyrene = branch("source", "S-01", "S-01-02", "裂解原料", "乙烯", "乙苯", "苯乙烯", "聚苯乙烯");
    expect(children(polystyrene)).toEqual(expect.arrayContaining(["GPPS", "HIPS", "可发性聚苯乙烯"]));
  });

  it("places EPDM and acrylamide under their respective upstream routes", () => {
    const cracking = ["S-01", "S-01-02", "裂解原料"];
    expect(children(branch("source", ...cracking, "1,3-丁二烯"))).not.toContain("三元乙丙橡胶");
    expect(children(branch("source", ...cracking, "丙烯", "乙丙橡胶"))).toContain("三元乙丙橡胶");
    expect(children(branch("source", ...cracking, "丙烯", "丙烯腈", "丙烯酰胺"))).toContain("聚丙烯酰胺");
  });

  it("keeps dissimilar processes and their materials in separate PET branches", () => {
    const polyester = branch("applications", "C", "C-26", "A-26-2651-07");
    const [exchange, direct] = polyester.children;
    expect(children(exchange)).toEqual(["对苯二甲酸二甲酯", "乙二醇"]);
    expect(children(direct)).toEqual(["对苯二甲酸", "乙二醇"]);
  });

  it("does not classify mineral silica as carbon black or recovered carbon dioxide as a nitrogen derivative", () => {
    const mineral = branch("source", "S-04", "S-04-02");
    expect(children(mineral)).not.toContain("炭黑");
    const carbonBlack = branch("source", "S-01", "芳香烃油与炭黑", "炭黑");
    expect(children(carbonBlack)).toContain("导电炭黑");
    expect(children(carbonBlack).some(name => name.includes("白炭黑"))).toBe(false);
    const nitrogen = branch("source", "S-05", "S-05-02", "氮气");
    expect(children(nitrogen)).not.toContain("二氧化碳");
    const recovery = branch("source", "S-02", "S-02-01", "天然气（CH₄）", "工艺气回收二氧化碳", "二氧化碳");
    expect(children(recovery)).toContain("干冰");
  });

  it("indexes verified synonyms without equating refrigerant blends, isomers or ambiguous abbreviations", () => {
    const find = (name: string) => chainAtlas.source.entries.find(node => node.label === name)?.terms ?? [];
    expect(find("2-丁酮")).toEqual(expect.arrayContaining(["丁酮", "78-93-3"]));
    expect(find("2-丁酮")).not.toContain("4-甲基-2-戊酮");
    expect(find("丙烯酸乙酯")).not.toContain("EA");
    expect(find("R-410A 混合制冷剂")).not.toContain("75-10-5");
    expect(find("二氟甲烷")).toContain("R-32");
  });
  it("fills application branches with named materials and omits generic placeholders", () => {
    const manufacturing = ["C", "C-28"];
    expect(children(branch("applications", ...manufacturing, "A-28-2821-01", "熔体纺丝"))).toContain("聚酰胺6");
    const water = ["D", "D-46", "A-46-4620"];
    expect(children(branch("applications", ...water, "除磷药剂"))).toEqual(
      expect.arrayContaining(["三氯化铁", "硫酸铝", "氢氧化钙"])
    );
    const biogas = branch("applications", "D", "D-45", "A-45-4520", "沼气脱硫");
    expect(children(biogas)).toEqual(["氧化铁脱硫介质", "活性炭"]);
    expect(chainAtlas.applications.entries.some(node => /不涉及化学品|^消耗少$/.test(node.label))).toBe(false);
  });

});
