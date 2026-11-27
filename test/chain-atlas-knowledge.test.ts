import { describe, expect, it } from "vitest";
import {
  chainAtlas,
  entityBelongsToChemical,
  isAmbiguousChemicalTerm,
  matchBelongsToChemical,
  resolveChemicalByName,
  resolveEntityChemical,
  type Chemical,
} from "../web/src/lib/chain-atlas.js";
import {
  ATLAS_TREE_MATCH_LIMIT,
  KNOWLEDGE_BUNDLE_ENTITY_BATCH,
  chunkIds,
  mergeKnowledgeBundles,
  pickPrimaryKnowledgeEntity,
  type KnowledgeEntityRecord,
} from "../web/src/lib/chemical-knowledge.js";

function chemical(name: string): Chemical {
  const hit = resolveChemicalByName(name);
  if (!hit) throw new Error(`Missing chemical ${name}`);
  return hit;
}

describe("chain atlas chemical knowledge matching", () => {
  it("resolves known chemicals by Chinese name and aliases", () => {
    const hydrogen = chemical("氢气");
    expect(matchBelongsToChemical("氢气", hydrogen)).toBe(true);
    const caustic = chemical("烧碱");
    expect(caustic.name).toBe("氢氧化钠");
    expect(matchBelongsToChemical("烧碱", caustic)).toBe(true);
    expect(matchBelongsToChemical("氢氧化钠装置", caustic)).toBe(false);
  });

  it("does not confirm identity from description mentions of a chemical or CAS", () => {
    const nacl = chemical("氯化钠");
    expect(resolveChemicalByName("盐")).toBeUndefined();
    expect(matchBelongsToChemical("盐", nacl)).toBe(false);
    expect(matchBelongsToChemical("盐类化合物", nacl)).toBe(false);
    expect(matchBelongsToChemical("工业盐", nacl)).toBe(false);
    expect(matchBelongsToChemical("氯化钠", nacl)).toBe(true);
    expect(
      entityBelongsToChemical(
        { name: "工业盐", description: "原料盐 CAS 7647-14-5" },
        nacl,
      ),
    ).toBe(false);
    expect(
      entityBelongsToChemical(
        {
          name: "氯碱装置",
          description: "电解氯化钠水溶液，CAS 7647-14-5",
        },
        nacl,
      ),
    ).toBe(false);
    expect(resolveEntityChemical({ name: "盐", description: "CAS 7647-14-5" })).toBeUndefined();
  });

  it("attaches the 氯化钠 chemical node used by the chlor-alkali feedstock branch", () => {
    const node = chainAtlas.source.entries.find((item) => item.label === "氯化钠");
    expect(node?.chemical?.name).toBe("氯化钠");
    expect(node?.chemical?.cas).toBe("7647-14-5");
    expect(node?.terms).toEqual(
      expect.arrayContaining(["氯化钠", "7647-14-5"]),
    );
  });

  it("never falls back to unconfirmed matches in knowledge filtering", () => {
    const nacl = chemical("氯化钠");
    const matches = [
      { name: "盐", description: null },
      { name: "盐湖卤水", description: null },
      { name: "氯化钠", description: null },
    ];
    const confirmed = matches.filter((match) =>
      matchBelongsToChemical(match.name, nacl, match.description),
    );
    expect(confirmed.map((item) => item.name)).toEqual(["氯化钠"]);
  });
});

describe("knowledge bundle batching helpers", () => {
  it("chunks more than 500 entity ids into page-sized batches", () => {
    expect(ATLAS_TREE_MATCH_LIMIT).toBe(12);
    const ids = Array.from({ length: 650 }, (_, index) => `id-${index}`);
    const batches = chunkIds(ids, KNOWLEDGE_BUNDLE_ENTITY_BATCH);
    expect(batches).toHaveLength(4);
    expect(batches[0]).toHaveLength(200);
    expect(batches[3]).toHaveLength(50);
    expect(batches.flat()).toHaveLength(650);
  });

  it("dedupes events shared by multiple entities and keeps each eventCount", () => {
    const sharedEvent = {
      id: "event-shared",
      sourceId: "source",
      title: "shared",
      summary: "",
      content: "",
      rank: 1,
    };
    const left: KnowledgeEntityRecord = {
      id: "e1",
      sourceId: "s1",
      type: "产品",
      name: "氢氧化钠",
      normalizedName: "氢氧化钠",
      description: "液碱",
      sourceName: "库A",
      eventCount: 42,
    };
    const right: KnowledgeEntityRecord = {
      id: "e2",
      sourceId: "s2",
      type: "化学品",
      name: "烧碱",
      normalizedName: "烧碱",
      description: "片碱",
      sourceName: "库B",
      eventCount: 27,
    };
    const merged = mergeKnowledgeBundles([
      { entities: [left], events: [sharedEvent, { ...sharedEvent, id: "event-a" }] },
      { entities: [right, left], events: [sharedEvent, { ...sharedEvent, id: "event-b" }] },
    ]);
    expect(merged.events.map((event) => event.id).sort()).toEqual([
      "event-a",
      "event-b",
      "event-shared",
    ]);
    expect(merged.entities.find((entity) => entity.id === "e1")?.eventCount).toBe(42);
    expect(merged.entities.find((entity) => entity.id === "e2")?.eventCount).toBe(27);
    expect(pickPrimaryKnowledgeEntity(merged.entities, "e2")?.id).toBe("e2");
    expect(pickPrimaryKnowledgeEntity(merged.entities)?.eventCount).toBe(42);
  });

  it("resolves entity chemical only from the entity name", () => {
    expect(resolveEntityChemical({ name: "烧碱" })?.name).toBe("氢氧化钠");
    expect(
      resolveEntityChemical({
        name: "原料盐",
        description: "氯化钠原料，CAS 7647-14-5",
      }),
    ).toBeUndefined();
    expect(isAmbiguousChemicalTerm("AA")).toBe(false);
  });
});
