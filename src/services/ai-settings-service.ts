import type { StructuredOutputMode } from "../ai/structured-output.js";
import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";
import {
  getAiProviderSettings,
  upsertAiProviderSettings
} from "../db/repositories.js";
import type { AiProviderSettingsRecord, ChunkingMode, PublicAiProviderSettings, SearchMode } from "../types.js";

export const DEFAULT_SEARCH_TOP_K = 10;
export const MAX_SEARCH_TOP_K = 50;
export const DEFAULT_CHUNKING_MODE: ChunkingMode = "heading_strict";
export const DEFAULT_CHUNK_TOKEN_LIMIT = 512;
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 100;
export const DEFAULT_ANSWER_SYSTEM_PROMPT = [
  "你是化工产业链知识超图问答助手。",
  "回答必须基于已检索到的项目证据，不要编造数据库里没有的事实。",
  "优先用中文回答；如果用户使用英文提问，则使用英文回答。",
  "关键结论尽量引用 [1]、[2] 这样的证据编号。",
  "默认结构清晰、专业，但不要堆砌空话。"
].join("\n");
export const DEFAULT_GRAPH_LAYOUT_STYLE = "columns";
export const DEFAULT_LONG_TERM_MEMORY_ENABLED = false;
const LEGACY_DEFAULT_WELCOME_PROMPT_TEMPLATES = [
  "请用表格整理「{focus}」相关的产业链关系：上游原料、工艺/事件、相关企业、下游应用和证据来源。",
  "基于当前项目内容，为「{focus}」生成一份 Markdown 大纲式思维导图，按原料、工艺、中间体、产品、下游应用、终端行业分层展开。",
  "写一份研究报告风格的「{projectName}」产业链分析，包含核心关系、关键企业、机会、风险和证据缺口。",
  "用通俗易懂的方式解释「{focus}」和「{secondary}」的关系。多用短句，少用长句，语气轻松一点，可以适当吐槽，不要说无关话。"
];
export const DEFAULT_WELCOME_PROMPT_TEMPLATES = [
  "基于「{projectName}」项目资料，围绕「{focus}」整理产业链表格：上游原料、关键工艺/事件、相关企业、下游产品/应用和证据来源。",
  "把「{focus}」做成 Markdown 大纲式知识图谱：原料 → 工艺/中间体 → 产品 → 下游应用 → 终端行业，并标注关键事件。",
  "比较「{focus}」和「{secondary}」在产业链中的位置、上下游关系、共同企业和证据缺口。",
  "以「{focus}」为核心写一份研究报告提纲，包含供需、企业/装置、价格/库存线索、机会与风险。"
];

export interface AiRuntimeSettings {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey: string;
  hasRemoteEmbedding: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  hasRemoteLlm: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  structuredOutputMode?: StructuredOutputMode;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  answerSystemPrompt: string;
  mcpSearchMode: SearchMode;
  graphDefaultLayoutStyle: string;
  welcomePromptTemplates: string[];
  longTermMemoryEnabled: boolean;
}

export interface UpdateAiSettingsInput {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string;
  clearEmbeddingApiKey?: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string;
  clearLlmApiKey?: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  structuredOutputMode?: StructuredOutputMode;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  answerSystemPrompt?: string;
  mcpSearchMode?: SearchMode;
  graphDefaultLayoutStyle?: string;
  welcomePromptTemplates?: string[];
  longTermMemoryEnabled?: boolean;
}

export class AiSettingsService {
  async getPublicSettings(): Promise<PublicAiProviderSettings> {
    return toPublicSettings(await this.getSettingsOrFallback());
  }

  async getRuntimeSettings(): Promise<AiRuntimeSettings> {
    const settings = await this.getSettingsOrFallback();
    const embeddingApiKey = settings.embeddingApiKey?.trim() ?? "";
    const llmApiKey = settings.llmApiKey?.trim() ?? "";
    const chunkTokenLimit = readBoundedInteger(settings.metadata.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    return {
      embeddingBaseUrl: settings.embeddingBaseUrl,
      embeddingModel: settings.embeddingModel,
      embeddingDimensions: settings.embeddingDimensions,
      embeddingApiKey,
      hasRemoteEmbedding: embeddingApiKey.length > 0,
      llmBaseUrl: settings.llmBaseUrl,
      llmModel: settings.llmModel,
      llmApiKey,
      hasRemoteLlm: llmApiKey.length > 0,
      llmTimeoutMs: settings.llmTimeoutMs,
      llmMaxRetries: settings.llmMaxRetries,
      structuredOutputMode: readStructuredOutputMode(settings.metadata.structuredOutputMode),
      defaultSearchMode: readDefaultSearchMode(settings.metadata),
      defaultSearchTopK: readBoundedInteger(settings.metadata.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
      defaultChunkingMode: readDefaultChunkingMode(settings.metadata),
      chunkTokenLimit,
      chunkOverlapTokens: readBoundedInteger(settings.metadata.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1),
      answerSystemPrompt: readNonEmptyString(settings.metadata.answerSystemPrompt, DEFAULT_ANSWER_SYSTEM_PROMPT),
      mcpSearchMode: readSearchMode(settings.metadata.mcpSearchMode, "fast"),
      graphDefaultLayoutStyle: readGraphLayoutStyle(settings.metadata.graphDefaultLayoutStyle),
      welcomePromptTemplates: readWelcomePromptTemplates(settings.metadata.welcomePromptTemplates),
      longTermMemoryEnabled: readBoolean(settings.metadata.longTermMemoryEnabled, DEFAULT_LONG_TERM_MEMORY_ENABLED)
    };
  }

  async updateSettings(input: UpdateAiSettingsInput): Promise<PublicAiProviderSettings> {
    if (input.embeddingDimensions !== SUPPORTED_EMBEDDING_DIMENSIONS) {
      throw new Error(`embeddingDimensions must be ${SUPPORTED_EMBEDDING_DIMENSIONS}`);
    }
    const chunkTokenLimit = clampInteger(input.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    const chunkOverlapTokens = clampInteger(input.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1);
    const current = await this.getSettingsOrFallback();
    const embeddingApiKey = input.clearEmbeddingApiKey ? null : normalizeOptionalSecret(input.embeddingApiKey);
    const llmApiKey = input.clearLlmApiKey ? null : normalizeOptionalSecret(input.llmApiKey);
    const answerSystemPrompt = input.answerSystemPrompt == null
      ? readNonEmptyString(current.metadata.answerSystemPrompt, DEFAULT_ANSWER_SYSTEM_PROMPT)
      : normalizeMultilineText(input.answerSystemPrompt, DEFAULT_ANSWER_SYSTEM_PROMPT);
    const welcomePromptTemplates = input.welcomePromptTemplates == null
      ? readWelcomePromptTemplates(current.metadata.welcomePromptTemplates)
      : normalizePromptTemplates(input.welcomePromptTemplates);
    const updated = await upsertAiProviderSettings({
      embeddingBaseUrl: input.embeddingBaseUrl.trim(),
      embeddingModel: input.embeddingModel.trim(),
      embeddingDimensions: input.embeddingDimensions,
      embeddingApiKey,
      preserveEmbeddingApiKey: !input.clearEmbeddingApiKey && embeddingApiKey == null,
      llmBaseUrl: input.llmBaseUrl.trim(),
      llmModel: input.llmModel.trim(),
      llmApiKey,
      preserveLlmApiKey: !input.clearLlmApiKey && llmApiKey == null,
      llmTimeoutMs: input.llmTimeoutMs,
      llmMaxRetries: input.llmMaxRetries,
      metadata: {
        ...current.metadata,
        updatedVia: "webui",
        previousUpdatedAt: current.updatedAt,
        structuredOutputMode: input.structuredOutputMode ?? readStructuredOutputMode(current.metadata.structuredOutputMode),
        defaultSearchMode: input.defaultSearchMode,
        defaultSearchTopK: clampInteger(input.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
        defaultChunkingMode: input.defaultChunkingMode,
        chunkTokenLimit,
        chunkOverlapTokens,
        answerSystemPrompt,
        mcpSearchMode: input.mcpSearchMode ?? readSearchMode(current.metadata.mcpSearchMode, "fast"),
        graphDefaultLayoutStyle: readGraphLayoutStyle(input.graphDefaultLayoutStyle ?? current.metadata.graphDefaultLayoutStyle),
        welcomePromptTemplates,
        longTermMemoryEnabled: input.longTermMemoryEnabled ?? readBoolean(current.metadata.longTermMemoryEnabled, DEFAULT_LONG_TERM_MEMORY_ENABLED)
      }
    });
    return toPublicSettings(updated);
  }

  private async getSettingsOrFallback(): Promise<AiProviderSettingsRecord> {
    if (config.NODE_ENV === "test") {
      return envSettings();
    }
    try {
      const settings = await getAiProviderSettings();
      if (settings) {
        return settings;
      }
    } catch {
      // Tests and fresh installs can run before migrations. Runtime callers still
      // need a deterministic fallback so local operation stays bootstrappable.
    }
    return envSettings();
  }
}

function envSettings(): AiProviderSettingsRecord {
  const now = new Date().toISOString();
  return {
    id: "global",
    embeddingBaseUrl: config.EMBEDDING_BASE_URL,
    embeddingModel: config.EMBEDDING_MODEL,
    embeddingDimensions: SUPPORTED_EMBEDDING_DIMENSIONS,
    embeddingApiKey: config.EMBEDDING_API_KEY || null,
    llmBaseUrl: config.LLM_BASE_URL,
    llmModel: config.LLM_MODEL,
    llmApiKey: config.LLM_API_KEY || null,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    llmMaxRetries: config.LLM_MAX_RETRIES,
    metadata: {
      defaultSearchMode: config.DEFAULT_SEARCH_MODE,
      defaultSearchTopK: DEFAULT_SEARCH_TOP_K,
      defaultChunkingMode: DEFAULT_CHUNKING_MODE,
      chunkTokenLimit: DEFAULT_CHUNK_TOKEN_LIMIT,
      chunkOverlapTokens: DEFAULT_CHUNK_OVERLAP_TOKENS,
      answerSystemPrompt: DEFAULT_ANSWER_SYSTEM_PROMPT,
      mcpSearchMode: "fast",
      graphDefaultLayoutStyle: DEFAULT_GRAPH_LAYOUT_STYLE,
      welcomePromptTemplates: DEFAULT_WELCOME_PROMPT_TEMPLATES,
      longTermMemoryEnabled: DEFAULT_LONG_TERM_MEMORY_ENABLED
    },
    createdAt: now,
    updatedAt: now
  };
}

function toPublicSettings(settings: AiProviderSettingsRecord): PublicAiProviderSettings {
  const chunkTokenLimit = readBoundedInteger(settings.metadata.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
  return {
    id: "global",
    embeddingBaseUrl: settings.embeddingBaseUrl,
    embeddingModel: settings.embeddingModel,
    embeddingDimensions: settings.embeddingDimensions,
    hasEmbeddingApiKey: (settings.embeddingApiKey?.trim() ?? "").length > 0,
    llmBaseUrl: settings.llmBaseUrl,
    llmModel: settings.llmModel,
    hasLlmApiKey: (settings.llmApiKey?.trim() ?? "").length > 0,
    llmTimeoutMs: settings.llmTimeoutMs,
    llmMaxRetries: settings.llmMaxRetries,
    structuredOutputMode: readStructuredOutputMode(settings.metadata.structuredOutputMode),
    defaultSearchMode: readDefaultSearchMode(settings.metadata),
    defaultSearchTopK: readBoundedInteger(settings.metadata.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
    defaultChunkingMode: readDefaultChunkingMode(settings.metadata),
    chunkTokenLimit,
    chunkOverlapTokens: readBoundedInteger(settings.metadata.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1),
    answerSystemPrompt: readNonEmptyString(settings.metadata.answerSystemPrompt, DEFAULT_ANSWER_SYSTEM_PROMPT),
    mcpSearchMode: readSearchMode(settings.metadata.mcpSearchMode, "fast"),
    graphDefaultLayoutStyle: readGraphLayoutStyle(settings.metadata.graphDefaultLayoutStyle),
    welcomePromptTemplates: readWelcomePromptTemplates(settings.metadata.welcomePromptTemplates),
    longTermMemoryEnabled: readBoolean(settings.metadata.longTermMemoryEnabled, DEFAULT_LONG_TERM_MEMORY_ENABLED),
    updatedAt: settings.updatedAt
  };
}

function readDefaultSearchMode(metadata: Record<string, unknown>): SearchMode {
  return readSearchMode(metadata.defaultSearchMode, "fast");
}

function readSearchMode(value: unknown, fallback: SearchMode): SearchMode {
  if (value === "standard" || value === "fast") {
    return value;
  }
  return fallback;
}

function readDefaultChunkingMode(metadata: Record<string, unknown>): ChunkingMode {
  return metadata.defaultChunkingMode === "token" ? "token" : DEFAULT_CHUNKING_MODE;
}

function readGraphLayoutStyle(value: unknown): string {
  return ["search_layers", "columns"].includes(String(value))
    ? String(value)
    : DEFAULT_GRAPH_LAYOUT_STYLE;
}

function readBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return clampInteger(value, fallback, min, max);
}

function readNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const items = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function readWelcomePromptTemplates(value: unknown): string[] {
  const templates = readStringArray(value, DEFAULT_WELCOME_PROMPT_TEMPLATES);
  return samePromptTemplates(templates, LEGACY_DEFAULT_WELCOME_PROMPT_TEMPLATES)
    ? DEFAULT_WELCOME_PROMPT_TEMPLATES
    : templates;
}

function samePromptTemplates(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.trim() === right[index]?.trim());
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(numberValue), max));
}

function normalizeOptionalSecret(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMultilineText(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\r\n/g, "\n").trim() ?? "";
  return normalized || fallback;
}

function normalizePromptTemplates(values: string[]): string[] {
  const normalized = values.map((value) => value.replace(/\r\n/g, "\n").trim()).filter(Boolean);
  if (normalized.length === 0) return DEFAULT_WELCOME_PROMPT_TEMPLATES;
  return samePromptTemplates(normalized, LEGACY_DEFAULT_WELCOME_PROMPT_TEMPLATES)
    ? DEFAULT_WELCOME_PROMPT_TEMPLATES
    : normalized;
}

export const aiSettingsService = new AiSettingsService();

function readStructuredOutputMode(value: unknown): StructuredOutputMode {
  return value === "json_schema" || value === "json_object" || value === "prompt_only" ? value : "auto";
}
