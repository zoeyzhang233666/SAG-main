import type { EntityRecord, EventRecord } from "../types.js";

/** Max entity IDs per knowledge-bundle request; larger sets are batched. */
export const KNOWLEDGE_BUNDLE_ENTITY_BATCH = 200;

/** Lightweight tree match page size (atlas rows stay cheap). */
export const ATLAS_TREE_MATCH_LIMIT = 12;

export type KnowledgeEntityRecord = EntityRecord & {
  description?: string | null;
  sourceName?: string | null;
  eventCount: number;
};

export type KnowledgeBundle = {
  entities: KnowledgeEntityRecord[];
  events: EventRecord[];
};

export function chunkIds(
  ids: string[],
  size = KNOWLEDGE_BUNDLE_ENTITY_BATCH,
): string[][] {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += size) {
    batches.push(unique.slice(offset, offset + size));
  }
  return batches;
}

export function mergeKnowledgeBundles(
  bundles: Array<{
    entities: KnowledgeEntityRecord[];
    events: EventRecord[];
  }>,
): {
  entities: KnowledgeEntityRecord[];
  events: EventRecord[];
} {
  const entities = new Map<string, KnowledgeEntityRecord>();
  const events = new Map<string, EventRecord>();
  for (const bundle of bundles) {
    for (const entity of bundle.entities) {
      if (!entities.has(entity.id)) entities.set(entity.id, entity);
    }
    for (const event of bundle.events) {
      if (!events.has(event.id)) events.set(event.id, event);
    }
  }
  return {
    entities: [...entities.values()].sort(
      (left, right) =>
        left.name.localeCompare(right.name, "zh") ||
        left.type.localeCompare(right.type, "zh") ||
        left.id.localeCompare(right.id),
    ),
    events: [...events.values()].sort(
      (left, right) =>
        (left.rank ?? 0) - (right.rank ?? 0) || left.id.localeCompare(right.id),
    ),
  };
}

/** Prefer each entity's own eventCount; never overwrite with aggregated event totals. */
export function pickPrimaryKnowledgeEntity(
  entities: KnowledgeEntityRecord[],
  preferredId?: string,
): KnowledgeEntityRecord | undefined {
  if (preferredId) {
    const preferred = entities.find((entity) => entity.id === preferredId);
    if (preferred) return preferred;
  }
  return [...entities].sort(
    (left, right) =>
      right.eventCount - left.eventCount ||
      left.name.localeCompare(right.name, "zh") ||
      left.id.localeCompare(right.id),
  )[0];
}
