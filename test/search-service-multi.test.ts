import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingClient } from "../src/ai/embedding-client.js";
import type { LlmClient } from "../src/ai/llm-client.js";
import type { RerankClient } from "../src/ai/rerank-client.js";

const repositories = vi.hoisted(() => ({
  assertSourcesAccessible: vi.fn(),
  coarseRankEventsByContent: vi.fn(),
  getEventIdsByEntityIds: vi.fn(),
  getEventsWithEntityIds: vi.fn(),
  getSectionsForEvents: vi.fn(),
  searchChunksByVector: vi.fn(),
  searchEntitiesByName: vi.fn(),
  searchEntitiesByText: vi.fn(),
  searchEntitiesByVector: vi.fn(),
  searchEventsByText: vi.fn(),
  searchEventsByTitleVector: vi.fn()
}));

vi.mock("../src/db/repositories.js", () => repositories);

import { SearchService } from "../src/services/search-service.js";

describe("SearchService multi search", () => {
  beforeEach(() => {
    for (const mock of Object.values(repositories)) {
      mock.mockReset();
    }
    repositories.assertSourcesAccessible.mockResolvedValue(undefined);
    repositories.searchEntitiesByName.mockResolvedValue([]);
    repositories.searchEntitiesByText.mockResolvedValue([]);
    repositories.searchEntitiesByVector.mockResolvedValue([]);
    repositories.getEventIdsByEntityIds.mockResolvedValue([]);
    repositories.searchEventsByText.mockResolvedValue([]);
    repositories.searchEventsByTitleVector.mockResolvedValue([]);
    repositories.searchChunksByVector.mockResolvedValue([]);
  });

  it("uses SAG2 multi defaults for thresholds and query-event oversampling", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]))
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["SAG"]),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn()
    };
    const service = new SearchService(embeddings, llm);

    await service.search({
      query: "SAG 多跳检索",
      sourceIds: ["00000000-0000-0000-0000-000000000001"],
      strategy: "multi",
      searchMode: "standard"
    });

    expect(repositories.searchEntitiesByVector).toHaveBeenCalledWith(expect.objectContaining({
      topK: 20,
      threshold: 0.9
    }));
    expect(repositories.searchEventsByTitleVector).toHaveBeenCalledWith(expect.objectContaining({
      topK: 60,
      threshold: 0.4
    }));
  });

  it("batches standard entity embeddings and starts vector lookups in parallel", async () => {
    const firstLookup = deferred<Array<ReturnType<typeof entity>>>();
    const secondLookup = deferred<Array<ReturnType<typeof entity>>>();
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [9, 0, 0]),
      batchGenerate: vi.fn(async () => [[1, 0, 0], [2, 0, 0]])
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["Alpha", " alpha ", "Beta"]),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => [])
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";

    repositories.searchEntitiesByVector
      .mockImplementationOnce(() => firstLookup.promise)
      .mockImplementationOnce(() => secondLookup.promise);

    const searchPromise = service.search({
      query: "compare alpha and beta",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "standard"
    });

    await vi.waitFor(() => {
      expect(repositories.searchEntitiesByVector).toHaveBeenCalledTimes(2);
    });
    expect(embeddings.generate).toHaveBeenCalledTimes(1);
    expect(embeddings.batchGenerate).toHaveBeenCalledWith(["Alpha", "Beta"]);

    firstLookup.resolve([]);
    secondLookup.resolve([]);
    await searchPromise;
  });

  it("starts entity, title-vector, and text-event recall concurrently", async () => {
    const entityEvents = deferred<string[]>();
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => [])
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    repositories.getEventIdsByEntityIds.mockImplementationOnce(() => entityEvents.promise);

    const searchPromise = service.search({
      query: "parallel recall",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "fast"
    });

    await vi.waitFor(() => {
      expect(repositories.getEventIdsByEntityIds).toHaveBeenCalledTimes(1);
      expect(repositories.searchEventsByTitleVector).toHaveBeenCalledTimes(1);
      expect(repositories.searchEventsByText).toHaveBeenCalledTimes(1);
    });

    entityEvents.resolve([]);
    await searchPromise;
  });

  it("allows vector search up to the configured service maximum", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(async () => []),
      rerankEvents: vi.fn(async () => [])
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    repositories.searchChunksByVector.mockResolvedValue(Array.from({ length: 60 }, (_, index) => ({
      chunkId: `chunk-${index + 1}`,
      sourceId,
      documentId: "00000000-0000-0000-0000-000000000002",
      heading: `切片 ${index + 1}`,
      content: `内容 ${index + 1}`,
      rank: index,
      score: 1
    })));

    const result = await service.search({
      query: "SAG topK",
      sourceIds: [sourceId],
      strategy: "vector",
      topK: 50
    });

    expect(repositories.searchChunksByVector).toHaveBeenCalledWith(expect.objectContaining({
      topK: 50
    }));
    expect(result.sections).toHaveLength(50);
  });

  it("expands only through new entities and ranks dual-phase candidates separately", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]))
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["初始实体"]),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => [])
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";

    repositories.searchEntitiesByVector.mockResolvedValue([entity("entity-query", sourceId, "初始实体")]);
    repositories.getEventIdsByEntityIds
      .mockResolvedValueOnce(["event-seed"])
      .mockResolvedValueOnce(["event-hop1"])
      .mockResolvedValueOnce(["event-hop2"]);
    repositories.getEventsWithEntityIds
      .mockResolvedValueOnce(new Map([
        ["event-seed", event("event-seed", sourceId, ["entity-query", "entity-new"])]
      ]))
      .mockResolvedValueOnce(new Map([
        ["event-hop1", event("event-hop1", sourceId, ["entity-new", "entity-hop2"])]
      ]));
    repositories.coarseRankEventsByContent.mockImplementation(async (input: { eventIds: string[] }) => (
      input.eventIds.map((id) => event(id, sourceId, []))
    ));
    repositories.getSectionsForEvents.mockResolvedValue([]);

    await service.search({
      query: "解释多跳检索",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "standard",
      subStrategy: "multi1",
      multi: {
        maxEventsB: 1
      }
    });

    expect(repositories.getEventIdsByEntityIds).toHaveBeenNthCalledWith(1, expect.objectContaining({
      entityIds: ["entity-query"]
    }));
    expect(repositories.getEventIdsByEntityIds).toHaveBeenNthCalledWith(2, expect.objectContaining({
      entityIds: ["entity-new"]
    }));
    expect(repositories.getEventIdsByEntityIds).toHaveBeenNthCalledWith(3, expect.objectContaining({
      entityIds: ["entity-hop2"]
    }));
    expect(repositories.coarseRankEventsByContent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      eventIds: ["event-seed", "event-hop1"],
      maxEvents: 100
    }));
    expect(repositories.coarseRankEventsByContent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      eventIds: ["event-hop2"],
      maxEvents: 1
    }));
  });

  it("uses requested topK for LLM rerank and final sections", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async (input: { candidates: Array<{ id: string }>; topK: number }) => (
        input.candidates.slice(0, input.topK).map((candidate) => candidate.id)
      ))
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    const events = Array.from({ length: 6 }, (_, index) => event(`event-${index + 1}`, sourceId, []));

    repositories.searchEventsByTitleVector.mockResolvedValue(events);
    repositories.getEventsWithEntityIds.mockResolvedValue(new Map(events.map((item) => [item.id, item])));
    repositories.coarseRankEventsByContent.mockResolvedValue(events);
    repositories.getSectionsForEvents.mockResolvedValue(events.map((item, index) => ({
      eventId: item.id,
      chunkId: `chunk-${index + 1}`,
      sourceId,
      documentId: item.documentId,
      heading: item.title,
      content: item.content,
      rank: index,
      score: 1
    })));

    const result = await service.search({
      query: "SAG topK",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "standard",
      topK: 50
    });

    expect(llm.rerankEvents).toHaveBeenCalledWith(expect.objectContaining({
      topK: 50
    }));
    expect(result.sections).toHaveLength(6);
  });

  it("uses fast mode without LLM entity extraction or LLM rerank", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["不应调用"]),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => ["不应调用"])
    };
    const reranker: RerankClient = {
      rerankEvents: vi.fn(async (input: { candidates: Array<{ id: string }>; topK: number }) => (
        input.candidates.slice(0, input.topK).map((candidate) => candidate.id)
      ))
    };
    const service = new SearchService(embeddings, llm, reranker);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    const matchedEntity = entity("entity-query", sourceId, "SAG");
    const events = Array.from({ length: 3 }, (_, index) => event(`event-${index + 1}`, sourceId, ["entity-query"]));

    repositories.searchEntitiesByText.mockResolvedValue([matchedEntity]);
    repositories.getEventIdsByEntityIds.mockResolvedValue(["event-1"]);
    repositories.searchEventsByTitleVector.mockResolvedValue(events);
    repositories.getEventsWithEntityIds.mockResolvedValue(new Map(events.map((item) => [item.id, item])));
    repositories.coarseRankEventsByContent.mockResolvedValue(events);
    repositories.getSectionsForEvents.mockResolvedValue(events.map((item, index) => ({
      eventId: item.id,
      chunkId: `chunk-${index + 1}`,
      sourceId,
      documentId: item.documentId,
      heading: item.title,
      content: item.content,
      rank: index,
      score: 1
    })));

    const result = await service.search({
      query: "SAG 为什么快",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "fast",
      returnTrace: true,
      topK: 5
    });

    expect(llm.extractNamedEntities).not.toHaveBeenCalled();
    expect(llm.rerankEvents).not.toHaveBeenCalled();
    expect(repositories.searchEntitiesByText).toHaveBeenCalledWith(expect.objectContaining({
      query: "SAG 为什么快",
      limit: 60
    }));
    expect(reranker.rerankEvents).toHaveBeenCalledWith(expect.objectContaining({
      topK: 5
    }));
    expect(result.trace?.searchMode).toBe("fast");
    expect(result.trace?.recalledEntities).toHaveLength(1);
    expect(result.sections).toHaveLength(3);
  });

  it("diversifies fast entity matches by normalized name and evidence score", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => [])
    };
    const reranker: RerankClient = {
      rerankEvents: vi.fn(async () => [])
    };
    const service = new SearchService(embeddings, llm, reranker);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    repositories.searchEntitiesByText.mockResolvedValue([
      { ...entity("company-best", sourceId, "企业"), type: "company", score: 1.2 },
      { ...entity("downstream-best", sourceId, "下游"), type: "category", score: 1.15 },
      { ...entity("polyester-best", sourceId, "聚酯"), type: "product", score: 1.1 },
      { ...entity("company-alternative", sourceId, "企业"), type: "organization", score: 1.05 },
      { ...entity("company-third", sourceId, "企业"), type: "subject", score: 1.0 },
      { ...entity("company-duplicate", sourceId, "企业"), type: "company", score: 0.8 }
    ]);

    const result = await service.search({
      query: "企业 下游 聚酯",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "fast",
      returnTrace: true
    });

    expect(repositories.getEventIdsByEntityIds).toHaveBeenNthCalledWith(1, expect.objectContaining({
      entityIds: ["company-best", "downstream-best", "polyester-best", "company-alternative"]
    }));
    expect(result.trace?.queryEntities).toEqual(["企业", "下游", "聚酯"]);
    expect(result.trace?.recalledEntities?.map((item) => item.id)).not.toContain("company-third");
    expect(result.trace?.recalledEntities?.map((item) => item.id)).not.toContain("company-duplicate");
  });

  it("marks standard entity-vector degradation as failed while preserving exact recall", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn(async () => {
        throw new Error("entity embedding unavailable");
      })
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => ["SAG"]),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => ["event-1"])
    };
    const service = new SearchService(embeddings, llm);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    const matchedEntity = entity("entity-query", sourceId, "SAG");
    const matchedEvent = event("event-1", sourceId, [matchedEntity.id]);
    const progress: Array<{ key: string; status: string; detail: string }> = [];
    repositories.searchEntitiesByName.mockResolvedValue([matchedEntity]);
    repositories.getEventIdsByEntityIds.mockResolvedValue([matchedEvent.id]);
    repositories.getEventsWithEntityIds.mockResolvedValue(new Map([[matchedEvent.id, matchedEvent]]));
    repositories.coarseRankEventsByContent.mockResolvedValue([matchedEvent]);
    repositories.getSectionsForEvents.mockResolvedValue([{
      eventId: matchedEvent.id,
      chunkId: "chunk-1",
      sourceId,
      documentId: matchedEvent.documentId,
      heading: matchedEvent.title,
      content: matchedEvent.content,
      rank: 0
    }]);

    const result = await service.search({
      query: "SAG",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "standard",
      returnTrace: true
    }, undefined, (item) => progress.push({
      key: item.key,
      status: item.status,
      detail: item.detail
    }));

    expect(result.sections).toHaveLength(1);
    expect(result.trace?.fallbackReason).toContain("实体向量召回不可用");
    expect(progress.filter((item) => item.key === "step2EntityVectors").at(-1)).toEqual(expect.objectContaining({
      status: "failed",
      detail: expect.stringContaining("保留名称精确召回")
    }));
  });

  it("continues fast search with text retrieval when query embedding fails", async () => {
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn(async () => [])
    };
    const reranker: RerankClient = {
      rerankEvents: vi.fn(async (input: { candidates: Array<{ id: string }>; topK: number }) => (
        input.candidates.slice(0, input.topK).map((candidate) => candidate.id)
      ))
    };
    const service = new SearchService(embeddings, llm, reranker);
    const sourceId = "00000000-0000-0000-0000-000000000001";
    const matchedEntity = entity("entity-query", sourceId, "SAG");
    const matchedEvent = {
      ...event("event-1", sourceId, ["entity-query"]),
      title: "SAG fast search",
      summary: "SAG text retrieval still works",
      content: "SAG fast search should continue when embedding fetch failed"
    };
    const progress: Array<{ key: string; status: string; detail: string }> = [];

    repositories.searchEntitiesByText.mockResolvedValue([matchedEntity]);
    repositories.getEventIdsByEntityIds.mockResolvedValue(["event-1"]);
    repositories.searchEventsByText.mockResolvedValue([matchedEvent]);
    repositories.getEventsWithEntityIds.mockResolvedValue(new Map([["event-1", matchedEvent]]));
    repositories.getSectionsForEvents.mockResolvedValue([{
      eventId: "event-1",
      chunkId: "chunk-1",
      sourceId,
      documentId: matchedEvent.documentId,
      heading: matchedEvent.title,
      content: matchedEvent.content,
      rank: 1,
      score: 1
    }]);

    const result = await service.search({
      query: "SAG fast search",
      sourceIds: [sourceId],
      strategy: "multi",
      searchMode: "fast",
      returnTrace: true,
      topK: 5
    }, undefined, (event) => progress.push({
      key: event.key,
      status: event.status,
      detail: event.detail
    }));

    expect(repositories.searchEventsByTitleVector).not.toHaveBeenCalled();
    expect(repositories.coarseRankEventsByContent).not.toHaveBeenCalled();
    expect(repositories.searchEventsByText).toHaveBeenCalledWith(expect.objectContaining({
      query: "SAG fast search"
    }));
    expect(reranker.rerankEvents).toHaveBeenCalledWith(expect.objectContaining({
      candidates: expect.arrayContaining([expect.objectContaining({ id: "event-1" })])
    }));
    expect(result.sections).toHaveLength(1);
    expect(result.trace?.fallbackReason).toContain("文本检索");
    expect(progress.filter((event) => event.key === "queryEmbedding").at(-1)).toEqual(expect.objectContaining({
      status: "failed",
      detail: expect.stringContaining("文本检索")
    }));
  });

  it("does not turn zero-similarity vector fallback into answer evidence", async () => {
    const sourceId = "00000000-0000-0000-0000-000000000001";
    repositories.searchChunksByVector.mockResolvedValue([
      { sourceId, chunkId: "unrelated", content: "Other", rank: 0, score: 0 },
      { sourceId, chunkId: "relevant", content: "Evidence", rank: 1, score: 0.78 }
    ]);
    const embeddings: EmbeddingClient = {
      generate: vi.fn(async () => [1, 0, 0]),
      batchGenerate: vi.fn()
    };
    const llm: LlmClient = {
      extractNamedEntities: vi.fn(async () => []),
      extractEventsFromChunk: vi.fn(),
      rerankEvents: vi.fn()
    };
    const search = new SearchService(embeddings, llm);
    const result = await search.multiSearch({
      query: "Evidence", sourceIds: [sourceId], multi: { similarityThreshold: 0.4 }
    });
    expect(result.sections.map((section) => section.chunkId)).toEqual(["relevant"]);
  });
});

function entity(id: string, sourceId: string, name: string) {
  return {
    id,
    sourceId,
    type: "subject",
    name,
    normalizedName: name.toLowerCase(),
    score: 1
  };
}

function event(id: string, sourceId: string, entityIds: string[]) {
  return {
    id,
    sourceId,
    documentId: "00000000-0000-0000-0000-000000000002",
    chunkId: "00000000-0000-0000-0000-000000000003",
    title: id,
    summary: id,
    content: id,
    rank: 0,
    score: 1,
    entityIds
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
