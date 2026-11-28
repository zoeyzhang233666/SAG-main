import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool } from "./pool.js";
import { toVectorLiteral } from "./vector.js";
import type {
  ChunkRecord,
  DocumentRecord,
  EntityRecord,
  EntityDetailRecord,
  EntityWithEventsRecord,
  EventRecord,
  EventDetailRecord,
  EmbeddingPreview,
  AiProviderSettingsRecord,
  McpMessageRecord,
  McpMessageRole,
  McpSessionRecord,
  McpToolCallRecord,
  ProjectGraphChunkRecord,
  ProjectGraphEntityRecord,
  ProjectGraphEventRecord,
  ProjectGraphRecord,
  ProjectGraphSuggestionRecord,
  ProjectStatsRecord,
  SourceRecord
} from "../types.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const DEFAULT_PROJECT_GRAPH_LIMIT = 160;
const FOCUSED_PROJECT_GRAPH_LIMIT = 240;
const MAX_PROJECT_GRAPH_LIMIT = 300;

function db(client?: Queryable): Queryable {
  return client ?? pool;
}

function sourceFromRow(row: Record<string, unknown>): SourceRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    archivedAt: row.archived_at == null ? null : new Date(String(row.archived_at)).toISOString(),
    createdAt: row.created_at == null ? undefined : new Date(String(row.created_at)).toISOString(),
    updatedAt: row.updated_at == null ? undefined : new Date(String(row.updated_at)).toISOString()
  };
}

function eventFromRow(row: Record<string, unknown>): EventRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    chunkId: row.chunk_id == null ? null : String(row.chunk_id),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    content: String(row.content ?? ""),
    rank: Number(row.rank ?? 0),
    score: row.score == null ? undefined : Number(row.score),
    titleEmbedding: embeddingPreviewFromRow(row, "title_embedding_preview", "title_embedding_dimensions"),
    contentEmbedding: embeddingPreviewFromRow(row, "content_embedding_preview", "content_embedding_dimensions")
  };
}

function entityFromRow(row: Record<string, unknown>): EntityRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    type: String(row.type),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    score: row.score == null ? undefined : Number(row.score),
    embedding: embeddingPreviewFromRow(row)
  };
}

function documentFromRow(row: Record<string, unknown>): DocumentRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    title: String(row.title),
    sourceName: row.source_name == null ? null : String(row.source_name),
    sourceType: row.source_type == null ? null : String(row.source_type),
    sourceDate: row.source_date == null ? null : String(row.source_date),
    sourceAuthor: row.source_author == null ? null : String(row.source_author),
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    status: String(row.status),
    parseStatus: String(row.parse_status),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    archivedAt: row.archived_at == null ? null : new Date(String(row.archived_at)).toISOString()
  };
}

function chunkFromRow(row: Record<string, unknown>): ChunkRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    heading: row.heading == null ? null : String(row.heading),
    content: String(row.content),
    rawContent: row.raw_content == null ? null : String(row.raw_content),
    rank: Number(row.rank ?? 0),
    references: Array.isArray(row.references) ? row.references.map(String) : [],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    embedding: embeddingPreviewFromRow(row)
  };
}

function embeddingPreviewFromRow(
  row: Record<string, unknown>,
  previewColumn = "embedding_preview",
  dimensionsColumn = "embedding_dimensions"
): EmbeddingPreview | null | undefined {
  const preview = embeddingPreviewFromText(row[previewColumn]);
  if (preview !== undefined) {
    return preview;
  }
  const dimensions = row[dimensionsColumn];
  if (dimensions === undefined) {
    return undefined;
  }
  if (dimensions === null) {
    return null;
  }
  const parsed = Number(dimensions);
  return Number.isFinite(parsed) && parsed > 0
    ? { dimensions: Math.trunc(parsed), sample: [] }
    : null;
}

function embeddingPreviewFromText(value: unknown): EmbeddingPreview | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const numbers = String(value)
    .match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)
    ?.map(Number)
    .filter((item) => Number.isFinite(item)) ?? [];
  if (numbers.length === 0) {
    return null;
  }
  return {
    dimensions: numbers.length,
    sample: numbers.slice(0, 8)
  };
}

function uniqueIds(ids?: string[], limit = MAX_PROJECT_GRAPH_LIMIT): string[] {
  return [...new Set((ids ?? []).filter(Boolean))].slice(0, limit);
}

function clampProjectGraphLimit(limit: number | undefined, hasFocus: boolean): number {
  const fallback = hasFocus ? FOCUSED_PROJECT_GRAPH_LIMIT : DEFAULT_PROJECT_GRAPH_LIMIT;
  const value = Number.isFinite(limit) ? Number(limit) : fallback;
  return Math.min(MAX_PROJECT_GRAPH_LIMIT, Math.max(1, Math.floor(value)));
}

function mcpSessionFromRow(row: Record<string, unknown>): McpSessionRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    title: String(row.title),
    status: String(row.status),
    model: row.model == null ? null : String(row.model),
    sourceIds: Array.isArray(row.source_ids) ? row.source_ids.map(String) : [],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

function mcpMessageFromRow(row: Record<string, unknown>): McpMessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: String(row.role) as McpMessageRole,
    content: String(row.content),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function mcpToolCallFromRow(row: Record<string, unknown>): McpToolCallRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    toolName: String(row.tool_name),
    arguments: (row.arguments ?? {}) as Record<string, unknown>,
    result: row.result,
    status: String(row.status) as McpToolCallRecord["status"],
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    error: row.error == null ? null : String(row.error),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function aiProviderSettingsFromRow(row: Record<string, unknown>): AiProviderSettingsRecord {
  return {
    id: "global",
    embeddingBaseUrl: String(row.embedding_base_url),
    embeddingModel: String(row.embedding_model),
    embeddingDimensions: Number(row.embedding_dimensions),
    embeddingApiKey: row.embedding_api_key == null ? null : String(row.embedding_api_key),
    llmBaseUrl: String(row.llm_base_url),
    llmModel: String(row.llm_model),
    llmApiKey: row.llm_api_key == null ? null : String(row.llm_api_key),
    llmTimeoutMs: Number(row.llm_timeout_ms),
    llmMaxRetries: Number(row.llm_max_retries),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

export async function createSource(input: {
  id?: string;
  tenantId: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}, client?: Queryable): Promise<SourceRecord> {
  const id = input.id ?? randomUUID();
  const result = await db(client).query(
    `
      insert into sources (id, tenant_id, name, description, metadata)
      values ($1, $2, $3, $4, $5::jsonb)
      on conflict (id) do update set
        name = sources.name,
        description = sources.description,
        metadata = sources.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [id, input.tenantId, input.name, input.description ?? null, JSON.stringify(input.metadata ?? {})]
  );
  return sourceFromRow(result.rows[0]);
}

export async function getSource(sourceId: string, tenantId: string): Promise<SourceRecord | null> {
  const result = await pool.query(
    "select * from sources where id = $1 and tenant_id = $2",
    [sourceId, tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function listSources(input: {
  tenantId: string;
  limit: number;
  cursor?: string;
  includeArchived?: boolean;
}): Promise<SourceRecord[]> {
  const params: unknown[] = [input.tenantId, input.limit];
  let cursorSql = "";
  if (input.cursor) {
    params.push(input.cursor);
    cursorSql = "and id::text > $3";
  }
  const archiveSql = input.includeArchived ? "" : "and archived_at is null";
  const result = await pool.query(
    `
      select *
      from sources
      where tenant_id = $1 ${archiveSql} ${cursorSql}
      order by id
      limit $2
    `,
    params
  );
  return result.rows.map(sourceFromRow);
}

export async function updateSource(input: {
  sourceId: string;
  tenantId: string;
  name?: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set
        name = coalesce($3, name),
        description = case when $4::boolean then $5 else description end,
        metadata = metadata || $6::jsonb,
        updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [
      input.sourceId,
      input.tenantId,
      input.name?.trim() || null,
      Object.prototype.hasOwnProperty.call(input, "description"),
      input.description ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function archiveSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set archived_at = coalesce(archived_at, now()), updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function restoreSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set archived_at = null, updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function deleteSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<boolean> {
  const result = await pool.query(
    "delete from sources where id = $1 and tenant_id = $2",
    [input.sourceId, input.tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function assertSourcesAccessible(sourceIds: string[], tenantId: string): Promise<void> {
  if (sourceIds.length === 0) {
    throw new Error("sourceIds must not be empty");
  }
  const result = await pool.query(
    "select id from sources where tenant_id = $1 and archived_at is null and id = any($2::uuid[])",
    [tenantId, sourceIds]
  );
  const found = new Set(result.rows.map((row) => String(row.id)));
  const missing = sourceIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`source not found or not accessible: ${missing.join(",")}`);
  }
}

export async function getDefaultEntityType(type: string, client?: Queryable): Promise<string | null> {
  const result = await db(client).query(
    `
      select id
      from entity_types
      where type = $1 and is_active = true
      order by is_default desc
      limit 1
    `,
    [type]
  );
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

export async function getAnyDefaultEntityType(client?: Queryable): Promise<string> {
  const result = await db(client).query(
    `
      select id
      from entity_types
      where is_active = true
      order by case when type = 'subject' then 0 else 1 end, is_default desc
      limit 1
    `
  );
  if (!result.rows[0]?.id) {
    throw new Error("entity_types seed data is missing; run npm run seed");
  }
  return String(result.rows[0].id);
}

// Graph writes in one project can touch the same entity rows in different orders.
export async function lockProjectGraph(client: Queryable, sourceId: string): Promise<void> {
  await client.query("select id from sources where id = $1 for no key update", [sourceId]);
}

export async function upsertEntity(input: {
  sourceId: string;
  type: string;
  name: string;
  description?: string;
  embedding: number[];
}, client?: Queryable): Promise<EntityRecord> {
  const canonicalType = input.type.normalize("NFKC").trim().toLowerCase();
  const normalizedName = normalizeEntityName(input.name);
  const legacyNormalizedName = input.name.trim().toLowerCase();
  const existingResult = await db(client).query(
    `
      select *
      from entities
      where source_id = $1
        and lower(type) = $2
        and (
          normalized_name = any($3::text[])
          or normalized_name % $4
          or lower(name) = $4
        )
      order by
        case when normalized_name = $5 then 0 else 1 end,
        similarity(normalized_name, $4) desc,
        created_at
      limit 20
    `,
    [
      input.sourceId,
      canonicalType,
      [...new Set([normalizedName, legacyNormalizedName])],
      legacyNormalizedName,
      normalizedName
    ]
  );
  const existing = existingResult.rows.find((row) => (
    normalizeEntityName(String(row.name)) === normalizedName ||
    normalizeEntityName(String(row.normalized_name)) === normalizedName
  ));
  if (existing) {
    const result = await db(client).query(
      `
        update entities
        set
          name = case when length(name) >= length($2) then name else $2 end,
          description = coalesce(nullif(description, ''), $3),
          embedding = coalesce(embedding, $4::vector),
          updated_at = now()
        where id = $1
        returning *
      `,
      [
        existing.id,
        input.name.trim(),
        input.description ?? "",
        toVectorLiteral(input.embedding)
      ]
    );
    return entityFromRow(result.rows[0]);
  }

  const entityTypeId = (await getDefaultEntityType(canonicalType, client)) ?? await getAnyDefaultEntityType(client);
  const result = await db(client).query(
    `
      insert into entities (
        id, source_id, entity_type_id, type, name, normalized_name, description, embedding
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::vector)
      on conflict (source_id, type, normalized_name) do update set
        name = excluded.name,
        description = coalesce(nullif(entities.description, ''), excluded.description),
        embedding = coalesce(entities.embedding, excluded.embedding),
        updated_at = now()
      returning *
    `,
    [
      randomUUID(),
      input.sourceId,
      entityTypeId,
      canonicalType,
      input.name.normalize("NFKC").trim(),
      normalizedName,
      input.description ?? "",
      toVectorLiteral(input.embedding)
    ]
  );
  return entityFromRow(result.rows[0]);
}

export function normalizeEntityName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF\s]+/g, "")
    .replace(/[‐‑‒–—−﹣]/g, "-")
    .replace(/[、﹑]/g, ",")
    .replace(/[·•・]/g, "·");
}

export async function searchEntitiesByVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
  threshold: number;
}): Promise<EntityRecord[]> {
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             1 - (ent.embedding <=> $1::vector) as score
      from entities ent
      where ent.source_id = any($2::uuid[])
        and ent.embedding is not null
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      order by ent.embedding <=> $1::vector
      limit $3
    `,
    [toVectorLiteral(input.queryVector), input.sourceIds, input.topK]
  );
  return result.rows
    .map(entityFromRow)
    .filter((entity) => (entity.score ?? 0) >= input.threshold);
}

export async function searchEntitiesByName(input: {
  sourceIds: string[];
  names: string[];
  limit: number;
}): Promise<EntityRecord[]> {
  if (input.names.length === 0) {
    return [];
  }
  const normalizedNames = input.names.map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (normalizedNames.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name, 1.0 as score
      from entities ent
      where ent.source_id = any($1::uuid[])
        and exists (
          select 1
          from unnest($2::text[]) as query_name(name)
          where ent.normalized_name = query_name.name
             or ent.normalized_name % query_name.name
        )
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      limit $3
    `,
    [input.sourceIds, normalizedNames, input.limit]
  );
  return result.rows.map(entityFromRow);
}

export async function searchEntitiesByText(input: {
  sourceIds: string[];
  query: string;
  limit: number;
}): Promise<EntityRecord[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }
  const result = await pool.query(
    `
      with q as (
        select
          websearch_to_tsquery('simple', $2) as tsq,
          lower($2) as raw_query
      )
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             greatest(
               coalesce(ts_rank_cd(ent.search_text, q.tsq), 0),
               similarity(ent.normalized_name, q.raw_query),
               case when ent.normalized_name like '%' || q.raw_query || '%' then 1.05 else 0 end,
               case when q.raw_query like '%' || ent.normalized_name || '%' then 1.0 else 0 end,
               case when ent.normalized_name = q.raw_query then 1.2 else 0 end
             ) as score
      from entities ent
      cross join q
      where ent.source_id = any($1::uuid[])
        and (
          ent.search_text @@ q.tsq
          or ent.normalized_name % q.raw_query
          or ent.normalized_name like '%' || q.raw_query || '%'
          or q.raw_query like '%' || ent.normalized_name || '%'
        )
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      order by score desc, ent.name
      limit $3
    `,
    [input.sourceIds, query, input.limit]
  );
  return result.rows.map(entityFromRow);
}

export async function searchProjectGraphSuggestions(input: {
  sourceId: string;
  tenantId: string;
  query: string;
  limit?: number;
}): Promise<ProjectGraphSuggestionRecord[]> {
  const query = input.query.normalize("NFKC").trim();
  if (!query) {
    return [];
  }
  const limit = Math.min(20, Math.max(1, Math.floor(input.limit ?? 10)));
  const candidateLimit = Math.max(18, limit * 3);
  const result = await pool.query(
    `
      with q as (
        select
          websearch_to_tsquery('simple', $3) as tsq,
          lower($3) as raw_query
      ),
      entity_candidates as (
        select
          ent.id,
          ent.name,
          ent.normalized_name,
          greatest(
            case when ent.normalized_name = q.raw_query then 1000 else 0 end,
            case when starts_with(ent.normalized_name, q.raw_query) then 900 else 0 end,
            case when strpos(lower(ent.name), q.raw_query) > 0 or strpos(ent.normalized_name, q.raw_query) > 0 then 800 else 0 end,
            coalesce(ts_rank_cd(ent.search_text, q.tsq) * 300, 0),
            similarity(ent.normalized_name, q.raw_query) * 500
          ) + 20 as score
        from entities ent
        cross join q
        where ent.source_id = $1
          and exists (
            select 1
            from event_entities active_ee
            join events active_e on active_e.id = active_ee.event_id
            join documents active_d on active_d.id = active_e.document_id
            join sources active_s on active_s.id = active_e.source_id
            where active_ee.entity_id = ent.id
              and active_e.source_id = $1
              and active_s.tenant_id = $2
              and active_s.archived_at is null
              and active_d.archived_at is null
              and active_e.deleted_at is null
          )
          and (
            strpos(lower(ent.name), q.raw_query) > 0
            or strpos(ent.normalized_name, q.raw_query) > 0
          )
      ),
      entity_matches as (
        select
          (array_agg(ec.id order by ec.score desc, ec.name, ec.id))[1] as id,
          'entity'::text as kind,
          (array_agg(ec.name order by ec.score desc, length(ec.name) desc, ec.name, ec.id))[1] as label,
          max(ec.score) as score,
          count(distinct ee.event_id)::int as weight,
          array_agg(distinct ec.id order by ec.id)::uuid[] as entity_ids,
          count(distinct ee.event_id)::int as related_event_count,
          count(distinct ec.id)::int as entity_count,
          ec.normalized_name as normalized_entity_name
        from entity_candidates ec
        join event_entities ee on ee.entity_id = ec.id
        join events e on e.id = ee.event_id
        join documents d on d.id = e.document_id
        join sources s on s.id = e.source_id
        where e.source_id = $1
          and s.tenant_id = $2
          and s.archived_at is null
          and d.archived_at is null
          and e.deleted_at is null
        group by ec.normalized_name
        order by score desc, weight desc, label
        limit $4
      ),
      event_matches as (
        select
          e.id,
          'event'::text as kind,
          e.title as label,
          greatest(
            case when lower(e.title) = q.raw_query then 960 else 0 end,
            case when starts_with(lower(e.title), q.raw_query) then 860 else 0 end,
            case when strpos(lower(e.title), q.raw_query) > 0 then 760 else 0 end,
            coalesce(ts_rank_cd(e.search_text, q.tsq) * 280, 0),
            similarity(lower(e.title), q.raw_query) * 420
          ) as score,
          count(distinct ee.entity_id)::int as weight,
          null::uuid[] as entity_ids,
          null::int as related_event_count,
          null::int as entity_count,
          null::text as normalized_entity_name
        from events e
        join documents d on d.id = e.document_id
        join sources s on s.id = e.source_id
        left join event_entities ee on ee.event_id = e.id
        cross join q
        where e.source_id = $1
          and s.tenant_id = $2
          and s.archived_at is null
          and d.archived_at is null
          and e.deleted_at is null
          and strpos(lower(e.title), q.raw_query) > 0
        group by e.id, q.raw_query, q.tsq
        order by score desc, weight desc, e.rank, e.title
        limit $4
      ),
      chunk_matches as (
        select
          c.id,
          'chunk'::text as kind,
          coalesce(
            nullif(btrim(c.heading), ''),
            left(regexp_replace(c.content, E'\\s+', ' ', 'g'), 80)
          ) as label,
          greatest(
            case when lower(coalesce(c.heading, '')) = q.raw_query then 920 else 0 end,
            case when starts_with(lower(coalesce(c.heading, '')), q.raw_query) then 820 else 0 end,
            case when strpos(lower(coalesce(c.heading, '')), q.raw_query) > 0 then 720 else 0 end,
            coalesce(ts_rank_cd(c.search_text, q.tsq) * 260, 0),
            similarity(lower(coalesce(c.heading, '')), q.raw_query) * 380
          ) as score,
          count(distinct e.id)::int as weight,
          null::uuid[] as entity_ids,
          null::int as related_event_count,
          null::int as entity_count,
          null::text as normalized_entity_name
        from source_chunks c
        join sources s on s.id = c.source_id
        left join documents d on d.id = c.document_id
        left join events e on e.chunk_id = c.id and e.deleted_at is null
        cross join q
        where c.source_id = $1
          and s.tenant_id = $2
          and s.archived_at is null
          and (d.id is null or d.archived_at is null)
          and strpos(lower(coalesce(c.heading, '')), q.raw_query) > 0
        group by c.id, q.raw_query, q.tsq
        order by score desc, weight desc, c.rank, label
        limit $4
      )
      select
        id,
        kind,
        label,
        score,
        weight,
        entity_ids,
        related_event_count,
        entity_count,
        normalized_entity_name
      from (
        select * from entity_matches
        union all
        select * from event_matches
        union all
        select * from chunk_matches
      ) matches
      where score > 0
      order by score desc, weight desc, label
      limit $5
    `,
    [input.sourceId, input.tenantId, query, candidateLimit, limit]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind) as ProjectGraphSuggestionRecord["kind"],
    label: String(row.label),
    score: Number(row.score ?? 0),
    weight: Number(row.weight ?? 0),
    entityIds: Array.isArray(row.entity_ids)
      ? row.entity_ids.map(String)
      : undefined,
    entityCount:
      row.entity_count == null ? undefined : Number(row.entity_count),
    relatedEventCount:
      row.related_event_count == null
        ? undefined
        : Number(row.related_event_count),
    normalizedEntityName:
      row.normalized_entity_name == null
        ? undefined
        : String(row.normalized_entity_name)
  }));
}

export async function getEventIdsByEntityIds(input: {
  entityIds: string[];
  sourceIds: string[];
  excludeEventIds?: string[];
}): Promise<string[]> {
  if (input.entityIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select distinct ee.event_id
      from event_entities ee
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where ee.entity_id = any($1::uuid[])
        and e.source_id = any($2::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and not (ee.event_id = any($3::uuid[]))
    `,
    [input.entityIds, input.sourceIds, input.excludeEventIds ?? []]
  );
  return result.rows.map((row) => String(row.event_id));
}

export async function searchEventsByTitleVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
  threshold: number;
}): Promise<EventRecord[]> {
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             1 - (e.title_embedding <=> $1::vector) as score
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.source_id = any($2::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and e.title_embedding is not null
      order by e.title_embedding <=> $1::vector
      limit $3
    `,
    [toVectorLiteral(input.queryVector), input.sourceIds, input.topK]
  );
  return result.rows
    .map(eventFromRow)
    .filter((event) => (event.score ?? 0) >= input.threshold);
}

export async function searchEventsByText(input: {
  sourceIds: string[];
  query: string;
  limit: number;
  threshold?: number;
}): Promise<EventRecord[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }
  const result = await pool.query(
    `
      with q as (
        select
          websearch_to_tsquery('simple', $2) as tsq,
          lower($2) as raw_query
      )
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             greatest(
               coalesce(ts_rank_cd(e.search_text, q.tsq), 0),
               similarity(lower(e.title), q.raw_query),
               similarity(lower(coalesce(e.summary, '')), q.raw_query) * 0.92,
               similarity(lower(coalesce(e.content, '')), q.raw_query) * 0.86,
               case when lower(e.title) like '%' || q.raw_query || '%' then 1.20 else 0 end,
               case when lower(coalesce(e.summary, '')) like '%' || q.raw_query || '%' then 1.05 else 0 end,
               case when lower(coalesce(e.content, '')) like '%' || q.raw_query || '%' then 1.00 else 0 end
             ) as score
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      cross join q
      where e.source_id = any($1::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and (
          e.search_text @@ q.tsq
          or lower(e.title) % q.raw_query
          or lower(coalesce(e.summary, '')) % q.raw_query
          or lower(coalesce(e.content, '')) % q.raw_query
          or lower(e.title) like '%' || q.raw_query || '%'
          or lower(coalesce(e.summary, '')) like '%' || q.raw_query || '%'
          or lower(coalesce(e.content, '')) like '%' || q.raw_query || '%'
        )
      order by score desc, e.rank, e.id
      limit $3
    `,
    [input.sourceIds, query, input.limit]
  );
  const threshold = input.threshold ?? 0.02;
  return result.rows
    .map(eventFromRow)
    .filter((event) => (event.score ?? 0) >= threshold);
}

export async function coarseRankEventsByContent(input: {
  sourceIds: string[];
  eventIds: string[];
  queryVector: number[];
  maxEvents: number;
}): Promise<EventRecord[]> {
  if (input.eventIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             1 - (e.content_embedding <=> $1::vector) as score
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.id = any($2::uuid[])
        and e.source_id = any($3::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and e.content_embedding is not null
      order by e.content_embedding <=> $1::vector
      limit $4
    `,
    [toVectorLiteral(input.queryVector), input.eventIds, input.sourceIds, input.maxEvents]
  );
  return result.rows.map(eventFromRow);
}

export async function getEventsWithEntityIds(eventIds: string[]): Promise<Map<string, EventRecord & { entityIds: string[] }>> {
  const map = new Map<string, EventRecord & { entityIds: string[] }>();
  if (eventIds.length === 0) {
    return map;
  }
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             coalesce(array_agg(ee.entity_id) filter (where ee.entity_id is not null), '{}') as entity_ids
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      left join event_entities ee on ee.event_id = e.id
      where e.id = any($1::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
      group by e.id
    `,
    [eventIds]
  );
  for (const row of result.rows) {
    const event = eventFromRow(row) as EventRecord & { entityIds: string[] };
    event.entityIds = (row.entity_ids ?? []).map(String);
    map.set(event.id, event);
  }
  return map;
}

export async function getSectionsForEvents(eventIds: string[]): Promise<Array<{
  eventId: string;
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank: number;
}>> {
  if (eventIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select e.id as event_id, c.id as chunk_id, c.source_id, c.document_id,
             c.heading, c.content, c.rank
      from events e
      join source_chunks c on c.id = e.chunk_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.id = any($1::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
      order by array_position($1::uuid[], e.id), c.rank
    `,
    [eventIds]
  );
  return result.rows.map((row) => ({
    eventId: String(row.event_id),
    chunkId: String(row.chunk_id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? undefined : String(row.document_id),
    heading: row.heading == null ? undefined : String(row.heading),
    content: String(row.content),
    rank: Number(row.rank)
  }));
}

export async function searchChunksByVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
}): Promise<Array<{
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank: number;
  score: number;
}>> {
  const result = await pool.query(
    `
      select c.id, c.source_id, c.document_id, c.heading, c.content, c.rank,
             1 - (c.embedding <=> $1::vector) as score
      from source_chunks c
      join documents d on d.id = c.document_id
      join sources s on s.id = c.source_id
      where c.source_id = any($2::uuid[])
        and c.embedding is not null
        and d.archived_at is null
        and s.archived_at is null
      order by c.embedding <=> $1::vector
      limit $3
    `,
    [toVectorLiteral(input.queryVector), input.sourceIds, input.topK]
  );
  return result.rows.map((row) => ({
    chunkId: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? undefined : String(row.document_id),
    heading: row.heading == null ? undefined : String(row.heading),
    content: String(row.content),
    rank: Number(row.rank),
    score: Number(row.score)
  }));
}

export async function getEventDetail(input: {
  eventId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<EventDetailRecord | null> {
  const archiveSql = input.includeArchived
    ? ""
    : "and s.archived_at is null and (d.id is null or d.archived_at is null)";
  const eventResult = await pool.query(
    `
      select
        e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
        e.title_embedding::text as title_embedding_preview,
        e.content_embedding::text as content_embedding_preview,
        d.id as document_id_for_detail,
        d.title as document_title,
        d.source_name as document_source_name,
        d.source_type as document_source_type,
        d.source_date as document_source_date,
        d.source_author as document_source_author,
        d.source_url as document_source_url,
        d.status as document_status,
        d.parse_status as document_parse_status,
        d.metadata as document_metadata,
        d.created_at as document_created_at,
        d.updated_at as document_updated_at,
        d.archived_at as document_archived_at,
        s.id as source_id_for_detail,
        s.tenant_id as source_tenant_id,
        s.name as source_name,
        s.description as source_description,
        s.metadata as source_metadata,
        s.archived_at as source_archived_at,
        s.created_at as source_created_at,
        s.updated_at as source_updated_at
      from events e
      join sources s on s.id = e.source_id
      left join documents d on d.id = e.document_id
      where e.id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
    `,
    [input.eventId, input.tenantId]
  );
  if (!eventResult.rows[0]) {
    return null;
  }
  const event = eventFromRow(eventResult.rows[0]);
  const entityResult = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name
      from event_entities ee
      join entities ent on ent.id = ee.entity_id
      join sources s on s.id = ent.source_id
      where ee.event_id = $1
        and s.tenant_id = $2
      order by ent.type, ent.name
    `,
    [input.eventId, input.tenantId]
  );
  const chunkResult = event.chunkId
    ? await pool.query(
        `
          select c.id, c.source_id, c.document_id, c.heading, c.content, c.rank
          from source_chunks c
          join sources s on s.id = c.source_id
          left join documents d on d.id = c.document_id
          where c.id = $1
            and s.tenant_id = $2
            ${archiveSql}
        `,
        [event.chunkId, input.tenantId]
      )
    : { rows: [] };
  const row = eventResult.rows[0] as Record<string, unknown>;

  return {
    event,
    entities: entityResult.rows.map(entityFromRow),
    source: row.source_id_for_detail == null
      ? null
      : sourceFromRow({
          id: row.source_id_for_detail,
          tenant_id: row.source_tenant_id,
          name: row.source_name,
          description: row.source_description,
          metadata: row.source_metadata,
          archived_at: row.source_archived_at,
          created_at: row.source_created_at,
          updated_at: row.source_updated_at
        }),
    document: row.document_id_for_detail == null
      ? null
      : documentFromRow({
          id: row.document_id_for_detail,
          source_id: row.source_id_for_detail,
          title: row.document_title,
          source_name: row.document_source_name,
          source_type: row.document_source_type,
          source_date: row.document_source_date,
          source_author: row.document_source_author,
          source_url: row.document_source_url,
          status: row.document_status,
          parse_status: row.document_parse_status,
          metadata: row.document_metadata,
          created_at: row.document_created_at,
          updated_at: row.document_updated_at,
          archived_at: row.document_archived_at
        }),
    chunk: chunkResult.rows[0]
      ? {
          chunkId: String(chunkResult.rows[0].id),
          sourceId: String(chunkResult.rows[0].source_id),
          documentId: chunkResult.rows[0].document_id == null ? null : String(chunkResult.rows[0].document_id),
          heading: chunkResult.rows[0].heading == null ? undefined : String(chunkResult.rows[0].heading),
          content: String(chunkResult.rows[0].content),
          rank: Number(chunkResult.rows[0].rank ?? 0)
        }
      : undefined
  };
}

export async function listDocumentsBySource(input: {
  sourceId: string;
  tenantId: string;
  limit: number;
  includeArchived?: boolean;
}): Promise<DocumentRecord[]> {
  const archiveSql = input.includeArchived ? "" : "and d.archived_at is null";
  const result = await pool.query(
    `
      select d.*
      from documents d
      join sources s on s.id = d.source_id
      where d.source_id = $1 and s.tenant_id = $2 ${archiveSql}
      order by d.created_at desc, d.id
      limit $3
    `,
    [input.sourceId, input.tenantId, input.limit]
  );
  return result.rows.map(documentFromRow);
}

export async function updateDocument(input: {
  documentId: string;
  tenantId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set
        title = coalesce($3, d.title),
        metadata = d.metadata || $4::jsonb,
        updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [
      input.documentId,
      input.tenantId,
      input.title?.trim() || null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function archiveDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set archived_at = coalesce(d.archived_at, now()), updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function restoreDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set archived_at = null, updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function deleteDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const documentResult = await client.query(
      `
        select d.id
        from documents d
        join sources s on s.id = d.source_id
        where d.id = $1 and s.tenant_id = $2
        for no key update of s
      `,
      [input.documentId, input.tenantId]
    );
    if (!documentResult.rows[0]) {
      await client.query("rollback");
      return false;
    }

    await client.query(
      `
        with document_events as (
          select id
          from events
          where document_id = $1
        ),
        candidate_entities as (
          select distinct ee.entity_id
          from event_entities ee
          join document_events de on de.id = ee.event_id
        ),
        shared_entities as (
          select distinct ee.entity_id
          from event_entities ee
          join events e on e.id = ee.event_id
          where ee.entity_id in (select entity_id from candidate_entities)
            and (e.document_id is distinct from $1)
        )
        delete from entities ent
        where ent.id in (select entity_id from candidate_entities)
          and ent.id not in (select entity_id from shared_entities)
      `,
      [input.documentId]
    );

    await client.query(
      `
        delete from documents d
        using sources s
        where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      `,
      [input.documentId, input.tenantId]
    );
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getProjectStats(input: {
  sourceId: string;
  tenantId: string;
}): Promise<ProjectStatsRecord> {
  const sourceResult = await pool.query(
    `
      select id
      from sources
      where id = $1
        and tenant_id = $2
      limit 1
    `,
    [input.sourceId, input.tenantId]
  );

  if (!sourceResult.rows[0]) {
    return {
      documentCount: 0,
      chunkCount: 0,
      eventCount: 0,
      entityCount: 0
    };
  }

  const documentsResult = await pool.query(
    `
      select id
      from documents
      where source_id = $1
        and archived_at is null
    `,
    [input.sourceId]
  );
  const documentIds = documentsResult.rows.map((row) => String(row.id));

  const entitiesResult = await pool.query(
    `
      select count(*)::int as count
      from entities
      where source_id = $1
    `,
    [input.sourceId]
  );

  if (documentIds.length === 0) {
    return {
      documentCount: 0,
      chunkCount: 0,
      eventCount: 0,
      entityCount: Number(entitiesResult.rows[0]?.count ?? 0)
    };
  }

  const [chunksResult, eventsResult] = await Promise.all([
    pool.query(
      `
        select count(*)::int as count
        from source_chunks
        where source_id = $1
          and document_id = any($2::uuid[])
      `,
      [input.sourceId, documentIds]
    ),
    pool.query(
      `
        select count(*)::int as count
        from events
        where source_id = $1
          and document_id = any($2::uuid[])
          and deleted_at is null
      `,
      [input.sourceId, documentIds]
    )
  ]);

  return {
    documentCount: documentIds.length,
    chunkCount: Number(chunksResult.rows[0]?.count ?? 0),
    eventCount: Number(eventsResult.rows[0]?.count ?? 0),
    entityCount: Number(entitiesResult.rows[0]?.count ?? 0)
  };
}

export async function getProjectGraph(input: {
  sourceId: string;
  tenantId: string;
  chunkIds?: string[];
  eventIds?: string[];
  entityIds?: string[];
  entityName?: string;
  query?: string;
  limit?: number;
}): Promise<ProjectGraphRecord> {
  const chunkIds = uniqueIds(input.chunkIds);
  const requestedEventIds = uniqueIds(input.eventIds);
  const normalizedEntityName = input.entityName?.trim() ?? "";
  const entityIdsFromInput = uniqueIds(input.entityIds);
  const graphQuery = chunkIds.length || requestedEventIds.length || entityIdsFromInput.length || normalizedEntityName
    ? "" : input.query?.normalize("NFKC").trim().toLowerCase() ?? "";
  const exactEntityGroupIds = normalizedEntityName
    ? (
        await pool.query(
          `
            select distinct ent.id
            from entities ent
            join event_entities ee on ee.entity_id = ent.id
            join events e on e.id = ee.event_id
            join documents d on d.id = e.document_id
            join sources s on s.id = e.source_id
            where ent.source_id = $1
              and ent.normalized_name = $3
              and e.source_id = $1
              and s.tenant_id = $2
              and s.archived_at is null
              and d.archived_at is null
              and e.deleted_at is null
            order by ent.id
          `,
          [input.sourceId, input.tenantId, normalizedEntityName]
        )
      ).rows.map((row) => String(row.id))
    : [];
  const queryMatchedEntityIds = graphQuery
    ? (await pool.query(
        `
          select ent.id
          from entities ent
          where ent.source_id = $1
            and (strpos(lower(ent.name), $3) > 0 or strpos(ent.normalized_name, $3) > 0)
            and exists (
              select 1 from event_entities ee
              join events e on e.id = ee.event_id
              join documents d on d.id = e.document_id
              join sources s on s.id = e.source_id
              where ee.entity_id = ent.id and e.source_id = $1 and s.tenant_id = $2
                and s.archived_at is null and d.archived_at is null and e.deleted_at is null
            )
          order by (ent.normalized_name = $3) desc, ent.name, ent.id
          limit 80
        `, [input.sourceId, input.tenantId, graphQuery]
      )).rows.map((row) => String(row.id))
    : [];
  const graphCollectionLimit = normalizedEntityName
    ? Number.MAX_SAFE_INTEGER
    : MAX_PROJECT_GRAPH_LIMIT;
  const requestedEntityIds = uniqueIds(
    [
      ...entityIdsFromInput,
      ...exactEntityGroupIds,
      ...queryMatchedEntityIds
    ],
    graphCollectionLimit
  );
  const hasFocus =
    chunkIds.length > 0 ||
    requestedEventIds.length > 0 ||
    requestedEntityIds.length > 0 ||
    normalizedEntityName.length > 0 ||
    graphQuery.length > 0;
  const limit = clampProjectGraphLimit(input.limit, hasFocus);

  const selectedEventIdsResult = hasFocus
    ? await pool.query(
        `
          with active_events as (
            select
              e.id,
              e.chunk_id,
              e.rank,
              e.title,
              coalesce(c.heading, '') as chunk_heading,
              coalesce(c.content, '') as chunk_content
            from events e
            join documents d on d.id = e.document_id
            join sources s on s.id = e.source_id
            left join source_chunks c on c.id = e.chunk_id
            where e.source_id = $1
              and s.tenant_id = $2
              and s.archived_at is null
              and d.archived_at is null
              and e.deleted_at is null
          ),
          ranked as (
            select ae.id, ae.rank,
              case
                when ae.id = any($3::uuid[]) then 0
                when ae.chunk_id = any($4::uuid[]) then 1
                when $7::text <> '' and strpos(lower(ae.title), $7::text) > 0 then 2
                when cardinality($5::uuid[]) > 0 and exists (
                  select 1 from event_entities ee
                  where ee.event_id = ae.id and ee.entity_id = any($5::uuid[])
                ) then 3
                when $7::text <> '' and strpos(lower(ae.chunk_heading), $7::text) > 0 then 4
                when $7::text <> '' and strpos(lower(ae.chunk_content), $7::text) > 0 then 5
                else 6
              end as match_rank
            from active_events ae
          )
          select id from ranked
          where match_rank < 4
             or (
               match_rank in (4, 5)
               and match_rank = (select min(match_rank) from ranked)
             )
          order by match_rank, rank, id
          limit $6::int
        `,
        [
          input.sourceId,
          input.tenantId,
          requestedEventIds,
          chunkIds,
          requestedEntityIds,
          normalizedEntityName ? null : limit,
          graphQuery
        ]
      )
    : await pool.query(
        `
          select e.id
          from events e
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where e.source_id = $1
            and s.tenant_id = $2
            and s.archived_at is null
            and d.archived_at is null
            and e.deleted_at is null
          order by e.rank, e.id
          limit $3
        `,
        [input.sourceId, input.tenantId, limit]
      );
  const selectedEventIds = selectedEventIdsResult.rows.map((row) =>
    String(row.id)
  );

  const eventsResult =
    selectedEventIds.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await pool.query(
          `
            select
              e.id,
              e.source_id,
              e.document_id,
              e.chunk_id,
              e.title,
              e.category,
              e.rank,
              coalesce(
                array_agg(ee.entity_id order by ent.name) filter (where ee.entity_id is not null),
                '{}'
              ) as entity_ids
            from events e
            join documents d on d.id = e.document_id
            join sources s on s.id = e.source_id
            left join event_entities ee on ee.event_id = e.id
            left join entities ent on ent.id = ee.entity_id
            where e.id = any($1::uuid[])
              and e.source_id = $2
              and s.tenant_id = $3
              and s.archived_at is null
              and d.archived_at is null
              and e.deleted_at is null
            group by e.id
            order by array_position($1::uuid[], e.id)
          `,
          [selectedEventIds, input.sourceId, input.tenantId]
        );

  const events: ProjectGraphEventRecord[] = eventsResult.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    chunkId: row.chunk_id == null ? null : String(row.chunk_id),
    title: String(row.title),
    category: row.category == null ? null : String(row.category),
    rank: Number(row.rank ?? 0),
    entityIds: Array.isArray(row.entity_ids) ? row.entity_ids.map(String) : []
  }));
  const entityIds = uniqueIds(
    [
      ...requestedEntityIds,
      ...events.flatMap((event) => event.entityIds)
    ],
    graphCollectionLimit
  );
  const chunkIdsForGraph = uniqueIds(
    [
      ...chunkIds,
      ...events
        .map((event) => event.chunkId)
        .filter((id): id is string => Boolean(id))
    ],
    graphCollectionLimit
  );
  const chunksResult =
    chunkIdsForGraph.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await pool.query(
          `
            select
              c.id,
              c.source_id,
              c.document_id,
              c.heading,
              left(c.content, 360) as content,
              c.rank,
              count(distinct e.id)::int as event_count
            from source_chunks c
            join documents d on d.id = c.document_id
            join sources s on s.id = c.source_id
            left join events e
              on e.chunk_id = c.id
             and e.deleted_at is null
            where c.id = any($1::uuid[])
              and c.source_id = $2
              and s.tenant_id = $3
              and s.archived_at is null
              and d.archived_at is null
            group by c.id
            order by array_position($1::uuid[], c.id), c.rank, c.id
          `,
          [chunkIdsForGraph, input.sourceId, input.tenantId]
        );

  const chunks: ProjectGraphChunkRecord[] = chunksResult.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    heading: row.heading == null ? null : String(row.heading),
    content: String(row.content ?? ""),
    rank: Number(row.rank ?? 0),
    eventCount: Number(row.event_count ?? 0)
  }));

  const entitiesResult =
    entityIds.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await pool.query(
          `
            select
              ent.id,
              ent.source_id,
              ent.type,
              ent.name,
              ent.normalized_name,
              count(distinct e.id)::int as event_count
            from entities ent
            join event_entities ee on ee.entity_id = ent.id
            join events e on e.id = ee.event_id
            join documents d on d.id = e.document_id
            join sources s on s.id = e.source_id
            where ent.id = any($1::uuid[])
              and ent.source_id = $2
              and s.tenant_id = $3
              and s.archived_at is null
              and d.archived_at is null
              and e.deleted_at is null
            group by ent.id
            order by event_count desc, ent.type, ent.name
          `,
          [entityIds, input.sourceId, input.tenantId]
        );

  const entities: ProjectGraphEntityRecord[] = entitiesResult.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    type: String(row.type),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    eventCount: Number(row.event_count ?? 0)
  }));
  const edges = events.flatMap((event) => event.entityIds.map((entityId) => ({
    entityId,
    eventId: event.id
  })));
  const chunkEventEdges = events
    .filter((event) => event.chunkId)
    .map((event) => ({
      chunkId: String(event.chunkId),
      eventId: event.id
    }));

  return {
    version: "limited-v1",
    scope: hasFocus ? "focus" : "overview",
    chunks,
    entities,
    events,
    edges,
    chunkEventEdges
  };
}

export async function getDocumentDetail(input: {
  documentId: string;
  tenantId: string;
}): Promise<(DocumentRecord & { source: SourceRecord }) | null> {
  const result = await pool.query(
    `
      select d.*, s.id as source_id_for_source, s.tenant_id, s.name as project_source_name,
             s.description as source_description, s.metadata as source_metadata
      from documents d
      join sources s on s.id = d.source_id
      where d.id = $1 and s.tenant_id = $2
    `,
    [input.documentId, input.tenantId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    ...documentFromRow(row),
    source: {
      id: String(row.source_id),
      tenantId: String(row.tenant_id),
      name: String(row.project_source_name),
      description: row.source_description == null ? null : String(row.source_description),
      metadata: (row.source_metadata ?? {}) as Record<string, unknown>
    }
  };
}

export async function listChunksByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<ChunkRecord[]> {
  const result = await pool.query(
    `
      select
        c.id, c.source_id, c.document_id, c.heading, c.content, c.raw_content,
        c.rank, c.references, c.metadata, c.created_at,
        case when c.embedding is null then null else vector_dims(c.embedding) end as embedding_dimensions
      from source_chunks c
      join sources s on s.id = c.source_id
      where c.document_id = $1 and s.tenant_id = $2
      order by c.rank, c.id
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows.map(chunkFromRow);
}

export async function listChunksByProject(input: {
  sourceId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<ChunkRecord[]> {
  const archiveSql = input.includeArchived ? "" : "and s.archived_at is null and (d.id is null or d.archived_at is null)";
  const result = await pool.query(
    `
      select
        c.id, c.source_id, c.document_id, c.heading, c.content, c.raw_content,
        c.rank, c.references, c.metadata, c.created_at,
        case when c.embedding is null then null else vector_dims(c.embedding) end as embedding_dimensions
      from source_chunks c
      join sources s on s.id = c.source_id
      left join documents d on d.id = c.document_id
      where c.source_id = $1
        and s.tenant_id = $2
        ${archiveSql}
      order by coalesce(d.created_at, c.created_at), c.rank, c.id
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows.map(chunkFromRow);
}

export async function updateChunk(input: {
  chunkId: string;
  tenantId: string;
  heading?: string | null;
  content?: string;
  rawContent?: string | null;
}): Promise<ChunkRecord | null> {
  const result = await pool.query(
    `
      update source_chunks c
      set
        heading = case when $3::boolean then nullif($4, '') else c.heading end,
        content = coalesce($5, c.content),
        raw_content = case when $6::boolean then $7 else c.raw_content end,
        updated_at = now()
      from sources s
      where c.source_id = s.id
        and c.id = $1
        and s.tenant_id = $2
        and s.archived_at is null
        and (
          c.document_id is null
          or exists (
            select 1
            from documents d
            where d.id = c.document_id
              and d.archived_at is null
          )
        )
      returning c.*
    `,
    [
      input.chunkId,
      input.tenantId,
      Object.prototype.hasOwnProperty.call(input, "heading"),
      input.heading?.trim() ?? "",
      input.content?.trim() || null,
      Object.prototype.hasOwnProperty.call(input, "rawContent"),
      input.rawContent ?? null
    ]
  );
  return result.rows[0] ? chunkFromRow(result.rows[0]) : null;
}

export async function deleteChunk(input: {
  chunkId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const eventResult = await client.query(
      `
        select e.id
        from events e
        join sources s on s.id = e.source_id
        left join documents d on d.id = e.document_id
        where e.chunk_id = $1
          and s.tenant_id = $2
          and e.deleted_at is null
          and s.archived_at is null
          and (d.id is null or d.archived_at is null)
        for update of e, s
      `,
      [input.chunkId, input.tenantId]
    );
    const eventIds = eventResult.rows.map((row) => String(row.id));
    await softDeleteEventsAndPruneEntities(client, eventIds);
    const result = await client.query(
      `
        delete from source_chunks c
        using sources s
        where c.source_id = s.id
          and c.id = $1
          and s.tenant_id = $2
      `,
      [input.chunkId, input.tenantId]
    );
    await client.query("commit");
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listEventsByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<Array<EventRecord & { entityCount: number; entities: EntityRecord[] }>> {
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary,
             e.content, e.rank,
             case when e.title_embedding is null then null else vector_dims(e.title_embedding) end as title_embedding_dimensions,
             case when e.content_embedding is null then null else vector_dims(e.content_embedding) end as content_embedding_dimensions,
             count(ee.entity_id)::int as entity_count,
             coalesce(
               jsonb_agg(
                 distinct jsonb_build_object(
                   'id', ent.id,
                   'source_id', ent.source_id,
                   'type', ent.type,
                   'name', ent.name,
                   'normalized_name', ent.normalized_name,
                   'description', ent.description
                 )
               ) filter (where ent.id is not null),
               '[]'::jsonb
             ) as entities
      from events e
      join sources s on s.id = e.source_id
      left join event_entities ee on ee.event_id = e.id
      left join entities ent on ent.id = ee.entity_id
      where e.document_id = $1 and s.tenant_id = $2 and e.deleted_at is null
      group by e.id
      order by e.rank, e.id
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows.map((row) => ({
    ...eventFromRow(row),
    entityCount: Number(row.entity_count ?? 0),
    entities: Array.isArray(row.entities)
      ? row.entities.map((entityRow: Record<string, unknown>) => entityFromRow(entityRow))
    : []
  }));
}

export async function listEventsByProject(input: {
  sourceId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<Array<EventRecord & { entityCount: number; entities: EntityRecord[] }>> {
  const archiveSql = input.includeArchived ? "" : "and s.archived_at is null and (d.id is null or d.archived_at is null)";
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary,
             e.content, e.rank,
             case when e.title_embedding is null then null else vector_dims(e.title_embedding) end as title_embedding_dimensions,
             case when e.content_embedding is null then null else vector_dims(e.content_embedding) end as content_embedding_dimensions,
             count(ee.entity_id)::int as entity_count,
             coalesce(
               jsonb_agg(
                 distinct jsonb_build_object(
                   'id', ent.id,
                   'source_id', ent.source_id,
                   'type', ent.type,
                   'name', ent.name,
                   'normalized_name', ent.normalized_name,
                   'description', ent.description
                 )
               ) filter (where ent.id is not null),
               '[]'::jsonb
             ) as entities
      from events e
      join sources s on s.id = e.source_id
      left join documents d on d.id = e.document_id
      left join event_entities ee on ee.event_id = e.id
      left join entities ent on ent.id = ee.entity_id
      where e.source_id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
      group by e.id, d.created_at
      order by coalesce(d.created_at, now()), e.rank, e.id
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows.map((row) => ({
    ...eventFromRow(row),
    entityCount: Number(row.entity_count ?? 0),
    entities: Array.isArray(row.entities)
      ? row.entities.map((entityRow: Record<string, unknown>) => entityFromRow(entityRow))
      : []
  }));
}

export async function updateEvent(input: {
  eventId: string;
  tenantId: string;
  title?: string;
  summary?: string;
  content?: string;
}): Promise<EventDetailRecord | null> {
  const result = await pool.query(
    `
      update events e
      set
        title = coalesce($3, e.title),
        summary = coalesce($4, e.summary),
        content = coalesce($5, e.content),
        metadata = e.metadata || $6::jsonb,
        updated_at = now()
      from sources s
      where e.source_id = s.id
        and e.id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        and s.archived_at is null
        and (
          e.document_id is null
          or exists (
            select 1
            from documents d
            where d.id = e.document_id
              and d.archived_at is null
          )
        )
      returning e.id
    `,
    [
      input.eventId,
      input.tenantId,
      input.title?.trim() || null,
      input.summary?.trim() ?? null,
      input.content?.trim() || null,
      JSON.stringify({ editedVia: "webui", editedAt: new Date().toISOString() })
    ]
  );
  return result.rows[0] ? getEventDetail({ eventId: String(result.rows[0].id), tenantId: input.tenantId }) : null;
}

export async function deleteEvent(input: {
  eventId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const eventResult = await client.query(
      `
        select e.id
        from events e
        join sources s on s.id = e.source_id
        left join documents d on d.id = e.document_id
        where e.id = $1
          and s.tenant_id = $2
          and e.deleted_at is null
          and s.archived_at is null
          and (d.id is null or d.archived_at is null)
        for update of e, s
      `,
      [input.eventId, input.tenantId]
    );
    if (!eventResult.rows[0]) {
      await client.query("rollback");
      return false;
    }
    await softDeleteEventsAndPruneEntities(client, [input.eventId]);
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listEntitiesByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<EntityWithEventsRecord[]> {
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             ent.description,
             case when ent.embedding is null then null else vector_dims(ent.embedding) end as embedding_dimensions,
             count(distinct ee.event_id)::int as event_count
      from entities ent
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join sources s on s.id = e.source_id
      where e.document_id = $1 and s.tenant_id = $2 and e.deleted_at is null
      group by ent.id
      order by event_count desc, ent.type, ent.name
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows.map((row) => ({
    ...entityFromRow(row),
    description: row.description == null ? null : String(row.description),
    eventCount: Number(row.event_count ?? 0)
  }));
}


export async function listEntitiesByProject(input: {
  sourceId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<EntityWithEventsRecord[]> {
  const archiveSql = input.includeArchived ? "" : "and s.archived_at is null and d.archived_at is null";
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             ent.description,
             case when ent.embedding is null then null else vector_dims(ent.embedding) end as embedding_dimensions,
             count(distinct ee.event_id)::int as event_count
      from entities ent
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where ent.source_id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
      group by ent.id
      order by event_count desc, ent.type, ent.name
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows.map((row) => ({
    ...entityFromRow(row),
    description: row.description == null ? null : String(row.description),
    eventCount: Number(row.event_count ?? 0)
  }));
}

export async function updateEntity(input: {
  entityId: string;
  tenantId: string;
  type?: string;
  name?: string;
  description?: string | null;
}): Promise<EntityDetailRecord | null> {
  const current = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name
      from entities ent
      join sources s on s.id = ent.source_id
      where ent.id = $1
        and s.tenant_id = $2
        and s.archived_at is null
    `,
    [input.entityId, input.tenantId]
  );
  const existing = current.rows[0];
  if (!existing) {
    return null;
  }
  const nextType = (input.type?.trim() || String(existing.type)).normalize("NFKC").toLowerCase();
  const nextName = (input.name?.trim() || String(existing.name)).normalize("NFKC").trim();
  const entityTypeId = (await getDefaultEntityType(nextType)) ?? await getAnyDefaultEntityType();
  const result = await pool.query(
    `
      update entities ent
      set
        entity_type_id = $3,
        type = $4,
        name = $5,
        normalized_name = $6,
        description = case when $7::boolean then $8 else ent.description end,
        metadata = ent.metadata || $9::jsonb,
        updated_at = now()
      from sources s
      where ent.source_id = s.id
        and ent.id = $1
        and s.tenant_id = $2
        and s.archived_at is null
      returning ent.id
    `,
    [
      input.entityId,
      input.tenantId,
      entityTypeId,
      nextType,
      nextName,
      normalizeEntityName(nextName),
      Object.prototype.hasOwnProperty.call(input, "description"),
      input.description ?? null,
      JSON.stringify({ editedVia: "webui", editedAt: new Date().toISOString() })
    ]
  );
  return result.rows[0] ? getEntityDetail({ entityId: String(result.rows[0].id), tenantId: input.tenantId }) : null;
}

export async function deleteEntity(input: {
  entityId: string;
  tenantId: string;
}): Promise<boolean> {
  const result = await pool.query(
    `
      delete from entities ent
      using sources s
      where ent.source_id = s.id
        and ent.id = $1
        and s.tenant_id = $2
      returning ent.id
    `,
    [input.entityId, input.tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getKnowledgeAssetsByChunkIds(input: {
  chunkIds: string[];
  tenantId: string;
}): Promise<{
  chunks: Array<ChunkRecord & { document?: DocumentRecord | null }>;
  events: Array<EventRecord & { entities: EntityRecord[] }>;
  entities: EntityRecord[];
}> {
  const chunkIds = [...new Set(input.chunkIds)].filter(Boolean);
  if (chunkIds.length === 0) {
    return { chunks: [], events: [], entities: [] };
  }

  const chunksResult = await pool.query(
    `
      select
        c.id, c.source_id, c.document_id, c.heading, c.content, c.raw_content, c.rank,
        c.references, c.metadata, c.created_at, c.embedding::text as embedding_preview,
        d.id as document_id_for_detail,
        d.title as document_title,
        d.source_name as document_source_name,
        d.source_type as document_source_type,
        d.source_date as document_source_date,
        d.source_author as document_source_author,
        d.source_url as document_source_url,
        d.status as document_status,
        d.parse_status as document_parse_status,
        d.metadata as document_metadata,
        d.created_at as document_created_at,
        d.updated_at as document_updated_at,
        d.archived_at as document_archived_at
      from source_chunks c
      join documents d on d.id = c.document_id
      join sources s on s.id = c.source_id
      where c.id = any($1::uuid[])
        and s.tenant_id = $2
        and d.archived_at is null
      order by array_position($1::uuid[], c.id), c.rank
    `,
    [chunkIds, input.tenantId]
  );
  const chunks = chunksResult.rows.map((row) => ({
    ...chunkFromRow(row),
    document: row.document_id_for_detail == null
      ? null
      : documentFromRow({
          id: row.document_id_for_detail,
          source_id: row.source_id,
          title: row.document_title,
          source_name: row.document_source_name,
          source_type: row.document_source_type,
          source_date: row.document_source_date,
          source_author: row.document_source_author,
          source_url: row.document_source_url,
          status: row.document_status,
          parse_status: row.document_parse_status,
          metadata: row.document_metadata,
          created_at: row.document_created_at,
          updated_at: row.document_updated_at,
          archived_at: row.document_archived_at
        })
  }));

  const eventsResult = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary,
             e.content, e.rank, e.title_embedding::text as title_embedding_preview,
             e.content_embedding::text as content_embedding_preview
      from events e
      join source_chunks c on c.id = e.chunk_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.chunk_id = any($1::uuid[])
        and s.tenant_id = $2
        and d.archived_at is null
        and e.deleted_at is null
      order by e.rank, e.id
    `,
    [chunkIds, input.tenantId]
  );
  const events = eventsResult.rows.map(eventFromRow);
  if (events.length === 0) {
    return { chunks, events: [], entities: [] };
  }

  const eventIds = events.map((event) => event.id);
  const entitiesResult = await pool.query(
    `
      select distinct ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             ent.description, ent.embedding::text as embedding_preview
      from event_entities ee
      join entities ent on ent.id = ee.entity_id
      where ee.event_id = any($1::uuid[])
      order by ent.type, ent.name
    `,
    [eventIds]
  );
  const entities = entitiesResult.rows.map(entityFromRow);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const relationResult = await pool.query(
    `
      select event_id, entity_id
      from event_entities
      where event_id = any($1::uuid[])
      order by event_id
    `,
    [eventIds]
  );
  const entityIdsByEventId = new Map<string, string[]>();
  for (const row of relationResult.rows) {
    const eventId = String(row.event_id);
    const group = entityIdsByEventId.get(eventId) ?? [];
    group.push(String(row.entity_id));
    entityIdsByEventId.set(eventId, group);
  }

  return {
    chunks,
    events: events.map((event) => ({
      ...event,
      entities: (entityIdsByEventId.get(event.id) ?? [])
        .map((entityId) => entityById.get(entityId))
        .filter((entity): entity is EntityRecord => Boolean(entity))
    })),
    entities
  };
}

export async function matchChainAtlasEntities(input: {
  names: string[];
  tenantId: string;
  projectId?: string;
}) {
  const names = [...new Set(input.names)];
  if (names.length === 0) return [];
  const result = await pool.query<{
    term: string;
    id: string;
    name: string;
    type: string;
    source_id: string;
    source_name: string;
  }>(
    `
      select requested.term, matched.*
      from unnest($1::text[], $2::text[]) as requested(term, normalized)
      cross join lateral (
        select ent.id, ent.name, ent.type, s.id as source_id, s.name as source_name
        from entities ent
        join sources s on s.id = ent.source_id
        where ent.normalized_name in (requested.normalized, lower(requested.term))
          and s.tenant_id = $3 and s.archived_at is null
          and ($4::uuid is null or s.id = $4)
          and exists (
            select 1
            from event_entities ee
            join events e on e.id = ee.event_id
            join documents d on d.id = e.document_id
            where ee.entity_id = ent.id
              and e.deleted_at is null and d.archived_at is null
          )
        order by lower(s.name), ent.name, ent.id
        limit 12
      ) matched
    `,
    [names, names.map(normalizeEntityName), input.tenantId, input.projectId ?? null]
  );
  return result.rows.map(row => ({
    term: row.term,
    id: row.id,
    name: row.name,
    type: row.type,
    sourceId: row.source_id,
    sourceName: row.source_name
  }));
}

export async function getEntityDetail(input: {
  entityId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<EntityDetailRecord | null> {
  const archiveSql = input.includeArchived
    ? ""
    : "and s.archived_at is null and d.archived_at is null";
  const entityResult = await pool.query(
    `
      select
        ent.id,
        ent.source_id,
        ent.type,
        ent.name,
        ent.normalized_name,
        ent.description,
        ent.embedding::text as embedding_preview,
        count(distinct ee.event_id)::int as event_count,
        s.tenant_id,
        s.name as source_name,
        s.description as source_description,
        s.metadata as source_metadata,
        s.archived_at as source_archived_at,
        s.created_at as source_created_at,
        s.updated_at as source_updated_at
      from entities ent
      join sources s on s.id = ent.source_id
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      where ent.id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
      group by ent.id, s.id
    `,
    [input.entityId, input.tenantId]
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) {
    return null;
  }
  const eventsResult = await pool.query(
    `
      select
        e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
        d.id as document_id_for_detail,
        d.title as document_title,
        d.source_name as document_source_name,
        d.source_type as document_source_type,
        d.source_date as document_source_date,
        d.source_author as document_source_author,
        d.source_url as document_source_url,
        d.status as document_status,
        d.parse_status as document_parse_status,
        d.metadata as document_metadata,
        d.created_at as document_created_at,
        d.updated_at as document_updated_at,
        d.archived_at as document_archived_at
      from event_entities ee
      join events e on e.id = ee.event_id
      join sources s on s.id = e.source_id
      join documents d on d.id = e.document_id
      where ee.entity_id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
      order by e.rank, e.id
    `,
    [input.entityId, input.tenantId]
  );
  return {
    entity: {
      ...entityFromRow(entityRow),
      description: entityRow.description == null ? null : String(entityRow.description),
      eventCount: Number(entityRow.event_count ?? 0)
    },
    events: eventsResult.rows.map((row) => ({
      ...eventFromRow(row),
      document: row.document_id_for_detail == null
        ? null
        : documentFromRow({
            id: row.document_id_for_detail,
            source_id: row.source_id,
            title: row.document_title,
            source_name: row.document_source_name,
            source_type: row.document_source_type,
            source_date: row.document_source_date,
            source_author: row.document_source_author,
            source_url: row.document_source_url,
            status: row.document_status,
            parse_status: row.document_parse_status,
            metadata: row.document_metadata,
            created_at: row.document_created_at,
            updated_at: row.document_updated_at,
            archived_at: row.document_archived_at
          })
    })),
    source: sourceFromRow({
      id: entityRow.source_id,
      tenant_id: entityRow.tenant_id,
      name: entityRow.source_name,
      description: entityRow.source_description,
      metadata: entityRow.source_metadata,
      archived_at: entityRow.source_archived_at,
      created_at: entityRow.source_created_at,
      updated_at: entityRow.source_updated_at
    })
  };
}

async function softDeleteEventsAndPruneEntities(client: Queryable, eventIds: string[]): Promise<void> {
  const uniqueEventIds = [...new Set(eventIds)].filter(Boolean);
  if (uniqueEventIds.length === 0) {
    return;
  }
  const candidateEntities = await client.query(
    `
      select distinct entity_id
      from event_entities
      where event_id = any($1::uuid[])
    `,
    [uniqueEventIds]
  );
  const entityIds = candidateEntities.rows.map((row) => String(row.entity_id));
  await client.query(
    "delete from event_entities where event_id = any($1::uuid[])",
    [uniqueEventIds]
  );
  await client.query(
    "update events set deleted_at = coalesce(deleted_at, now()), updated_at = now() where id = any($1::uuid[])",
    [uniqueEventIds]
  );
  if (entityIds.length === 0) {
    return;
  }
  await client.query(
    `
      delete from entities ent
      where ent.id = any($1::uuid[])
        and not exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
        )
    `,
    [[...new Set(entityIds)]]
  );
}

export async function getAiProviderSettings(): Promise<AiProviderSettingsRecord | null> {
  const result = await pool.query("select * from ai_provider_settings where id = 'global'");
  return result.rows[0] ? aiProviderSettingsFromRow(result.rows[0]) : null;
}

export async function upsertAiProviderSettings(input: {
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string | null;
  preserveEmbeddingApiKey?: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string | null;
  preserveLlmApiKey?: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  metadata?: Record<string, unknown>;
}): Promise<AiProviderSettingsRecord> {
  const result = await pool.query(
    `
      insert into ai_provider_settings (
        id,
        embedding_base_url,
        embedding_model,
        embedding_dimensions,
        embedding_api_key,
        llm_base_url,
        llm_model,
        llm_api_key,
        llm_timeout_ms,
        llm_max_retries,
        metadata
      )
      values (
        'global',
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10::jsonb
      )
      on conflict (id) do update set
        embedding_base_url = excluded.embedding_base_url,
        embedding_model = excluded.embedding_model,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding_api_key = case
          when $11::boolean then ai_provider_settings.embedding_api_key
          else excluded.embedding_api_key
        end,
        llm_base_url = excluded.llm_base_url,
        llm_model = excluded.llm_model,
        llm_api_key = case
          when $12::boolean then ai_provider_settings.llm_api_key
          else excluded.llm_api_key
        end,
        llm_timeout_ms = excluded.llm_timeout_ms,
        llm_max_retries = excluded.llm_max_retries,
        metadata = ai_provider_settings.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [
      input.embeddingBaseUrl,
      input.embeddingModel,
      input.embeddingDimensions,
      input.embeddingApiKey ?? null,
      input.llmBaseUrl,
      input.llmModel,
      input.llmApiKey ?? null,
      input.llmTimeoutMs,
      input.llmMaxRetries,
      JSON.stringify(input.metadata ?? {}),
      input.preserveEmbeddingApiKey ?? false,
      input.preserveLlmApiKey ?? false
    ]
  );
  return aiProviderSettingsFromRow(result.rows[0]);
}

export async function createMcpSession(input: {
  tenantId: string;
  title: string;
  model?: string;
  sourceIds?: string[];
  metadata?: Record<string, unknown>;
}): Promise<McpSessionRecord> {
  const result = await pool.query(
    `
      insert into mcp_sessions (id, tenant_id, title, model, source_ids, metadata)
      values ($1, $2, $3, $4, $5::uuid[], $6::jsonb)
      returning *
    `,
    [
      randomUUID(),
      input.tenantId,
      input.title,
      input.model ?? null,
      input.sourceIds ?? [],
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return mcpSessionFromRow(result.rows[0]);
}

export async function listMcpSessions(input: {
  tenantId: string;
  limit: number;
  sourceId?: string;
}): Promise<McpSessionRecord[]> {
  const params: unknown[] = [input.tenantId, input.limit];
  const sourceSql = input.sourceId ? "and source_ids @> $3::uuid[]" : "";
  if (input.sourceId) {
    params.push([input.sourceId]);
  }
  const result = await pool.query(
    `
      select *
      from mcp_sessions
      where tenant_id = $1 ${sourceSql}
      order by updated_at desc, id
      limit $2
    `,
    params
  );
  return result.rows.map(mcpSessionFromRow);
}

export async function getMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<McpSessionRecord | null> {
  const result = await pool.query(
    "select * from mcp_sessions where id = $1 and tenant_id = $2",
    [input.sessionId, input.tenantId]
  );
  return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
}

export async function updateMcpSessionTitle(input: {
  sessionId: string;
  tenantId: string;
  title: string;
  metadata?: Record<string, unknown>;
}): Promise<McpSessionRecord | null> {
  const result = await pool.query(
    `
      update mcp_sessions
      set
        title = $3,
        metadata = metadata || $4::jsonb,
        updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [
      input.sessionId,
      input.tenantId,
      input.title.trim(),
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
}

export async function updateMcpSessionMetadata(input: {
  sessionId: string;
  tenantId: string;
  metadata: Record<string, unknown>;
}): Promise<McpSessionRecord | null> {
  const result = await pool.query(
    `
      update mcp_sessions
      set
        metadata = metadata || $3::jsonb,
        updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [
      input.sessionId,
      input.tenantId,
      JSON.stringify(input.metadata)
    ]
  );
  return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
}

export async function clearMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sessionResult = await client.query(
      "select id from mcp_sessions where id = $1 and tenant_id = $2 for update",
      [input.sessionId, input.tenantId]
    );
    if (!sessionResult.rows[0]) {
      await client.query("rollback");
      return false;
    }
    await client.query("delete from mcp_tool_calls where session_id = $1", [input.sessionId]);
    await client.query("delete from mcp_messages where session_id = $1", [input.sessionId]);
    await client.query(
      "update mcp_sessions set updated_at = now() where id = $1",
      [input.sessionId]
    );
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<boolean> {
  const result = await pool.query(
    "delete from mcp_sessions where id = $1 and tenant_id = $2",
    [input.sessionId, input.tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function addMcpMessage(input: {
  sessionId: string;
  id?: string;
  role: McpMessageRole;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<McpMessageRecord> {
  const result = await pool.query(
    `
      insert into mcp_messages (id, session_id, role, content, metadata)
      values ($1, $2, $3, $4, $5::jsonb)
      on conflict (id) do nothing
      returning *
    `,
    [input.id ?? randomUUID(), input.sessionId, input.role, input.content, JSON.stringify(input.metadata ?? {})]
  );
  if (!result.rows[0]) {
    const existing = await pool.query(
      "select * from mcp_messages where id = $1 and session_id = $2 and role = $3 and content = $4",
      [input.id, input.sessionId, input.role, input.content]
    );
    if (!existing.rows[0]) throw new Error("会话轮次标识和已存储的消息不匹配");
    return mcpMessageFromRow(existing.rows[0]);
  }
  await touchMcpSession(input.sessionId);
  return mcpMessageFromRow(result.rows[0]);
}

export async function addMcpToolCall(input: {
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  durationMs?: number | null;
  error?: string | null;
}): Promise<McpToolCallRecord> {
  const queryResult = await pool.query(
    `
      insert into mcp_tool_calls (
        id, session_id, message_id, tool_name, arguments, result, status, duration_ms, error
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
      returning *
    `,
    [
      randomUUID(),
      input.sessionId,
      input.messageId ?? null,
      input.toolName,
      JSON.stringify(input.arguments),
      JSON.stringify(input.result ?? null),
      input.status,
      input.durationMs ?? null,
      input.error ?? null
    ]
  );
  await touchMcpSession(input.sessionId);
  return mcpToolCallFromRow(queryResult.rows[0]);
}

export async function getMcpSessionDetail(input: {
  sessionId: string;
  tenantId: string;
}): Promise<{
  session: McpSessionRecord;
  messages: McpMessageRecord[];
  toolCalls: McpToolCallRecord[];
} | null> {
  const session = await getMcpSession(input);
  if (!session) {
    return null;
  }
  const [messagesResult, callsResult] = await Promise.all([
    pool.query(
      "select * from mcp_messages where session_id = $1 order by created_at, id",
      [input.sessionId]
    ),
    pool.query(
      "select * from mcp_tool_calls where session_id = $1 order by created_at, id",
      [input.sessionId]
    )
  ]);
  return {
    session,
    messages: messagesResult.rows.map(mcpMessageFromRow),
    toolCalls: callsResult.rows.map(mcpToolCallFromRow)
  };
}

async function touchMcpSession(sessionId: string): Promise<void> {
  await pool.query(
    "update mcp_sessions set updated_at = now() where id = $1",
    [sessionId]
  );
}
