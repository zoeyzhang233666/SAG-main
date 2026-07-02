import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export type ModelCallKind = "llm" | "embedding";
export type ModelCallStatus = "SUCCEEDED" | "FAILED";

export interface ModelCallLogRecord {
  sequence: number;
  id: string;
  kind: ModelCallKind;
  operation: string;
  status: ModelCallStatus;
  createdAt: string;
  durationMs: number;
  request: unknown;
  response?: unknown;
  error?: string;
}

type ModelCallLogListener = (log: ModelCallLogRecord) => void;

const MAX_MODEL_CALL_LOGS = 500;
const MAX_IMPORTED_MODEL_CALL_LOG_IDS = MAX_MODEL_CALL_LOGS * 2;
const MAX_LOG_PAYLOAD_DEPTH = 6;
const MAX_LOG_STRING_LENGTH = 6000;
const MAX_LOG_ARRAY_ITEMS = 50;
const MAX_LOG_OBJECT_KEYS = 80;
const MAX_LOG_NUMERIC_ARRAY_PREVIEW_ITEMS = 16;
const logs: ModelCallLogRecord[] = [];
const importedLogIds = new Set<string>();
const importedLogIdQueue: string[] = [];
const listeners = new Set<ModelCallLogListener>();
let latestSequence = 0;

export function createModelCallLogger(input: {
  kind: ModelCallKind;
  operation: string;
  request: unknown;
}) {
  const started = performance.now();
  return {
    succeed(response: unknown) {
      appendModelCallLog({
        kind: input.kind,
        operation: input.operation,
        status: "SUCCEEDED",
        request: input.request,
        response,
        durationMs: Math.round(performance.now() - started)
      });
    },
    fail(error: unknown, response?: unknown) {
      appendModelCallLog({
        kind: input.kind,
        operation: input.operation,
        status: "FAILED",
        request: input.request,
        response,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - started)
      });
    }
  };
}

export function listModelCallLogs(afterSequence = 0): {
  logs: ModelCallLogRecord[];
  latestSequence: number;
} {
  return {
    logs: logs.filter((log) => log.sequence > afterSequence),
    latestSequence
  };
}

export function importModelCallLog(log: ModelCallLogRecord): ModelCallLogRecord | null {
  if (importedLogIds.has(log.id)) {
    return null;
  }
  rememberImportedLogId(log.id);
  return appendModelCallLog({
    kind: log.kind,
    operation: log.operation,
    status: log.status,
    request: log.request,
    response: log.response,
    error: log.error,
    durationMs: log.durationMs
  });
}

function rememberImportedLogId(id: string) {
  importedLogIds.add(id);
  importedLogIdQueue.push(id);
  if (importedLogIdQueue.length <= MAX_IMPORTED_MODEL_CALL_LOG_IDS) {
    return;
  }
  const expiredIds = importedLogIdQueue.splice(0, importedLogIdQueue.length - MAX_IMPORTED_MODEL_CALL_LOG_IDS);
  for (const expiredId of expiredIds) {
    importedLogIds.delete(expiredId);
  }
}

export function subscribeModelCallLogs(listener: ModelCallLogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function sanitizeModelCallLogPayload(value: unknown): unknown {
  return sanitizeModelCallLogValue(value, 0, new WeakSet<object>());
}

function sanitizeModelCallLogValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return truncateModelLogString(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return sanitizeModelCallLogArray(value, depth, seen);
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    if (depth >= MAX_LOG_PAYLOAD_DEPTH) {
      return {
        __sagTruncated: true,
        reason: "max depth reached"
      };
    }
    seen.add(value);
    try {
      const entries = Object.entries(value as Record<string, unknown>);
      const output: Record<string, unknown> = {};
      for (const [key, entryValue] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
        output[key] = sanitizeModelCallLogValue(entryValue, depth + 1, seen);
      }
      if (entries.length > MAX_LOG_OBJECT_KEYS) {
        output.__sagTruncatedKeys = entries.length - MAX_LOG_OBJECT_KEYS;
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

function sanitizeModelCallLogArray(value: unknown[], depth: number, seen: WeakSet<object>): unknown {
  if (looksLikeNumericVector(value)) {
    return {
      __sagPreview: "numeric-array",
      length: value.length,
      sample: value.slice(0, MAX_LOG_NUMERIC_ARRAY_PREVIEW_ITEMS),
      omitted: Math.max(0, value.length - MAX_LOG_NUMERIC_ARRAY_PREVIEW_ITEMS)
    };
  }
  if (depth >= MAX_LOG_PAYLOAD_DEPTH) {
    return {
      __sagPreview: "array",
      length: value.length,
      omitted: value.length
    };
  }
  const items = value.slice(0, MAX_LOG_ARRAY_ITEMS).map((item) => sanitizeModelCallLogValue(item, depth + 1, seen));
  if (value.length > MAX_LOG_ARRAY_ITEMS) {
    items.push({
      __sagTruncatedItems: value.length - MAX_LOG_ARRAY_ITEMS
    });
  }
  return items;
}

function looksLikeNumericVector(value: unknown[]): value is number[] {
  if (value.length < MAX_LOG_ARRAY_ITEMS) {
    return false;
  }
  const sampleSize = Math.min(value.length, MAX_LOG_NUMERIC_ARRAY_PREVIEW_ITEMS);
  for (let index = 0; index < sampleSize; index += 1) {
    if (typeof value[index] !== "number") {
      return false;
    }
  }
  return true;
}

function truncateModelLogString(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}… [truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`;
}

function appendModelCallLog(input: Omit<ModelCallLogRecord, "sequence" | "id" | "createdAt">): ModelCallLogRecord {
  latestSequence += 1;
  const log = {
    sequence: latestSequence,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    kind: input.kind,
    operation: input.operation,
    status: input.status,
    request: sanitizeModelCallLogPayload(input.request),
    response: input.response === undefined ? undefined : sanitizeModelCallLogPayload(input.response),
    error: input.error,
    durationMs: input.durationMs
  };
  logs.push(log);
  if (logs.length > MAX_MODEL_CALL_LOGS) {
    logs.splice(0, logs.length - MAX_MODEL_CALL_LOGS);
  }
  for (const listener of listeners) {
    listener(log);
  }
  return log;
}
