import { z } from "zod";
import type { AnswerEvidence, ProjectGraphRecord } from "../types.js";

const ids = z.array(z.guid()).max(1000);
const schema = z.object({
  version: z.literal(1),
  projectId: z.guid(),
  chunkIds: ids,
  eventIds: ids,
  entityIds: ids,
  citations: z.array(z.object({ index: z.number().int().positive(), chunkId: z.guid(), eventIds: ids })).max(50)
});

export function readAnswerEvidence(value: unknown, projectId: string): AnswerEvidence | null {
  const result = schema.safeParse(value);
  return result.success && result.data.projectId === projectId ? result.data : null;
}

export function composeExplorationScope(rounds: AnswerEvidence[]) {
  const mostRecentFirst = [...rounds].reverse();
  return {
    chunkIds: [...new Set(mostRecentFirst.flatMap((item) => item.chunkIds))].slice(0, 64),
    eventIds: [...new Set(mostRecentFirst.flatMap((item) => item.eventIds))].slice(0, 72),
    entityIds: [...new Set(mostRecentFirst.flatMap((item) => item.entityIds))].slice(0, 80)
  };
}

export function projectGraphForExploration(graph: ProjectGraphRecord, projectId: string): ProjectGraphRecord {
  const chunks = graph.chunks.filter((item) => item.sourceId === projectId);
  const events = graph.events.filter((item) => item.sourceId === projectId);
  const entities = graph.entities.filter((item) => item.sourceId === projectId);
  const chunkIds = new Set(chunks.map((item) => item.id));
  const eventIds = new Set(events.map((item) => item.id));
  const entityIds = new Set(entities.map((item) => item.id));
  return {
    ...graph,
    chunks, events,
    entities,
    edges: graph.edges.filter((item) => eventIds.has(item.eventId) && entityIds.has(item.entityId)),
    chunkEventEdges: graph.chunkEventEdges.filter((item) => chunkIds.has(item.chunkId) && eventIds.has(item.eventId))
  };
}
