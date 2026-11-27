import type {
  ChainAtlasEntityMatch,
  ChunkRecord,
  DocumentRecord,
  EntityRecord,
  EntityDetailRecord,
  EventDetailRecord,
  EventRecord,
  McpSessionDetail,
  McpSessionRecord,
  McpStreamEvent,
  ModelCallLogRecord,
  ManualImportFormat,
  ProjectGraphRecord,
  ProjectGraphSuggestionRecord,
  ProjectStatsRecord,
  PublicAiProviderSettings,
  PublicMcpSettings,
  ChunkingMode,
  SearchMode,
  SearchStreamEvent,
  SearchResult,
  SourceRecord,
  UploadJobRecord
} from "../types.js";

function safeParseJson(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new Error("无法连接本地 SAG 服务。请确认后端仍在运行；若正在导入大文件，请更新并重启后端后重试。");
  }
  const text = await response.text();
  const data = safeParseJson(text);
  if (!response.ok) {
    const message = data?.error?.message ?? `请求失败：${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

export const api = {
  async listProjects(includeArchived = false) {
    const query = includeArchived ? "?includeArchived=true" : "";
    return request<{ projects: SourceRecord[] }>(`/api/projects${query}`);
  },

  async createProject(input: { name: string; description?: string | null }) {
    return request<{ project: SourceRecord }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async updateProject(projectId: string, input: { name?: string; description?: string | null }) {
    return request<{ project: SourceRecord }>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async archiveProject(projectId: string) {
    return request<{ project: SourceRecord }>(`/api/projects/${projectId}/archive`, {
      method: "POST"
    });
  },

  async restoreProject(projectId: string) {
    return request<{ project: SourceRecord }>(`/api/projects/${projectId}/restore`, {
      method: "POST"
    });
  },

  async deleteProject(projectId: string) {
    return request<{ deleted: boolean }>(`/api/projects/${projectId}?permanent=true`, {
      method: "DELETE"
    });
  },

  async listDocuments(projectId: string, includeArchived = false) {
    const query = includeArchived ? "?includeArchived=true" : "";
    return request<{ documents: DocumentRecord[] }>(`/api/projects/${projectId}/documents${query}`);
  },

  async getProjectStats(projectId: string) {
    return request<{ stats: ProjectStatsRecord }>(`/api/projects/${projectId}/stats`);
  },

  async getProjectGraph(
    projectId: string,
    input: { chunkIds?: string[]; eventIds?: string[]; entityIds?: string[]; entityName?: string; query?: string; limit?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (input.chunkIds?.length) params.set("chunkIds", input.chunkIds.join(","));
    if (input.eventIds?.length) params.set("eventIds", input.eventIds.join(","));
    if (input.entityIds?.length) params.set("entityIds", input.entityIds.join(","));
    if (input.entityName?.trim()) params.set("entityName", input.entityName.trim());
    if (input.query?.trim()) params.set("query", input.query.trim());
    if (input.limit) params.set("limit", String(input.limit));
    const query = params.toString();
    return request<{ graph: ProjectGraphRecord }>(
      `/api/projects/${projectId}/graph${query ? `?${query}` : ""}`,
    );
  },

  async matchChainAtlasEntities(names: string[], projectId?: string, signal?: AbortSignal) {
    return request<{ matches: ChainAtlasEntityMatch[] }>("/api/chain-atlas/entity-matches", {
      method: "POST",
      body: JSON.stringify({ names, projectId }),
      signal
    });
  },

  async getProjectGraphSuggestions(
    projectId: string,
    input: { query: string; limit?: number },
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams({ q: input.query.trim() });
    if (input.limit) params.set("limit", String(input.limit));
    return request<{ suggestions: ProjectGraphSuggestionRecord[] }>(
      `/api/projects/${projectId}/graph/suggestions?${params.toString()}`,
      { signal, cache: "no-store" },
    );
  },

  async listProjectChunks(projectId: string) {
    return request<{ chunks: ChunkRecord[] }>(`/api/projects/${projectId}/chunks`);
  },

  async listProjectEvents(projectId: string) {
    return request<{ events: EventRecord[] }>(`/api/projects/${projectId}/events`);
  },

  async listProjectEntities(projectId: string) {
    return request<{ entities: EntityRecord[] }>(`/api/projects/${projectId}/entities`);
  },

  async downloadProjectExport(projectId: string, format: "csv" | "json", profile: "simple" | "full" = "simple") {
    const params = new URLSearchParams({ format });
    const endpoint = profile === "simple" ? "export-simple" : "export-full";
    const response = await fetch(`/api/projects/${projectId}/${endpoint}?${params.toString()}`, {
      cache: "no-store"
    });
    if (!response.ok) {
      const text = await response.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `Export failed: ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const fileName = encodedName
      ? decodeURIComponent(encodedName)
      : `sag-project-export.${format}`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },

  async downloadProjectExportFiles(projectId: string, input: {
    format: "csv" | "json";
    profile?: "simple" | "full";
    split?: "none" | "documents" | "size";
    maxBytes?: number;
  }) {
    const profile = input.profile ?? "simple";
    const params = new URLSearchParams({
      format: input.format,
      split: input.split ?? "none"
    });
    if (input.maxBytes) {
      params.set("maxBytes", String(input.maxBytes));
    }
    const endpoint = profile === "simple" ? "export-files-simple" : "export-files-full";
    const response = await fetch(`/api/projects/${projectId}/${endpoint}?${params.toString()}`, {
      cache: "no-store"
    });
    if (!response.ok) {
      const text = await response.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `Export failed: ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const fileName = encodedName
      ? decodeURIComponent(encodedName)
      : `sag-project-export.${blob.type === "application/zip" ? "zip" : input.format}`;
    downloadBlob(fileName, blob);
    return {
      fileCount: Number(response.headers.get("X-Export-File-Count") ?? "1"),
      documentCount: Number(response.headers.get("X-Export-Document-Count") ?? "0"),
      fileName
    };
  },

  async repairMermaid(input: { source: string; error?: string }) {
    return request<{ repairedSource: string | null }>("/api/mermaid/repair", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async getDocument(documentId: string) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}`);
  },

  async listChunks(documentId: string) {
    return request<{ chunks: ChunkRecord[] }>(`/api/documents/${documentId}/chunks`);
  },

  async listEvents(documentId: string) {
    return request<{ events: EventRecord[] }>(`/api/documents/${documentId}/events`);
  },

  async listEntities(documentId: string) {
    return request<{ entities: EntityRecord[] }>(`/api/documents/${documentId}/entities`);
  },

  async getChunkAssets(chunkIds: string[]) {
    return request<{
      chunks: Array<ChunkRecord & { document?: DocumentRecord | null }>;
      events: Array<EventRecord & { entities: EntityRecord[] }>;
      entities: EntityRecord[];
    }>("/api/chunks/assets", {
      method: "POST",
      body: JSON.stringify({ chunkIds })
    });
  },

  async updateChunk(chunkId: string, input: { heading?: string | null; content?: string; rawContent?: string | null }) {
    return request<{ chunk: ChunkRecord }>(`/api/chunks/${chunkId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async deleteChunk(chunkId: string) {
    return request<{ deleted: boolean }>(`/api/chunks/${chunkId}`, {
      method: "DELETE"
    });
  },

  async updateDocument(
    documentId: string,
    input: {
      title?: string;
      sourceName?: string | null;
      sourceType?: string | null;
      sourceDate?: string | null;
      sourceAuthor?: string | null;
      sourceUrl?: string | null;
    }
  ) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async archiveDocument(documentId: string) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}/archive`, {
      method: "POST"
    });
  },

  async restoreDocument(documentId: string) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}/restore`, {
      method: "POST"
    });
  },

  async deleteDocument(documentId: string) {
    return request<{ deleted: boolean }>(`/api/documents/${documentId}?permanent=true`, {
      method: "DELETE"
    });
  },

  async getEvent(eventId: string) {
    return request<EventDetailRecord>(`/api/events/${eventId}`);
  },

  async updateEvent(eventId: string, input: { title?: string; summary?: string; content?: string }) {
    return request<{ detail: EventDetailRecord }>(`/api/events/${eventId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async deleteEvent(eventId: string) {
    return request<{ deleted: boolean }>(`/api/events/${eventId}`, {
      method: "DELETE"
    });
  },

  async getEntity(entityId: string) {
    return request<EntityDetailRecord>(`/api/entities/${entityId}`);
  },

  async getEntitiesKnowledgeBundle(entityIds: string[]) {
    return request<{
      entities: Array<
        EntityRecord & {
          description?: string | null;
          sourceName?: string | null;
          eventCount: number;
        }
      >;
      events: EventRecord[];
    }>("/api/entities/knowledge-bundle", {
      method: "POST",
      body: JSON.stringify({ entityIds }),
    });
  },

  async getChemicalKnowledgeBundle(input: {
    terms: string[];
    cas?: string;
    projectId?: string;
  }) {
    return request<{
      entities: Array<
        EntityRecord & {
          description?: string | null;
          sourceName?: string | null;
          eventCount: number;
        }
      >;
      events: EventRecord[];
    }>("/api/entities/chemical-knowledge", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async updateEntity(entityId: string, input: { type?: string; name?: string; description?: string | null }) {
    return request<{ detail: EntityDetailRecord }>(`/api/entities/${entityId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async deleteEntity(entityId: string) {
    return request<{ deleted: boolean }>(`/api/entities/${entityId}`, {
      method: "DELETE"
    });
  },

  async uploadDocument(input: {
    sourceId?: string;
    title?: string;
    fileName: string;
    content: string;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }) {
    return request<{
      sourceId: string;
      documentId: string;
      chunkCount: number;
      eventCount: number;
      document: DocumentRecord | null;
    }>("/api/documents/upload", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async createUploadJob(input: {
    sourceId?: string;
    title?: string;
    fileName: string;
    content: string;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }) {
    return request<{ job: UploadJobRecord }>("/api/documents/upload/jobs", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async importStructuredKnowledge(input: {
    sourceId: string;
    title?: string;
    fileName?: string;
    format?: ManualImportFormat;
    content: string;
  }) {
    return request<{
      sourceId: string;
      documentId: string;
      documentIds: string[];
      documentCount: number;
      chunkCount: number;
      eventCount: number;
      document: DocumentRecord | null;
    }>("/api/documents/import-structured", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async createStructuredImportJob(input: {
    sourceId: string;
    title?: string;
    fileName?: string;
    format?: ManualImportFormat;
    content: string;
  }) {
    return request<{ job: UploadJobRecord }>("/api/documents/import-structured/jobs", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async createStructuredImportFileJob(input: {
    sourceId: string;
    title?: string;
    fileName: string;
    format?: ManualImportFormat;
    file: File;
  }) {
    const params = new URLSearchParams({
      sourceId: input.sourceId,
      fileName: input.fileName,
      format: input.format ?? "auto"
    });
    if (input.title?.trim()) {
      params.set("title", input.title.trim());
    }
    return request<{ job: UploadJobRecord }>(
      `/api/documents/import-structured/file/jobs?${params.toString()}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream"
        },
        body: input.file
      }
    );
  },

  async getStructuredImportJob(jobId: string) {
    return request<{ job: UploadJobRecord }>(`/api/documents/import-structured/jobs/${jobId}`);
  },

  async getUploadJob(jobId: string) {
    return request<{ job: UploadJobRecord }>(`/api/documents/upload/jobs/${jobId}`);
  },

  async listModelCallLogs(afterSequence = 0) {
    return request<{
      logs: ModelCallLogRecord[];
      latestSequence: number;
    }>(`/api/model-call-logs?after=${encodeURIComponent(String(afterSequence))}`);
  },

  async search(input: {
    query: string;
    sourceIds: string[];
    searchMode?: SearchMode;
    topK?: number;
  }) {
    return request<SearchResult>("/api/search", {
      method: "POST",
      body: JSON.stringify({
        query: input.query,
        sourceIds: input.sourceIds,
        strategy: "multi",
        searchMode: input.searchMode ?? "fast",
        returnTrace: true,
        topK: input.topK
      })
    });
  },

  async streamSearch(input: {
    query: string;
    sourceIds: string[];
    searchMode?: SearchMode;
    topK?: number;
  }, onEvent: (event: SearchStreamEvent) => void) {
    const response = await fetch("/api/search/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: input.query,
        sourceIds: input.sourceIds,
        strategy: "multi",
        searchMode: input.searchMode ?? "fast",
        returnTrace: true,
        topK: input.topK
      })
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `请求失败：${response.status}`);
    }
    await readSseStream(response, onEvent);
  },

  async listMcpSessions(projectId?: string) {
    if (projectId) {
      return request<{ sessions: McpSessionRecord[] }>(`/api/projects/${projectId}/mcp/sessions`);
    }
    return request<{ sessions: McpSessionRecord[] }>("/api/mcp/sessions");
  },

  async createMcpSession(input: { title?: string; sourceIds?: string[] }) {
    return request<{ session: McpSessionRecord }>("/api/mcp/sessions", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async getMcpSession(sessionId: string) {
    return request<McpSessionDetail>(`/api/mcp/sessions/${sessionId}`);
  },

  async clearMcpSession(sessionId: string) {
    return request<McpSessionDetail>(`/api/mcp/sessions/${sessionId}/clear`, {
      method: "POST"
    });
  },

  async deleteMcpSession(sessionId: string) {
    return request<{ deleted: boolean }>(`/api/mcp/sessions/${sessionId}`, {
      method: "DELETE"
    });
  },

  async sendMcpMessage(sessionId: string, content: string) {
    return request<{
      detail: McpSessionDetail;
    }>(`/api/mcp/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content })
    });
  },

  async streamMcpMessage(
    sessionId: string,
    content: string,
    onEvent: (event: McpStreamEvent) => void,
    options: { signal?: AbortSignal; autoMermaid?: boolean } = {}
  ) {
    const response = await fetch(`/api/mcp/sessions/${sessionId}/messages/stream`, {
      method: "POST",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content,
        autoMermaid: options.autoMermaid ?? false
      })
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `请求失败：${response.status}`);
    }

    await readSseStream(response, onEvent);
  },

  async getAiSettings() {
    return request<{ settings: PublicAiProviderSettings }>("/api/settings/ai");
  },

  async getMcpSettings() {
    return request<{ settings: PublicMcpSettings }>("/api/settings/mcp");
  },

  async updateAiSettings(input: {
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
    answerSystemPrompt: string;
    mermaidTemplate: string;
    mermaidPendingText: string;
    mcpSearchMode: SearchMode;
    graphDefaultLayoutStyle: string;
    welcomePromptTemplates: string[];
    longTermMemoryEnabled: boolean;
  }) {
    return request<{ settings: PublicAiProviderSettings }>("/api/settings/ai", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  }
};

function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function readSseStream<T>(
  response: Response,
  onEvent: (event: T) => void,
) {
  if (!response.body) {
    throw new Error("流式响应没有可读取的内容。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  let streamClosed = false;

  const consumeFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    const namedEvent = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error("流式响应包含无法解析的事件数据。");
    }
    const eventTypeFromData =
      parsed && typeof parsed === "object" && "type" in parsed
        ? (parsed as { type?: unknown }).type
        : undefined;
    const eventType =
      typeof eventTypeFromData === "string" ? eventTypeFromData : namedEvent;
    if (eventType === "error") {
      const message =
        parsed && typeof parsed === "object" && "message" in parsed
          ? (parsed as { message?: unknown }).message
          : undefined;
      throw new Error(
        typeof message === "string" && message.trim()
          ? message
          : "服务端报告流式处理失败。",
      );
    }
    onEvent(parsed as T);
    return eventType === "done";
  };

  try {
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) {
        streamClosed = true;
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (consumeFrame(part)) {
          sawDone = true;
          break;
        }
      }
    }

    if (!sawDone && buffer.trim()) {
      sawDone = consumeFrame(buffer);
    }
  } finally {
    if (!streamClosed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  if (!sawDone) {
    throw new Error("流式连接在完成事件到达前提前中断，请重试。");
  }
}
