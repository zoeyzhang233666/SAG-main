import { expect, it } from "vitest";
import { buildSceneData, layoutUniverse, type SceneNode } from "../web/src/lib/graph-scene-data.js";

it("prioritizes focused 3D nodes and only emits real links between visible nodes", () => {
  const nodes: SceneNode[] = Array.from({ length: 122 }, (_, index) => ({
    id: String(index), label: String(index), kind: index ? "entity" : "event"
  }));
  const data = buildSceneData({
    nodes,
    compact: true,
    priority: new Set(["121"]),
    graph: {
      edges: [{ eventId: "0", entityId: "121" }, { eventId: "0", entityId: "120" }],
      chunkEventEdges: [{ chunkId: "missing", eventId: "0" }]
    }
  });
  expect(data.nodes).toHaveLength(120);
  expect(data.nodes.at(-1)?.id).toBe("121");
  expect(data.links).toEqual([{ source: "0", target: "121" }]);
  expect(data.cropped).toBe(true);
  expect(nodes[0]?.id).toBe("0");
});

it("keeps only actual neighbours of the selected event category in the star scene", () => {
  const nodes: SceneNode[] = [
    { id: "a", label: "Event A", kind: "event", category: "Process" },
    { id: "b", label: "Event B", kind: "event", category: "Market" },
    { id: "c", label: "Entity C", kind: "entity" },
    { id: "d", label: "Chunk D", kind: "chunk" },
    { id: "e", label: "Entity E", kind: "entity" }
  ];
  const scene = buildSceneData({
    nodes, compact: true, priority: new Set(["b"]), category: "Process",
    graph: {
      edges: [{ eventId: "a", entityId: "c" }, { eventId: "b", entityId: "e" }],
      chunkEventEdges: [{ eventId: "a", chunkId: "d" }]
    }
  });
  expect(scene.nodes.map(({ id }) => id)).toEqual(["a", "c", "d"]);
  expect(scene.links).toEqual([{ source: "a", target: "c" }, { source: "d", target: "a" }]);
  const positions = layoutUniverse(scene.nodes, scene.links);
  expect(positions).toEqual(layoutUniverse(scene.nodes, scene.links));
  expect(positions.get("b")).toBeUndefined();
  expect(positions.get("a")).not.toEqual(positions.get("c"));
});
