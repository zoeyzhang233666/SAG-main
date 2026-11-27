import { describe, expect, it, vi } from "vitest";
import { ModelHttpError, structuredCompletion } from "../src/ai/structured-output.js";

describe("structured output compatibility", () => {
  it("downgrades unsupported formats and remembers successful capabilities", async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(new ModelHttpError(400, "json_schema is unsupported"))
      .mockRejectedValueOnce(new ModelHttpError(422, "response_format json_object not supported"))
      .mockResolvedValue('{"action":"final"}');
    const input = { mode: "auto" as const, capabilityKey: "fixture-a", schema: { type: "object" }, call, parse: JSON.parse };
    expect(await structuredCompletion(input)).toEqual({ action: "final" });
    expect(call.mock.calls.map((args) => args[1])).toEqual(["json_schema", "json_object", "prompt_only"]);
    await structuredCompletion(input);
    expect(call.mock.calls.at(-1)).toEqual([undefined, "prompt_only"]);
  });

  it("keeps authorization errors and explicit formats single-attempt", async () => {
    const denied = new ModelHttpError(401, "unauthorized");
    const call = vi.fn().mockRejectedValue(denied);
    await expect(structuredCompletion({ mode: "auto", capabilityKey: "fixture-b", schema: {}, call, parse: JSON.parse }))
      .rejects.toBe(denied);
    expect(call).toHaveBeenCalledTimes(1);
    const incompatible = vi.fn().mockRejectedValue(new ModelHttpError(400, "response_format is unsupported"));
    await expect(structuredCompletion({ mode: "json_object", capabilityKey: "fixture-c", call: incompatible, parse: JSON.parse }))
      .rejects.toThrow("unsupported");
    expect(incompatible).toHaveBeenCalledTimes(1);
  });
});
