import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { config } from "../config/env.js";
import {
  archiveDocument,
  archiveSource,
  createSource,
  deleteChunk,
  deleteDocument,
  deleteEntity,
  deleteEvent,
  deleteSource,
  getEntityDetail,
  getKnowledgeAssetsByChunkIds,
  getDocumentDetail,
  getEventDetail,
  getProjectGraph,
  getProjectStats,
  getSource,
  listChunksByDocument,
  listChunksByProject,
  listDocumentsBySource,
  listEntitiesByDocument,
  listEntitiesByProject,
  listEventsByDocument,
  listEventsByProject,
  listSources,
  matchChainAtlasEntities,
  getEntitiesKnowledgeBundle,
  restoreDocument,
  restoreSource,
  searchProjectGraphSuggestions,
  updateChunk,
  updateDocument,
  updateEntity,
  updateEvent,
  updateSource
} from "../db/repositories.js";
import { parseManualKnowledgeDocuments, type ManualImportFormat, type ManualKnowledgeDocument } from "../ingestion/manual-import.js";
import { MAX_STRUCTURED_TEXT_BYTES, stageStructuredImportFile } from "../ingestion/structured-import-file.js";
import { logger } from "../observability/logger.js";
import { ingestionService } from "./ingestion-service.js";
import { manualIngestionService } from "./manual-ingestion-service.js";
import type { ChunkingMode, IngestProgressStage, IngestProgressUpdate } from "../types.js";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([".md", ".txt"]);

type UploadJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
type UploadJobKind = "upload" | "structured-import";

export interface UploadJobRecord {
  kind?: UploadJobKind;
  id: string;
  sourceId: string;
  fileName: string;
  title: string;
  status: UploadJobStatus;
  stage: IngestProgressStage;
  message: string;
  progress: number;
  chunkCount?: number;
  eventCount?: number;
  documentCount?: number;
  currentChunk?: number;
  totalChunks?: number;
  documentId?: string;
  traceId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface StructuredImportJobInput {
  title: string;
  fileName: string;
  sourceId: string;
  format: ManualImportFormat;
  importBytes: number;
  streamed?: boolean;
  readDocuments: () => AsyncIterable<ManualKnowledgeDocument>;
  cleanup?: () => Promise<void>;
}

export class WebuiService {
  private readonly uploadJobs = new Map<string, UploadJobRecord>();

  async listProjects(input: {
    limit?: number;
    cursor?: string;
    includeArchived?: boolean;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    return listSources({
      tenantId,
      limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
      cursor: input.cursor,
      includeArchived: input.includeArchived ?? false
    });
  }

  async listSources(input: { limit?: number; cursor?: string }, tenantId = config.DEFAULT_TENANT_ID) {
    return this.listProjects(input, tenantId);
  }

  async createProject(input: {
    name: string;
    description?: string | null;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const name = input.name.trim();
    if (!name) {
      throw new Error("项目名称不能为空");
    }
    return createSource({
      tenantId,
      name,
      description: input.description?.trim() || undefined,
      metadata: {
        createdVia: "webui",
        semanticType: "project"
      }
    });
  }

  async updateProject(projectId: string, input: {
    name?: string;
    description?: string | null;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const project = await updateSource({
      sourceId: projectId,
      tenantId,
      name: input.name,
      description: input.description
    });
    if (!project) {
      throw new Error("项目不存在");
    }
    return project;
  }

  async archiveProject(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const project = await archiveSource({ sourceId: projectId, tenantId });
    if (!project) {
      throw new Error("项目不存在");
    }
    return project;
  }

  async restoreProject(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const project = await restoreSource({ sourceId: projectId, tenantId });
    if (!project) {
      throw new Error("项目不存在");
    }
    return project;
  }

  async deleteProject(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteSource({ sourceId: projectId, tenantId });
    if (!deleted) {
      throw new Error("项目不存在");
    }
    return { deleted: true };
  }

  async uploadDocument(input: {
    title?: string;
    fileName: string;
    content: string;
    sourceId?: string;
    extract?: boolean;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const fileName = input.fileName.trim();
    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error("只支持上传 .md 和 .txt 文档");
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes === 0) {
      throw new Error("上传文档为空");
    }
    if (bytes > MAX_UPLOAD_BYTES) {
      throw new Error(`上传文档超过 ${MAX_UPLOAD_BYTES} 字节限制`);
    }
    if (!input.sourceId) {
      throw new Error("上传文档必须先选择项目");
    }
    const title = input.title?.trim() || fileName.replace(/\.[^.]+$/, "") || "未命名文档";
    const result = await ingestionService.ingestDocument({
      sourceId: input.sourceId,
      title,
      content: input.content,
      extract: input.extract ?? true,
      chunking: input.chunking,
      metadata: {
        fileName,
        uploadedVia: "webui",
        uploadBytes: bytes
      }
    }, tenantId);
    const document = await getDocumentDetail({
      documentId: result.documentId,
      tenantId
    });
    return {
      ...result,
      document
    };
  }

  async importStructuredKnowledge(input: {
    sourceId: string;
    title?: string;
    fileName?: string;
    format?: ManualImportFormat;
    content: string;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const structuredImport = validateStructuredImportInput(input);
    const documents = parseManualKnowledgeDocuments(structuredImport.content, {
      format: structuredImport.format,
      fileName: structuredImport.fileName,
      fallbackTitle: structuredImport.title
    });
    const results = [];
    for (const document of documents) {
      results.push(await manualIngestionService.ingest({
        sourceId: structuredImport.sourceId,
        document,
        fileName: structuredImport.fileName,
        format: structuredImport.format ?? "auto"
      }, tenantId));
    }
    const first = results[0];
    if (!first) {
      throw new Error("没有可导入的文档");
    }
    return {
      ...first,
      documentIds: results.map((result) => result.documentId),
      documentCount: results.length,
      chunkCount: results.reduce((sum, result) => sum + result.chunkCount, 0),
      eventCount: results.reduce((sum, result) => sum + result.eventCount, 0),
      document: await getDocumentDetail({
        documentId: first.documentId,
        tenantId
      })
    };
  }

  async createStructuredImportJob(input: {
    sourceId: string;
    title?: string;
    fileName?: string;
    format?: ManualImportFormat;
    content: string;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const structuredImport = validateStructuredImportInput(input);
    return this.queueStructuredImport({
      ...structuredImport,
      readDocuments: async function* () {
        yield* parseManualKnowledgeDocuments(structuredImport.content, {
          format: structuredImport.format,
          fileName: structuredImport.fileName,
          fallbackTitle: structuredImport.title
        });
      }
    }, tenantId);
  }

  async createStructuredImportFileJob(input: {
    sourceId: string;
    title?: string;
    fileName: string;
    format: ManualImportFormat;
    stream: Readable;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const source = await getSource(input.sourceId, tenantId);
    if (!source || source.archivedAt) {
      throw Object.assign(new Error("导入数据必须先选择未归档项目"), { statusCode: 404 });
    }
    const fileName = input.fileName.trim() || "structured-import.json";
    const title = input.title?.trim() || fileName.replace(/\.[^.]+$/, "") || "结构化导入";
    const staged = await stageStructuredImportFile(input.stream, { fileName, format: input.format, fallbackTitle: title });
    return this.queueStructuredImport({
      sourceId: input.sourceId, title, fileName, format: input.format, importBytes: staged.bytes,
      streamed: staged.streamed, readDocuments: staged.readDocuments, cleanup: staged.cleanup
    }, tenantId);
  }

  private queueStructuredImport(structuredImport: StructuredImportJobInput, tenantId: string) {
    const now = new Date().toISOString();
    const job: UploadJobRecord = {
      id: randomUUID(),
      kind: "structured-import",
      sourceId: structuredImport.sourceId,
      fileName: structuredImport.fileName,
      title: structuredImport.title || structuredImport.fileName.replace(/\.[^.]+$/, "") || "结构化导入",
      status: "QUEUED",
      stage: "QUEUED",
      message: `等待导入（${formatBytes(structuredImport.importBytes)}）`,
      progress: 0,
      createdAt: now,
      updatedAt: now
    };
    this.uploadJobs.set(job.id, job);
    queueMicrotask(() => {
      void this.runStructuredImportJob(job.id, structuredImport, tenantId);
    });
    return job;
  }

  async createUploadJob(input: {
    title?: string;
    fileName: string;
    content: string;
    sourceId?: string;
    extract?: boolean;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const upload = validateUploadInput(input);
    const now = new Date().toISOString();
    const job: UploadJobRecord = {
      id: randomUUID(),
      kind: "upload",
      sourceId: upload.sourceId,
      fileName: upload.fileName,
      title: upload.title,
      status: "QUEUED",
      stage: "QUEUED",
      message: "等待处理",
      progress: 0,
      createdAt: now,
      updatedAt: now
    };
    this.uploadJobs.set(job.id, job);
    queueMicrotask(() => {
      void this.runUploadJob(job.id, {
        ...upload,
        extract: input.extract,
        chunking: input.chunking
      }, tenantId);
    });
    return job;
  }

  getUploadJob(jobId: string) {
    return this.uploadJobs.get(jobId) ?? null;
  }

  private async runStructuredImportJob(jobId: string, input: StructuredImportJobInput, tenantId: string) {
    let completedChunks = 0;
    let completedEvents = 0;
    let completedDocuments = 0;
    let first: Awaited<ReturnType<typeof manualIngestionService.ingest>> | undefined;
    this.updateUploadJob(jobId, {
      status: "RUNNING",
      stage: "PARSING",
      message: "正在解析结构化导入文件",
      progress: 5
    });
    try {
      const buffered: ManualKnowledgeDocument[] = [];
      let documentCount = 0;
      let totalChunks = 0;
      for await (const document of input.readDocuments()) {
        documentCount += 1;
        totalChunks += document.chunks.length;
        if (!input.streamed) buffered.push(document);
        this.updateUploadJob(jobId, { message: `已校验 ${documentCount} 个文档 · ${totalChunks} 个切片` });
      }
      if (documentCount === 0) throw new Error("没有可导入的文档");

      // Validate the entire file before writing and only keep one document in memory.
      const documents = input.streamed ? input.readDocuments() : buffered;
      this.updateUploadJob(jobId, {
        status: "RUNNING",
        stage: "PARSING",
        message: `解析完成：${documentCount} 个文档，${totalChunks} 个切片`,
        progress: 8,
        documentCount,
        totalChunks,
        currentChunk: 0
      });

      for await (const document of documents) {
        const documentIndex = completedDocuments;
        const result = await manualIngestionService.ingest({
          sourceId: input.sourceId,
          document,
          fileName: input.fileName,
          format: input.format
        }, tenantId, (update) => {
          const documentProgress = Math.max(0, Math.min(100, update.progress));
          const overallProgress = totalChunks > 0
            ? 8 + ((completedChunks + ((update.currentChunk ?? 0) || 0)) / totalChunks) * 90
            : 8 + ((documentIndex + documentProgress / 100) / documentCount) * 90;
          this.updateUploadJob(jobId, {
            status: "RUNNING",
            ...update,
            message: documentCount > 1
              ? `[${documentIndex + 1}/${documentCount}] ${update.message}`
              : update.message,
            progress: Math.min(99, overallProgress),
            documentCount,
            currentChunk: completedChunks + (update.currentChunk ?? 0),
            totalChunks
          });
        });
        completedChunks += result.chunkCount;
        completedEvents += result.eventCount;
        completedDocuments += 1;
        first ??= result;
      }

      if (!first) {
        throw new Error("没有可导入的文档");
      }
      this.updateUploadJob(jobId, {
        status: "COMPLETED",
        stage: "COMPLETED",
        message: `导入完成：${documentCount} 个文档，${completedChunks} 个切片`,
        progress: 100,
        documentId: first.documentId,
        traceId: first.traceId,
        chunkCount: completedChunks,
        eventCount: completedEvents,
        documentCount,
        currentChunk: completedChunks,
        totalChunks
      });
    } catch (error) {
      this.updateUploadJob(jobId, {
        status: "FAILED",
        stage: "FAILED",
        message: completedDocuments > 0 ? `导入中断 · 已保存 ${completedDocuments} 个文档` : "导入失败",
        progress: 100,
        documentCount: completedDocuments,
        documentId: first?.documentId,
        chunkCount: completedChunks,
        eventCount: completedEvents,
        currentChunk: completedChunks,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await input.cleanup?.().catch(error => logger.warn({ error }, "could not remove staged import file"));
    }
  }

  private async runUploadJob(jobId: string, input: {
    title: string;
    fileName: string;
    content: string;
    sourceId: string;
    extract?: boolean;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
    uploadBytes: number;
  }, tenantId: string) {
    this.updateUploadJob(jobId, {
      status: "RUNNING",
      stage: "READING",
      message: "已读取文件，准备提交处理",
      progress: 5
    });
    try {
      const result = await ingestionService.ingestDocument({
        sourceId: input.sourceId,
        title: input.title,
        content: input.content,
        extract: input.extract ?? true,
        chunking: input.chunking,
        metadata: {
          fileName: input.fileName,
          uploadedVia: "webui",
          uploadBytes: input.uploadBytes
        }
      }, tenantId, (update) => this.updateUploadJob(jobId, {
        status: update.stage === "COMPLETED" ? "COMPLETED" : "RUNNING",
        ...update
      }));
      this.updateUploadJob(jobId, {
        status: "COMPLETED",
        stage: "COMPLETED",
        message: `处理完成：${result.chunkCount} 个切片，${result.eventCount} 个事件`,
        progress: 100,
        documentId: result.documentId,
        traceId: result.traceId,
        chunkCount: result.chunkCount,
        eventCount: result.eventCount
      });
    } catch (error) {
      this.updateUploadJob(jobId, {
        status: "FAILED",
        stage: "FAILED",
        message: "处理失败",
        progress: 100,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private updateUploadJob(jobId: string, patch: Partial<UploadJobRecord> & Partial<IngestProgressUpdate>) {
    const existing = this.uploadJobs.get(jobId);
    if (!existing) {
      return;
    }
    this.uploadJobs.set(jobId, {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    });
  }

  async listDocuments(sourceId: string, input: { includeArchived?: boolean } = {}, tenantId = config.DEFAULT_TENANT_ID) {
    return listDocumentsBySource({
      sourceId,
      tenantId,
      limit: 100,
      includeArchived: input.includeArchived ?? false
    });
  }

  async getProjectStats(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getProjectStats({ sourceId: projectId, tenantId });
  }

  async getProjectGraph(
    projectId: string,
    input: { chunkIds?: string[]; eventIds?: string[]; entityIds?: string[]; entityName?: string; query?: string; limit?: number } = {},
    tenantId = config.DEFAULT_TENANT_ID
  ) {
    return getProjectGraph({ sourceId: projectId, tenantId, ...input });
  }

  async searchProjectGraphSuggestions(
    projectId: string,
    input: { query: string; limit?: number },
    tenantId = config.DEFAULT_TENANT_ID
  ) {
    return searchProjectGraphSuggestions({
      sourceId: projectId,
      tenantId,
      query: input.query,
      limit: input.limit
    });
  }

  async updateDocument(
    documentId: string,
    input: {
      title?: string;
      sourceName?: string | null;
      sourceType?: string | null;
      sourceDate?: string | null;
      sourceAuthor?: string | null;
      sourceUrl?: string | null;
    },
    tenantId = config.DEFAULT_TENANT_ID
  ) {
    const document = await updateDocument({
      documentId,
      tenantId,
      title: input.title,
      ...(Object.prototype.hasOwnProperty.call(input, "sourceName") ? { sourceName: input.sourceName } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "sourceType") ? { sourceType: input.sourceType } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "sourceDate") ? { sourceDate: input.sourceDate } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "sourceAuthor") ? { sourceAuthor: input.sourceAuthor } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "sourceUrl") ? { sourceUrl: input.sourceUrl } : {})
    });
    if (!document) {
      throw new Error("文档不存在");
    }
    return document;
  }

  async archiveDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const document = await archiveDocument({ documentId, tenantId });
    if (!document) {
      throw new Error("文档不存在");
    }
    return document;
  }

  async restoreDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const document = await restoreDocument({ documentId, tenantId });
    if (!document) {
      throw new Error("文档不存在");
    }
    return document;
  }

  async deleteDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteDocument({ documentId, tenantId });
    if (!deleted) {
      throw new Error("文档不存在");
    }
    return { deleted: true };
  }

  async getDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getDocumentDetail({ documentId, tenantId });
  }

  async listChunks(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listChunksByDocument({ documentId, tenantId });
  }

  async listProjectChunks(sourceId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listChunksByProject({ sourceId, tenantId });
  }

  async updateChunk(chunkId: string, input: {
    heading?: string | null;
    content?: string;
    rawContent?: string | null;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const chunk = await updateChunk({
      chunkId,
      tenantId,
      ...input
    });
    if (!chunk) {
      throw new Error("切片不存在");
    }
    return chunk;
  }

  async deleteChunk(chunkId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteChunk({ chunkId, tenantId });
    if (!deleted) {
      throw new Error("切片不存在");
    }
    return { deleted: true };
  }

  async listEvents(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listEventsByDocument({ documentId, tenantId });
  }

  async listProjectEvents(sourceId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listEventsByProject({ sourceId, tenantId });
  }

  async updateEvent(eventId: string, input: {
    title?: string;
    summary?: string;
    content?: string;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const event = await updateEvent({
      eventId,
      tenantId,
      ...input
    });
    if (!event) {
      throw new Error("事件不存在");
    }
    return event;
  }

  async deleteEvent(eventId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteEvent({ eventId, tenantId });
    if (!deleted) {
      throw new Error("事件不存在");
    }
    return { deleted: true };
  }

  async listEntities(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listEntitiesByDocument({ documentId, tenantId });
  }

  async listProjectEntities(sourceId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listEntitiesByProject({ sourceId, tenantId });
  }

  async updateEntity(entityId: string, input: {
    type?: string;
    name?: string;
    description?: string | null;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const entity = await updateEntity({
      entityId,
      tenantId,
      ...input
    });
    if (!entity) {
      throw new Error("实体不存在");
    }
    return entity;
  }

  async deleteEntity(entityId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteEntity({ entityId, tenantId });
    if (!deleted) {
      throw new Error("实体不存在");
    }
    return { deleted: true };
  }

  async getKnowledgeAssetsByChunkIds(chunkIds: string[], tenantId = config.DEFAULT_TENANT_ID) {
    return getKnowledgeAssetsByChunkIds({ chunkIds, tenantId });
  }

  async getEvent(eventId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getEventDetail({ eventId, tenantId });
  }

  async matchChainAtlasEntities(input: { names: string[]; projectId?: string }, tenantId = config.DEFAULT_TENANT_ID) {
    return matchChainAtlasEntities({ ...input, tenantId });
  }

  async getEntity(entityId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getEntityDetail({ entityId, tenantId });
  }

  async getEntitiesKnowledgeBundle(entityIds: string[], tenantId = config.DEFAULT_TENANT_ID) {
    return getEntitiesKnowledgeBundle({ entityIds, tenantId });
  }
}

export const webuiService = new WebuiService();

function validateStructuredImportInput(input: {
  sourceId?: string;
  title?: string;
  fileName?: string;
  format?: ManualImportFormat;
  content: string;
}) {
  const importBytes = Buffer.byteLength(input.content, "utf8");
  if (importBytes === 0) {
    throw new Error("导入内容为空");
  }
  if (importBytes > MAX_STRUCTURED_TEXT_BYTES) {
    throw new Error("粘贴内容超过 50 MiB，请选择 JSON 文件导入");
  }
  if (!input.sourceId) {
    throw new Error("导入数据必须先选择项目");
  }
  const fileName = input.fileName?.trim() || "structured-import.json";
  return {
    sourceId: input.sourceId,
    title: input.title?.trim() || fileName.replace(/\.[^.]+$/, "") || "结构化导入",
    fileName,
    format: input.format ?? "auto",
    content: input.content,
    importBytes
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function validateUploadInput(input: {
  title?: string;
  fileName: string;
  content: string;
  sourceId?: string;
}) {
  const fileName = input.fileName.trim();
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("只支持上传 .md 和 .txt 文档");
  }
  const uploadBytes = Buffer.byteLength(input.content, "utf8");
  if (uploadBytes === 0) {
    throw new Error("上传文档为空");
  }
  if (uploadBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`上传文档超过 ${MAX_UPLOAD_BYTES} 字节限制`);
  }
  if (!input.sourceId) {
    throw new Error("上传文档必须先选择项目");
  }
  return {
    fileName,
    title: input.title?.trim() || fileName.replace(/\.[^.]+$/, "") || "未命名文档",
    content: input.content,
    sourceId: input.sourceId,
    uploadBytes
  };
}
