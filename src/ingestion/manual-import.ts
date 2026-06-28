export type ManualImportFormat = "auto" | "json" | "csv" | "markdown";

export interface ManualKnowledgeEntity {
  type: string;
  name: string;
  description: string;
}

export interface ManualKnowledgeEvent {
  title: string;
  summary: string;
  content: string;
  category?: string;
  keywords: string[];
  entities: ManualKnowledgeEntity[];
}

export interface ManualKnowledgeChunk {
  key: string;
  heading: string;
  content: string;
  event: ManualKnowledgeEvent;
}

export interface ManualKnowledgeDocument {
  title: string;
  chunks: ManualKnowledgeChunk[];
}

type FlatRow = Record<string, unknown>;

type NormalizedRow = {
  documentKey: string;
  documentTitle: string;
  chunkKey: string;
  chunkHeading: string;
  chunkContent: string;
  eventTitle: string;
  eventSummary: string;
  eventContent: string;
  eventCategory: string;
  keywords: string;
  entityType: string;
  entityName: string;
  entityDescription: string;
};

const COLUMN_ALIASES = {
  documentKey: ["document_id", "documentid", "system_document_id"],
  documentTitle: ["文档标题", "document_title", "documenttitle", "document"],
  chunkKey: ["切片编号", "切片id", "chunk_id", "chunkid", "chunk_key"],
  chunkHeading: ["切片标题", "chunk_heading", "chunkheading", "heading"],
  chunkContent: ["原文切片", "切片原文", "chunk_content", "chunkcontent", "source_text", "原文"],
  eventTitle: ["事件标题", "event_title", "eventtitle"],
  eventSummary: ["事件摘要", "event_summary", "eventsummary", "summary"],
  eventContent: ["事件内容", "event_content", "eventcontent"],
  eventCategory: ["事件分类", "event_category", "eventcategory", "category"],
  keywords: ["关键词", "keywords", "keyword"],
  entityType: ["实体类型", "entity_type", "entitytype"],
  entityName: ["实体名称", "entity_name", "entityname", "entity"],
  entityDescription: ["实体说明", "关系说明", "entity_description", "entitydescription", "relation_description", "description"]
} as const;

export function parseManualKnowledge(
  content: string,
  options: { format?: ManualImportFormat; fileName?: string; fallbackTitle?: string } = {}
): ManualKnowledgeDocument {
  const documents = parseManualKnowledgeDocuments(content, options);
  if (documents.length === 1) {
    return documents[0];
  }
  return validateDocument({
    title: options.fallbackTitle || "批量结构化导入",
    chunks: documents.flatMap((document, documentIndex) => (
      document.chunks.map((chunk) => ({
        ...chunk,
        key: `${documentIndex + 1}:${chunk.key}`
      }))
    ))
  });
}

export function parseManualKnowledgeDocuments(
  content: string,
  options: { format?: ManualImportFormat; fileName?: string; fallbackTitle?: string } = {}
): ManualKnowledgeDocument[] {
  const text = unwrapCodeFence(content.replace(/^\uFEFF/, "").trim());
  if (!text) {
    throw new Error("导入内容为空");
  }
  const format = resolveFormat(text, options.format ?? "auto", options.fileName);
  if (format === "json") {
    return parseJsonDocuments(text, options.fallbackTitle);
  }
  const rows = format === "markdown" ? parseMarkdownTable(text) : parseCsv(text);
  return buildDocumentsFromRows(rows, options.fallbackTitle);
}

function unwrapCodeFence(text: string): string {
  const match = text.match(/^```(?:csv|tsv|json|markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return match ? match[1].trim() : text;
}

function resolveFormat(text: string, requested: ManualImportFormat, fileName?: string): Exclude<ManualImportFormat, "auto"> {
  if (requested !== "auto") {
    return requested;
  }
  const extension = fileName?.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  if (extension === ".json") return "json";
  if (extension === ".csv" || extension === ".tsv") return "csv";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (text.startsWith("{") || text.startsWith("[")) return "json";
  if (looksLikeMarkdownTable(text)) return "markdown";
  return "csv";
}

function parseJsonDocuments(text: string, fallbackTitle?: string): ManualKnowledgeDocument[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("JSON 格式无效，请确认没有 Markdown 代码块标记或多余说明");
  }

  if (isRecord(value) && Array.isArray(value.documents)) {
    const documents = value.documents
      .filter(isRecord)
      .map((document, index) => normalizeExportDocument(document, index, fallbackTitle));
    if (documents.length === 0) {
      throw new Error("项目导出 JSON 中没有可导入的 documents");
    }
    return documents;
  }

  if (isRecord(value) && Array.isArray(value.chunks)) {
    const chunks = value.chunks.map((item, index) => normalizeStructuredChunk(item, index));
    return [validateDocument({
      title: readString(value.title) || fallbackTitle || "网页版 AI 导入",
      chunks
    })];
  }

  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.rows)
      ? value.rows
      : null;
  if (!rows) {
    throw new Error("JSON 需要包含 documents、chunks、rows 数组，或直接使用行对象数组");
  }
  return buildDocumentsFromRows(rows.filter(isRecord), fallbackTitle);
}

function normalizeExportDocument(
  value: Record<string, any>,
  documentIndex: number,
  fallbackTitle?: string
): ManualKnowledgeDocument {
  const chunks: ManualKnowledgeChunk[] = [];
  const exportedChunks = Array.isArray(value.chunks) ? value.chunks.filter(isRecord) : [];
  for (const [chunkIndex, chunk] of exportedChunks.entries()) {
    const exportedEvents = Array.isArray(chunk.events)
      ? chunk.events.filter(isRecord)
      : isRecord(chunk.event)
        ? [chunk.event]
        : [];
    for (const [eventIndex, event] of exportedEvents.entries()) {
      chunks.push(normalizeExportChunkEvent(chunk, event, chunkIndex, eventIndex, exportedEvents.length));
    }
  }

  const eventsWithoutChunk = Array.isArray(value.eventsWithoutChunk)
    ? value.eventsWithoutChunk.filter(isRecord)
    : [];
  for (const [eventIndex, event] of eventsWithoutChunk.entries()) {
    chunks.push(normalizeExportChunkEvent({
      id: `event-${readString(event.id) || eventIndex + 1}`,
      heading: event.title,
      content: event.content
    }, event, exportedChunks.length + eventIndex, 0, 1));
  }

  return validateDocument({
    title: readString(value.title) || fallbackTitle || `导入文档 ${documentIndex + 1}`,
    chunks
  });
}

function normalizeExportChunkEvent(
  chunk: Record<string, any>,
  event: Record<string, any>,
  chunkIndex: number,
  eventIndex: number,
  eventCount: number
): ManualKnowledgeChunk {
  const eventTitle = readString(event.title) || readString(chunk.heading) || `事件 ${chunkIndex + 1}`;
  const chunkContent = readString(chunk.rawContent) || readString(chunk.content) || readString(event.content);
  const baseKey = readString(chunk.id) || readString(chunk.systemChunkId) || String(chunkIndex + 1);
  const entities = Array.isArray(event.entities)
    ? event.entities.filter(isRecord).map((entity) => ({
        type: readString(entity.entityType) || readString(entity.type) || "subject",
        name: readString(entity.entityName) || readString(entity.name),
        description: readString(entity.relationDescription) ||
          readString(entity.entityDescription) ||
          readString(entity.description) ||
          `在事件「${eventTitle}」中被提及`
      })).filter((entity) => entity.name.length > 0)
    : [];
  return {
    key: eventCount > 1 ? `${baseKey}:${eventIndex + 1}` : baseKey,
    heading: readString(chunk.heading) || eventTitle,
    content: chunkContent,
    event: {
      title: eventTitle,
      summary: readString(event.summary) || readString(event.content) || chunkContent,
      content: readString(event.content) || chunkContent,
      category: readString(event.category) || undefined,
      keywords: normalizeKeywords(event.keywords),
      entities
    }
  };
}

function normalizeStructuredChunk(value: unknown, index: number): ManualKnowledgeChunk {
  if (!isRecord(value)) {
    throw new Error(`第 ${index + 1} 个 chunk 不是对象`);
  }
  const eventValue = isRecord(value.event) ? value.event : value;
  const entitiesValue = Array.isArray(eventValue.entities) ? eventValue.entities : [];
  const eventTitle = readString(eventValue.title) || readString(value.heading);
  const chunkContent = readString(value.content) || readString(eventValue.content);
  return {
    key: readString(value.id) || readString(value.key) || String(index + 1),
    heading: readString(value.heading) || eventTitle || `切片 ${index + 1}`,
    content: chunkContent,
    event: {
      title: eventTitle || `事件 ${index + 1}`,
      summary: readString(eventValue.summary) || readString(eventValue.content) || chunkContent,
      content: readString(eventValue.content) || chunkContent,
      category: readString(eventValue.category) || undefined,
      keywords: normalizeKeywords(eventValue.keywords),
      entities: entitiesValue.filter(isRecord).map((entity) => ({
        type: readString(entity.type) || "subject",
        name: readString(entity.name),
        description: readString(entity.description) || `在事件「${eventTitle || `事件 ${index + 1}`}」中被提及`
      })).filter((entity) => entity.name.length > 0)
    }
  };
}

function parseCsv(text: string): FlatRow[] {
  const delimiter = detectDelimiter(text);
  const records = parseDelimitedRecords(text, delimiter);
  if (records.length < 2) {
    throw new Error("CSV 至少需要一行表头和一行数据");
  }
  const headers = records[0].map((value) => value.trim());
  return records.slice(1)
    .filter((record) => record.some((value) => value.trim()))
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
}

function parseDelimitedRecords(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) {
    throw new Error("CSV 存在未闭合的双引号");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",";
}

function parseMarkdownTable(text: string): FlatRow[] {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = splitMarkdownRow(lines[index]);
    const separator = splitMarkdownRow(lines[index + 1]);
    if (headers.length < 2 || separator.length !== headers.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      continue;
    }
    const rows: FlatRow[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const values = splitMarkdownRow(lines[rowIndex]);
      if (values.length === 0) break;
      if (values.length !== headers.length) {
        throw new Error(`Markdown 表格第 ${rowIndex + 1} 行列数与表头不一致`);
      }
      rows.push(Object.fromEntries(headers.map((header, columnIndex) => [
        header.trim(),
        decodeMarkdownCell(values[columnIndex])
      ])));
    }
    if (rows.length === 0) {
      throw new Error("Markdown 表格没有数据行");
    }
    return rows;
  }
  throw new Error("没有找到有效的 Markdown 表格");
}

function looksLikeMarkdownTable(text: string): boolean {
  const lines = text.split(/\r?\n/);
  return lines.some((line, index) => index > 0 && splitMarkdownRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim())));
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let field = "";
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      field += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "|") {
      cells.push(field.trim());
      field = "";
    } else {
      field += char;
    }
  }
  cells.push(field.trim());
  return cells;
}

function decodeMarkdownCell(value: string): string {
  return value.replace(/<br\s*\/?>/gi, "\n").replace(/\\\|/g, "|").trim();
}

function buildDocumentsFromRows(rows: FlatRow[], fallbackTitle?: string): ManualKnowledgeDocument[] {
  if (rows.length === 0) {
    throw new Error("表格没有数据行");
  }
  const normalized = rows.map(normalizeFlatRow);
  const documentGroups = new Map<string, NormalizedRow[]>();
  for (const row of normalized) {
    const key = row.documentKey || row.documentTitle || fallbackTitle || "__single_document__";
    const group = documentGroups.get(key) ?? [];
    group.push(row);
    documentGroups.set(key, group);
  }
  return [...documentGroups.values()].map((group) => buildDocumentFromNormalizedRows(group, fallbackTitle));
}

function buildDocumentFromRows(rows: FlatRow[], fallbackTitle?: string): ManualKnowledgeDocument {
  const documents = buildDocumentsFromRows(rows, fallbackTitle);
  return documents.length === 1
    ? documents[0]
    : validateDocument({
        title: fallbackTitle || "批量结构化导入",
        chunks: documents.flatMap((document, index) => document.chunks.map((chunk) => ({
          ...chunk,
          key: `${index + 1}:${chunk.key}`
        })))
      });
}

function buildDocumentFromNormalizedRows(
  normalized: NormalizedRow[],
  fallbackTitle?: string
): ManualKnowledgeDocument {
  const groups = new Map<string, NormalizedRow[]>();
  for (const [index, row] of normalized.entries()) {
    const key = row.chunkKey || `${row.eventTitle}\u0000${row.chunkHeading}\u0000${row.chunkContent.slice(0, 120)}` || String(index + 1);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const chunks: ManualKnowledgeChunk[] = [...groups.entries()].map(([key, group], index) => {
    const first = group[0];
    const eventTitle = first.eventTitle || first.chunkHeading || `事件 ${index + 1}`;
    const chunkContent = first.chunkContent || first.eventContent || first.eventSummary;
    const keywords = unique(group.flatMap((row) => normalizeKeywords(row.keywords)));
    const entities = uniqueEntities(group.map((row) => ({
      type: row.entityType || "subject",
      name: row.entityName,
      description: row.entityDescription || `在事件「${eventTitle}」中被提及`
    })).filter((entity) => entity.name));
    return {
      key,
      heading: first.chunkHeading || eventTitle,
      content: chunkContent,
      event: {
        title: eventTitle,
        summary: first.eventSummary || first.eventContent || chunkContent,
        content: first.eventContent || chunkContent,
        category: first.eventCategory || undefined,
        keywords,
        entities
      }
    };
  });

  return validateDocument({
    title: normalized.find((row) => row.documentTitle)?.documentTitle || fallbackTitle || "网页版 AI 导入",
    chunks
  });
}

function normalizeFlatRow(row: FlatRow): NormalizedRow {
  const normalizedEntries = new Map(
    Object.entries(row).map(([key, value]) => [normalizeHeader(key), readString(value)])
  );
  const read = (aliases: readonly string[]) => {
    for (const alias of aliases) {
      const value = normalizedEntries.get(normalizeHeader(alias));
      if (value) return value;
    }
    return "";
  };
  return {
    documentKey: read(COLUMN_ALIASES.documentKey),
    documentTitle: read(COLUMN_ALIASES.documentTitle),
    chunkKey: read(COLUMN_ALIASES.chunkKey),
    chunkHeading: read(COLUMN_ALIASES.chunkHeading),
    chunkContent: read(COLUMN_ALIASES.chunkContent),
    eventTitle: read(COLUMN_ALIASES.eventTitle),
    eventSummary: read(COLUMN_ALIASES.eventSummary),
    eventContent: read(COLUMN_ALIASES.eventContent),
    eventCategory: read(COLUMN_ALIASES.eventCategory),
    keywords: read(COLUMN_ALIASES.keywords),
    entityType: read(COLUMN_ALIASES.entityType),
    entityName: read(COLUMN_ALIASES.entityName),
    entityDescription: read(COLUMN_ALIASES.entityDescription)
  };
}

function validateDocument(document: ManualKnowledgeDocument): ManualKnowledgeDocument {
  if (document.chunks.length === 0) {
    throw new Error("没有可导入的切片");
  }
  for (const [index, chunk] of document.chunks.entries()) {
    if (!chunk.content.trim()) {
      throw new Error(`第 ${index + 1} 个切片缺少“原文切片”`);
    }
    if (!chunk.event.title.trim()) {
      throw new Error(`第 ${index + 1} 个切片缺少“事件标题”`);
    }
    if (chunk.event.entities.length === 0) {
      throw new Error(`第 ${index + 1} 个事件没有实体；至少需要一行实体数据`);
    }
  }
  return {
    title: document.title.trim() || "网页版 AI 导入",
    chunks: document.chunks
  };
}

function normalizeKeywords(value: unknown): string[] {
  if (Array.isArray(value)) {
    return unique(value.map(readString).filter(Boolean));
  }
  return unique(readString(value).split(/[;；、,，]/).map((item) => item.trim()).filter(Boolean));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueEntities(entities: ManualKnowledgeEntity[]): ManualKnowledgeEntity[] {
  const map = new Map<string, ManualKnowledgeEntity>();
  for (const entity of entities) {
    const key = `${entity.type.trim().toLowerCase()}\u0000${entity.name.trim().toLowerCase()}`;
    if (!map.has(key)) map.set(key, entity);
  }
  return [...map.values()];
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function readString(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value.trim() : String(value).trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
