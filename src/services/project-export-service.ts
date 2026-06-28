import { deflateRawSync } from "node:zlib";
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";

export type ProjectExportFormat = "csv" | "json";
export type ProjectExportSplitMode = "none" | "documents" | "size";
export type ProjectExportProfile = "simple" | "full";

export type ProjectExportFile = {
  fileName: string;
  contentType: string;
  content: string;
  bytes: number;
  documentCount: number;
};

export type ProjectExportArchive = {
  fileName: string;
  contentType: string;
  content: string | Buffer;
  bytes: number;
  fileCount: number;
  documentCount: number;
};

type ExportDocument = {
  id: string;
  title: string;
  content: string | null;
  sourceName: string | null;
  sourceType: string | null;
  sourceDate: string | null;
  sourceAuthor: string | null;
  sourceUrl: string | null;
  status: string;
  parseStatus: string;
  metadata: Record<string, unknown>;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ExportChunk = {
  id: string;
  documentId: string | null;
  key: string;
  heading: string;
  content: string;
  rawContent: string | null;
  rank: number;
  metadata: Record<string, unknown>;
};

type ExportEvent = {
  id: string;
  documentId: string | null;
  chunkId: string | null;
  title: string;
  summary: string;
  content: string;
  category: string | null;
  keywords: string[];
  rank: number;
  metadata: Record<string, unknown>;
};

type ExportRelation = {
  eventId: string;
  entityId: string;
  entityType: string;
  entityName: string;
  entityDescription: string;
  relationDescription: string;
};

type ExportProject = {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type ProjectExportData = {
  projectId: string;
  project: ExportProject;
  documents: ExportDocument[];
  chunks: ExportChunk[];
  events: ExportEvent[];
  relations: ExportRelation[];
};

export class ProjectExportService {
  async exportProject(
    projectId: string,
    format: ProjectExportFormat,
    profile: ProjectExportProfile = "simple",
    tenantId = config.DEFAULT_TENANT_ID
  ): Promise<{ fileName: string; contentType: string; content: string }> {
    const [file] = await this.exportProjectFiles(projectId, { format, profile, split: "none" }, tenantId);
    return {
      fileName: file.fileName,
      contentType: file.contentType,
      content: file.content
    };
  }

  async exportProjectFiles(
    projectId: string,
    options: { format: ProjectExportFormat; profile?: ProjectExportProfile; split?: ProjectExportSplitMode; maxBytes?: number },
    tenantId = config.DEFAULT_TENANT_ID
  ): Promise<ProjectExportFile[]> {
    const data = await this.loadProjectData(projectId, tenantId);
    const safeName = sanitizeFileName(data.project.name);
    const split = options.split ?? "none";
    const documentGroups = split === "documents"
      ? data.documents.map((document) => [document])
      : split === "size"
        ? splitDocumentsByApproximateSize(data, options.maxBytes ?? 50 * 1024 * 1024)
        : [data.documents];
    const groups = documentGroups.length > 0 ? documentGroups : [[]];
    const profile = options.profile ?? "simple";
    return groups.map((documents, index) => {
      const fileStem = buildSplitFileStem(safeName, documents, groups.length, index, split);
      return buildExportFile({ ...data, documents }, options.format, fileStem, profile);
    });
  }

  async exportProjectArchive(
    projectId: string,
    options: { format: ProjectExportFormat; profile?: ProjectExportProfile; split?: ProjectExportSplitMode; maxBytes?: number },
    tenantId = config.DEFAULT_TENANT_ID
  ): Promise<ProjectExportArchive> {
    const files = await this.exportProjectFiles(projectId, options, tenantId);
    if (files.length === 1) {
      const [file] = files;
      return {
        ...file,
        fileCount: 1,
        documentCount: file.documentCount
      };
    }
    const zipContent = buildZipArchive(files.map((file) => ({
      fileName: file.fileName,
      content: Buffer.from(file.content, "utf8")
    })));
    const firstStem = files[0]?.fileName.replace(/(?:-part-\d+)?-(?:knowledge-export|simple-import)\.(?:csv|json)$/i, "") || "sag-project";
    const profile = options.profile ?? "simple";
    return {
      fileName: `${firstStem}-${profile === "simple" ? "simple-import" : "knowledge-export"}-bundle.zip`,
      contentType: "application/zip",
      content: zipContent,
      bytes: zipContent.byteLength,
      fileCount: files.length,
      documentCount: files.reduce((sum, file) => sum + file.documentCount, 0)
    };
  }

  private async loadProjectData(projectId: string, tenantId: string): Promise<ProjectExportData> {
    const projectResult = await pool.query(
      `
        select id, name, description, metadata, archived_at, created_at, updated_at
        from sources
        where id = $1 and tenant_id = $2
      `,
      [projectId, tenantId]
    );
    const projectRow = projectResult.rows[0] as Record<string, unknown> | undefined;
    if (!projectRow) {
      throw new Error("项目不存在");
    }

    const [documentsResult, chunksResult, eventsResult, relationsResult] = await Promise.all([
      pool.query(
        `
          select id, title, content, source_name, source_type, source_date, source_author, source_url, status, parse_status, metadata, archived_at, created_at, updated_at
          from documents
          where source_id = $1
          order by created_at, id
        `,
        [projectId]
      ),
      pool.query(
        `
          select id, document_id, heading, content, raw_content, rank, metadata
          from source_chunks
          where source_id = $1
          order by document_id, rank, id
        `,
        [projectId]
      ),
      pool.query(
        `
          select id, document_id, chunk_id, title, summary, content, category, keywords, rank, metadata
          from events
          where source_id = $1 and deleted_at is null
          order by document_id, rank, id
        `,
        [projectId]
      ),
      pool.query(
        `
          select
            ee.event_id,
            ent.id as entity_id,
            ent.type as entity_type,
            ent.name as entity_name,
            coalesce(ent.description, '') as entity_description,
            coalesce(ee.description, ent.description, '') as relation_description
          from event_entities ee
          join events e on e.id = ee.event_id
          join entities ent on ent.id = ee.entity_id
          where e.source_id = $1 and e.deleted_at is null
          order by ee.event_id, ent.type, ent.name
        `,
        [projectId]
      )
    ]);

    const documents: ExportDocument[] = documentsResult.rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      content: row.content == null ? null : String(row.content),
      sourceName: row.source_name == null ? null : String(row.source_name),
      sourceType: row.source_type == null ? null : String(row.source_type),
      sourceDate: row.source_date == null ? null : String(row.source_date),
      sourceAuthor: row.source_author == null ? null : String(row.source_author),
      sourceUrl: row.source_url == null ? null : String(row.source_url),
      status: String(row.status),
      parseStatus: String(row.parse_status),
      metadata: asRecord(row.metadata),
      archivedAt: toIso(row.archived_at),
      createdAt: toIso(row.created_at) ?? "",
      updatedAt: toIso(row.updated_at) ?? ""
    }));
    const chunks: ExportChunk[] = chunksResult.rows.map((row) => {
      const metadata = asRecord(row.metadata);
      return {
        id: String(row.id),
        documentId: row.document_id == null ? null : String(row.document_id),
        key: readMetadataString(metadata, "manualChunkKey") || String(row.id),
        heading: row.heading == null ? "" : String(row.heading),
        content: String(row.content),
        rawContent: row.raw_content == null ? null : String(row.raw_content),
        rank: Number(row.rank ?? 0),
        metadata
      };
    });
    const events: ExportEvent[] = eventsResult.rows.map((row) => ({
      id: String(row.id),
      documentId: row.document_id == null ? null : String(row.document_id),
      chunkId: row.chunk_id == null ? null : String(row.chunk_id),
      title: String(row.title),
      summary: String(row.summary ?? ""),
      content: String(row.content ?? ""),
      category: row.category == null ? null : String(row.category),
      keywords: Array.isArray(row.keywords) ? row.keywords.map(String) : [],
      rank: Number(row.rank ?? 0),
      metadata: asRecord(row.metadata)
    }));
    const relations: ExportRelation[] = relationsResult.rows.map((row) => ({
      eventId: String(row.event_id),
      entityId: String(row.entity_id),
      entityType: String(row.entity_type),
      entityName: String(row.entity_name),
      entityDescription: String(row.entity_description ?? ""),
      relationDescription: String(row.relation_description ?? "")
    }));

    return {
      projectId,
      project: {
        id: projectId,
        name: String(projectRow.name),
        description: projectRow.description == null ? null : String(projectRow.description),
        metadata: asRecord(projectRow.metadata),
        archivedAt: toIso(projectRow.archived_at),
        createdAt: toIso(projectRow.created_at),
        updatedAt: toIso(projectRow.updated_at)
      },
      documents,
      chunks,
      events,
      relations
    };
  }
}

export const projectExportService = new ProjectExportService();

function buildExportFile(
  data: ProjectExportData,
  format: ProjectExportFormat,
  fileStem: string,
  profile: ProjectExportProfile
): ProjectExportFile {
  const selected = selectDataForDocuments(data);
  const suffix = profile === "simple" ? "simple-import" : "knowledge-export";
  const content = format === "csv"
    ? `\uFEFF${profile === "simple"
        ? buildSimpleCsv({
            documents: selected.documents,
            chunks: selected.chunks,
            events: selected.events,
            relations: selected.relations
          })
        : buildCsv({
            projectId: data.projectId,
            projectName: data.project.name,
            documents: selected.documents,
            chunks: selected.chunks,
            events: selected.events,
            relations: selected.relations
          })}`
    : JSON.stringify(profile === "simple"
        ? buildSimpleJsonPayload({
            ...data,
            documents: selected.documents,
            chunks: selected.chunks,
            events: selected.events,
            relations: selected.relations
          })
        : buildJsonPayload({
            ...data,
            documents: selected.documents,
            chunks: selected.chunks,
            events: selected.events,
            relations: selected.relations
          }), null, 2);
  return {
    fileName: `${fileStem}-${suffix}.${format}`,
    contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    documentCount: selected.documents.length
  };
}

function selectDataForDocuments(data: ProjectExportData): ProjectExportData {
  const documentIds = new Set(data.documents.map((document) => document.id));
  const chunkIds = new Set(
    data.chunks
      .filter((chunk) => chunk.documentId == null || documentIds.has(chunk.documentId))
      .map((chunk) => chunk.id)
  );
  const events = data.events.filter((event) => (
    (event.documentId == null || documentIds.has(event.documentId)) &&
    (event.chunkId == null || chunkIds.has(event.chunkId))
  ));
  const eventIds = new Set(events.map((event) => event.id));
  return {
    ...data,
    chunks: data.chunks.filter((chunk) => chunk.documentId == null || documentIds.has(chunk.documentId)),
    events,
    relations: data.relations.filter((relation) => eventIds.has(relation.eventId))
  };
}

function buildJsonPayload(data: ProjectExportData) {
  const selected = selectDataForDocuments(data);
  const relationsByEventId = groupBy(selected.relations, (relation) => relation.eventId);
  const eventsByChunkId = groupBy(selected.events, (event) => event.chunkId ?? "");
  const chunksByDocumentId = groupBy(selected.chunks, (chunk) => chunk.documentId ?? "");
  const orphanEventsByDocumentId = groupBy(
    selected.events.filter((event) => !event.chunkId),
    (event) => event.documentId ?? ""
  );
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    idPolicy: {
      databaseIds: "System-generated UUIDs. Import ignores external event IDs and creates new UUIDs.",
      chunkKey: "The original manual chunk number is preserved as key when available."
    },
    project: selected.project,
    documents: selected.documents.map((document) => ({
      ...document,
      chunks: (chunksByDocumentId.get(document.id) ?? []).map((chunk) => ({
        id: chunk.key,
        systemChunkId: chunk.id,
        heading: chunk.heading,
        content: chunk.content,
        rawContent: chunk.rawContent,
        rank: chunk.rank,
        metadata: chunk.metadata,
        events: (eventsByChunkId.get(chunk.id) ?? []).map((event) => ({
          ...event,
          entities: relationsByEventId.get(event.id) ?? []
        }))
      })),
      eventsWithoutChunk: (orphanEventsByDocumentId.get(document.id) ?? []).map((event) => ({
        ...event,
        entities: relationsByEventId.get(event.id) ?? []
      }))
    }))
  };
}


function buildSimpleJsonPayload(data: ProjectExportData) {
  const selected = selectDataForDocuments(data);
  const relationsByEventId = groupBy(selected.relations, (relation) => relation.eventId);
  const eventsByChunkId = groupBy(selected.events, (event) => event.chunkId ?? "");
  const chunksByDocumentId = groupBy(selected.chunks, (chunk) => chunk.documentId ?? "");
  const orphanEventsByDocumentId = groupBy(
    selected.events.filter((event) => !event.chunkId),
    (event) => event.documentId ?? ""
  );

  return {
    documents: selected.documents.map((document) => ({
      title: document.title,
      source: cleanSource({
        name: document.sourceName || document.title,
        type: document.sourceType || undefined,
        date: document.sourceDate || undefined,
        author: document.sourceAuthor || undefined,
        url: document.sourceUrl || undefined
      }),
      chunks: [
        ...(chunksByDocumentId.get(document.id) ?? []).flatMap((chunk, chunkIndex) => {
          const events = eventsByChunkId.get(chunk.id) ?? [];
          return events.map((event, eventIndex) => simpleChunkFromEvent({
            chunk,
            event,
            relations: relationsByEventId.get(event.id) ?? [],
            chunkIndex,
            eventIndex,
            eventCount: events.length
          }));
        }),
        ...(orphanEventsByDocumentId.get(document.id) ?? []).map((event, eventIndex) => simpleChunkFromEvent({
          chunk: null,
          event,
          relations: relationsByEventId.get(event.id) ?? [],
          chunkIndex: eventIndex,
          eventIndex: 0,
          eventCount: 1
        }))
      ]
    }))
  };
}

function simpleChunkFromEvent(input: {
  chunk: ExportChunk | null;
  event: ExportEvent;
  relations: ExportRelation[];
  chunkIndex: number;
  eventIndex: number;
  eventCount: number;
}) {
  const baseKey = input.chunk?.key || String(input.chunkIndex + 1);
  return {
    key: input.eventCount > 1 ? `${baseKey}:${input.eventIndex + 1}` : baseKey,
    heading: input.chunk?.heading || input.event.title,
    content: input.chunk?.rawContent || input.chunk?.content || input.event.content,
    event: {
      title: input.event.title,
      summary: input.event.summary,
      content: input.event.content,
      category: input.event.category ?? "",
      keywords: input.event.keywords,
      entities: input.relations.map((relation) => ({
        type: relation.entityType,
        name: relation.entityName,
        description: relation.entityDescription,
        relation: relation.relationDescription || relation.entityDescription
      }))
    }
  };
}

function buildSimpleCsv(input: {
  documents: ExportDocument[];
  chunks: ExportChunk[];
  events: ExportEvent[];
  relations: ExportRelation[];
}): string {
  const documentsById = new Map(input.documents.map((document) => [document.id, document]));
  const chunksById = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
  const relationsByEventId = groupBy(input.relations, (relation) => relation.eventId);
  const headers = [
    "文档标题",
    "来源名称",
    "来源类型",
    "来源日期",
    "来源作者",
    "来源链接",
    "切片编号",
    "切片标题",
    "原文切片",
    "事件标题",
    "事件摘要",
    "事件内容",
    "事件分类",
    "关键词",
    "实体类型",
    "实体名称",
    "实体说明",
    "关系说明"
  ];
  const rows: string[][] = [];
  const chunkEventCounters = new Map<string, number>();

  for (const event of input.events) {
    const document = event.documentId ? documentsById.get(event.documentId) : undefined;
    const chunk = event.chunkId ? chunksById.get(event.chunkId) : undefined;
    const chunkKey = chunk?.key || chunk?.id || event.id;
    const countKey = event.chunkId || event.id;
    const eventIndex = chunkEventCounters.get(countKey) ?? 0;
    chunkEventCounters.set(countKey, eventIndex + 1);
    const manualKey = eventIndex > 0 ? `${chunkKey}:${eventIndex + 1}` : chunkKey;
    const relations = relationsByEventId.get(event.id) ?? [null];
    for (const relation of relations) {
      rows.push([
        document?.title ?? "",
        document?.sourceName || document?.title || "",
        document?.sourceType ?? "",
        document?.sourceDate ?? "",
        document?.sourceAuthor ?? "",
        document?.sourceUrl ?? "",
        manualKey,
        chunk?.heading || event.title,
        chunk?.rawContent ?? chunk?.content ?? event.content,
        event.title,
        event.summary,
        event.content,
        event.category ?? "",
        event.keywords.join(";"),
        relation?.entityType ?? "",
        relation?.entityName ?? "",
        relation?.entityDescription ?? "",
        relation?.relationDescription ?? ""
      ]);
    }
  }

  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function cleanSource(source: { name?: string; type?: string; date?: string; author?: string; url?: string }) {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => typeof value === "string" && value.trim().length > 0)
  );
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function splitDocumentsByApproximateSize(data: ProjectExportData, maxBytes: number): ExportDocument[][] {
  const safeMaxBytes = Math.max(128 * 1024, maxBytes);
  const groups: ExportDocument[][] = [];
  let current: ExportDocument[] = [];
  for (const document of data.documents) {
    const candidate = [...current, document];
    const candidateBytes = estimateExportBytes({ ...data, documents: candidate });
    if (current.length > 0 && candidateBytes > safeMaxBytes) {
      groups.push(current);
      current = [document];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function estimateExportBytes(data: ProjectExportData): number {
  const payload = JSON.stringify(buildJsonPayload(data));
  return Buffer.byteLength(payload, "utf8");
}

function buildSplitFileStem(
  safeProjectName: string,
  documents: ExportDocument[],
  groupCount: number,
  index: number,
  split: ProjectExportSplitMode
): string {
  if (split === "documents" && documents.length === 1) {
    return `${safeProjectName}-${sanitizeFileName(documents[0].title).slice(0, 72)}`;
  }
  return groupCount > 1
    ? `${safeProjectName}-part-${String(index + 1).padStart(2, "0")}`
    : safeProjectName;
}

function buildCsv(input: {
  projectId: string;
  projectName: string;
  documents: ExportDocument[];
  chunks: ExportChunk[];
  events: ExportEvent[];
  relations: ExportRelation[];
}): string {
  const documentsById = new Map(input.documents.map((document) => [document.id, document]));
  const chunksById = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
  const relationsByEventId = groupBy(input.relations, (relation) => relation.eventId);
  const headers = [
    "project_id",
    "project_name",
    "document_id",
    "document_title",
    "source_name",
    "source_type",
    "source_date",
    "source_author",
    "source_url",
    "chunk_id",
    "system_chunk_id",
    "chunk_heading",
    "chunk_content",
    "system_event_id",
    "event_title",
    "event_summary",
    "event_content",
    "event_category",
    "keywords",
    "system_entity_id",
    "entity_type",
    "entity_name",
    "entity_description",
    "relation_description",
    "document_archived_at"
  ];
  const rows: string[][] = [];

  for (const event of input.events) {
    const document = event.documentId ? documentsById.get(event.documentId) : undefined;
    const chunk = event.chunkId ? chunksById.get(event.chunkId) : undefined;
    const relations = relationsByEventId.get(event.id) ?? [null];
    for (const relation of relations) {
      rows.push([
        input.projectId,
        input.projectName,
        document?.id ?? event.documentId ?? "",
        document?.title ?? "",
        document?.sourceName ?? "",
        document?.sourceType ?? "",
        document?.sourceDate ?? "",
        document?.sourceAuthor ?? "",
        document?.sourceUrl ?? "",
        chunk?.key ?? chunk?.id ?? "",
        chunk?.id ?? event.chunkId ?? "",
        chunk?.heading ?? "",
        chunk?.rawContent ?? chunk?.content ?? "",
        event.id,
        event.title,
        event.summary,
        event.content,
        event.category ?? "",
        event.keywords.join(";"),
        relation?.entityId ?? "",
        relation?.entityType ?? "",
        relation?.entityName ?? "",
        relation?.entityDescription ?? "",
        relation?.relationDescription ?? "",
        document?.archivedAt ?? ""
      ]);
    }
  }

  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function toIso(value: unknown): string | null {
  return value == null ? null : new Date(String(value)).toISOString();
}

function sanitizeFileName(value: string): string {
  const sanitized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
  return sanitized || "sag-project";
}

function buildZipArchive(files: Array<{ fileName: string; content: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.fileName, "utf8");
    const compressed = deflateRawSync(file.content);
    const crc = crc32(file.content);
    const { dosTime, dosDate } = currentDosDateTime();
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.byteLength, 18);
    localHeader.writeUInt32LE(file.content.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.byteLength, 20);
    centralHeader.writeUInt32LE(file.content.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.byteLength + name.byteLength + compressed.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function currentDosDateTime() {
  const now = new Date();
  const year = Math.max(1980, now.getFullYear());
  return {
    dosTime: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  };
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
