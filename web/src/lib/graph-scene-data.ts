import type { ProjectGraphRecord } from "../types.js";

export type SceneNode = {
  id: string;
  label: string;
  kind: "chunk" | "entity" | "event";
  color?: string;
};

export type SceneLink = { source: string; target: string };

export function buildSceneData(input: {
  nodes: SceneNode[];
  graph: Pick<ProjectGraphRecord, "edges" | "chunkEventEdges">;
  priority: Set<string>;
  compact: boolean;
}) {
  const nodeLimit = input.compact ? 120 : 240;
  const linkLimit = input.compact ? 180 : 360;
  const prioritized = input.nodes.filter((node) => input.priority.has(node.id));
  const ordinary = input.nodes.filter((node) => !input.priority.has(node.id));
  const nodes = [...prioritized, ...ordinary].slice(0, nodeLimit);
  const visibleIds = new Set(nodes.map((node) => node.id));
  const links: SceneLink[] = [
    ...input.graph.edges.map((item) => ({ source: item.eventId, target: item.entityId })),
    ...input.graph.chunkEventEdges.map((item) => ({ source: item.chunkId, target: item.eventId }))
  ].filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target));
  links.sort((left, right) =>
    Number(input.priority.has(right.source) || input.priority.has(right.target)) -
    Number(input.priority.has(left.source) || input.priority.has(left.target))
  );
  return {
    nodes,
    links: links.slice(0, linkLimit),
    cropped: input.nodes.length > nodes.length || links.length > linkLimit
  };
}
