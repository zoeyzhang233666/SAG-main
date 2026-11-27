import { expect, it } from "vitest";
import { composeExplorationScope, readAnswerEvidence } from "../web/src/lib/exploration-evidence.js";

it("combines successive verified evidence snapshots and rejects other projects", () => {
  const projectId = "01956639-9af8-717a-8f6a-f94f95cfce77";
  const old = "01956639-9af8-717a-8f6a-f94f95cfce78";
  const fresh = "01956639-9af8-717a-8f6a-f94f95cfce79";
  const first = { version: 1 as const, projectId, chunkIds: [old], eventIds: [old], entityIds: [], citations: [] };
  const next = { ...first, chunkIds: [fresh, old], eventIds: [fresh] };
  expect(readAnswerEvidence(first, fresh)).toBeNull();
  expect(readAnswerEvidence({ ...first, eventIds: ["invented"] }, projectId)).toBeNull();
  expect(composeExplorationScope([first, next])).toEqual({ chunkIds: [fresh, old], eventIds: [fresh, old], entityIds: [] });
});
