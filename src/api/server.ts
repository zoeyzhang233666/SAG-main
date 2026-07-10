import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";
import { ingestionService } from "../services/ingestion-service.js";
import { searchService } from "../services/search-service.js";
import { graphService } from "../services/graph-service.js";
import { logger } from "../observability/logger.js";
import { webuiService } from "../services/webui-service.js";
import { mcpAgentService } from "../services/mcp-agent-service.js";
import { aiSettingsService } from "../services/ai-settings-service.js";
import { getPublicMcpSettings } from "../services/mcp-settings-service.js";
import { listModelCallLogs } from "../observability/model-call-log.js";
import { projectExportService } from "../services/project-export-service.js";
import { llmClient } from "../ai/llm-client.js";

const rootDir = process.cwd();
const webDistDir = path.join(rootDir, "web", "dist");
const webIndexFile = path.join(webDistDir, "index.html");
const MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;

const ingestSchema = z.object({
  sourceId: z.string().uuid().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  extract: z.boolean().optional(),
  waitForCompletion: z.boolean().optional(),
  chunking: z.object({
    mode: z.enum(["heading_strict", "token"]).optional(),
    maxTokens: z.number().int().min(64).max(8192).optional(),
    overlapTokens: z.number().int().min(0).max(4096).optional()
  }).optional()
});

const searchSchema = z.object({
  query: z.string().min(1),
  sourceIds: z.array(z.string().uuid()).min(1),
  strategy: z.enum(["vector", "multi"]).optional(),
  searchMode: z.enum(["standard", "fast"]).optional(),
  subStrategy: z.enum(["multi", "multi1", "hopllm"]).optional(),
  topK: z.number().int().positive().max(50).optional(),
  returnTrace: z.boolean().optional(),
  multi: z.object({
    entityTopK: z.number().int().positive().optional(),
    multiTopK: z.number().int().positive().optional(),
    keySimilarityThreshold: z.number().min(0).max(1).optional(),
    similarityThreshold: z.number().min(0).max(1).optional(),
    maxHops: z.number().int().min(0).max(10).optional(),
    maxEvents: z.number().int().positive().optional(),
    maxEventsA: z.number().int().positive().optional(),
    maxEventsB: z.number().int().min(0).optional(),
    maxHopRetries: z.number().int().positive().max(10).optional(),
    rerankTopK: z.number().int().positive().max(20).optional(),
    maxSections: z.number().int().positive().max(50).optional()
  }).optional()
});

const uploadSchema = z.object({
  sourceId: z.string().uuid().optional(),
  title: z.string().min(1).optional(),
  fileName: z.string().min(1),
  content: z.string(),
  extract: z.boolean().optional(),
  chunking: z.object({
    mode: z.enum(["heading_strict", "token"]).optional(),
    maxTokens: z.number().int().min(64).max(8192).optional(),
    overlapTokens: z.number().int().min(0).max(4096).optional()
  }).optional()
});

const structuredImportSchema = z.object({
  sourceId: z.string().uuid(),
  title: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  format: z.enum(["auto", "json", "csv", "markdown"]).default("auto"),
  content: z.string().min(1)
});

const structuredImportFileJobQuerySchema = z.object({
  sourceId: z.string().uuid(),
  title: z.string().min(1).optional(),
  fileName: z.string().min(1),
  format: z.enum(["auto", "json", "csv", "markdown"]).default("auto")
});

const exportFilesQuerySchema = z.object({
  format: z.enum(["csv", "json"]).default("csv"),
  profile: z.enum(["simple", "full"]).default("simple"),
  split: z.enum(["none", "documents", "size"]).default("none"),
  maxBytes: z.coerce.number().int().min(128 * 1024).max(1024 * 1024 * 1024).optional()
});

const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable()
});


const graphQuerySchema = z.object({
  chunkIds: z.string().optional(),
  eventIds: z.string().optional(),
  entityIds: z.string().optional(),
  query: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().positive().max(300).optional()
});

function parseUuidList(value?: string) {
  if (!value) return [] as string[];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => z.string().uuid().parse(item));
}

const projectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable()
});

const documentUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  sourceName: z.string().optional().nullable(),
  sourceType: z.string().optional().nullable(),
  sourceDate: z.string().optional().nullable(),
  sourceAuthor: z.string().optional().nullable(),
  sourceUrl: z.string().optional().nullable()
});

const chunkUpdateSchema = z.object({
  heading: z.string().optional().nullable(),
  content: z.string().min(1).optional(),
  rawContent: z.string().optional().nullable()
});

const eventUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  summary: z.string().optional(),
  content: z.string().min(1).optional()
});

const entityUpdateSchema = z.object({
  type: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable()
});

const createMcpSessionSchema = z.object({
  title: z.string().min(1).optional(),
  sourceIds: z.array(z.string().uuid()).optional()
});

const mcpMessageSchema = z.object({
  content: z.string().min(1),
  autoMermaid: z.boolean().optional().default(false)
});

const mermaidRepairSchema = z.object({
  source: z.string().min(1).max(20000),
  error: z.string().max(4000).optional()
});

const chunkAssetsSchema = z.object({
  chunkIds: z.array(z.string().uuid()).min(1).max(50)
});

const aiSettingsSchema = z.object({
  embeddingBaseUrl: z.string().url(),
  embeddingModel: z.string().min(1),
  embeddingDimensions: z.literal(SUPPORTED_EMBEDDING_DIMENSIONS),
  embeddingApiKey: z.string().optional(),
  clearEmbeddingApiKey: z.boolean().optional(),
  llmBaseUrl: z.string().url(),
  llmModel: z.string().min(1),
  llmApiKey: z.string().optional(),
  clearLlmApiKey: z.boolean().optional(),
  llmTimeoutMs: z.number().int().positive(),
  llmMaxRetries: z.number().int().min(0).max(10),
  defaultSearchMode: z.enum(["standard", "fast"]).default("fast"),
  defaultSearchTopK: z.number().int().min(1).max(50).default(10),
  defaultChunkingMode: z.enum(["heading_strict", "token"]).default("heading_strict"),
  chunkTokenLimit: z.number().int().min(64).max(8192).default(512),
  chunkOverlapTokens: z.number().int().min(0).max(4096).default(100),
  answerSystemPrompt: z.string().max(12000).optional(),
  mermaidTemplate: z.string().max(20000).optional(),
  mermaidPendingText: z.string().max(200).optional(),
  mcpSearchMode: z.enum(["standard", "fast"]).optional(),
  graphDefaultLayoutStyle: z.enum(["search_layers", "entity_inner", "columns", "spiral"]).optional(),
  welcomePromptTemplates: z.array(z.string().max(800)).max(8).optional(),
  longTermMemoryEnabled: z.boolean().optional()
});

export function buildHttpServer() {
  const app = Fastify({
    bodyLimit: MAX_HTTP_BODY_BYTES,
    logger: {
      level: config.LOG_LEVEL,
      base: {
        service: "sag"
      }
    }
  });

  app.get("/health", async () => ({
    ok: true,
    service: "sag"
  }));

  /**
   * 局域网 / 临时分享权限保护：
   *
   * - ADMIN_SHARE_TOKEN：管理员口令，拥有全部权限。
   * - PUBLIC_SHARE_TOKEN：上司/试用口令，可以查看、问答、新增、导入和普通编辑。
   *   但是不能删除、归档、清空会话，也不能修改 AI 设置。
   *
   * 不设置这两个环境变量时，项目保持原来的无登录模式。
   */
  const viewerShareToken = process.env.PUBLIC_SHARE_TOKEN?.trim() ?? "";
  const adminShareToken = process.env.ADMIN_SHARE_TOKEN?.trim() ?? "";

  app.get("/share-login", async (request, reply) => {
    const query = request.query as { token?: string };
    const token = String(query.token ?? "").trim();

    if (!viewerShareToken || !adminShareToken) {
      return reply.code(500).type("text/html; charset=utf-8").send(`
        <h2>分享模式未配置</h2>
        <p>请先在项目根目录的 .env 文件里设置 PUBLIC_SHARE_TOKEN 和 ADMIN_SHARE_TOKEN。</p>
      `);
    }

    if (token !== viewerShareToken && token !== adminShareToken) {
      return reply.code(403).type("text/html; charset=utf-8").send(`
        <h2>访问口令无效</h2>
        <p>请联系管理员重新获取访问链接。</p>
      `);
    }

    const cookieParts = [
      `sag_share_token=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=2592000"
    ];

    if (request.headers["x-forwarded-proto"] === "https") {
      cookieParts.push("Secure");
    }

    reply.header("Set-Cookie", cookieParts.join("; "));
    return reply.redirect("/");
  });

  app.addHook("onRequest", async (request, reply) => {
    // 两个口令都不设置时，不启用分享权限保护，项目保持原样。
    if (!viewerShareToken && !adminShareToken) {
      return;
    }

    const pathOnly = request.url.split("?")[0] ?? "/";

    if (pathOnly === "/health" || pathOnly === "/share-login") {
      return;
    }

    const token = getCookieValue(request, "sag_share_token");
    const isAdmin = Boolean(adminShareToken && token === adminShareToken);
    const isViewer = Boolean(viewerShareToken && token === viewerShareToken);

    if (!isAdmin && !isViewer) {
      return reply.code(401).type("text/html; charset=utf-8").send(`
        <h2>需要授权访问</h2>
        <p>请使用管理员提供的访问链接进入系统。</p>
      `);
    }

    if (isAdmin) {
      return;
    }

    if (isViewerAllowedRequest(request.method, pathOnly)) {
      return;
    }

    return reply.code(403).send({
      error: {
        code: "VIEWER_FORBIDDEN",
        message: "当前账号可以查看、问答和新增数据，但不能删除、归档、清空会话或修改系统 AI 设置。"
      }
    });
  });

  app.get("/api/model-call-logs", async (request) => {
    const query = request.query as { after?: string };
    const after = query.after ? Number(query.after) : 0;
    return listModelCallLogs(Number.isFinite(after) ? after : 0);
  });

  app.post("/api/mermaid/repair", async (request) => {
    const input = mermaidRepairSchema.parse(request.body);
    const repairedSource = await llmClient.repairMermaidDiagram(input);
    return {
      repairedSource
    };
  });

  app.get("/sources", async (request) => {
    const query = request.query as { limit?: string; cursor?: string };
    return {
      sources: await graphService.listSources({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor
      })
    };
  });

  app.get("/api/sources", async (request) => {
    const query = request.query as { limit?: string; cursor?: string };
    return {
      sources: await webuiService.listSources({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor
      })
    };
  });

  app.get("/api/projects", async (request) => {
    const query = request.query as { limit?: string; cursor?: string; includeArchived?: string };
    return {
      projects: await webuiService.listProjects({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor,
        includeArchived: query.includeArchived === "true"
      })
    };
  });

  app.post("/api/projects", async (request, reply) => {
    const input = projectSchema.parse(request.body);
    const project = await webuiService.createProject(input);
    return reply.code(201).send({ project });
  });

  app.patch("/api/projects/:projectId", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    const input = projectUpdateSchema.parse(request.body);
    return {
      project: await webuiService.updateProject(params.projectId, input)
    };
  });

  app.post("/api/projects/:projectId/archive", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      project: await webuiService.archiveProject(params.projectId)
    };
  });

  app.post("/api/projects/:projectId/restore", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      project: await webuiService.restoreProject(params.projectId)
    };
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    const params = request.params as { projectId: string };
    const query = request.query as { permanent?: string };
    z.string().uuid().parse(params.projectId);
    if (query.permanent !== "true") {
      return reply.code(400).send({
        error: {
          code: "PERMANENT_CONFIRMATION_REQUIRED",
          message: "永久删除项目必须显式传入 permanent=true"
        }
      });
    }
    return webuiService.deleteProject(params.projectId);
  });

  app.get("/api/sources/:sourceId/documents", async (request) => {
    const params = request.params as { sourceId: string };
    const query = request.query as { includeArchived?: string };
    z.string().uuid().parse(params.sourceId);
    return {
      documents: await webuiService.listDocuments(params.sourceId, {
        includeArchived: query.includeArchived === "true"
      })
    };
  });

  app.get("/api/projects/:projectId/documents", async (request) => {
    const params = request.params as { projectId: string };
    const query = request.query as { includeArchived?: string };
    z.string().uuid().parse(params.projectId);
    return {
      documents: await webuiService.listDocuments(params.projectId, {
        includeArchived: query.includeArchived === "true"
      })
    };
  });

  app.get("/api/projects/:projectId/stats", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      stats: await webuiService.getProjectStats(params.projectId)
    };
  });

  app.get("/api/projects/:projectId/graph", async (request) => {
    const params = request.params as { projectId: string };
    const query = graphQuerySchema.parse(request.query);
    z.string().uuid().parse(params.projectId);
    return {
      graph: await webuiService.getProjectGraph(params.projectId, {
        chunkIds: parseUuidList(query.chunkIds),
        eventIds: parseUuidList(query.eventIds),
        entityIds: parseUuidList(query.entityIds),
        query: query.query,
        limit: query.limit
      })
    };
  });

  app.get("/api/projects/:projectId/chunks", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      chunks: await webuiService.listProjectChunks(params.projectId)
    };
  });

  app.get("/api/projects/:projectId/events", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      events: await webuiService.listProjectEvents(params.projectId)
    };
  });

  app.get("/api/projects/:projectId/entities", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      entities: await webuiService.listProjectEntities(params.projectId)
    };
  });

  async function sendProjectExport(
    request: FastifyRequest,
    reply: FastifyReply,
    forcedProfile?: "simple" | "full"
  ) {
    const params = request.params as { projectId: string };
    const query = request.query as { format?: string; profile?: string };
    z.string().uuid().parse(params.projectId);
    const format = z.enum(["csv", "json"]).default("csv").parse(query.format);
    const profile = forcedProfile ?? z.enum(["simple", "full"]).default("simple").parse(query.profile);
    const exported = await projectExportService.exportProject(params.projectId, format, profile);
    return reply
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(exported.fileName)}`)
      .header("X-Export-Profile", profile)
      .type(exported.contentType)
      .send(exported.content);
  }

  async function sendProjectExportFiles(
    request: FastifyRequest,
    reply: FastifyReply,
    forcedProfile?: "simple" | "full"
  ) {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    const query = exportFilesQuerySchema.parse(request.query);
    const profile = forcedProfile ?? query.profile;
    const exported = await projectExportService.exportProjectArchive(params.projectId, {
      format: query.format,
      profile,
      split: query.split,
      maxBytes: query.maxBytes
    });
    return reply
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(exported.fileName)}`)
      .header("X-Export-Profile", profile)
      .header("X-Export-File-Count", String(exported.fileCount))
      .header("X-Export-Document-Count", String(exported.documentCount))
      .type(exported.contentType)
      .send(exported.content);
  }

  app.get("/api/projects/:projectId/export-simple", async (request, reply) => {
    return sendProjectExport(request, reply, "simple");
  });

  app.get("/api/projects/:projectId/export-full", async (request, reply) => {
    return sendProjectExport(request, reply, "full");
  });

  app.get("/api/projects/:projectId/export", async (request, reply) => {
    return sendProjectExport(request, reply);
  });

  app.get("/api/projects/:projectId/export-files-simple", async (request, reply) => {
    return sendProjectExportFiles(request, reply, "simple");
  });

  app.get("/api/projects/:projectId/export-files-full", async (request, reply) => {
    return sendProjectExportFiles(request, reply, "full");
  });

  app.get("/api/projects/:projectId/export-files", async (request, reply) => {
    return sendProjectExportFiles(request, reply);
  });

  app.post("/api/documents/upload", async (request, reply) => {
    const input = uploadSchema.parse(request.body);
    const result = await webuiService.uploadDocument(input);
    return reply.code(201).send(result);
  });

  app.post("/api/documents/upload/jobs", async (request, reply) => {
    const input = uploadSchema.parse(request.body);
    const job = await webuiService.createUploadJob(input);
    return reply.code(202).send({ job });
  });

  app.post("/api/documents/import-structured", async (request, reply) => {
    const input = structuredImportSchema.parse(request.body);
    const result = await webuiService.importStructuredKnowledge(input);
    return reply.code(201).send(result);
  });

  app.post("/api/documents/import-structured/jobs", async (request, reply) => {
    const input = structuredImportSchema.parse(request.body);
    const job = await webuiService.createStructuredImportJob(input);
    return reply.code(202).send({ job });
  });

  app.post("/api/documents/import-structured/file/jobs", async (request, reply) => {
    const query = structuredImportFileJobQuerySchema.parse(request.query);
    const rawBody = request.body;
    const content =
      typeof rawBody === "string"
        ? rawBody
        : Buffer.isBuffer(rawBody)
          ? rawBody.toString("utf8")
          : "";
    const input = structuredImportSchema.parse({
      ...query,
      content
    });
    const job = await webuiService.createStructuredImportJob(input);
    return reply.code(202).send({ job });
  });

  app.get("/api/documents/import-structured/jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId: string };
    z.string().uuid().parse(params.jobId);
    const job = webuiService.getUploadJob(params.jobId);
    if (!job) {
      return reply.code(404).send(notFound("IMPORT_JOB_NOT_FOUND", "导入任务不存在"));
    }
    return { job };
  });

  app.get("/api/documents/upload/jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId: string };
    z.string().uuid().parse(params.jobId);
    const job = webuiService.getUploadJob(params.jobId);
    if (!job) {
      return reply.code(404).send(notFound("UPLOAD_JOB_NOT_FOUND", "上传任务不存在"));
    }
    return { job };
  });

  app.get("/api/documents/:documentId", async (request, reply) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    const document = await webuiService.getDocument(params.documentId);
    if (!document) {
      return reply.code(404).send(notFound("DOCUMENT_NOT_FOUND", "文档不存在"));
    }
    return { document };
  });

  app.patch("/api/documents/:documentId", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    const input = documentUpdateSchema.parse(request.body);
    return {
      document: await webuiService.updateDocument(params.documentId, input)
    };
  });

  app.post("/api/documents/:documentId/archive", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      document: await webuiService.archiveDocument(params.documentId)
    };
  });

  app.post("/api/documents/:documentId/restore", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      document: await webuiService.restoreDocument(params.documentId)
    };
  });

  app.delete("/api/documents/:documentId", async (request, reply) => {
    const params = request.params as { documentId: string };
    const query = request.query as { permanent?: string };
    z.string().uuid().parse(params.documentId);
    if (query.permanent !== "true") {
      return reply.code(400).send({
        error: {
          code: "PERMANENT_CONFIRMATION_REQUIRED",
          message: "永久删除文档必须显式传入 permanent=true"
        }
      });
    }
    return webuiService.deleteDocument(params.documentId);
  });

  app.get("/api/documents/:documentId/chunks", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      chunks: await webuiService.listChunks(params.documentId)
    };
  });

  app.patch("/api/chunks/:chunkId", async (request) => {
    const params = request.params as { chunkId: string };
    z.string().uuid().parse(params.chunkId);
    const input = chunkUpdateSchema.parse(request.body);
    return {
      chunk: await webuiService.updateChunk(params.chunkId, input)
    };
  });

  app.delete("/api/chunks/:chunkId", async (request) => {
    const params = request.params as { chunkId: string };
    z.string().uuid().parse(params.chunkId);
    return webuiService.deleteChunk(params.chunkId);
  });

  app.get("/api/documents/:documentId/events", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      events: await webuiService.listEvents(params.documentId)
    };
  });

  app.get("/api/documents/:documentId/entities", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      entities: await webuiService.listEntities(params.documentId)
    };
  });

  app.post("/api/chunks/assets", async (request) => {
    const input = chunkAssetsSchema.parse(request.body);
    return webuiService.getKnowledgeAssetsByChunkIds(input.chunkIds);
  });

  app.post("/ingest", async (request, reply) => {
    const input = ingestSchema.parse(request.body);
    const result = await ingestionService.ingestDocument(input);
    return reply.code(201).send(result);
  });

  app.post("/search", async (request) => {
    const input = searchSchema.parse(request.body);
    return searchService.search(input);
  });

  app.post("/api/search", async (request) => {
    const input = searchSchema.parse(request.body);
    return searchService.search(input);
  });

  app.post("/api/search/stream", async (request, reply) => {
    const input = searchSchema.parse(request.body);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      const flush = (reply.raw as typeof reply.raw & { flush?: () => void }).flush;
      if (typeof flush === "function") {
        flush.call(reply.raw);
      }
    };

    try {
      const result = await searchService.search(input, config.DEFAULT_TENANT_ID, (event) => {
        send(event.type, event);
      });
      send("done", {
        type: "done",
        result
      });
    } catch (error) {
      send("error", {
        type: "error",
        message: getErrorMessage(error)
      });
    } finally {
      reply.raw.end();
    }
  });

  app.get("/api/settings/ai", async () => ({
    settings: await aiSettingsService.getPublicSettings()
  }));

  app.get("/api/settings/mcp", async () => ({
    settings: getPublicMcpSettings()
  }));

  app.put("/api/settings/ai", async (request) => {
    const input = aiSettingsSchema.parse(request.body);
    return {
      settings: await aiSettingsService.updateSettings(input)
    };
  });

  app.get("/events/:eventId", async (request, reply) => {
    const params = request.params as { eventId: string };
    const event = await graphService.getEvent(params.eventId);
    if (!event) {
      return reply.code(404).send({
        error: {
          code: "EVENT_NOT_FOUND",
          message: "事件不存在"
        }
      });
    }
    return event;
  });

  app.get("/api/events/:eventId", async (request, reply) => {
    const params = request.params as { eventId: string };
    z.string().uuid().parse(params.eventId);
    const event = await webuiService.getEvent(params.eventId);
    if (!event) {
      return reply.code(404).send(notFound("EVENT_NOT_FOUND", "事件不存在"));
    }
    return event;
  });

  app.patch("/api/events/:eventId", async (request) => {
    const params = request.params as { eventId: string };
    z.string().uuid().parse(params.eventId);
    const input = eventUpdateSchema.parse(request.body);
    return {
      detail: await webuiService.updateEvent(params.eventId, input)
    };
  });

  app.delete("/api/events/:eventId", async (request) => {
    const params = request.params as { eventId: string };
    z.string().uuid().parse(params.eventId);
    return webuiService.deleteEvent(params.eventId);
  });

  app.get("/api/entities/:entityId", async (request, reply) => {
    const params = request.params as { entityId: string };
    z.string().uuid().parse(params.entityId);
    const entity = await webuiService.getEntity(params.entityId);
    if (!entity) {
      return reply.code(404).send(notFound("ENTITY_NOT_FOUND", "实体不存在"));
    }
    return entity;
  });

  app.patch("/api/entities/:entityId", async (request) => {
    const params = request.params as { entityId: string };
    z.string().uuid().parse(params.entityId);
    const input = entityUpdateSchema.parse(request.body);
    return {
      detail: await webuiService.updateEntity(params.entityId, input)
    };
  });

  app.delete("/api/entities/:entityId", async (request) => {
    const params = request.params as { entityId: string };
    z.string().uuid().parse(params.entityId);
    return webuiService.deleteEntity(params.entityId);
  });

  app.post("/api/mcp/sessions", async (request, reply) => {
    const input = createMcpSessionSchema.parse(request.body);
    const session = await mcpAgentService.createSession(input);
    return reply.code(201).send({ session });
  });

  app.get("/api/mcp/sessions", async () => ({
    sessions: await mcpAgentService.listSessions()
  }));

  app.get("/api/projects/:projectId/mcp/sessions", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      sessions: await mcpAgentService.listSessions({ sourceId: params.projectId })
    };
  });

  app.get("/api/mcp/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const detail = await mcpAgentService.getSession(params.sessionId);
    if (!detail) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return detail;
  });

  app.post("/api/mcp/sessions/:sessionId/clear", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const detail = await mcpAgentService.clearSession(params.sessionId);
    if (!detail) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return detail;
  });

  app.delete("/api/mcp/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    return mcpAgentService.deleteSession(params.sessionId);
  });

  app.post("/api/mcp/sessions/:sessionId/messages", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const input = mcpMessageSchema.parse(request.body);
    const result = await mcpAgentService.runUserMessage({
      sessionId: params.sessionId,
      content: input.content,
      autoMermaid: input.autoMermaid
    });
    return reply.code(201).send(result);
  });

  app.post("/api/mcp/sessions/:sessionId/messages/stream", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const input = mcpMessageSchema.parse(request.body);
    const abortController = new AbortController();
    let completed = false;
    const abortRun = () => {
      if (!completed) {
        abortController.abort();
      }
    };
    request.raw.on("aborted", abortRun);
    reply.raw.on("close", abortRun);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });
    reply.raw.write(": connected\n\n");
    const heartbeat = setInterval(() => {
      if (!abortController.signal.aborted && !reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(": heartbeat\n\n");
      }
    }, 15_000);

    const send = (event: string, data: unknown) => {
      if (abortController.signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) {
        return;
      }
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await mcpAgentService.runUserMessage({
        sessionId: params.sessionId,
        content: input.content,
        autoMermaid: input.autoMermaid,
        signal: abortController.signal
      }, config.DEFAULT_TENANT_ID, (event) => {
        send(event.type, event);
      });
    } catch (error) {
      if (!isAbortError(error)) {
        send("error", {
          type: "error",
          message: getErrorMessage(error)
        });
      }
    } finally {
      completed = true;
      clearInterval(heartbeat);
      request.raw.off("aborted", abortRun);
      reply.raw.off("close", abortRun);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  if (fs.existsSync(webIndexFile)) {
    app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/"
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/health") {
        return reply.code(404).send(notFound("NOT_FOUND", "接口不存在"));
      }
      return reply.type("text/html").send(fs.readFileSync(webIndexFile, "utf8"));
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    const fastifyStatusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : null;
    const payloadTooLarge = (error as { code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
      getErrorMessage(error).includes("超过");
    const statusCode = error instanceof z.ZodError
      ? 400
      : payloadTooLarge
        ? 413
        : fastifyStatusCode && fastifyStatusCode >= 400 && fastifyStatusCode < 600
          ? fastifyStatusCode
          : 500;
    const logPayload = { error, statusCode };
    if (statusCode >= 500) {
      logger.error(logPayload, "request failed");
    } else {
      logger.warn(logPayload, "request validation failed");
    }
    reply.code(statusCode).send({
      error: {
        code: statusCode === 400
          ? "BAD_REQUEST"
          : statusCode === 413
            ? "PAYLOAD_TOO_LARGE"
            : "INTERNAL_ERROR",
        message: getErrorMessage(error)
      }
    });
  });

  return app;
}

function notFound(code: string, message: string) {
  return {
    error: {
      code,
      message
    }
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "请求参数无效";
  }
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getCookieValue(request: FastifyRequest, name: string): string | null {
  const cookieHeader = request.headers.cookie;

  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");

    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return null;
}

function isViewerAllowedRequest(method: string, pathOnly: string): boolean {
  // 上司/试用用户可以打开页面、查看数据、问答、新建项目、上传/导入数据、普通编辑。
  // 但是不允许任何真正删除、归档、清空会话，或修改 AI 设置的操作。

  if (method === "DELETE") {
    return false;
  }

  if (method === "POST") {
    if (/^\/api\/projects\/[^/]+\/archive$/.test(pathOnly)) {
      return false;
    }

    if (/^\/api\/documents\/[^/]+\/archive$/.test(pathOnly)) {
      return false;
    }

    if (/^\/api\/mcp\/sessions\/[^/]+\/clear$/.test(pathOnly)) {
      return false;
    }
  }

  if (method === "PUT" && pathOnly === "/api/settings/ai") {
    return false;
  }

  return true;
}

export async function startHttpServer(): Promise<void> {
  const app = buildHttpServer();
  await app.listen({
    host: config.HTTP_HOST,
    port: config.HTTP_PORT
  });
}
