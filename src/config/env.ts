import "dotenv/config";
import { z } from "zod";
import { DEFAULT_EMBEDDING_BASE_URL, DEFAULT_EMBEDDING_MODEL, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from "./default-ai-providers.js";

export const SUPPORTED_EMBEDDING_DIMENSIONS = 1024;

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(4300),
  DATABASE_URL: z.string().min(1).default("postgres://sag_lite:sag_lite_pass@localhost:5432/sag_lite"),
  DEFAULT_TENANT_ID: z.string().min(1).default("default"),
  AUTH_MODE: z.enum(["none", "bearer", "external"]).default("none"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(SUPPORTED_EMBEDDING_DIMENSIONS)
    .refine((value) => value === SUPPORTED_EMBEDDING_DIMENSIONS, `EMBEDDING_DIMENSIONS must be ${SUPPORTED_EMBEDDING_DIMENSIONS} because pgvector columns are vector(${SUPPORTED_EMBEDDING_DIMENSIONS})`),
  EMBEDDING_MODEL: z.string().min(1).default(DEFAULT_EMBEDDING_MODEL),
  EMBEDDING_API_KEY: z.string().default(""),
  EMBEDDING_BASE_URL: z.string().url().default(DEFAULT_EMBEDDING_BASE_URL),
  // 是否在 embedding 请求里发送 `dimensions` 参数。默认关闭：bge-m3 等固定维度模型
  // 会因为收到该参数而返回 400（parameter is invalid）。仅当所用模型支持自定义维度
  // 且需要降维到 1024（如 OpenAI text-embedding-3）时，设为 true。
  EMBEDDING_SEND_DIMENSIONS: z.string().optional().transform((value) => value === "true" || value === "1"),
  LLM_MODEL: z.string().min(1).default(DEFAULT_LLM_MODEL),
  LLM_API_KEY: z.string().default(""),
  LLM_BASE_URL: z.string().url().default(DEFAULT_LLM_BASE_URL),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  RERANK_MODEL: z.string().min(1).default("qwen3-rerank"),
  // rerank 可使用与问答 LLM 不同的服务商：填了 RERANK_API_KEY 就用这组独立配置，
  // 否则回退到 LLM 的地址/key（旧行为）。地址留空时回退到 embedding 地址，再回退到 LLM 地址。
  RERANK_BASE_URL: z.string().default(""),
  RERANK_API_KEY: z.string().default(""),
  RERANK_INSTRUCT: z.string().min(1).default("Given a user question, rank SAG event candidates by relevance and usefulness for retrieval-augmented question answering."),
  DEFAULT_SEARCH_MODE: z.enum(["standard", "fast"]).default("fast"),
  INGEST_CONCURRENCY: z.coerce.number().int().positive().max(20).default(5),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(4174),
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000)
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse(process.env);

export const hasRemoteEmbedding = config.EMBEDDING_API_KEY.trim().length > 0;
export const hasRemoteLlm = config.LLM_API_KEY.trim().length > 0;
