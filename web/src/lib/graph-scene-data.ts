import type { ProjectGraphRecord } from "../types.js";

export type SceneNode = {
  id: string;
  label: string;
  kind: "chunk" | "entity" | "event";
  category?: string;
};

export type SceneLink = { source: string; target: string };

type GraphRelations = Pick<ProjectGraphRecord, "edges" | "chunkEventEdges">;

export function nodesForEventCategory(nodes: SceneNode[], graph: GraphRelations, category: string) {
  const allowed = new Set(nodes.filter((node) => node.kind === "event" && node.category === category).map((node) => node.id));
  for (const edge of graph.edges) {
    if (allowed.has(edge.eventId)) allowed.add(edge.entityId);
  }
  for (const edge of graph.chunkEventEdges) {
    if (allowed.has(edge.eventId)) allowed.add(edge.chunkId);
  }
  return allowed;
}

export function buildSceneData(input: {
  nodes: SceneNode[];
  graph: GraphRelations;
  priority: Set<string>;
  compact: boolean;
  category?: string;
}) {
  const nodeLimit = input.compact ? 120 : 240;
  const linkLimit = input.compact ? 180 : 360;
  const allowed = input.category ? nodesForEventCategory(input.nodes, input.graph, input.category) : null;
  const candidates = allowed ? input.nodes.filter((node) => allowed.has(node.id)) : input.nodes;
  const prioritized = candidates.filter((node) => input.priority.has(node.id));
  const ordinary = candidates.filter((node) => !input.priority.has(node.id));
  const visibleIds = new Set([...prioritized, ...ordinary].slice(0, nodeLimit).map((node) => node.id));
  const nodes = candidates.filter((node) => visibleIds.has(node.id));
  const links: SceneLink[] = [
    ...input.graph.edges.map((item) => ({ source: item.eventId, target: item.entityId })),
    ...input.graph.chunkEventEdges.map((item) => ({ source: item.chunkId, target: item.eventId }))
  ].filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target));
  const prioritizedLinks = links.length > linkLimit ? [...links].sort((left, right) =>
    Number(input.priority.has(right.source) || input.priority.has(right.target)) -
    Number(input.priority.has(left.source) || input.priority.has(left.target))
  ) : links;
  return {
    nodes,
    links: prioritizedLinks.slice(0, linkLimit),
    cropped: candidates.length > nodes.length || links.length > linkLimit
  };
}

export type UniversePosition = { x: number; y: number; z: number };
const goldenAngle = Math.PI * (3 - Math.sqrt(5));

export function layoutUniverse(nodes: SceneNode[], links: SceneLink[]) {
  const positions = new Map<string, UniversePosition>();
  const adjacent = new Map<string, string[]>();
  for (const link of links) {
    adjacent.set(link.source, [...(adjacent.get(link.source) ?? []), link.target]);
    adjacent.set(link.target, [...(adjacent.get(link.target) ?? []), link.source]);
  }
  const counts = new Map<string, number>();
  for (const kind of ["chunk", "event", "entity"] as const) {
    for (const node of nodes.filter((entry) => entry.kind === kind)) {
      const neighbours = (adjacent.get(node.id) ?? []).filter((id) => positions.has(id));
      const anchorId = neighbours[0] ?? kind;
      const anchor = positions.get(anchorId) ?? { x: 0, y: 0, z: 0 };
      const index = counts.get(anchorId) ?? 0;
      counts.set(anchorId, index + 1);
      const phase = Array.from(anchorId).reduce((sum, letter) => sum + letter.charCodeAt(0), 0) / 30;
      const angle = phase + index * goldenAngle;
      const spacing = neighbours.length ? (kind === "event" ? 37 : 27) : 68;
      const radius = spacing * Math.sqrt(index + 0.6);
      positions.set(node.id, {
        x: anchor.x + Math.cos(angle) * radius,
        y: anchor.y + Math.sin(angle) * radius * 0.74,
        z: anchor.z + Math.sin(angle * 1.7) * Math.min(radius * 0.36, 36),
      });
    }
  }
  return positions;
}
