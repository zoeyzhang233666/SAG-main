import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeSettings = vi.hoisted(() => ({
  current: {
    embeddingBaseUrl: "https://api.siliconflow.cn/v1",
    embeddingModel: "BAAI/bge-m3",
    embeddingDimensions: 1024,
    embeddingApiKey: "embedding-key",
    hasRemoteEmbedding: true,
    llmBaseUrl: "https://api.modelarts-maas.com/openai/v1",
    llmModel: "glm-test",
    llmApiKey: "llm-key",
    hasRemoteLlm: true,
    llmTimeoutMs: 60_000,
    llmMaxRetries: 1,
    defaultSearchMode: "fast" as const,
    defaultSearchTopK: 10,
    defaultChunkingMode: "heading_strict" as const,
    chunkTokenLimit: 512,
    chunkOverlapTokens: 100,
    answerSystemPrompt: "",
    mermaidTemplate: "",
    mermaidPendingText: "",
    mcpSearchMode: "fast" as const,
    graphDefaultLayoutStyle: "force",
    welcomePromptTemplates: [],
    longTermMemoryEnabled: false
  }
}));

vi.mock("../src/config/env.js", () => ({
  config: {
    RERANK_MODEL: "BAAI/bge-reranker-v2-m3",
    RERANK_API_KEY: "rerank-key",
    RERANK_BASE_URL: "https://api.siliconflow.cn/v1",
    RERANK_INSTRUCT: "rank"
  }
}));

vi.mock("../src/services/ai-settings-service.js", () => ({
  aiSettingsService: {
    getRuntimeSettings: vi.fn(async () => runtimeSettings.current)
  }
}));

import { QwenRerankClient } from "../src/ai/rerank-client.js";
import { listModelCallLogs } from "../src/observability/model-call-log.js";

const candidates = [
  {
    id: "event-1",
    sourceId: "source-1",
    documentId: "document-1",
    chunkId: "chunk-1",
    title: "聚酯产业链",
    summary: "PTA 和乙二醇生产聚酯",
    content: "聚酯用于纤维、瓶片和薄膜。",
    rank: 0,
    score: 0.8
  }
];

describe("QwenRerankClient network resilience", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    runtimeSettings.current = { ...runtimeSettings.current, llmMaxRetries: 1 };
  });

  it("retries a transient fetch failure before using the remote result", async () => {
    const cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          results: [{ index: 0, relevance_score: 0.91 }]
        })
      } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const client = new QwenRerankClient();
    await expect(client.rerankEvents({
      query: "聚酯产业链",
      candidates,
      topK: 1
    })).resolves.toEqual(["event-1"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records an explicit local fallback when the remote reranker stays unavailable", async () => {
    runtimeSettings.current = { ...runtimeSettings.current, llmMaxRetries: 0 };
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" })
      });
    }));
    const before = listModelCallLogs().latestSequence;

    const client = new QwenRerankClient();
    const ids = await client.rerankEvents({
      query: "聚酯产业链",
      candidates,
      topK: 1
    });

    expect(ids).toEqual(["event-1"]);
    const logs = listModelCallLogs(before).logs;
    expect(logs.find((log) => log.operation === "rerankEvents.qwen3Rerank")?.error)
      .toContain("ECONNREFUSED");
    expect(logs.find((log) => log.operation === "rerankEvents.localFallback")?.status)
      .toBe("SUCCEEDED");
  });
});
