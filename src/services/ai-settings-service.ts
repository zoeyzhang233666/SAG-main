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
export const DEFAULT_MERMAID_TEMPLATE = `graph LR
    subgraph 原料超边 ["原料超边"]
        style 原料超边 fill:#F3EEF8,stroke:#7B5EA7,stroke-width:2px,color:#2E1C4A
        原料A["原料A"]:::rawMaterial
    end

    subgraph 生产工艺超边 ["生产工艺超边"]
        style 生产工艺超边 fill:#FEF3EB,stroke:#D4764A,stroke-width:2px,color:#4E2010
        工艺A{"工艺A"}:::process
    end

    subgraph 产品超边 ["产品超边"]
        style 产品超边 fill:#FDF0F5,stroke:#D47B9C,stroke-width:2px,color:#4A2035
        主产品["主产品"]:::product
    end

    subgraph 直接下游产品超边 ["直接下游产品超边"]
        style 直接下游产品超边 fill:#EBF5F0,stroke:#3D8B62,stroke-width:2px,color:#143826
        下游A("下游产品"):::downstream
    end

    subgraph 终端行业超边 ["终端行业超边"]
        style 终端行业超边 fill:#FCF8F1,stroke:#C49B4C,stroke-width:2px,color:#4A3010
        终端A{{"终端行业"}}:::endUse
    end

    原料A -->|进入| 工艺A
    工艺A -->|生成| 主产品
    主产品 -->|主要下游| 下游A
    下游A -->|终端行业| 终端A

    classDef rawMaterial fill:#DDD2EB,stroke:#7B5EA7,color:#2E1C4A
    classDef process fill:#FAD4BF,stroke:#D4764A,color:#4E2010
    classDef product fill:#F5D0DE,stroke:#D47B9C,color:#4A2035
    classDef downstream fill:#BFE0D0,stroke:#3D8B62,color:#143826
    classDef endUse fill:#F2E1C0,stroke:#C49B4C,color:#4A3010`;
export const DEFAULT_MERMAID_PENDING_TEXT = "ChemClaw正在绘制产业链关系图";
export const DEFAULT_GRAPH_LAYOUT_STYLE = "search_layers";
export const DEFAULT_LONG_TERM_MEMORY_ENABLED = false;
export const DEFAULT_WELCOME_PROMPT_TEMPLATES = [
  "请用表格整理「{focus}」相关的产业链关系：上游原料、工艺/事件、相关企业、下游应用和证据来源。",
  "基于当前项目内容，为「{focus}」生成一份 Markdown 大纲式思维导图，按原料、工艺、中间体、产品、下游应用、终端行业分层展开。",
  "写一份研究报告风格的「{projectName}」产业链分析，包含核心关系、关键企业、机会、风险和证据缺口。",
  "用通俗易懂的方式解释「{focus}」和「{secondary}」的关系。多用短句，少用长句，语气轻松一点，可以适当吐槽，不要说无关话。"
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
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  answerSystemPrompt: string;
  mermaidTemplate: string;
  mermaidPendingText: string;
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
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  answerSystemPrompt?: string;
  mermaidTemplate?: string;
  mermaidPendingText?: string;
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
      defaultSearchMode: readDefaultSearchMode(settings.metadata),
      defaultSearchTopK: readBoundedInteger(settings.metadata.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
      defaultChunkingMode: readDefaultChunkingMode(settings.metadata),
      chunkTokenLimit,
      chunkOverlapTokens: readBoundedInteger(settings.metadata.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1),
      answerSystemPrompt: readNonEmptyString(settings.metadata.answerSystemPrompt, DEFAULT_ANSWER_SYSTEM_PROMPT),
      mermaidTemplate: readNonEmptyString(settings.metadata.mermaidTemplate, DEFAULT_MERMAID_TEMPLATE),
      mermaidPendingText: readNonEmptyString(settings.metadata.mermaidPendingText, DEFAULT_MERMAID_PENDING_TEXT),
      mcpSearchMode: readSearchMode(settings.metadata.mcpSearchMode, "fast"),
      graphDefaultLayoutStyle: readGraphLayoutStyle(settings.metadata.graphDefaultLayoutStyle),
      welcomePromptTemplates: readStringArray(settings.metadata.welcomePromptTemplates, DEFAULT_WELCOME_PROMPT_TEMPLATES),
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
    const mermaidTemplate = input.mermaidTemplate == null
      ? readNonEmptyString(current.metadata.mermaidTemplate, DEFAULT_MERMAID_TEMPLATE)
      : normalizeMultilineText(input.mermaidTemplate, DEFAULT_MERMAID_TEMPLATE);
    const mermaidPendingText = input.mermaidPendingText == null
      ? readNonEmptyString(current.metadata.mermaidPendingText, DEFAULT_MERMAID_PENDING_TEXT)
      : normalizeMultilineText(input.mermaidPendingText, DEFAULT_MERMAID_PENDING_TEXT);
    const welcomePromptTemplates = input.welcomePromptTemplates == null
      ? readStringArray(current.metadata.welcomePromptTemplates, DEFAULT_WELCOME_PROMPT_TEMPLATES)
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
        updatedVia: "webui",
        previousUpdatedAt: current.updatedAt,
        defaultSearchMode: input.defaultSearchMode,
        defaultSearchTopK: clampInteger(input.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
        defaultChunkingMode: input.defaultChunkingMode,
        chunkTokenLimit,
        chunkOverlapTokens,
        answerSystemPrompt,
        mermaidTemplate,
        mermaidPendingText,
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
      mermaidTemplate: DEFAULT_MERMAID_TEMPLATE,
      mermaidPendingText: DEFAULT_MERMAID_PENDING_TEXT,
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
    defaultSearchMode: readDefaultSearchMode(settings.metadata),
    defaultSearchTopK: readBoundedInteger(settings.metadata.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
    defaultChunkingMode: readDefaultChunkingMode(settings.metadata),
    chunkTokenLimit,
    chunkOverlapTokens: readBoundedInteger(settings.metadata.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1),
    answerSystemPrompt: readNonEmptyString(settings.metadata.answerSystemPrompt, DEFAULT_ANSWER_SYSTEM_PROMPT),
    mermaidTemplate: readNonEmptyString(settings.metadata.mermaidTemplate, DEFAULT_MERMAID_TEMPLATE),
    mermaidPendingText: readNonEmptyString(settings.metadata.mermaidPendingText, DEFAULT_MERMAID_PENDING_TEXT),
    mcpSearchMode: readSearchMode(settings.metadata.mcpSearchMode, "fast"),
    graphDefaultLayoutStyle: readGraphLayoutStyle(settings.metadata.graphDefaultLayoutStyle),
    welcomePromptTemplates: readStringArray(settings.metadata.welcomePromptTemplates, DEFAULT_WELCOME_PROMPT_TEMPLATES),
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
  return normalized.length > 0 ? normalized : DEFAULT_WELCOME_PROMPT_TEMPLATES;
}

export const aiSettingsService = new AiSettingsService();
