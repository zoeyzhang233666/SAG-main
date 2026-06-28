import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config/env.js";
import {
  addMcpMessage,
  addMcpToolCall,
  clearMcpSession,
  createMcpSession,
  deleteMcpSession,
  getMcpSessionDetail,
  listMcpSessions,
  updateMcpSessionMetadata,
  updateMcpSessionTitle
} from "../db/repositories.js";
import type { McpSessionRecord, McpToolCallRecord } from "../types.js";
import type { SearchProgressEvent } from "../types.js";
import { aiSettingsService, type AiRuntimeSettings } from "./ai-settings-service.js";
import { createModelCallLogger, importModelCallLog, type ModelCallLogRecord } from "../observability/model-call-log.js";
import { defaultMcpSessionTitle, summarizeConversationTitle } from "./mcp-title.js";

type ToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type ToolAction = {
  action: "call_tool" | "final";
  toolName?: string;
  arguments?: Record<string, unknown>;
  final?: string;
};

type AnswerCitation = {
  index: number;
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank?: number;
  score?: number;
  query?: string;
  toolCallId?: string;
};

type AssistantGenerationResult = {
  text: string;
  streamed: boolean;
};

export type McpRunStreamEvent =
  | { type: "stage"; label: string; detail?: string }
  | { type: "message"; message: { id: string; sessionId: string; role: string; content: string; metadata: Record<string, unknown>; createdAt: string } }
  | { type: "assistant_delta"; delta: string }
  | { type: "tool_start"; toolName: string; arguments: Record<string, unknown> }
  | { type: "search_progress"; event: SearchProgressEvent }
  | { type: "tool_end"; toolCall: McpToolCallRecord }
  | { type: "done"; detail: Awaited<ReturnType<typeof getMcpSessionDetail>> }
  | { type: "error"; message: string };

type StreamEmitter = (event: McpRunStreamEvent) => void;

export class McpAgentService {
  async createSession(input: {
    title?: string;
    sourceIds?: string[];
  }, tenantId = config.DEFAULT_TENANT_ID): Promise<McpSessionRecord> {
    const settings = await aiSettingsService.getRuntimeSettings();
    const title = input.title?.trim();
    const inheritedMemory = settings.longTermMemoryEnabled
      ? await loadLatestProjectMemory(input.sourceIds?.[0], tenantId)
      : null;
    return createMcpSession({
      tenantId,
      title: title || defaultMcpSessionTitle(),
      model: settings.hasRemoteLlm ? settings.llmModel : "local-rule-fallback",
      sourceIds: input.sourceIds ?? [],
      metadata: {
        createdVia: "webui",
        autoTitle: !title,
        ...(inheritedMemory ? { longTermMemory: inheritedMemory } : {})
      }
    });
  }

  async listSessions(input: { sourceId?: string } = {}, tenantId = config.DEFAULT_TENANT_ID) {
    return listMcpSessions({
      tenantId,
      limit: 50,
      sourceId: input.sourceId
    });
  }

  async getSession(sessionId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getMcpSessionDetail({ sessionId, tenantId });
  }

  async clearSession(sessionId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const cleared = await clearMcpSession({ sessionId, tenantId });
    if (!cleared) {
      return null;
    }
    return getMcpSessionDetail({ sessionId, tenantId });
  }

  async deleteSession(sessionId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteMcpSession({ sessionId, tenantId });
    if (!deleted) {
      return null;
    }
    return { deleted: true };
  }

  async runUserMessage(input: {
    sessionId: string;
    content: string;
    autoMermaid?: boolean;
    signal?: AbortSignal;
  }, tenantId = config.DEFAULT_TENANT_ID, emit?: StreamEmitter) {
    assertNotAborted(input.signal);
    emit?.({ type: "stage", label: "加载会话", detail: "正在读取当前 MCP 会话上下文" });
    const detail = await getMcpSessionDetail({
      sessionId: input.sessionId,
      tenantId
    });
    assertNotAborted(input.signal);
    if (!detail) {
      throw new Error("MCP 会话不存在");
    }

    const userMessage = await addMcpMessage({
      sessionId: input.sessionId,
      role: "user",
      content: input.content
    });
    let activeSession = detail.session;
    if (shouldAutoTitleSession(detail.session, detail.messages)) {
      const updatedSession = await updateMcpSessionTitle({
        sessionId: input.sessionId,
        tenantId,
        title: summarizeConversationTitle(input.content),
        metadata: {
          autoTitle: true,
          titledFromMessageId: userMessage.id
        }
      });
      if (updatedSession) {
        activeSession = updatedSession;
      }
    }
    assertNotAborted(input.signal);
    emit?.({ type: "message", message: userMessage });
    emit?.({ type: "stage", label: "连接 MCP", detail: "正在启动 MCP 客户端并发现可用工具" });

    const projectId = activeSession.sourceIds[0];
    if (!projectId) {
      throw new Error("MCP 会话缺少项目 ID，请先在项目下新建会话。");
    }
    const runner = await this.createRunner(projectId, input.signal);
    const toolCalls: McpToolCallRecord[] = [];
    let assistantResult: AssistantGenerationResult = { text: "", streamed: false };
    let runtimeSettings: AiRuntimeSettings | null = null;
    try {
      assertNotAborted(input.signal);
      const toolsResult = await runner.client.listTools(undefined, { signal: input.signal });
      const tools = toolsResult.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }));
      assertNotAborted(input.signal);
      emit?.({ type: "stage", label: "工具发现", detail: `发现 ${tools.length} 个 MCP 工具` });
      const settings = await aiSettingsService.getRuntimeSettings();
      runtimeSettings = settings;
      assertNotAborted(input.signal);

      if (!settings.hasRemoteLlm) {
        assistantResult = {
          text: await this.runFallbackToolFlow({
            runner,
            session: activeSession,
            messageId: userMessage.id,
            userContent: input.content,
            mcpSearchMode: settings.mcpSearchMode,
            toolCalls,
            signal: input.signal,
            emit
          }),
          streamed: false
        };
      } else {
        try {
          assistantResult = await this.runLlmToolFlow({
            runner,
            session: activeSession,
            messageId: userMessage.id,
            history: detail.messages,
            settings,
            tools,
            userContent: input.content,
            autoMermaid: input.autoMermaid ?? false,
            toolCalls,
            signal: input.signal,
            emit
          });
        } catch {
          if (toolCalls.some((toolCall) => toolCall.status === "SUCCEEDED")) {
            emit?.({ type: "stage", label: "保留检索结果", detail: "上游模型未完成最终组织，正在返回已检索到的证据" });
            assistantResult = { text: buildEvidenceFallbackAnswer(toolCalls), streamed: false };
          } else {
            emit?.({ type: "stage", label: "切换本地检索", detail: "远程 LLM 不可用，已自动改用本地规则" });
            assistantResult = {
              text: await this.runFallbackToolFlow({
                runner,
                session: activeSession,
                messageId: userMessage.id,
                userContent: input.content,
                mcpSearchMode: settings.mcpSearchMode,
                toolCalls,
                signal: input.signal,
                emit
              }),
              streamed: false
            };
          }
        }
      }
    } finally {
      await runner.close();
    }

    assertNotAborted(input.signal);
    const answerCitations = collectAnswerCitations(toolCalls);
    const assistantContent = assistantResult.text || "已完成工具调用。";
    if (!assistantResult.streamed) {
      for (const delta of chunkText(assistantContent, 24)) {
        assertNotAborted(input.signal);
        emit?.({ type: "assistant_delta", delta });
        await sleep(12);
      }
    }
    assertNotAborted(input.signal);
    const assistant = await addMcpMessage({
      sessionId: input.sessionId,
      role: "assistant",
      content: assistantContent,
      metadata: answerCitations.length > 0 ? { citations: answerCitations } : undefined
    });
    emit?.({ type: "message", message: assistant });

    if (runtimeSettings?.longTermMemoryEnabled) {
      await updateSessionLongTermMemory({
        sessionId: input.sessionId,
        tenantId,
        existingMetadata: activeSession.metadata,
        userContent: input.content,
        assistantContent
      });
    }

    assertNotAborted(input.signal);
    const updatedDetail = await getMcpSessionDetail({
      sessionId: input.sessionId,
      tenantId
    });
    emit?.({ type: "done", detail: updatedDetail });

    return {
      session: activeSession,
      assistant,
      toolCalls,
      detail: updatedDetail
    };
  }

  private async createRunner(projectId: string, signal?: AbortSignal) {
    const client = new Client({
      name: "sag-webui",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      ...resolveMcpServerCommand(),
      env: childEnv(projectId),
      stderr: "pipe"
    });
    try {
      await client.connect(transport, { signal });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    return {
      client,
      close: async () => {
        await transport.close();
      }
    };
  }

  private async runFallbackToolFlow(input: {
    runner: Awaited<ReturnType<McpAgentService["createRunner"]>>;
    session: McpSessionRecord;
    messageId: string;
    userContent: string;
    mcpSearchMode: "standard" | "fast";
    toolCalls: McpToolCallRecord[];
    signal?: AbortSignal;
    emit?: StreamEmitter;
  }): Promise<string> {
    const lower = input.userContent.toLowerCase();
    let finalText = "";

    const eventId = input.userContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    const isEventLookup = /event|事件/.test(lower) && Boolean(eventId);
    if (!isEventLookup || /search|检索|搜索|查找/.test(lower)) {
      assertNotAborted(input.signal);
      const args = {
        query: input.userContent,
        strategy: "multi",
        searchMode: input.mcpSearchMode,
        returnTrace: true
      };
      input.emit?.({ type: "tool_start", toolName: "sag_search", arguments: args });
      const call = await this.callToolAndPersist(input.runner, input.session.id, "sag_search", args, input.messageId, input.signal, input.emit);
      input.toolCalls.push(call);
      input.emit?.({ type: "tool_end", toolCall: call });
      finalText = buildLocalSearchAnswer(call);
    }

    if (/event|事件/.test(lower) && eventId) {
      assertNotAborted(input.signal);
      const args = { eventId };
      input.emit?.({ type: "tool_start", toolName: "sag_get_event", arguments: args });
      const call = await this.callToolAndPersist(input.runner, input.session.id, "sag_get_event", args, input.messageId, input.signal, input.emit);
      input.toolCalls.push(call);
      input.emit?.({ type: "tool_end", toolCall: call });
      finalText = "已通过 MCP 调用 sag_get_event 查询事件详情。";
    }

    return finalText || "未配置可用的 LLM API。当前本地模式可以检索并返回相关原文，但不能像大模型一样综合推理和改写答案。";
  }

  private async runLlmToolFlow(input: {
    runner: Awaited<ReturnType<McpAgentService["createRunner"]>>;
    session: McpSessionRecord;
    messageId: string;
    history: Array<{ role: string; content: string }>;
    settings: AiRuntimeSettings;
    tools: ToolInfo[];
    userContent: string;
    autoMermaid: boolean;
    toolCalls: McpToolCallRecord[];
    signal?: AbortSignal;
    emit?: StreamEmitter;
  }): Promise<AssistantGenerationResult> {
    let finalText = "";
    const observations: Array<{ toolName: string; result: unknown; error?: string | null }> = [];
    for (let step = 0; step < 6; step += 1) {
      assertNotAborted(input.signal);
      input.emit?.({ type: "stage", label: `LLM 规划 ${step + 1}`, detail: "正在决定下一步 MCP 工具调用" });
      const action = await planToolAction({
        userContent: input.userContent,
        session: input.session,
        history: input.history,
        settings: input.settings,
        tools: input.tools,
        observations,
        autoMermaid: input.autoMermaid,
        signal: input.signal
      });
      assertNotAborted(input.signal);
      if (action.action === "final") {
        const candidate = action.final?.trim() ?? "";
        if (!isToolOnlyPlaceholder(candidate)) {
          finalText = candidate;
        }
        break;
      }
      if (!action.toolName || !input.tools.some((tool) => tool.name === action.toolName)) {
        finalText = "LLM 选择了不存在的工具，已停止本轮调用。";
        break;
      }
      const toolArguments = normalizeToolArguments(action.toolName, action.arguments ?? {}, input.settings.mcpSearchMode);
      input.emit?.({ type: "tool_start", toolName: action.toolName, arguments: toolArguments });
      const call = await this.callToolAndPersist(
        input.runner,
        input.session.id,
        action.toolName,
        toolArguments,
        input.messageId,
        input.signal,
        input.emit
      );
      assertNotAborted(input.signal);
      input.toolCalls.push(call);
      input.emit?.({ type: "tool_end", toolCall: call });
      observations.push({
        toolName: action.toolName,
        result: call.result,
        error: call.error
      });
      if (call.status === "FAILED") {
        finalText = `工具 ${action.toolName} 调用失败：${call.error ?? "未知错误"}`;
        break;
      }
      break;
    }
    if (!finalText && observations.length > 0) {
      input.emit?.({ type: "stage", label: "生成最终回答", detail: "正在根据 MCP 检索结果组织答案" });
      try {
        const generated = await synthesizeFinalAnswer({
          userContent: input.userContent,
          session: input.session,
          history: input.history,
          settings: input.settings,
          observations,
          autoMermaid: input.autoMermaid,
          signal: input.signal,
          emit: input.emit
        });
        const candidate = generated.text.trim();
        if (!isToolOnlyPlaceholder(candidate)) {
          return generated;
        }
      } catch {
        // The retrieved evidence is still useful when a slow or incompatible
        // upstream model fails during the final synthesis request.
      }
    }
    return {
      text: finalText || buildEvidenceFallbackAnswer(input.toolCalls),
      streamed: false
    };
  }

  private async callToolAndPersist(
    runner: Awaited<ReturnType<McpAgentService["createRunner"]>>,
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    messageId?: string,
    signal?: AbortSignal,
    emit?: StreamEmitter
  ): Promise<McpToolCallRecord> {
    const started = performance.now();
    try {
      assertNotAborted(signal);
      const result = await runner.client.callTool(
        {
          name: toolName,
          arguments: args
        },
        undefined,
        {
          timeout: config.MCP_TOOL_TIMEOUT_MS,
          signal,
          resetTimeoutOnProgress: true,
          onprogress: (progress) => {
            const modelLog = parseModelCallLogProgress(progress.message);
            if (modelLog) {
              importModelCallLog(modelLog);
            }
            if (toolName === "sag_search" || toolName === "sag_explain_search") {
              const event = parseSearchProgress(progress.message);
              if (event) {
                emit?.({ type: "search_progress", event });
              }
            }
          }
        }
      );
      assertNotAborted(signal);
      return addMcpToolCall({
        sessionId,
        messageId,
        toolName,
        arguments: args,
        result,
        status: result.isError ? "FAILED" : "SUCCEEDED",
        durationMs: Math.round(performance.now() - started),
        error: result.isError ? extractToolText(result) : null
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new McpRunAbortedError();
      }
      return addMcpToolCall({
        sessionId,
        messageId,
        toolName,
        arguments: args,
        result: null,
        status: "FAILED",
        durationMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

class McpRunAbortedError extends Error {
  constructor() {
    super("MCP 对话已停止");
    this.name = "AbortError";
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new McpRunAbortedError();
  }
}

function normalizeToolArguments(toolName: string, args: Record<string, unknown>, defaultSearchMode: "standard" | "fast"): Record<string, unknown> {
  const scopedArgs = { ...args };
  delete scopedArgs.sourceId;
  delete scopedArgs.sourceIds;
  delete scopedArgs.projectId;
  delete scopedArgs.projectIds;
  if (toolName !== "sag_search" && toolName !== "sag_explain_search") {
    return scopedArgs;
  }
  const strategy = scopedArgs.strategy === "vector" || scopedArgs.strategy === "multi"
    ? scopedArgs.strategy
    : "multi";
  const normalized: Record<string, unknown> = {
    ...scopedArgs,
    strategy,
    returnTrace: true,
    searchMode: scopedArgs.searchMode === "standard" || scopedArgs.searchMode === "fast"
      ? scopedArgs.searchMode
      : defaultSearchMode
  };
  return normalized;
}

function shouldAutoTitleSession(session: McpSessionRecord, messages: Array<{ role: string }>): boolean {
  if (messages.some((message) => message.role === "user")) {
    return false;
  }
  if (session.metadata.autoTitle === false) {
    return false;
  }
  return session.metadata.autoTitle === true ||
    session.title === defaultMcpSessionTitle() ||
    session.title === "新 MCP 测试会话";
}

type LongTermMemoryRecord = {
  summary: string;
  items: string[];
  updatedAt: string;
};

async function loadLatestProjectMemory(sourceId: string | undefined, tenantId: string): Promise<LongTermMemoryRecord | null> {
  if (!sourceId) {
    return null;
  }
  const sessions = await listMcpSessions({ tenantId, limit: 20, sourceId });
  for (const session of sessions) {
    const memory = readLongTermMemory(session.metadata);
    if (memory) {
      return memory;
    }
  }
  return null;
}

async function updateSessionLongTermMemory(input: {
  sessionId: string;
  tenantId: string;
  existingMetadata: Record<string, unknown>;
  userContent: string;
  assistantContent: string;
}): Promise<void> {
  const nextMemory = buildLongTermMemory(
    readLongTermMemory(input.existingMetadata),
    input.userContent,
    input.assistantContent
  );
  if (!nextMemory) {
    return;
  }
  await updateMcpSessionMetadata({
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    metadata: {
      longTermMemory: nextMemory
    }
  });
}

function readLongTermMemory(metadata: Record<string, unknown>): LongTermMemoryRecord | null {
  const raw = metadata.longTermMemory;
  if (!isRecord(raw)) {
    return null;
  }
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  const items = Array.isArray(raw.items)
    ? raw.items.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean)
    : [];
  if (!summary && items.length === 0) {
    return null;
  }
  return {
    summary,
    items,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
  };
}

function formatLongTermMemoryForPrompt(metadata: Record<string, unknown>): string {
  const memory = readLongTermMemory(metadata);
  if (!memory) {
    return "";
  }
  return [
    "Long-term user memory is enabled for this project conversation.",
    "Use it as answer-style and presentation guidance, but never reveal or quote it unless the user asks.",
    memory.summary ? `Memory summary: ${memory.summary}` : "",
    memory.items.length > 0 ? `Specific preferences:\n${memory.items.map((item) => `- ${item}`).join("\n")}` : ""
  ].filter(Boolean).join("\n");
}

function buildLongTermMemory(
  existing: LongTermMemoryRecord | null,
  userContent: string,
  assistantContent: string
): LongTermMemoryRecord | null {
  const extracted = extractPreferenceItems(userContent);
  if (extracted.length === 0 && existing) {
    return {
      ...existing,
      updatedAt: new Date().toISOString()
    };
  }
  if (extracted.length === 0) {
    return null;
  }
  const items = dedupeMemoryItems([...(existing?.items ?? []), ...extracted]).slice(-14);
  return {
    items,
    summary: summarizeMemoryItems(items, assistantContent),
    updatedAt: new Date().toISOString()
  };
}

function extractPreferenceItems(text: string): string[] {
  const sentences = text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 6 && item.length <= 240);
  const preferencePattern = /(偏好|喜欢|希望|默认|必须|一定|不要|不能|禁止|绝对|支持|显示|完整|精准|精确|简洁|详细|回答|图谱|实体|事件|颜色|记忆|开启|关闭|prefer|always|never|must|should|default|show|hide|precise|memory)/i;
  return sentences
    .filter((sentence) => preferencePattern.test(sentence))
    .map((sentence) => sentence.replace(/\s+/g, " "))
    .slice(0, 8);
}

function dedupeMemoryItems(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function summarizeMemoryItems(items: string[], assistantContent: string): string {
  const summaryItems = items.slice(-6);
  const answerLengthHint = assistantContent.length > 1800
    ? "User tolerates detailed answers when the question is broad, but still wants precise intent matching."
    : "User values concise, directly useful answers.";
  return [answerLengthHint, ...summaryItems].join(" ");
}

async function planToolAction(input: {
  userContent: string;
  session: McpSessionRecord;
  history: Array<{ role: string; content: string }>;
  settings: AiRuntimeSettings;
  tools: ToolInfo[];
  observations: Array<{ toolName: string; result: unknown; error?: string | null }>;
  autoMermaid?: boolean;
  forceFinal?: boolean;
  signal?: AbortSignal;
}): Promise<ToolAction> {
  assertNotAborted(input.signal);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), input.settings.llmTimeoutMs);
  const url = buildChatCompletionsUrl(input.settings.llmBaseUrl);
  const body = {
    model: input.settings.llmModel,
    messages: [
      {
        role: "system",
        content: [
          "You are an intelligent MCP tool-calling agent for SAG.",
          input.forceFinal
            ? "Return JSON only. You MUST choose final now. Do not call another tool."
            : "Return JSON only. Choose either call_tool or final.",
          input.settings.longTermMemoryEnabled ? formatLongTermMemoryForPrompt(input.session.metadata) : "",
          "",
          "Before calling any tool, silently analyze the user's question:",
          "1. Identify the actual information need, not just the literal wording.",
          "2. Extract key entities, concepts, aliases, time ranges, document names, and constraints.",
          "3. Rewrite the user's question into a concise SAG search query that preserves the user's language.",
          "4. Prefer the rewritten search query over the raw user message when calling sag_search.",
          "5. If the question asks for comparison, cause/effect, architecture, process, evidence, or details from project documents, call sag_search first.",
          "6. If the user asks about a specific event id, call sag_get_event.",
          "7. The MCP server is already bound to the current project through startup configuration; never pass sourceId, sourceIds, projectId, or projectIds in tool arguments.",
          "",
          "When calling sag_search:",
          "- Set strategy to multi unless the user explicitly asks for pure vector retrieval.",
          `- Set searchMode to ${input.settings.mcpSearchMode} by default. Use the other mode only when the user explicitly asks for it.`,
          "- Set returnTrace to true.",
          "- Use a clear query field that reflects your analysis of the user's intent.",
          "- Do not invent project ids, source ids, eventIds, or facts.",
          "",
          "After observing SAG results, answer from retrieved evidence. If the retrieved evidence is insufficient, say so and optionally perform one more refined sag_search.",
          "When citation_sources are provided, cite important claims with [1], [2], [3] style markers that match citation_sources.index.",
          "Do not invent citation numbers. Do not cite a source that does not support the sentence.",
          input.autoMermaid
            ? [
                "At the bottom of the final answer, append one valid fenced ```mermaid diagram when the evidence contains industry-chain relationships.",
                "Use flowchart LR or flowchart TD, meaningful subgraph sections, classDef styles with several restrained colors, and quoted node labels when labels contain punctuation.",
                "Keep the Mermaid syntax conservative and valid. Do not use unsupported icons, HTML, click actions, or invented relationships.",
                "The narrative answer must come before the diagram; never return only a diagram."
              ].join("\n")
            : "Do not add a Mermaid diagram unless the user explicitly asks for one.",
          "Schema: {\"action\":\"call_tool\",\"toolName\":\"string\",\"arguments\":{}} or {\"action\":\"final\",\"final\":\"string\"}."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: input.userContent,
          session: {
            id: input.session.id,
            projectId: input.session.sourceIds[0] ?? null
          },
          recent_messages: input.history.slice(-10),
          available_tools: input.forceFinal ? [] : input.tools,
          observations: input.observations,
          citation_sources: collectCitationSourcesFromObservations(input.observations),
          auto_mermaid: input.autoMermaid ?? false
        })
      }
    ],
    temperature: 0.1
  };
  try {
    assertNotAborted(input.signal);
    const parsed = await requestChatJsonObject({
      settings: input.settings,
      url,
      body,
      operation: "mcp.planToolAction",
      signal: controller.signal
    });
    const action = normalizeToolAction(parsed);
    return action;
  } catch (error) {
    if (input.signal?.aborted) {
      throw new McpRunAbortedError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function synthesizeFinalAnswer(input: {
  userContent: string;
  session: McpSessionRecord;
  history: Array<{ role: string; content: string }>;
  settings: AiRuntimeSettings;
  observations: Array<{ toolName: string; result: unknown; error?: string | null }>;
  autoMermaid: boolean;
  signal?: AbortSignal;
  emit?: StreamEmitter;
}): Promise<AssistantGenerationResult> {
  assertNotAborted(input.signal);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), input.settings.llmTimeoutMs);
  const url = buildChatCompletionsUrl(input.settings.llmBaseUrl);
  const body = {
    model: input.settings.llmModel,
    messages: buildFinalAnswerMessages(input),
    temperature: 0.2
  };
  try {
    const streamed = await streamChatCompletionText({
      settings: input.settings,
      url,
      body,
      operation: "mcp.synthesizeFinalAnswer.stream",
      signal: controller.signal,
      emit: input.emit
    });
    if (streamed.text.trim()) {
      return streamed;
    }
    throw new Error("LLM 流式最终回答为空");
  } catch (error) {
    if (input.signal?.aborted) {
      throw new McpRunAbortedError();
    }
    if (controller.signal.aborted) {
      throw error;
    }
    input.emit?.({ type: "stage", label: "切换普通生成", detail: "流式输出不可用，正在改用普通请求生成最终回答" });
    const text = await requestChatCompletionText({
      settings: input.settings,
      url,
      body,
      operation: "mcp.synthesizeFinalAnswer",
      signal: controller.signal
    });
    return {
      text,
      streamed: false
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}

function buildFinalAnswerMessages(input: {
  userContent: string;
  session: McpSessionRecord;
  history: Array<{ role: string; content: string }>;
  settings: AiRuntimeSettings;
  observations: Array<{ toolName: string; result: unknown; error?: string | null }>;
  autoMermaid: boolean;
}) {
  const citationSources = collectCitationSourcesFromObservations(input.observations);
  return [
    {
      role: "system" as const,
      content: [
        input.settings.answerSystemPrompt,
        "",
        input.settings.longTermMemoryEnabled ? formatLongTermMemoryForPrompt(input.session.metadata) : "",
        "",
        "You are composing the final answer after SAG MCP retrieval.",
        "Evidence priority: project database evidence first; authoritative public web sources second if the upstream model/provider truly has access to them; model general knowledge last.",
        "Do not refuse only because the project database lacks a fact. If project evidence is missing, provide a cautious supplement from authoritative public knowledge or model general knowledge.",
        "Never present supplements as project-database facts. Do not add visible parenthetical source labels such as （模型知识补充） or （基于项目证据 + 模型知识补充） in the answer body.",
        "Cite project-database claims with [1], [2], [3] markers that match citation_sources.index.",
        "If you use authoritative web/public sources, cite them with <span class=\"chem-web-citation\">网1</span>, <span class=\"chem-web-citation\">网2</span> style markers and include source names/URLs when available.",
        "If you rely on model general knowledge without an external source, do not add citation markers, footnotes, URLs, or explicit labels for that content. Phrase uncertain points cautiously and keep them separate from cited project or web claims.",
        "Never write visible phrases such as '项目资料里没搜到', '在项目资料里未检索到', 'the project data did not contain', or similar meta-retrieval disclaimers in the answer body.",
        "When evidence is limited, answer the directly supported part first, then state practical uncertainty without exposing retrieval internals.",
        "Do not add parenthetical source or confidence qualifiers in headings, figure titles, or Mermaid titles. Avoid headings like 产业链示意图（基于现有证据并补充公开知识）; use plain headings like 产业链示意图.",
        "Return normal Markdown text, not JSON.",
        input.autoMermaid
          ? [
              "If the evidence supports industry-chain relationships, append one valid fenced ```mermaid diagram at the bottom.",
              "Use the following Mermaid template as a style and grouping reference. Replace placeholder labels with evidence-backed nodes and relationships.",
              "Do not keep placeholder nodes such as 原料A, 工艺A, 主产品 unless they are truly present in evidence.",
              "If project evidence is sparse, complete the Mermaid diagram with authoritative public knowledge when available, or cautious model general knowledge as a last resort.",
              "In Mermaid node labels or edge labels, add project citation markers like [1] for relationships supported by citation_sources.",
              "For public web supplements, use markers like [网1] in Mermaid labels and mention the source in the narrative.",
              "For model-knowledge supplements, do not put any citation marker, footnote marker, URL, or label such as [模型知识补充] inside Mermaid node labels or edge labels.",
              "Do not mix unsupported supplements into project-evidence claims.",
              "Do not put source-qualification text such as 基于现有证据, 补充公开知识, or 模型知识补充 in Mermaid graph titles, subgraph titles, node labels, or the Markdown heading before the diagram.",
              "Keep Mermaid syntax conservative: graph/flowchart only, no HTML, no click actions, no unsupported icons.",
              "",
              "Mermaid template:",
              "```mermaid",
              input.settings.mermaidTemplate,
              "```"
            ].join("\n")
          : "Do not add a Mermaid diagram unless the user explicitly asks for one."
      ].join("\n")
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        user_message: input.userContent,
        session: {
          id: input.session.id,
          projectId: input.session.sourceIds[0] ?? null
        },
        recent_messages: input.history.slice(-8),
        citation_sources: citationSources,
        tool_observations: compactObservationsForPrompt(input.observations),
        auto_mermaid: input.autoMermaid
      })
    }
  ];
}

async function requestChatJsonObject(input: {
  settings: AiRuntimeSettings;
  url: string;
  body: Record<string, unknown>;
  operation: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (const useJsonMode of [true, false]) {
    const body = useJsonMode
      ? { ...input.body, response_format: { type: "json_object" } }
      : { ...input.body };
    try {
      const content = await requestChatCompletionText({
        settings: input.settings,
        url: input.url,
        body,
        operation: useJsonMode ? input.operation : `${input.operation}.noResponseFormat`,
        signal: input.signal
      });
      return parseJsonObject(content);
    } catch (error) {
      lastError = error;
      if (input.signal?.aborted || !useJsonMode) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function requestChatCompletionText(input: {
  settings: AiRuntimeSettings;
  url: string;
  body: Record<string, unknown>;
  operation: string;
  signal?: AbortSignal;
}): Promise<string> {
  let lastError: unknown;
  const maxAttempts = input.settings.llmMaxRetries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const log = createModelCallLogger({
      kind: "llm",
      operation: input.operation,
      request: {
        url: input.url,
        method: "POST",
        attempt,
        maxAttempts,
        headers: {
          "Content-Type": "application/json"
        },
        body: input.body
      }
    });
    try {
      const response = await fetch(input.url, {
        method: "POST",
        signal: input.signal,
        headers: {
          Authorization: `Bearer ${input.settings.llmApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(input.body)
      });
      const { responseText, responseBody } = await readResponseBody(response);
      if (!response.ok) {
        const error = new Error(`LLM 请求失败：${response.status} ${responseText.slice(0, 500)}`);
        log.fail(error, {
          status: response.status,
          body: responseBody
        });
        lastError = error;
        if (attempt < maxAttempts && isRetryableHttpStatus(response.status)) {
          await waitBeforeRetry(attempt);
          continue;
        }
        throw error;
      }
      const content = extractChatResponseText(responseBody);
      if (!content.trim()) {
        const error = new Error("LLM 返回成功，但正文为空或不在兼容字段中");
        log.fail(error, {
          status: response.status,
          body: responseBody
        });
        throw error;
      }
      log.succeed({
        status: response.status,
        body: responseBody,
        content
      });
      return content;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isRetryableFetchError(error)) {
        log.fail(error);
        await waitBeforeRetry(attempt);
        continue;
      }
      if (!(error instanceof Error && error.message.startsWith("LLM 请求失败"))) {
        log.fail(error);
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function streamChatCompletionText(input: {
  settings: AiRuntimeSettings;
  url: string;
  body: Record<string, unknown>;
  operation: string;
  signal?: AbortSignal;
  emit?: StreamEmitter;
}): Promise<AssistantGenerationResult> {
  const streamBody = { ...input.body, stream: true };
  const log = createModelCallLogger({
    kind: "llm",
    operation: input.operation,
    request: {
      url: input.url,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: streamBody
    }
  });
  try {
    const response = await fetch(input.url, {
      method: "POST",
      signal: input.signal,
      headers: {
        Authorization: `Bearer ${input.settings.llmApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(streamBody)
    });
    if (!response.ok) {
      const { responseText, responseBody } = await readResponseBody(response);
      const error = new Error(`LLM 流式请求失败：${response.status} ${responseText.slice(0, 500)}`);
      log.fail(error, {
        status: response.status,
        body: responseBody
      });
      throw error;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !/text\/event-stream|application\/x-ndjson/i.test(contentType)) {
      const { responseBody } = await readResponseBody(response);
      const content = extractChatResponseText(responseBody);
      log.succeed({
        status: response.status,
        body: responseBody,
        content,
        streamed: false
      });
      return {
        text: content,
        streamed: false
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const delta = parseChatStreamPart(part);
        if (!delta) continue;
        text += delta;
        input.emit?.({ type: "assistant_delta", delta });
      }
    }
    if (buffer.trim()) {
      const delta = parseChatStreamPart(buffer);
      if (delta) {
        text += delta;
        input.emit?.({ type: "assistant_delta", delta });
      }
    }
    if (!text.trim()) {
      const error = new Error("LLM 流式返回成功，但没有输出正文");
      log.fail(error);
      throw error;
    }
    log.succeed({
      status: response.status,
      content: text,
      streamed: true
    });
    return {
      text,
      streamed: true
    };
  } catch (error) {
    log.fail(error);
    throw error;
  }
}

function parseJsonOrText(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readResponseBody(response: Response): Promise<{ responseText: string; responseBody: unknown }> {
  const maybeText = (response as Response & { text?: () => Promise<string> }).text;
  if (typeof maybeText === "function") {
    const responseText = await maybeText.call(response);
    return {
      responseText,
      responseBody: parseJsonOrText(responseText)
    };
  }
  const responseBody = await (response as Response & { json: () => Promise<unknown> }).json();
  return {
    responseText: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
    responseBody
  };
}

function extractChatResponseText(responseBody: unknown): string {
  const parts: string[] = [];
  collectChatResponseText(responseBody, parts, 0);
  return parts.join("").trim();
}

function collectChatResponseText(value: unknown, parts: string[], depth: number): void {
  if (depth > 5 || value == null) {
    return;
  }
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectChatResponseText(item, parts, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (typeof value.output_text === "string") {
    parts.push(value.output_text);
  }
  if (typeof value.text === "string" && depth > 0) {
    parts.push(value.text);
  }

  if (Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      if (!isRecord(choice)) continue;
      if (typeof choice.text === "string") {
        parts.push(choice.text);
      }
      if (isRecord(choice.message)) {
        collectMessageContent(choice.message.content, parts);
      }
      if (isRecord(choice.delta)) {
        collectMessageContent(choice.delta.content, parts);
      }
    }
  }

  if (Array.isArray(value.output)) {
    for (const outputItem of value.output) {
      if (isRecord(outputItem)) {
        collectMessageContent(outputItem.content, parts);
      }
    }
  }

  if (Array.isArray(value.content)) {
    collectMessageContent(value.content, parts);
  }
}

function collectMessageContent(value: unknown, parts: string[]): void {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    if (typeof item.text === "string") {
      parts.push(item.text);
    } else if (typeof item.content === "string") {
      parts.push(item.content);
    }
  }
}

function parseChatStreamPart(part: string): string {
  const dataLines = part
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, "").trim())
    .filter(Boolean);
  let delta = "";
  for (const data of dataLines) {
    if (data === "[DONE]") {
      continue;
    }
    try {
      delta += extractChatDeltaText(JSON.parse(data));
    } catch {
      // Some relays send comments or keepalive frames that are not JSON.
    }
  }
  return delta;
}

function extractChatDeltaText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return "";
  }
  const parts: string[] = [];
  for (const choice of value.choices) {
    if (!isRecord(choice)) continue;
    if (typeof choice.text === "string") {
      parts.push(choice.text);
    }
    if (isRecord(choice.delta)) {
      collectMessageContent(choice.delta.content, parts);
    }
    if (isRecord(choice.message)) {
      collectMessageContent(choice.message.content, parts);
    }
  }
  return parts.join("");
}

function compactObservationsForPrompt(
  observations: Array<{ toolName: string; result: unknown; error?: string | null }>
) {
  return observations.map((observation) => {
    if (observation.error) {
      return {
        toolName: observation.toolName,
        error: observation.error
      };
    }
    const result = parseToolJsonResult(observation.result);
    if (!isRecord(result)) {
      return {
        toolName: observation.toolName,
        result
      };
    }
    return {
      toolName: observation.toolName,
      traceId: result.traceId,
      trace: isRecord(result.trace)
        ? {
            query: result.trace.query,
            searchMode: result.trace.searchMode,
            queryEntities: result.trace.queryEntities,
            recalledEntities: result.trace.recalledEntities,
            rerankedEventIds: result.trace.rerankedEventIds
          }
        : undefined,
      sections: Array.isArray(result.sections)
        ? result.sections.slice(0, 5).map((section) => isRecord(section)
          ? {
              heading: section.heading,
              content: typeof section.content === "string" ? previewForPrompt(section.content) : "",
              score: section.score,
              rank: section.rank
            }
          : section)
        : undefined
    };
  });
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.message.includes("fetch failed");
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1));
  await sleep(delayMs);
}

function normalizeToolAction(raw: unknown): ToolAction {
  const record = raw as Record<string, unknown>;
  if (record.action === "call_tool") {
    return {
      action: "call_tool",
      toolName: record.toolName == null ? undefined : String(record.toolName),
      arguments: isRecord(record.arguments) ? record.arguments : {}
    };
  }
  return {
    action: "final",
    final: record.final == null ? "" : String(record.final)
  };
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced) as Record<string, unknown>;
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error("LLM 未返回可解析的 JSON 规划结果");
  }
}

function isToolOnlyPlaceholder(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").replace(/[。.!！]/g, "");
  return !normalized || [
    "工具调用完成",
    "已完成工具调用",
    "已完成本轮MCP工具调用",
    "MCP工具调用完成"
  ].includes(normalized);
}

function buildEvidenceFallbackAnswer(toolCalls: McpToolCallRecord[]): string {
  const latestSearch = [...toolCalls]
    .reverse()
    .find((toolCall) => toolCall.toolName === "sag_search" && toolCall.status === "SUCCEEDED");
  if (latestSearch) {
    const sections = extractCitationSections(parseToolJsonResult(latestSearch.result)).slice(0, 5);
    if (sections.length > 0) {
      return [
        "我已经检索到相关项目证据。当前先按证据片段整理如下，关键业务结论建议结合原文继续核验：",
        "",
        ...sections.map((section, index) => {
          const heading = section.heading?.trim() || `相关原文 ${index + 1}`;
          const preview = section.content.replace(/\s+/g, " ").trim().slice(0, 420);
          return `### ${index + 1}. ${heading}\n${preview}${section.content.length > 420 ? "…" : ""} [${index + 1}]`;
        })
      ].join("\n\n");
    }
  }
  const failedCall = [...toolCalls].reverse().find((toolCall) => toolCall.status === "FAILED");
  return failedCall
    ? `本轮工具调用未能完成：${failedCall.error ?? "未知错误"}`
    : "本轮没有拿到可用答案。可以换一个更具体的化工品、工艺、企业或应用场景重新提问。";
}

function collectAnswerCitations(toolCalls: McpToolCallRecord[]): AnswerCitation[] {
  const citations: AnswerCitation[] = [];
  const seenChunkIds = new Set<string>();
  for (const toolCall of toolCalls) {
    if (toolCall.toolName !== "sag_search" || toolCall.status !== "SUCCEEDED") {
      continue;
    }
    const result = parseToolJsonResult(toolCall.result);
    const query = typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : undefined;
    for (const section of extractCitationSections(result)) {
      if (seenChunkIds.has(section.chunkId)) {
        continue;
      }
      seenChunkIds.add(section.chunkId);
      citations.push({
        index: citations.length + 1,
        ...section,
        query,
        toolCallId: toolCall.id
      });
      if (citations.length >= 5) {
        return citations;
      }
    }
  }
  return citations;
}

function buildLocalSearchAnswer(toolCall: McpToolCallRecord): string {
  if (toolCall.status !== "SUCCEEDED") {
    return `本地检索失败：${toolCall.error ?? "未知错误"}`;
  }
  const sections = extractCitationSections(parseToolJsonResult(toolCall.result)).slice(0, 5);
  if (sections.length === 0) {
    return "这个问题需要更具体的产品、时间、工艺、企业或事件线索才能继续缩小范围。请补充关键词后我可以再帮你精确定位。";
  }
  const excerpts = sections.map((section, index) => {
    const heading = section.heading?.trim() || `原文片段 ${index + 1}`;
    const content = section.content.replace(/\s+/g, " ").trim();
    const preview = content.length > 360 ? `${content.slice(0, 359)}…` : content;
    return `${index + 1}. ${heading}\n${preview}`;
  });
  return [
    "当前未配置可用的 LLM API，以下是本地检索命中的相关原文。它可以帮助你查资料，但不会自动综合推理：",
    "",
    ...excerpts
  ].join("\n\n");
}

function collectCitationSourcesFromObservations(
  observations: Array<{ toolName: string; result: unknown; error?: string | null }>
) {
  const citations: AnswerCitation[] = [];
  const seenChunkIds = new Set<string>();
  for (const observation of observations) {
    if (observation.toolName !== "sag_search" || observation.error) {
      continue;
    }
    for (const section of extractCitationSections(parseToolJsonResult(observation.result))) {
      if (seenChunkIds.has(section.chunkId)) {
        continue;
      }
      seenChunkIds.add(section.chunkId);
      citations.push({
        index: citations.length + 1,
        ...section,
        content: previewForPrompt(section.content)
      });
      if (citations.length >= 5) {
        return citations;
      }
    }
  }
  return citations;
}

function extractCitationSections(result: unknown): Array<Omit<AnswerCitation, "index" | "query" | "toolCallId">> {
  if (!isRecord(result) || !Array.isArray(result.sections)) {
    return [];
  }
  const sections: Array<Omit<AnswerCitation, "index" | "query" | "toolCallId">> = [];
  for (const section of result.sections) {
    if (!isRecord(section)) {
      continue;
    }
    const chunkId = typeof section.chunkId === "string" ? section.chunkId : "";
    const sourceId = typeof section.sourceId === "string" ? section.sourceId : "";
    const content = typeof section.content === "string" ? section.content.trim() : "";
    if (!chunkId || !sourceId || !content) {
      continue;
    }
    sections.push({
      chunkId,
      sourceId,
      documentId: typeof section.documentId === "string" ? section.documentId : undefined,
      heading: typeof section.heading === "string" ? section.heading : undefined,
      content,
      rank: typeof section.rank === "number" ? section.rank : undefined,
      score: typeof section.score === "number" ? section.score : undefined
    });
  }
  return sections;
}

function parseToolJsonResult(result: unknown): unknown {
  const text = extractToolText(result);
  if (!text) {
    return result;
  }
  try {
    return JSON.parse(text);
  } catch {
    return result;
  }
}

function previewForPrompt(content: string): string {
  return content.length > 1200 ? `${content.slice(0, 1200)}...` : content;
}

function resolveMcpServerCommand(): { command: string; args: string[]; cwd: string } {
  const cwd = path.resolve(process.cwd());
  const command = process.env.SAG_MCP_SERVER_COMMAND;
  if (command) {
    return {
      command,
      args: process.env.SAG_MCP_SERVER_ARGS ? JSON.parse(process.env.SAG_MCP_SERVER_ARGS) as string[] : [],
      cwd
    };
  }
  if (shouldUseDistServer(cwd)) {
    return {
      command: process.execPath,
      args: [path.join(cwd, "dist", "src", "mcp", "server.js")],
      cwd
    };
  }
  return {
    command: process.execPath,
    args: [
      path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(cwd, "src", "mcp", "server.ts")
    ],
    cwd
  };
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "");
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function shouldUseDistServer(cwd: string): boolean {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return process.env.NODE_ENV === "production" || entry.startsWith(path.join(cwd, "dist"));
}

function childEnv(projectId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.SAG_LOG_STDERR = "true";
  env.SAG_MCP_SOURCE_ID = projectId;
  return env;
}

function chunkText(content: string, size: number): string[] {
  if (content.length <= size) return [content];
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += size) {
    chunks.push(content.slice(index, index + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSearchProgress(message: string | undefined): SearchProgressEvent | null {
  if (!message) {
    return null;
  }
  try {
    const parsed = JSON.parse(message) as { kind?: unknown; event?: unknown };
    if (parsed.kind !== "sag_search_progress" || !isRecord(parsed.event)) {
      return null;
    }
    const event = parsed.event;
    if (
      event.type !== "step" ||
      typeof event.key !== "string" ||
      typeof event.title !== "string" ||
      typeof event.detail !== "string" ||
      (event.status !== "running" && event.status !== "done" && event.status !== "failed")
    ) {
      return null;
    }
    return {
      type: "step",
      key: event.key,
      title: event.title,
      detail: event.detail,
      status: event.status,
      payload: event.payload,
      durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined
    };
  } catch {
    return null;
  }
}

function parseModelCallLogProgress(message: string | undefined): ModelCallLogRecord | null {
  if (!message) {
    return null;
  }
  try {
    const parsed = JSON.parse(message) as { kind?: unknown; log?: unknown };
    if (parsed.kind !== "sag_model_call_log" || !isRecord(parsed.log)) {
      return null;
    }
    const log = parsed.log;
    if (
      typeof log.sequence !== "number" ||
      typeof log.id !== "string" ||
      (log.kind !== "llm" && log.kind !== "embedding") ||
      typeof log.operation !== "string" ||
      (log.status !== "SUCCEEDED" && log.status !== "FAILED") ||
      typeof log.createdAt !== "string" ||
      typeof log.durationMs !== "number"
    ) {
      return null;
    }
    return {
      sequence: log.sequence,
      id: log.id,
      kind: log.kind,
      operation: log.operation,
      status: log.status,
      createdAt: log.createdAt,
      durationMs: log.durationMs,
      request: log.request,
      response: log.response,
      error: typeof log.error === "string" ? log.error : undefined
    };
  } catch {
    return null;
  }
}

function extractToolText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return "";
  }
  return value.content
    .map((item) => isRecord(item) && item.type === "text" ? String(item.text ?? "") : "")
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const mcpAgentService = new McpAgentService();
