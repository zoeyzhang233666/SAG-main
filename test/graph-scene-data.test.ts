import { expect, it } from "vitest";
import { buildSceneData, type SceneNode } from "../web/src/lib/graph-scene-data.js";

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
  expect(data.nodes[0]?.id).toBe("121");
  expect(data.links).toEqual([{ source: "0", target: "121" }]);
  expect(data.cropped).toBe(true);
  expect(nodes[0]?.id).toBe("0");
});
