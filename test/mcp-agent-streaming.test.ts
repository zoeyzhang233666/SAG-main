import { afterEach, describe, expect, it, vi } from "vitest";
import { listModelCallLogs } from "../src/observability/model-call-log.js";
import { __mcpAgentTestUtils } from "../src/services/mcp-agent-service.js";
import type { AiRuntimeSettings } from "../src/services/ai-settings-service.js";
import type { McpSessionRecord } from "../src/types.js";

const encoder = new TextEncoder();

const baseSettings: AiRuntimeSettings = {
  embeddingBaseUrl: "https://example.test/v1",
  embeddingModel: "embedding-test",
  embeddingDimensions: 1024,
  embeddingApiKey: "test-key",
  hasRemoteEmbedding: true,
  llmBaseUrl: "https://example.test/v1",
  llmModel: "llm-test",
  llmApiKey: "test-key",
  hasRemoteLlm: true,
  llmTimeoutMs: 1_000,
  llmMaxRetries: 0,
  defaultSearchMode: "fast",
  defaultSearchTopK: 10,
  defaultChunkingMode: "heading_strict",
  chunkTokenLimit: 512,
  chunkOverlapTokens: 100,
  answerSystemPrompt: "Answer from evidence.",
  mcpSearchMode: "fast",
  graphDefaultLayoutStyle: "force",
  welcomePromptTemplates: [],
  longTermMemoryEnabled: false
};

const session: McpSessionRecord = {
  id: "session-test",
  tenantId: "tenant-test",
  title: "Test",
  status: "ACTIVE",
  model: "llm-test",
  sourceIds: ["source-test"],
  metadata: {},
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MCP final-answer streaming", () => {
  it("uses an idle timeout that resets on every chunk instead of an absolute request timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => scheduledSseResponse([
      { at: 20, frame: deltaFrame("A") },
      { at: 40, frame: deltaFrame("B") },
      { at: 60, frame: deltaFrame("C") },
      { at: 80, frame: `${finishFrame("stop")}data: [DONE]\n\n`, close: true }
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const resultPromise = __mcpAgentTestUtils.streamChatCompletionText({
      settings: { ...baseSettings, llmTimeoutMs: 30 },
      url: "https://example.test/v1/chat/completions",
      body: { model: "llm-test", messages: [] },
      operation: "test.mcp.idle-reset",
      totalTimeoutMs: 200,
      emit: (event) => {
        if (event.type === "assistant_delta") deltas.push(event.delta);
      }
    });

    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: "ABC", streamed: true, finishReason: "stop" });
    expect(deltas.join("")).toBe("ABC");
  });

  it("keeps a separate total deadline even while chunks continue to arrive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => scheduledSseResponse([
      { at: 20, frame: deltaFrame("A") },
      { at: 40, frame: deltaFrame("B") },
      { at: 60, frame: deltaFrame("C") },
      { at: 80, frame: deltaFrame("D") }
    ])));

    const errorPromise = __mcpAgentTestUtils.streamChatCompletionText({
      settings: { ...baseSettings, llmTimeoutMs: 35 },
      url: "https://example.test/v1/chat/completions",
      body: { model: "llm-test", messages: [] },
      operation: "test.mcp.total-timeout",
      totalTimeoutMs: 75
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(90);
    const error = await errorPromise;

    expect(error).toMatchObject({
      name: "LlmStreamInterruptedError",
      partialText: "ABC",
      reasonCode: "total_timeout",
      timeoutKind: "total"
    });
    expect(__mcpAgentTestUtils.resolveStreamTotalTimeoutMs(100_000)).toBe(300_000);
  });

  it("preserves partial text, appends a visible warning, and logs a partial summary on abnormal EOF", async () => {
    const before = listModelCallLogs(0).latestSequence;
    const fetchMock = vi.fn(async () => immediateSseResponse([
      deltaFrame("已经生成的回答")
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const visibleDeltas: string[] = [];

    const result = await __mcpAgentTestUtils.synthesizeFinalAnswer({
      userContent: "请回答这个问题",
      session,
      history: [],
      settings: baseSettings,
      observations: [],
      emit: (event) => {
        if (event.type === "assistant_delta") visibleDeltas.push(event.delta);
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.generationIncomplete).toBe(true);
    expect(result.incompleteReason).toBe("unexpected_eof");
    expect(result.text).toContain("已经生成的回答");
    expect(result.text).toContain("生成中断");
    expect(visibleDeltas.join("")).toBe(result.text);

    const metadata = __mcpAgentTestUtils.buildAssistantMessageMetadata([], result);
    expect(metadata).toMatchObject({
      generationIncomplete: true,
      generationIncompleteReason: "unexpected_eof"
    });

    const log = listModelCallLogs(before).logs.find(
      (item) => item.operation === "mcp.synthesizeFinalAnswer.stream"
    );
    expect(log?.status).toBe("FAILED");
    expect(log?.response).toMatchObject({
      partial: true,
      partialChars: "已经生成的回答".length,
      doneReceived: false
    });
  });

  it("treats finish_reason=length as incomplete and never replaces its partial answer", async () => {
    const fetchMock = vi.fn(async () => immediateSseResponse([
      `${deltaFrame("模型回答前半段")}data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n`
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const visibleDeltas: string[] = [];

    const result = await __mcpAgentTestUtils.synthesizeFinalAnswer({
      userContent: "继续说明",
      session,
      history: [],
      settings: baseSettings,
      observations: [],
      emit: (event) => {
        if (event.type === "assistant_delta") visibleDeltas.push(event.delta);
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      streamed: true,
      generationIncomplete: true,
      incompleteReason: "finish_reason_length",
      finishReason: "length"
    });
    expect(result.text).not.toContain("我已经检索到相关项目证据");
    expect(visibleDeltas.join("")).toBe(result.text);
  });

  it("still aborts immediately when the user cancels after partial output", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => scheduledSseResponse([
      { at: 10, frame: deltaFrame("partial") }
    ])));
    const controller = new AbortController();
    const resultPromise = __mcpAgentTestUtils.synthesizeFinalAnswer({
      userContent: "cancel this",
      session,
      history: [],
      settings: baseSettings,
      observations: [],
      signal: controller.signal
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(15);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    const error = await resultPromise;

    expect(error).toMatchObject({ name: "AbortError" });
  });
});

describe("MCP final-answer prompt compaction", () => {
  it("keeps citation evidence once, budgets history, and diversifies documents", () => {
    const sections = [
      citationSection("a1", "doc-a", "EVIDENCE_A1"),
      citationSection("a2", "doc-a", "EVIDENCE_A2"),
      citationSection("a3", "doc-a", "EVIDENCE_A3"),
      citationSection("b1", "doc-b", "EVIDENCE_B1"),
      citationSection("b2", "doc-b", "EVIDENCE_B2"),
      citationSection("c1", "doc-c", "EVIDENCE_C1")
    ];
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}-`.repeat(1_800)
    }));
    const messages = __mcpAgentTestUtils.buildFinalAnswerMessages({
      userContent: "question",
      session,
      history,
      settings: baseSettings,
      observations: [{
        toolName: "sag_search",
        result: {
          content: [{ type: "text", text: JSON.stringify({ traceId: "trace", sections }) }]
        }
      }],
    });
    const payload = JSON.parse(messages[1].content) as {
      recent_messages: Array<{ role: string; content: string }>;
      citation_sources: Array<{ documentId?: string; content: string }>;
      tool_observations: Array<{ sections?: Array<{ content?: string; citationIndex?: number }> }>;
    };

    expect(payload.citation_sources).toHaveLength(5);
    expect(payload.citation_sources.map((item) => item.documentId)).toEqual([
      "doc-a",
      "doc-a",
      "doc-b",
      "doc-b",
      "doc-c"
    ]);
    expect(payload.citation_sources[0]?.content).toBe("EVIDENCE_A1");
    expect(payload.tool_observations[0]?.sections?.every((section) => section.content == null)).toBe(true);
    expect(messages[1].content.match(/EVIDENCE_A1/g)).toHaveLength(1);
    expect(payload.recent_messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(6_000);
    expect(payload.recent_messages.at(-1)?.content).toContain("7-");
  });

  it("backfills to five results when only one document is available", () => {
    const selected = __mcpAgentTestUtils.selectDiverseCitationSections(
      Array.from({ length: 6 }, (_, index) => ({
        chunkId: `chunk-${index}`,
        documentId: "one-document"
      }))
    );

    expect(selected.map((item) => item.chunkId)).toEqual([
      "chunk-0",
      "chunk-1",
      "chunk-2",
      "chunk-3",
      "chunk-4"
    ]);
  });
});

function deltaFrame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
}

function finishFrame(reason: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;
}

function immediateSseResponse(frames: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    }
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

function scheduledSseResponse(
  schedule: Array<{ at: number; frame: string; close?: boolean }>
): Response {
  let cancelled = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of schedule) {
        timers.push(setTimeout(() => {
          if (cancelled) return;
          controller.enqueue(encoder.encode(item.frame));
          if (item.close) controller.close();
        }, item.at));
      }
    },
    cancel() {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    }
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

function citationSection(chunkId: string, documentId: string, content: string) {
  return {
    chunkId,
    sourceId: "source-test",
    documentId,
    heading: `Heading ${chunkId}`,
    content,
    rank: 1,
    score: 0.9
  };
}
