import { createHash } from "node:crypto";
import { config } from "../config/env.js";
import { normalizeVector } from "../db/vector.js";
import { aiSettingsService } from "../services/ai-settings-service.js";
import { createModelCallLogger } from "../observability/model-call-log.js";

const EMBEDDING_TIMEOUT_MS = 45_000;
const MAX_EMBEDDING_ATTEMPTS = 3;

export interface EmbeddingClient {
  generate(text: string): Promise<number[]>;
  batchGenerate(texts: string[]): Promise<number[][]>;
}

export class OpenAICompatibleEmbeddingClient implements EmbeddingClient {
  async generate(text: string): Promise<number[]> {
    const [embedding] = await this.batchGenerate([text]);
    return embedding;
  }

  async batchGenerate(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteEmbedding) {
      const request = {
        url: "local://embedding/deterministic",
        method: "POST",
        body: {
          model: "deterministic-local",
          input: texts,
          dimensions: settings.embeddingDimensions
        }
      };
      const log = createModelCallLogger({
        kind: "embedding",
        operation: "batchGenerate",
        request
      });
      const embeddings = texts.map((text) => deterministicEmbedding(text, settings.embeddingDimensions));
      log.succeed({
        data: embeddings.map((embedding, index) => ({
          index,
          embedding
        }))
      });
      return embeddings;
    }

    const url = `${settings.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`;
    const body: Record<string, unknown> = {
      model: settings.embeddingModel,
      input: texts
    };
    // 仅当显式开启时才发送 dimensions：bge-m3 等固定维度模型收到该参数会返回 400。
    if (config.EMBEDDING_SEND_DIMENSIONS) {
      body.dimensions = settings.embeddingDimensions;
    }
    const maxAttempts = Math.max(
      1,
      Math.min(MAX_EMBEDDING_ATTEMPTS, settings.llmMaxRetries + 1)
    );
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutMs = Math.min(settings.llmTimeoutMs, EMBEDDING_TIMEOUT_MS);
      const timeout = setTimeout(
        () => controller.abort(new Error(`embedding request timeout (${timeoutMs} ms)`)),
        timeoutMs
      );
      const log = createModelCallLogger({
        kind: "embedding",
        operation: "batchGenerate",
        request: {
          url,
          method: "POST",
          attempt,
          maxAttempts,
          timeoutMs,
          headers: {
            "Content-Type": "application/json"
          },
          body
        }
      });
      let logged = false;
      try {
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${settings.embeddingApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const { responseText, responseBody } = await readResponseBody(response);

        if (!response.ok) {
          const error = new Error(`embedding request failed: ${response.status} ${responseText.slice(0, 500)}`);
          log.fail(error, {
            status: response.status,
            body: responseBody
          });
          logged = true;
          lastError = error;
          if (attempt < maxAttempts && isRetryableHttpStatus(response.status)) {
            await waitBeforeRetry(attempt);
            continue;
          }
          throw error;
        }

        const json = responseBody as {
          data?: Array<{ embedding?: number[] }>;
        };
        const embeddings = json.data?.map((item) => item.embedding ?? []) ?? [];
        if (embeddings.length !== texts.length) {
          throw new Error(`embedding count mismatch: expected=${texts.length}, actual=${embeddings.length}`);
        }
        for (const embedding of embeddings) {
          if (embedding.length !== settings.embeddingDimensions) {
            throw new Error(`embedding dimension mismatch: expected=${settings.embeddingDimensions}, actual=${embedding.length}`);
          }
        }
        log.succeed({
          status: response.status,
          body: responseBody
        });
        return embeddings;
      } catch (error) {
        lastError = error;
        if (!logged) {
          log.fail(error);
        }
        if (attempt < maxAttempts && (controller.signal.aborted || isRetryableFetchError(error))) {
          await waitBeforeRetry(attempt);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = readNestedErrorCode(error);
  return error.name === "AbortError" ||
    error.message.includes("fetch failed") ||
    ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code);
}

function readNestedErrorCode(error: unknown, depth = 0): string {
  if (depth > 4 || !(error instanceof Error)) {
    return "";
  }
  const record = error as Error & { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof record.code === "string") {
    return record.code;
  }
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      const code = readNestedErrorCode(item, depth + 1);
      if (code) return code;
    }
  }
  return readNestedErrorCode(record.cause, depth + 1);
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(2_000, 300 * 2 ** Math.max(0, attempt - 1));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
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

export function deterministicEmbedding(text: string, dimensions: number): number[] {
  const normalized = text.trim().toLowerCase();
  const values = new Array<number>(dimensions).fill(0);
  let offset = 0;
  while (offset < dimensions) {
    const hash = createHash("sha256").update(`${normalized}:${offset}`).digest();
    for (const byte of hash) {
      if (offset >= dimensions) {
        break;
      }
      values[offset] = (byte / 255) * 2 - 1;
      offset += 1;
    }
  }
  return normalizeVector(values);
}

export const embeddingClient = new OpenAICompatibleEmbeddingClient();
