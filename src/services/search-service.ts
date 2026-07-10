import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { embeddingClient, type EmbeddingClient } from "../ai/embedding-client.js";
import { llmClient, type LlmClient } from "../ai/llm-client.js";
import { rerankClient, type RerankClient } from "../ai/rerank-client.js";
import { MAX_SEARCH_TOP_K, aiSettingsService } from "./ai-settings-service.js";
import {
  assertSourcesAccessible,
  coarseRankEventsByContent,
  getEventIdsByEntityIds,
  getEventsWithEntityIds,
  getSectionsForEvents,
  searchChunksByVector,
  searchEntitiesByName,
  searchEntitiesByText,
  searchEntitiesByVector,
  searchEventsByText,
  searchEventsByTitleVector
} from "../db/repositories.js";
import type {
  EntityRecord,
  EventRecord,
  MultiSubStrategy,
  SearchInput,
  SearchProgressEvent,
  SearchResult,
  SearchSection,
  SearchTrace,
  SearchTraceEvent
} from "../types.js";

interface MultiOptions {
  subStrategy: MultiSubStrategy;
  entityTopK: number;
  multiTopK: number;
  keySimilarityThreshold: number;
  similarityThreshold: number;
  maxHops: number;
  maxEvents: number;
  maxEventsA: number;
  maxEventsB: number;
  maxHopRetries: number;
  rerankTopK: number;
  maxSections: number;
}

type SearchProgressEmitter = (event: SearchProgressEvent) => void;
const MAX_SEARCH_RESULTS = MAX_SEARCH_TOP_K;
const FAST_ENTITY_OVERFETCH_MULTIPLIER = 3;
const MAX_FAST_ENTITY_CANDIDATES = 100;
const MAX_ENTITY_VARIANTS_PER_NORMALIZED_NAME = 2;

export class SearchService {
  constructor(
    private readonly embeddings: EmbeddingClient = embeddingClient,
    private readonly llm: LlmClient = llmClient,
    private readonly reranker: RerankClient = rerankClient
  ) {}

  async search(input: SearchInput, tenantId = config.DEFAULT_TENANT_ID, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const strategy = input.strategy ?? "multi";
    if (strategy !== "vector" && strategy !== "multi") {
      throw new Error(`Unsupported search strategy: ${String(strategy)}`);
    }

    await assertSourcesAccessible(input.sourceIds, tenantId);
    if (strategy === "vector") {
      return this.vectorSearch(input, emit);
    }
    return this.multiSearch(input, emit);
  }

  async vectorSearch(input: SearchInput, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const topK = resolveFinalSearchTopK(input.multi?.maxSections ?? input.topK ?? runtimeSettings.defaultSearchTopK);
    const traceId = randomUUID();
    const timings: Record<string, number> = {};
    const queryVector = await timed(timings, "queryEmbedding", () => this.embeddings.generate(input.query), emit, {
      title: "查询向量化",
      detail: "把用户问题转成向量，用于向量召回。"
    });
    const sections = await timed(timings, "vectorSearchChunks", () => searchChunksByVector({
      sourceIds: input.sourceIds,
      queryVector,
      topK
    }), emit, {
      title: "向量召回切片",
      detail: "按查询向量召回最相近的文档切片。"
    });
    return {
      traceId,
      sections: sections.slice(0, topK).map((section) => ({ ...section }))
    };
  }

  async multiSearch(input: SearchInput, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const options = resolveMultiOptions(input, runtimeSettings.defaultSearchTopK);
    const searchMode = input.searchMode ?? runtimeSettings.defaultSearchMode;
    const traceId = randomUUID();
    const timings: Record<string, number> = {};
    const trace: SearchTrace = {
      traceId,
      query: input.query,
      searchMode,
      queryEntities: [],
      recalledEntities: [],
      entityEventIds: [],
      queryEventIds: [],
      expandedEventIds: [],
      coarseRankedEventIds: [],
      rerankedEventIds: [],
      timings
    };

    const queryEmbedding = await timedOptional(timings, "queryEmbedding", () => this.embeddings.generate(input.query), emit, {
      title: "查询向量化",
      detail: "把用户问题转成向量，用于召回相关事件和切片。"
    }, (error) => `查询向量化不可用，已继续使用文本检索：${formatSearchError(error)}`);
    const queryVector = queryEmbedding.value;
    if (!queryVector) {
      appendFallbackReason(trace, queryEmbedding.fallbackDetail);
    }

    let queryEntities: string[] = [];
    let recalledEntities: EntityRecord[] = [];
    if (searchMode === "fast") {
      const matchedEntities = await timed(timings, "step1Bm25Entities", () => searchEntitiesByText({
        sourceIds: input.sourceIds,
        query: input.query,
        limit: resolveFastEntityCandidateLimit(options.entityTopK)
      }), emit, {
        title: "BM25 匹配查询实体",
        detail: "直接用用户问题在实体库做全文/BM25 匹配，不调用 LLM 抽取 key。"
      });
      recalledEntities = diversifyEntitiesByNormalizedName(matchedEntities, options.entityTopK);
      queryEntities = uniqueEntityNames(recalledEntities.map((entity) => entity.name));
      trace.queryEntities = queryEntities;
      emitSearchStep(emit, timings, "step1Bm25Entities", {
        title: "BM25 匹配查询实体",
        detail: recalledEntities.length === 0
          ? "没有匹配到查询实体"
          : `匹配到 ${matchedEntities.length} 个候选实体，按名称和证据分数去重后保留 ${recalledEntities.length} 个`,
        payload: recalledEntities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          score: entity.score ?? 0
        }))
      });
    } else {
      queryEntities = uniqueEntityNames(await timed(timings, "step1ExtractEntities", () => this.llm.extractNamedEntities(input.query), emit, {
        title: "抽取查询实体",
        detail: "识别用户问题中的关键实体。"
      }));
      trace.queryEntities = queryEntities;
      emitSearchStep(emit, timings, "step1ExtractEntities", {
        title: "抽取查询实体",
        detail: queryEntities.length === 0 ? "没有识别到查询实体" : `识别到 ${queryEntities.length} 个查询实体`,
        payload: queryEntities
      });

      recalledEntities = await timed(timings, "step2RetrieveEntities", async () => {
        const exactPromise = searchEntitiesByName({
          sourceIds: input.sourceIds,
          names: queryEntities,
          limit: options.entityTopK
        });
        const vectorPromise = queryVector && queryEntities.length > 0
          ? timedOptional(timings, "step2EntityVectors", async () => {
              const vectors = await this.embeddings.batchGenerate(queryEntities);
              if (vectors.length !== queryEntities.length) {
                throw new Error(`entity embedding count mismatch: expected=${queryEntities.length}, actual=${vectors.length}`);
              }
              const matches = await Promise.all(vectors.map((vector) => searchEntitiesByVector({
                sourceIds: input.sourceIds,
                queryVector: vector,
                topK: options.entityTopK,
                threshold: options.keySimilarityThreshold
              })));
              return matches.flat();
            }, emit, {
              title: "批量召回实体向量",
              detail: "批量生成查询实体向量，并行召回相似实体。"
            }, (error) => `实体向量召回不可用，已保留名称精确召回：${formatSearchError(error)}`)
          : Promise.resolve({ value: [] as EntityRecord[], fallbackDetail: undefined });
        const [exact, vectorResult] = await Promise.all([exactPromise, vectorPromise]);
        if (vectorResult.fallbackDetail) {
          appendFallbackReason(trace, vectorResult.fallbackDetail);
        }
        return dedupeEntities([...exact, ...(vectorResult.value ?? [])]);
      }, emit, {
        title: "召回相关实体",
        detail: "按实体名称和实体向量召回相关实体。"
      });
    }
    trace.recalledEntities = recalledEntities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      score: entity.score ?? 0
    }));
    if (searchMode !== "fast") {
      emitSearchStep(emit, timings, "step2RetrieveEntities", {
        title: "召回相关实体",
        detail: `召回 ${trace.recalledEntities.length} 个实体`,
        payload: trace.recalledEntities
      });
    }

    const entityEventIdsPromise = timed(timings, "step3EntityEvents", () => getEventIdsByEntityIds({
      entityIds: recalledEntities.map((entity) => entity.id),
      sourceIds: input.sourceIds
    }), emit, {
      title: "实体关联事件",
      detail: "读取召回实体关联的候选事件。"
    });
    const queryEventsPromise = queryVector
      ? timed(timings, "step3QueryEvents", () => searchEventsByTitleVector({
          sourceIds: input.sourceIds,
          queryVector,
          topK: options.multiTopK * 3,
          threshold: options.similarityThreshold
        }).then((events) => events.slice(0, options.multiTopK)), emit, {
          title: "标题向量召回事件",
          detail: "按查询向量召回标题相关事件。"
        })
      : Promise.resolve([] as EventRecord[]);
    if (!queryVector) {
      timings.step3QueryEvents = 0;
      emitSearchStep(emit, timings, "step3QueryEvents", {
        title: "标题向量召回事件",
        detail: "查询向量不可用，标题向量召回已降级并跳过。"
      }, "failed");
    }
    const textEventsPromise = timed(timings, "step3TextEvents", () => searchEventsByText({
      sourceIds: input.sourceIds,
      query: input.query,
      limit: options.multiTopK,
      threshold: 0.04
    }), emit, {
      title: "事件文本匹配",
      detail: "直接在事件标题、摘要和内容中匹配用户问题。"
    });
    const [entityEventIds, queryEvents, textEvents] = await Promise.all([
      entityEventIdsPromise,
      queryEventsPromise,
      textEventsPromise
    ]);
    trace.entityEventIds = entityEventIds;
    emitSearchStep(emit, timings, "step3EntityEvents", {
      title: "实体关联事件",
      detail: `找到 ${entityEventIds.length} 个实体关联事件`
    });

    trace.queryEventIds = queryEvents.map((event) => event.id);
    trace.queryEvents = toTraceEvents(queryEvents);
    appendEventSnapshots(trace, trace.queryEvents);
    if (queryVector) {
      emitSearchStep(emit, timings, "step3QueryEvents", {
        title: "标题向量召回事件",
        detail: `召回 ${trace.queryEvents.length} 个标题相关事件`,
        payload: trace.queryEvents
      });
    }

    trace.textEventIds = textEvents.map((event) => event.id);
    trace.textEvents = toTraceEvents(textEvents);
    appendEventSnapshots(trace, trace.textEvents);
    emitSearchStep(emit, timings, "step3TextEvents", {
      title: "事件文本匹配",
      detail: `匹配 ${trace.textEvents.length} 个事件`,
      payload: trace.textEvents
    });

    const seedEventIds = unique([
      ...entityEventIds,
      ...queryEvents.map((event) => event.id),
      ...textEvents.map((event) => event.id)
    ]);
    if (seedEventIds.length === 0) {
      const fallbackDetail = queryVector
        ? "no seed events; used vector chunk search"
        : "no seed events; query embedding unavailable and text retrieval found no matches";
      appendFallbackReason(trace, fallbackDetail);
      emitSearchStep(emit, timings, "fallback", {
        title: "降级路径",
        detail: fallbackDetail
      });
      if (!queryVector) {
        return {
          traceId,
          sections: [],
          trace: input.returnTrace ? trace : undefined
        };
      }
      const fallbackSections = await timed(timings, "fallbackVectorChunks", () => searchChunksByVector({
        sourceIds: input.sourceIds,
        queryVector,
        topK: options.maxSections
      }), emit, {
        title: "向量召回切片",
        detail: "按查询向量召回最相近的文档切片。"
      });
      return {
        traceId,
        sections: fallbackSections.slice(0, options.maxSections).map((section) => ({ ...section })),
        trace: input.returnTrace ? trace : undefined
      };
    }

    const seedEvents = await timed(timings, "step4FetchDetails", () => getEventsWithEntityIds(seedEventIds), emit, {
      title: "读取候选事件详情",
      detail: "读取候选事件及其关联实体。"
    });
    trace.entityEvents = idsToTraceEvents(entityEventIds, seedEvents);
    appendEventSnapshots(trace, trace.entityEvents);
    emitSearchStep(emit, timings, "step4FetchDetails", {
      title: "读取候选事件详情",
      detail: `读取 ${seedEvents.size} 个候选事件详情`,
      payload: toTraceEvents([...seedEvents.values()])
    });
    const expanded = await timed(timings, "step5Expand", () => this.expandEvents({
      seedEvents,
      initialEntityIds: recalledEntities.map((entity) => entity.id),
      sourceIds: input.sourceIds,
      query: input.query,
      queryVector,
      options
    }), emit, {
      title: "事件扩展",
      detail: "沿事件实体关系扩展候选事件集合。"
    });
    trace.expandedEventIds = expanded.expandedEventIds;
    emitSearchStep(emit, timings, "step5Expand", {
      title: "事件扩展",
      detail: `扩展 ${expanded.expandedEventIds.length} 个事件`
    });

    const coarseRanked = await timed(timings, "step6CoarseRank", async () => {
      if (!queryVector) {
        const candidateEventIds = unique([...seedEventIds, ...expanded.eventsetIds, ...expanded.eventset1Ids]);
        const candidateEvents = await getEventsWithEntityIds(candidateEventIds);
        return rankEventsByTextFallback(input.query, candidateEventIds, candidateEvents, options.maxEvents);
      }
      if (options.subStrategy === "multi") {
        return coarseRankEventsByContent({
          sourceIds: input.sourceIds,
          eventIds: unique([...seedEventIds, ...expanded.eventsetIds]),
          queryVector,
          maxEvents: options.maxEvents
        });
      }

      const eventsetRanked = await coarseRankEventsByContent({
        sourceIds: input.sourceIds,
        eventIds: unique([...seedEventIds, ...expanded.eventsetIds]),
        queryVector,
        maxEvents: options.maxEventsA
      });
      const eventset1Ranked = expanded.eventset1Ids.length > 0 && options.maxEventsB > 0
        ? await coarseRankEventsByContent({
            sourceIds: input.sourceIds,
            eventIds: expanded.eventset1Ids,
            queryVector,
            maxEvents: options.maxEventsB
          })
        : [];
      return [...eventsetRanked, ...eventset1Ranked];
    }, emit, {
      title: queryVector ? "粗排事件" : "文本粗排事件",
      detail: queryVector
        ? "按事件内容向量相似度粗排候选事件。"
        : "查询向量不可用，按文本命中、候选顺序和事件关联粗排候选事件。"
    });
    trace.coarseRankedEventIds = coarseRanked.map((event) => event.id);
    trace.coarseRankedEvents = toTraceEvents(coarseRanked);
    trace.expandedEvents = trace.expandedEventIds.length > 0
      ? trace.coarseRankedEvents.filter((event) => trace.expandedEventIds.includes(event.id))
      : [];
    appendEventSnapshots(trace, trace.coarseRankedEvents);
    emitSearchStep(emit, timings, "step6CoarseRank", {
      title: queryVector ? "粗排事件" : "文本粗排事件",
      detail: queryVector
        ? `粗排得到 ${trace.coarseRankedEvents.length} 个候选事件`
        : `文本粗排得到 ${trace.coarseRankedEvents.length} 个候选事件`,
      payload: trace.coarseRankedEvents
    });

    const rerankStepKey = searchMode === "fast" ? "step7RerankModel" : "step7LlmRerank";
    let selectedIds = await timed(timings, rerankStepKey, () => (
      searchMode === "fast"
        ? this.reranker.rerankEvents({
            query: input.query,
            candidates: coarseRanked,
            topK: options.rerankTopK
          })
        : this.llm.rerankEvents({
            query: input.query,
            candidates: coarseRanked,
            topK: options.rerankTopK
          })
    ), emit, {
      title: searchMode === "fast" ? "Rerank 模型重排" : "LLM 重排",
      detail: searchMode === "fast"
        ? "用 rerank 模型对候选事件排序，不调用 LLM 过滤。"
        : "让 LLM 根据问题从候选事件中选择最终事件。"
    });
    if (selectedIds.length === 0) {
      const fallbackDetail = searchMode === "fast"
        ? "rerank model returned no ids; used coarse rank"
        : "llm rerank returned no ids; used coarse rank";
      appendFallbackReason(trace, fallbackDetail);
      selectedIds = coarseRanked.slice(0, options.rerankTopK).map((event) => event.id);
    }
    selectedIds = filterUsefulEventIds(input.query, selectedIds, coarseRanked, options.rerankTopK, Boolean(queryVector));
    trace.rerankedEventIds = selectedIds;
    const eventSnapshotById = new Map((trace.eventSnapshots ?? []).map((event) => [event.id, event]));
    trace.rerankedEvents = selectedIds.map((id) => eventSnapshotById.get(id)).filter((event): event is SearchTraceEvent => Boolean(event));
    emitSearchStep(emit, timings, rerankStepKey, {
      title: searchMode === "fast" ? "Rerank 模型重排" : "LLM 重排",
      detail: `选出 ${trace.rerankedEvents.length || selectedIds.length} 个最终候选事件`,
      payload: trace.rerankedEvents.length > 0 ? trace.rerankedEvents : undefined
    });

    const sections = await timed(timings, "step8FetchChunks", () => this.sectionsForSelectedEvents(selectedIds, coarseRanked, options.maxSections), emit, {
      title: "回取关联切片",
      detail: "读取最终事件关联的原文切片。"
    });
    emitSearchStep(emit, timings, "step8FetchChunks", {
      title: "回取关联切片",
      detail: `读取 ${sections.slice(0, options.maxSections).length} 个最终上下文切片`,
      payload: sections.slice(0, options.maxSections).map((section) => ({
        heading: section.heading,
        contentPreview: previewText(section.content, 160),
        score: section.score,
        rank: section.rank
      }))
    });

    return {
      traceId,
      sections: sections.slice(0, options.maxSections),
      trace: input.returnTrace ? trace : undefined
    };
  }

  private async expandEvents(input: {
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>;
    initialEntityIds: string[];
    sourceIds: string[];
    query: string;
    queryVector: number[] | null;
    options: MultiOptions;
  }): Promise<{ eventsetIds: string[]; eventset1Ids: string[]; expandedEventIds: string[] }> {
    if (input.options.subStrategy === "multi") {
      return this.expandFixedHops(input.seedEvents, input.initialEntityIds, input.sourceIds, input.options.maxHops);
    }
    const stageA = await this.expandOneHop(input.seedEvents, input.initialEntityIds, input.sourceIds, new Set(input.seedEvents.keys()));
    const trackedEntityIdsForB = unique([...input.initialEntityIds, ...stageA.expandedEntityIds]);
    let seedForB = stageA.events;
    if (input.options.subStrategy === "hopllm" && input.queryVector) {
      const eventsetIds = unique([...input.seedEvents.keys(), ...stageA.eventIds]);
      const ranked = await coarseRankEventsByContent({
        sourceIds: input.sourceIds,
        eventIds: eventsetIds,
        queryVector: input.queryVector,
        maxEvents: input.options.maxEventsA
      });
      seedForB = await getEventsWithEntityIds(ranked.map((event) => event.id));
    }
    const stageB = await this.expandDynamic(seedForB, trackedEntityIdsForB, input.sourceIds, new Set([...input.seedEvents.keys(), ...stageA.eventIds]), input.options.maxEventsB, input.options.maxHopRetries);
    return {
      eventsetIds: stageA.eventIds,
      eventset1Ids: stageB.eventIds,
      expandedEventIds: unique([...stageA.eventIds, ...stageB.eventIds])
    };
  }

  private async expandFixedHops(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    maxHops: number
  ): Promise<{ eventsetIds: string[]; eventset1Ids: string[]; expandedEventIds: string[] }> {
    const trackedEvents = new Set(seedEvents.keys());
    const trackedEntities = new Set(initialEntityIds);
    let current = seedEvents;
    const expandedEventIds: string[] = [];
    for (let hop = 0; hop < maxHops; hop += 1) {
      const newEntityIds = collectNewEntityIds(current, trackedEntities);
      newEntityIds.forEach((id) => trackedEntities.add(id));
      if (newEntityIds.length === 0) {
        break;
      }
      const newEventIds = await getEventIdsByEntityIds({
        entityIds: newEntityIds,
        sourceIds,
        excludeEventIds: [...trackedEvents]
      });
      if (newEventIds.length === 0) {
        break;
      }
      newEventIds.forEach((id) => trackedEvents.add(id));
      expandedEventIds.push(...newEventIds);
      current = await getEventsWithEntityIds(newEventIds);
    }
    return { eventsetIds: expandedEventIds, eventset1Ids: [], expandedEventIds };
  }

  private async expandOneHop(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    excludeEvents: Set<string>
  ): Promise<{ eventIds: string[]; events: Map<string, EventRecord & { entityIds: string[] }>; expandedEntityIds: string[] }> {
    const trackedEntities = new Set(initialEntityIds);
    const entityIds = collectNewEntityIds(seedEvents, trackedEntities);
    const eventIds = await getEventIdsByEntityIds({
      entityIds,
      sourceIds,
      excludeEventIds: [...excludeEvents]
    });
    return {
      eventIds,
      events: await getEventsWithEntityIds(eventIds),
      expandedEntityIds: entityIds
    };
  }

  private async expandDynamic(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    excludeEvents: Set<string>,
    targetEvents: number,
    maxHopRetries: number
  ): Promise<{ eventIds: string[] }> {
    if (targetEvents === 0 || seedEvents.size === 0) {
      return { eventIds: [] };
    }
    const trackedEntities = new Set(initialEntityIds);
    const collected: string[] = [];
    let current = seedEvents;
    for (let hop = 0; hop < maxHopRetries; hop += 1) {
      const newEntityIds = collectNewEntityIds(current, trackedEntities);
      newEntityIds.forEach((id) => trackedEntities.add(id));
      if (newEntityIds.length === 0) {
        break;
      }
      const newEventIds = await getEventIdsByEntityIds({
        entityIds: newEntityIds,
        sourceIds,
        excludeEventIds: [...excludeEvents, ...collected]
      });
      if (newEventIds.length === 0) {
        break;
      }
      collected.push(...newEventIds);
      if (collected.length >= targetEvents) {
        break;
      }
      current = await getEventsWithEntityIds(newEventIds);
    }
    return { eventIds: collected };
  }

  private async sectionsForSelectedEvents(
    eventIds: string[],
    rankedEvents: EventRecord[],
    maxSections: number
  ): Promise<SearchSection[]> {
    const scoreByEventId = new Map(rankedEvents.map((event) => [event.id, event.score ?? 0]));
    const rawSections = await getSectionsForEvents(eventIds);
    const seenChunks = new Set<string>();
    const sections: SearchSection[] = [];
    for (const section of rawSections) {
      if (seenChunks.has(section.chunkId)) {
        continue;
      }
      seenChunks.add(section.chunkId);
      sections.push({
        chunkId: section.chunkId,
        sourceId: section.sourceId,
        documentId: section.documentId,
        heading: section.heading,
        content: section.content,
        rank: section.rank,
        score: scoreByEventId.get(section.eventId) ?? 0
      });
      if (sections.length >= maxSections) {
        break;
      }
    }
    return sections;
  }
}

function rankEventsByTextFallback(
  query: string,
  eventIds: string[],
  events: Map<string, EventRecord & { entityIds: string[] }>,
  limit: number
): EventRecord[] {
  const ranked: EventRecord[] = [];
  unique(eventIds).forEach((id, index) => {
    const event = events.get(id);
    if (!event) {
      return;
    }
    ranked.push({
      ...event,
      score: Math.max(event.score ?? 0, lexicalEventScore(query, event), 1 / (index + 1))
    });
  });
  return ranked
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.rank - right.rank || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, limit));
}

function filterUsefulEventIds(
  query: string,
  selectedIds: string[],
  candidates: EventRecord[],
  limit: number,
  hasReliableVectorScores = true
): string[] {
  if (selectedIds.length === 0 || candidates.length === 0) {
    return [];
  }
  const byId = new Map(candidates.map((event) => [event.id, event]));
  const ordered = unique(selectedIds)
    .map((id) => byId.get(id))
    .filter((event): event is EventRecord => Boolean(event));
  if (ordered.length === 0) {
    return [];
  }
  if (!hasReliableVectorScores) {
    return ordered.slice(0, Math.max(1, limit)).map((event) => event.id);
  }
  const bestScore = Math.max(...ordered.map((event) => event.score ?? 0));
  const minVectorScore = Math.max(0.34, Math.min(0.62, bestScore - 0.12));
  const useful = ordered.filter((event, index) => {
    const lexical = lexicalEventScore(query, event);
    if (lexical >= 1) {
      return true;
    }
    const score = event.score ?? 0;
    if (score >= minVectorScore && (index === 0 || bestScore >= 0.48)) {
      return true;
    }
    return false;
  });
  return useful.slice(0, Math.max(1, limit)).map((event) => event.id);
}

function lexicalEventScore(query: string, event: EventRecord): number {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedText = normalizeSearchText(`${event.title} ${event.summary} ${event.content}`);
  if (!normalizedQuery || !normalizedText) {
    return 0;
  }
  if (normalizedQuery.length >= 4 && normalizedText.includes(normalizedQuery)) {
    return 3;
  }
  const terms = extractSearchTerms(query);
  return terms.reduce((score, term) => score + (normalizedText.includes(term) ? 1 : 0), 0);
}

function extractSearchTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLowerCase();
  const terms = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => normalizeSearchText(term))
    .filter((term) => term.length >= 2);
  const cjkPhrases = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const phrase of cjkPhrases) {
    const compact = normalizeSearchText(phrase);
    if (compact.length >= 2) {
      terms.push(compact);
    }
  }
  return [...new Set(terms)].slice(0, 12);
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function formatSearchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveMultiOptions(input: SearchInput, defaultSearchTopK: number): MultiOptions {
  const multi = input.multi ?? {};
  const topK = resolveFinalSearchTopK(input.topK ?? defaultSearchTopK);
  const rerankTopK = resolveFinalSearchTopK(multi.rerankTopK ?? topK);
  const maxSections = resolveFinalSearchTopK(multi.maxSections ?? topK);
  return {
    subStrategy: input.subStrategy ?? "multi",
    entityTopK: multi.entityTopK ?? 20,
    multiTopK: multi.multiTopK ?? 20,
    keySimilarityThreshold: multi.keySimilarityThreshold ?? 0.9,
    similarityThreshold: multi.similarityThreshold ?? 0.4,
    maxHops: multi.maxHops ?? 1,
    maxEvents: multi.maxEvents ?? 100,
    maxEventsA: multi.maxEventsA ?? 100,
    maxEventsB: multi.maxEventsB ?? 0,
    maxHopRetries: multi.maxHopRetries ?? 3,
    rerankTopK,
    maxSections
  };
}

function resolveFinalSearchTopK(value?: number): number {
  if (!Number.isFinite(value) || value == null) {
    return MAX_SEARCH_RESULTS;
  }
  return Math.max(1, Math.min(Math.trunc(value), MAX_SEARCH_RESULTS));
}

function resolveFastEntityCandidateLimit(entityTopK: number): number {
  return Math.max(
    entityTopK,
    Math.min(entityTopK * FAST_ENTITY_OVERFETCH_MULTIPLIER, MAX_FAST_ENTITY_CANDIDATES)
  );
}

function uniqueEntityNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const trimmed = name.normalize("NFKC").trim();
    const key = trimmed.toLowerCase().replace(/\s+/g, "");
    if (!trimmed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function diversifyEntitiesByNormalizedName(entities: EntityRecord[], limit: number): EntityRecord[] {
  if (entities.length === 0 || limit <= 0) {
    return [];
  }
  type IndexedEntity = { entity: EntityRecord; index: number };
  const grouped = new Map<string, Map<string, IndexedEntity>>();
  entities.forEach((entity, index) => {
    const nameKey = (entity.normalizedName || entity.name)
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "") || entity.id;
    const variantKey = `${entity.sourceId}\u0000${entity.type.normalize("NFKC").trim().toLowerCase()}`;
    const variants = grouped.get(nameKey) ?? new Map<string, IndexedEntity>();
    const current = variants.get(variantKey);
    if (!current || compareEntityEvidence({ entity, index }, current) < 0) {
      variants.set(variantKey, { entity, index });
    }
    grouped.set(nameKey, variants);
  });

  const groups = [...grouped.values()]
    .map((variants) => [...variants.values()].sort(compareEntityEvidence))
    .sort((left, right) => compareEntityEvidence(left[0], right[0]));
  const selected: EntityRecord[] = [];
  const seenIds = new Set<string>();
  for (let variantIndex = 0; variantIndex < MAX_ENTITY_VARIANTS_PER_NORMALIZED_NAME; variantIndex += 1) {
    const candidates = groups
      .map((group) => group[variantIndex])
      .filter((candidate): candidate is IndexedEntity => Boolean(candidate))
      .sort(compareEntityEvidence);
    for (const candidate of candidates) {
      if (seenIds.has(candidate.entity.id)) {
        continue;
      }
      seenIds.add(candidate.entity.id);
      selected.push(candidate.entity);
      if (selected.length >= limit) {
        return selected;
      }
    }
  }
  return selected;
}

function compareEntityEvidence(
  left: { entity: EntityRecord; index: number },
  right: { entity: EntityRecord; index: number }
): number {
  const leftScore = Number.isFinite(left.entity.score) ? left.entity.score ?? 0 : 0;
  const rightScore = Number.isFinite(right.entity.score) ? right.entity.score ?? 0 : 0;
  return rightScore - leftScore || left.index - right.index || left.entity.id.localeCompare(right.entity.id);
}

function appendFallbackReason(trace: SearchTrace, detail?: string): void {
  const normalized = detail?.trim();
  if (!normalized) {
    return;
  }
  if (!trace.fallbackReason) {
    trace.fallbackReason = normalized;
    return;
  }
  if (!trace.fallbackReason.split("; ").includes(normalized)) {
    trace.fallbackReason = `${trace.fallbackReason}; ${normalized}`;
  }
}

function collectNewEntityIds(
  events: Map<string, EventRecord & { entityIds: string[] }>,
  trackedEntities: Set<string>
): string[] {
  const ids = unique([...events.values()].flatMap((event) => event.entityIds));
  return ids.filter((id) => !trackedEntities.has(id));
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

function dedupeEntities(entities: EntityRecord[]): EntityRecord[] {
  const seen = new Set<string>();
  const result: EntityRecord[] = [];
  for (const entity of entities) {
    if (seen.has(entity.id)) {
      continue;
    }
    seen.add(entity.id);
    result.push(entity);
  }
  return result;
}

async function timed<T>(
  timings: Record<string, number>,
  key: string,
  fn: () => Promise<T>,
  emit?: SearchProgressEmitter,
  step?: { title: string; detail: string; payload?: unknown }
): Promise<T> {
  const start = performance.now();
  if (emit && step) {
    emitSearchStep(emit, timings, key, step, "running");
  }
  try {
    const result = await fn();
    timings[key] = Math.round((performance.now() - start) * 100) / 100;
    if (emit && step) {
      emitSearchStep(emit, timings, key, step, "done");
    }
    return result;
  } catch (error) {
    timings[key] = Math.round((performance.now() - start) * 100) / 100;
    if (emit && step) {
      emitSearchStep(emit, timings, key, {
        ...step,
        detail: `${step.detail} 失败：${error instanceof Error ? error.message : String(error)}`
      }, "failed");
    }
    throw error;
  }
}

async function timedOptional<T>(
  timings: Record<string, number>,
  key: string,
  fn: () => Promise<T>,
  emit: SearchProgressEmitter | undefined,
  step: { title: string; detail: string; payload?: unknown },
  fallbackDetail: (error: unknown) => string
): Promise<{ value: T | null; fallbackDetail?: string }> {
  const start = performance.now();
  if (emit && step) {
    emitSearchStep(emit, timings, key, step, "running");
  }
  try {
    const value = await fn();
    timings[key] = Math.round((performance.now() - start) * 100) / 100;
    emitSearchStep(emit, timings, key, step, "done");
    return { value };
  } catch (error) {
    timings[key] = Math.round((performance.now() - start) * 100) / 100;
    const detail = fallbackDetail(error);
    emitSearchStep(emit, timings, key, {
      ...step,
      detail
    }, "failed");
    return { value: null, fallbackDetail: detail };
  }
}

function emitSearchStep(
  emit: SearchProgressEmitter | undefined,
  timings: Record<string, number>,
  key: string,
  step: { title: string; detail: string; payload?: unknown },
  status: SearchProgressEvent["status"] = "done"
) {
  emit?.({
    type: "step",
    status,
    key,
    title: step.title,
    detail: step.detail,
    payload: step.payload,
    durationMs: timings[key]
  });
}

function toTraceEvents(events: Array<EventRecord & { entityIds?: string[] }>): SearchTraceEvent[] {
  return events.map((event) => ({
    id: event.id,
    title: event.title,
    summary: event.summary,
    contentPreview: previewText(event.content || event.summary || event.title, 160),
    score: event.score
  }));
}

function idsToTraceEvents(
  ids: string[],
  events: Map<string, EventRecord & { entityIds: string[] }>
): SearchTraceEvent[] {
  return ids
    .map((id) => events.get(id))
    .filter((event): event is EventRecord & { entityIds: string[] } => Boolean(event))
    .map((event) => toTraceEvents([event])[0]);
}

function appendEventSnapshots(trace: SearchTrace, events: SearchTraceEvent[]) {
  const byId = new Map((trace.eventSnapshots ?? []).map((event) => [event.id, event]));
  for (const event of events) {
    byId.set(event.id, event);
  }
  trace.eventSnapshots = [...byId.values()];
}

function previewText(text: string, limit: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

export const searchService = new SearchService();
