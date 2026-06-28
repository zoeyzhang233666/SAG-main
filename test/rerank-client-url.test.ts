import { describe, expect, it } from "vitest";
import { buildRerankUrl } from "../src/ai/rerank-client.js";

describe("buildRerankUrl", () => {
  it("derives rerank endpoint from a full chat completions URL", () => {
    expect(buildRerankUrl("https://apihub.chem-cloud.cn/v1/chat/completions"))
      .toBe("https://apihub.chem-cloud.cn/v1/reranks");
  });

  it("supports API roots and explicit rerank endpoints", () => {
    expect(buildRerankUrl("https://api.example.com/v1"))
      .toBe("https://api.example.com/v1/reranks");
    expect(buildRerankUrl("https://api.example.com/openai/v1/chat/completions/"))
      .toBe("https://api.example.com/openai/v1/reranks");
    expect(buildRerankUrl("https://api.example.com/v1/reranks"))
      .toBe("https://api.example.com/v1/reranks");
  });
});
