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
export const DEFAULT_MERMAID_TEMPLATE = `Mermaid 生成规则：
1. 保留下面模板中的 subgraph 超边结构、配色、classDef 和节点形状风格。
2. Mermaid 图代码内部禁止出现引用标记，例如 [1]、[2]、[3]、[网1]。
3. 不要在节点 ID、节点显示名、边标签、subgraph 名称中写引用标记、URL、脚注或来源说明。
4. 如需说明证据来源，必须在 Mermaid 代码块之外另起小节，标题固定写“产业链关系图引用说明”。引用编号使用普通 Markdown 形式 [1]、[2]，不要使用【1】。
5. 每一条节点定义、每一条关系连线、每一个 classDef 必须单独占一行，禁止把两条连线写在同一行。
6. 边标签只写关系名称，例如“进入”“生成”“副产”“主要下游”“终端行业”，不要写证据编号。
7. 节点 ID 使用简短安全名称，例如 原料A、工艺A、产品A、下游A、终端A；真实实体名称放在节点显示文本里。
8. 如果实体名称包含 /、-、+、%、括号、方括号、逗号、CAS号等特殊字符，不要直接用作节点 ID，只能放在节点显示文本中。
9. Mermaid 代码块内只输出 graph、subgraph、style、节点、连线和 classDef，不要输出解释文字。

Mermaid 样式模板：
graph LR
    %% ================= 原料超边 =================
    subgraph 原料超边 ["原料超边"]
        style 原料超边 fill:#F3EEF8,stroke:#7B5EA7,stroke-width:2px,color:#2E1C4A
        原料A["原料A"]:::rawMaterial
        原料B["原料B"]:::rawMaterial
    end

    %% ================= 生产工艺超边 =================
    subgraph 生产工艺超边 ["生产工艺超边"]
        style 生产工艺超边 fill:#FEF3EB,stroke:#D4764A,stroke-width:2px,color:#4E2010
        工艺A{"工艺A"}:::process
        工艺B{"工艺B"}:::process
    end

    %% ================= 中间体超边 =================
    subgraph 中间体超边 ["中间体超边"]
        style 中间体超边 fill:#F2ECF7,stroke:#8B6BAE,stroke-width:2px,color:#3D2355
        中间体A("中间体A"):::intermediate
    end

    %% ================= 企业超边 =================
    subgraph 企业超边 ["企业超边"]
        style 企业超边 fill:#F4F8FC,stroke:#4A7BA6,stroke-width:2px,color:#1A2F40
        生产企业A[(中国石化)]:::producer
        采购企业A[/恒力石化/]:::buyer
    end

    %% ================= 产品超边 =================
    subgraph 产品超边 ["产品超边"]
        style 产品超边 fill:#FDF0F5,stroke:#D47B9C,stroke-width:2px,color:#4A2035
        主产品["乙二醇"]:::product
    end

    %% ================= 直接下游产品超边 =================
    subgraph 直接下游产品超边 ["直接下游产品超边"]
        style 直接下游产品超边 fill:#EBF5F0,stroke:#3D8B62,stroke-width:2px,color:#143826
        下游A("聚酯纤维"):::downstream
        下游B("防冻液"):::downstream
    end

    %% ================= 终端行业超边 =================
    subgraph 终端行业超边 ["终端行业超边"]
        style 终端行业超边 fill:#FCF8F1,stroke:#C49B4C,stroke-width:2px,color:#4A3010
        终端A{{"纺织业"}}:::endUse
        终端B{{"汽车行业"}}:::endUse
        多领域应用{{"多领域应用"}}:::endUse
    end

    %% 关系连线
    原料A -->|进入| 工艺A
    工艺A -->|生成| 中间体A
    中间体A -->|进入| 工艺B
    工艺B -->|生成| 主产品

    %% 企业关系
    生产企业A -->|主要生产商| 主产品
    采购企业A -->|主要采购商| 下游A

    主产品 -->|主要下游| 下游A
    主产品 -->|次要下游| 下游B
    下游A -->|终端行业| 终端A
    下游B -->|终端行业| 多领域应用
    多领域应用 -->|包含| 终端B

    %% classDef 样式定义
    classDef rawMaterial fill:#DDD2EB,stroke:#7B5EA7,color:#2E1C4A
    classDef intermediate fill:#E0D7F0,stroke:#8B6BAE,color:#2A1F44
    classDef process fill:#FAD4BF,stroke:#D4764A,color:#4E2010
    classDef product fill:#F5D0DE,stroke:#D47B9C,color:#4A2035
    classDef downstream fill:#BFE0D0,stroke:#3D8B62,color:#143826
    classDef subDownstream fill:#A8D5BE,stroke:#2D6B4F,color:#0F261A
    classDef endUse fill:#F2E1C0,stroke:#C49B4C,color:#4A3010
    classDef producer fill:#D6E4F0,stroke:#4A7BA6,color:#1A2F40
    classDef buyer fill:#F9E4B7,stroke:#C48E3B,color:#402D10`;
export const DEFAULT_MERMAID_PENDING_TEXT = "ChemClaw正在绘制产业链关系图";
export const DEFAULT_GRAPH_LAYOUT_STYLE = "search_layers";
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
    const mermaidTemplate = input.mermaidTemplate == null
      ? readNonEmptyString(current.metadata.mermaidTemplate, DEFAULT_MERMAID_TEMPLATE)
      : normalizeMultilineText(input.mermaidTemplate, DEFAULT_MERMAID_TEMPLATE);
    const mermaidPendingText = input.mermaidPendingText == null
      ? readNonEmptyString(current.metadata.mermaidPendingText, DEFAULT_MERMAID_PENDING_TEXT)
      : normalizeMultilineText(input.mermaidPendingText, DEFAULT_MERMAID_PENDING_TEXT);
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
