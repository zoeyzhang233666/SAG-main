import type { ProjectGraphRecord } from "../types.js";

export type EvidenceCitation = { index: number; chunkId: string; heading?: string; documentId?: string; sourceId: string };

export function buildAnswerEvidence(projectId: string, citations: EvidenceCitation[], graph: ProjectGraphRecord) {
  const scopedCitations = citations.filter((item) => item.sourceId === projectId);
  const chunkIds = [...new Set(scopedCitations.map((item) => item.chunkId))];
  const chunkSet = new Set(chunkIds);
  const events = graph.events.filter((item) =>
    item.sourceId === projectId && item.chunkId && chunkSet.has(item.chunkId)
  );
  const eventById = new Map(events.map((item) => [item.id, item]));
  const entityIds = new Set(graph.entities.filter((item) => item.sourceId === projectId).map((item) => item.id));
  const edges = graph.edges.filter((edge) => eventById.has(edge.eventId) && entityIds.has(edge.entityId));
  return {
    version: 1 as const,
    projectId,
    chunkIds,
    eventIds: events.map((item) => item.id),
    entityIds: [...new Set(edges.map((edge) => edge.entityId))],
    citations: scopedCitations.map(({ index, chunkId }) => ({
      index,
      chunkId,
      eventIds: events.filter((event) => event.chunkId === chunkId).map((event) => event.id)
    }))
  };
}

export type AnswerEvidence = ReturnType<typeof buildAnswerEvidence>;

export function buildAnswerArtifacts(
  question: string, citations: EvidenceCitation[], graph: ProjectGraphRecord, evidence: AnswerEvidence
) {
  const requestedDiagram = /图|上游|下游|产业链|供应链|关系|diagram|links?|flow|supply chain/i.test(question);
  if (requestedDiagram) {
    const eventIds = new Set(evidence.eventIds.slice(0, 4));
    const entityLabels = new Map(graph.entities.filter((item) => item.sourceId === evidence.projectId).map((item) => [item.id, item.name]));
    const edges: Array<{ from: string; to: string }> = [];
    const linkedEntities = new Set<string>();
    for (const edge of graph.edges) {
      if (!eventIds.has(edge.eventId) || !entityLabels.has(edge.entityId)) continue;
      if (!linkedEntities.has(edge.entityId) && linkedEntities.size >= 8) continue;
      edges.push({ from: edge.eventId, to: edge.entityId });
      linkedEntities.add(edge.entityId);
      if (edges.length >= 16) break;
    }
    if (edges.length) {
      const linkedEvents = new Set(edges.map((edge) => edge.from));
      const nodes = [
        ...graph.events.filter((item) => linkedEvents.has(item.id)).map((item) => ({
          id: item.id,
          label: item.title.slice(0, 96),
          kind: "event" as const,
          citation: citations.find((citation) => citation.chunkId === item.chunkId)?.index
        })),
        ...Array.from(linkedEntities, (id) => ({ id, label: entityLabels.get(id)!.slice(0, 96), kind: "entity" as const }))
      ];
      return [{ version: 1 as const, kind: "flow" as const, nodes, edges }];
    }
  }
  if (/汇总|统计|数量|覆盖|summary|count|coverage/i.test(question) && citations.length > 0) {
    return [{
      version: 1 as const,
      kind: "metrics" as const,
      chunks: evidence.chunkIds.length,
      events: evidence.eventIds.length,
      entities: evidence.entityIds.length
    }];
  }
  if (/表格|对比|比较|table|compar/i.test(question) && citations.length > 1) {
    return [{
      version: 1 as const,
      kind: "table" as const,
      rows: citations.map(({ index, heading }) => ({ index, heading: heading?.slice(0, 160) }))
    }];
  }
  return [];
}
