import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  pool: db
}));

import { getAtlasEntityKnowledgeBundle, getChemicalKnowledgeBundle } from "../src/db/repositories.js";
import {
  chemicalIdentityTerms,
  entityBelongsToChemical,
  resolveChemicalByName,
  resolveEntityChemical,
} from "../src/lib/chemical-identity.js";

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function entityRow(input: {
  id: string;
  name: string;
  type?: string;
  description?: string | null;
  sourceName?: string;
  eventCount?: number;
}) {
  return {
    id: input.id,
    source_id: "00000000-0000-4000-8000-000000000010",
    type: input.type ?? "产品",
    name: input.name,
    normalized_name: input.name.toLowerCase(),
    description: input.description ?? null,
    source_name: input.sourceName ?? "库A",
    event_count: input.eventCount ?? 1
  };
}

function eventRow(input: { id: string; title: string; rank?: number }) {
  return {
    id: input.id,
    source_id: "00000000-0000-4000-8000-000000000010",
    document_id: "00000000-0000-4000-8000-000000000020",
    chunk_id: null,
    title: input.title,
    summary: input.title,
    content: input.title,
    category: "生产工艺",
    rank: input.rank ?? 1,
    document_id_for_detail: "00000000-0000-4000-8000-000000000020",
    document_title: "doc",
    document_source_name: "库A",
    document_source_type: null,
    document_source_date: null,
    document_source_author: null,
    document_source_url: null,
    document_status: "ready",
    document_parse_status: "ready",
    document_metadata: {},
    document_created_at: new Date().toISOString(),
    document_updated_at: new Date().toISOString(),
    document_archived_at: null
  };
}

describe("getChemicalKnowledgeBundle identity chain", () => {
  beforeEach(() => {
    db.query.mockReset();
  });

  it("uses an atlas anchor to aggregate material roles without collecting same-name industry events", async () => {
    const feedstock = entityRow({ id: "feedstock", name: "某牌号原料", type: "原料" });
    const product = entityRow({ id: "product", name: "某牌号原料", type: "产品" });
    const sector = entityRow({ id: "sector", name: "某牌号原料", type: "终端行业" });
    db.query.mockResolvedValueOnce({ rows: [feedstock, product, sector] })
      .mockResolvedValueOnce({ rows: [feedstock, product] })
      .mockResolvedValueOnce({ rows: [eventRow({ id: "material-event", title: "原料供应" })] });

    const bundle = await getAtlasEntityKnowledgeBundle({ entityId: feedstock.id, tenantId: "default" });
    expect(bundle.entities.map((entity) => entity.id).sort()).toEqual([feedstock.id, product.id].sort());
    expect(db.query.mock.calls[0][1]).toEqual([feedstock.id, "default"]);
    const anchorSql = normalizeSql(String(db.query.mock.calls[0][0]));
    expect(anchorSql).toContain("ent.source_id = anchor.source_id");
    expect(anchorSql).toContain("e.deleted_at is null");
    expect(db.query.mock.calls[1][1][0]).toEqual([feedstock.id, product.id]);
  });

  it("combines natural gas material roles and excludes same-name sector records", async () => {
    const energy = entityRow({ id: "gas-energy", name: "天然气", type: "能源" });
    const feedstock = entityRow({ id: "gas-feedstock", name: "Natural Gas", type: "原料气" });
    const industry = entityRow({ id: "gas-industry", name: "天然气", type: "终端行业" });
    const materialEvent = eventRow({ id: "material-event", title: "天然气原料供应" });
    const industryEvent = eventRow({ id: "industry-event", title: "行业分类" });
    db.query
      .mockResolvedValueOnce({ rows: [energy, feedstock, industry] })
      .mockResolvedValueOnce({ rows: [energy, feedstock, industry] })
      .mockResolvedValueOnce({ rows: [materialEvent, industryEvent] })
      .mockResolvedValueOnce({ rows: [energy, feedstock] })
      .mockResolvedValueOnce({ rows: [materialEvent] });

    const bundle = await getChemicalKnowledgeBundle({ terms: ["天然气"], projectId: "project", tenantId: "default" });
    expect(bundle.entities.map((entity) => entity.id).sort()).toEqual([energy.id, feedstock.id].sort());
    expect(bundle.events.map((event) => event.id)).toEqual([materialEvent.id]);
    expect([...db.query.mock.calls[3][1][0]].sort()).toEqual([energy.id, feedstock.id].sort());
    expect(resolveEntityChemical({ name: "天然气", type: "应用领域" })).toBeUndefined();
    expect(entityBelongsToChemical({ name: "甲烷", type: "原料" }, resolveChemicalByName("天然气")!)).toBe(false);
  });

  it("filters candidates with entityBelongsToChemical and reloads events for confirmed ids only", async () => {
    const caustic = resolveChemicalByName("氢氧化钠");
    expect(caustic).toBeTruthy();

    const confirmedId = "00000000-0000-4000-8000-000000000101";
    const aliasId = "00000000-0000-4000-8000-000000000102";
    const plantId = "00000000-0000-4000-8000-000000000103";
    const sharedEventId = "00000000-0000-4000-8000-000000000201";
    const plantOnlyEventId = "00000000-0000-4000-8000-000000000202";

    db.query
      // candidate id page
      .mockResolvedValueOnce({
        rows: [{ id: confirmedId }, { id: aliasId }, { id: plantId }]
      })
      // candidate entities
      .mockResolvedValueOnce({
        rows: [
          entityRow({ id: confirmedId, name: "氢氧化钠", eventCount: 5 }),
          entityRow({ id: aliasId, name: "烧碱", eventCount: 3 }),
          entityRow({
            id: plantId,
            name: "烧碱装置",
            description: "生产氢氧化钠 / CAS 1310-73-2 的电解装置",
            eventCount: 9
          })
        ]
      })
      // candidate events (includes plant-only event that must be dropped)
      .mockResolvedValueOnce({
        rows: [
          eventRow({ id: sharedEventId, title: "液碱供应" }),
          eventRow({ id: plantOnlyEventId, title: "装置检修" })
        ]
      })
      // confirmed entities reload
      .mockResolvedValueOnce({
        rows: [
          entityRow({ id: confirmedId, name: "氢氧化钠", eventCount: 5 }),
          entityRow({ id: aliasId, name: "烧碱", eventCount: 3 })
        ]
      })
      // confirmed events reload
      .mockResolvedValueOnce({
        rows: [eventRow({ id: sharedEventId, title: "液碱供应" })]
      });

    const bundle = await getChemicalKnowledgeBundle({
      terms: chemicalIdentityTerms(caustic!),
      cas: caustic!.cas,
      chemicalName: caustic!.name,
      tenantId: "default"
    });

    expect(bundle.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(["氢氧化钠", "烧碱"]),
    );
    expect(bundle.entities).toHaveLength(2);
    expect(bundle.entities.some((entity) => entity.name === "烧碱装置")).toBe(false);
    expect(bundle.events.map((event) => event.id)).toEqual([sharedEventId]);
    expect(bundle.entities.find((entity) => entity.id === confirmedId)?.eventCount).toBe(5);

    const candidateSql = normalizeSql(String(db.query.mock.calls[0][0]));
    expect(candidateSql).toContain("ent.normalized_name = any");
    expect(candidateSql).not.toContain("description");
    expect(candidateSql).toContain("archived_at is null");
    expect(candidateSql).toContain("e.deleted_at is null");

    // Second entity/event load uses only confirmed ids.
    const reloadEntityIds = db.query.mock.calls[3][1][0] as string[];
    expect(reloadEntityIds.sort()).toEqual([aliasId, confirmedId].sort());
  });

  it("does not treat description mentions or broad 盐 labels as 氯化钠", async () => {
    const nacl = resolveChemicalByName("氯化钠");
    expect(nacl).toBeTruthy();
    expect(entityBelongsToChemical({ name: "盐" }, nacl!)).toBe(false);
    expect(
      entityBelongsToChemical(
        { name: "工业盐", description: "原料盐 CAS 7647-14-5" },
        nacl!,
      ),
    ).toBe(false);
    expect(
      entityBelongsToChemical(
        {
          name: "氯碱装置",
          description: "电解氯化钠水溶液生产烧碱",
        },
        nacl!,
      ),
    ).toBe(false);
    expect(entityBelongsToChemical({ name: "氯化钠" }, nacl!)).toBe(true);
    expect(resolveEntityChemical({ name: "原料盐", description: "CAS 7647-14-5" })).toBeUndefined();

    const saltId = "00000000-0000-4000-8000-000000000301";
    const naclId = "00000000-0000-4000-8000-000000000302";

    db.query
      .mockResolvedValueOnce({ rows: [{ id: saltId }, { id: naclId }] })
      .mockResolvedValueOnce({
        rows: [
          entityRow({
            id: saltId,
            name: "盐",
            description: "广义盐类，含氯化钠原料路线说明",
          }),
          entityRow({ id: naclId, name: "氯化钠" })
        ]
      })
      .mockResolvedValueOnce({
        rows: [
          eventRow({ id: "00000000-0000-4000-8000-000000000401", title: "盐类综述" }),
          eventRow({ id: "00000000-0000-4000-8000-000000000402", title: "氯化钠精制" })
        ]
      })
      .mockResolvedValueOnce({
        rows: [entityRow({ id: naclId, name: "氯化钠", eventCount: 2 })]
      })
      .mockResolvedValueOnce({
        rows: [
          eventRow({ id: "00000000-0000-4000-8000-000000000402", title: "氯化钠精制" })
        ]
      });

    const bundle = await getChemicalKnowledgeBundle({
      terms: ["盐", "氯化钠", "Sodium chloride"],
      cas: "7647-14-5",
      chemicalName: "氯化钠",
      tenantId: "default"
    });

    expect(bundle.entities.map((entity) => entity.name)).toEqual(["氯化钠"]);
    expect(bundle.events).toHaveLength(1);
    expect(bundle.events[0]?.title).toBe("氯化钠精制");
  });

  it("returns empty when chemical identity cannot be resolved", async () => {
    const bundle = await getChemicalKnowledgeBundle({
      terms: ["盐"],
      tenantId: "default"
    });
    expect(bundle).toEqual({ entities: [], events: [] });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("respects project scope in candidate recall", async () => {
    const hydrogen = resolveChemicalByName("氢气");
    expect(hydrogen).toBeTruthy();
    const projectId = "00000000-0000-4000-8000-000000000501";

    db.query.mockResolvedValueOnce({ rows: [] });

    await getChemicalKnowledgeBundle({
      terms: chemicalIdentityTerms(hydrogen!),
      chemicalName: hydrogen!.name,
      tenantId: "default",
      projectId
    });

    expect(db.query.mock.calls[0][1][1]).toBe(projectId);
    const sql = normalizeSql(String(db.query.mock.calls[0][0]));
    expect(sql).toContain("($2::uuid is null or s.id = $2)");
  });
});
