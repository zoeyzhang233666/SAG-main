import { randomUUID } from "node:crypto";
import { embeddingClient, type EmbeddingClient } from "../ai/embedding-client.js";
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import { createSource, deleteDocument, upsertEntity } from "../db/repositories.js";
import { toVectorLiteral } from "../db/vector.js";
import { estimateTokens } from "../ingestion/chunking/markdown.js";
import type { ManualKnowledgeDocument } from "../ingestion/manual-import.js";
import { logger } from "../observability/logger.js";
import type { IngestDocumentResult, IngestProgressUpdate } from "../types.js";

const DEFAULT_CHUNK_BATCH_SIZE = 25;
const DEFAULT_EMBEDDING_BATCH_SIZE = 64;
const MAX_CHUNK_BATCH_SIZE = 200;
const MAX_EMBEDDING_BATCH_SIZE = 256;

type ManualIngestProgress = (update: IngestProgressUpdate) => void;

type PreparedManualItem = {
  rank: number;
  section: {
    id: string;
    heading: string;
    content: string;
    rawContent: string;
    tokenCount: number;
  };
  chunk: {
    id: string;
    heading: string;
    content: string;
    rawContent: string;
    embedding: number[];
  };
  event: {
    id: string;
    title: string;
    summary: string;
    content: string;
    category?: string;
    keywords: string[];
    titleEmbedding: number[];
    contentEmbedding: number[];
    entities: Array<{
      type: string;
      name: string;
      description: string;
      relation?: string;
      entityEmbedding: number[];
      relationEmbedding: number[];
    }>;
  };
};

export class ManualIngestionService {
  constructor(private readonly embeddings: EmbeddingClient = embeddingClient) {}

  async ingest(
    input: {
      sourceId: string;
      document: ManualKnowledgeDocument;
      fileName?: string;
      format: string;
    },
    tenantId = config.DEFAULT_TENANT_ID,
    onProgress?: ManualIngestProgress
  ): Promise<IngestDocumentResult> {
    const traceId = randomUUID();
    const taskId = randomUUID();
    const documentId = randomUUID();
    const chunks = input.document.chunks;
    const totalChunks = chunks.length;
    let insertedChunks = 0;
    let documentCreated = false;

    const report = (update: IngestProgressUpdate) => {
      onProgress?.({
        totalChunks,
        currentChunk: insertedChunks,
        chunkCount: insertedChunks,
        eventCount: insertedChunks,
        ...update
      });
    };

    report({
      stage: "PARSING",
      message: `准备导入「${input.document.title}」：${totalChunks} 个切片`,
      progress: 2
    });

    const source = await createSource({
      id: input.sourceId,
      tenantId,
      name: input.document.title,
      description: "Created by manual structured import",
      metadata: {
        traceId,
        importedVia: "manual-structured"
      }
    });

    const documentContent = input.document.chunks
      .map((chunk) => `## ${chunk.heading}\n\n${chunk.content}`)
      .join("\n\n");

    try {
      await pool.query(
        `
          insert into documents (
            id, source_id, title, content, status, parse_status,
            source_name, source_type, source_date, source_author, source_url,
            metadata
          )
          values ($1, $2, $3, $4, 'PROCESSING', 'PROCESSING', $5, $6, $7, $8, $9, $10::jsonb)
        `,
        [
          documentId,
          source.id,
          input.document.title,
          documentContent,
          input.document.source?.name ?? null,
          input.document.source?.type ?? null,
          input.document.source?.date ?? null,
          input.document.source?.author ?? null,
          input.document.source?.url ?? null,
          JSON.stringify({
            traceId,
            fileName: input.fileName ?? null,
            importedVia: "manual-structured",
            importFormat: input.format,
            embeddingMode: "configured-client",
            source: input.document.source ?? null
          })
        ]
      );
      documentCreated = true;

      if (totalChunks === 0) {
        throw new Error("导入文档没有可写入的切片");
      }

      const chunkBatchSize = readPositiveIntEnv(
        "STRUCTURED_IMPORT_CHUNK_BATCH_SIZE",
        DEFAULT_CHUNK_BATCH_SIZE,
        MAX_CHUNK_BATCH_SIZE
      );
      const embeddingBatchSize = readPositiveIntEnv(
        "STRUCTURED_IMPORT_EMBEDDING_BATCH_SIZE",
        DEFAULT_EMBEDDING_BATCH_SIZE,
        MAX_EMBEDDING_BATCH_SIZE
      );

      for (let offset = 0; offset < chunks.length; offset += chunkBatchSize) {
        const batch = chunks.slice(offset, offset + chunkBatchSize);
        const batchStartRank = offset;
        const batchEndRank = offset + batch.length;
        const chunkProgressBase = progressForOffset(offset, totalChunks, 10, 75);

        report({
          stage: "EMBEDDING_CHUNKS",
          message: `正在分批生成切片向量：${offset + 1}-${batchEndRank}/${totalChunks}`,
          progress: chunkProgressBase,
          currentChunk: offset,
          totalChunks
        });

        const chunkEmbeddings = await this.embedInBatches(
          batch.map((item) => `${item.heading}\n${item.content}`),
          embeddingBatchSize,
          (done, total) => report({
            stage: "EMBEDDING_CHUNKS",
            message: `正在分批生成切片向量：${offset + done}/${totalChunks}`,
            progress: chunkProgressBase + (done / Math.max(total, 1)) * 6,
            currentChunk: offset,
            totalChunks
          })
        );

        report({
          stage: "EMBEDDING_EVENTS",
          message: `正在分批生成事件向量：${offset + 1}-${batchEndRank}/${totalChunks}`,
          progress: progressForOffset(offset, totalChunks, 76, 86),
          currentChunk: offset,
          totalChunks
        });

        const titleEmbeddings = await this.embedInBatches(
          batch.map((item) => item.event.title),
          embeddingBatchSize
        );
        const contentEmbeddings = await this.embedInBatches(
          batch.map((item) => `${item.event.title}\n\n${item.event.content}`),
          embeddingBatchSize
        );

        const entityNameTexts: string[] = [];
        const relationTexts: string[] = [];
        for (const item of batch) {
          for (const entity of item.event.entities) {
            entityNameTexts.push(entity.name);
            relationTexts.push(entity.relation || entity.description || `${item.event.title} ${entity.name}`);
          }
        }

        const entityNameEmbeddings = await this.embedInBatches(
          entityNameTexts,
          embeddingBatchSize,
          (done, total) => report({
            stage: "EMBEDDING_EVENTS",
            message: `正在分批生成实体向量：本批 ${done}/${total}，切片 ${offset + 1}-${batchEndRank}/${totalChunks}`,
            progress: progressForOffset(offset, totalChunks, 86, 93),
            currentChunk: offset,
            totalChunks
          })
        );
        const relationEmbeddings = await this.embedInBatches(relationTexts, embeddingBatchSize);

        let entityCursor = 0;
        const prepared = batch.map((item, indexInBatch): PreparedManualItem => {
          const rank = batchStartRank + indexInBatch;
          const sectionId = randomUUID();
          const chunkId = randomUUID();
          const eventId = randomUUID();
          return {
            rank,
            section: {
              id: sectionId,
              heading: item.heading,
              content: item.content,
              rawContent: item.content,
              tokenCount: estimateTokens(item.content)
            },
            chunk: {
              id: chunkId,
              heading: item.heading,
              content: item.content,
              rawContent: item.content,
              embedding: chunkEmbeddings[indexInBatch]
            },
            event: {
              id: eventId,
              ...item.event,
              titleEmbedding: titleEmbeddings[indexInBatch],
              contentEmbedding: contentEmbeddings[indexInBatch],
              entities: item.event.entities.map((entity) => {
                const embeddingIndex = entityCursor;
                entityCursor += 1;
                return {
                  ...entity,
                  entityEmbedding: entityNameEmbeddings[embeddingIndex],
                  relationEmbedding: relationEmbeddings[embeddingIndex]
                };
              })
            }
          };
        });

        report({
          stage: "WRITING_GRAPH",
          message: `正在写入数据库：${offset + 1}-${batchEndRank}/${totalChunks}`,
          progress: progressForOffset(offset, totalChunks, 93, 99),
          currentChunk: offset,
          totalChunks
        });

        await this.writePreparedItems({
          sourceId: source.id,
          documentId,
          items: prepared,
          originalChunks: chunks
        });

        insertedChunks = batchEndRank;
        report({
          stage: "WRITING_GRAPH",
          message: `已写入 ${insertedChunks}/${totalChunks} 个切片`,
          progress: progressForOffset(insertedChunks, totalChunks, 93, 99),
          currentChunk: insertedChunks,
          totalChunks,
          chunkCount: insertedChunks,
          eventCount: insertedChunks
        });
      }

      await pool.query(
        `
          update documents
          set status = 'COMPLETED', parse_status = 'COMPLETED', updated_at = now()
          where id = $1
        `,
        [documentId]
      );

      report({
        stage: "COMPLETED",
        message: `导入完成：${totalChunks} 个切片，${totalChunks} 个事件`,
        progress: 100,
        currentChunk: totalChunks,
        totalChunks,
        chunkCount: totalChunks,
        eventCount: totalChunks
      });

      return {
        sourceId: source.id,
        documentId,
        chunkCount: totalChunks,
        eventCount: totalChunks,
        taskId,
        traceId
      };
    } catch (error) {
      if (documentCreated) {
        try {
          await deleteDocument({ documentId, tenantId });
        } catch (cleanupError) {
          logger.warn({ cleanupError, documentId, traceId }, "failed to clean up failed structured import document");
        }
      }
      throw error;
    }
  }

  private async embedInBatches(
    texts: string[],
    batchSize: number,
    onBatchProgress?: (done: number, total: number) => void
  ): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const result: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const batch = texts.slice(offset, offset + batchSize);
      const embeddings = await this.embeddings.batchGenerate(batch);
      result.push(...embeddings);
      onBatchProgress?.(Math.min(offset + batch.length, texts.length), texts.length);
      await yieldToEventLoop();
    }
    return result;
  }

  private async writePreparedItems(input: {
    sourceId: string;
    documentId: string;
    items: PreparedManualItem[];
    originalChunks: ManualKnowledgeDocument["chunks"];
  }) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const item of input.items) {
        await client.query(
          `
            insert into document_sections (
              id, document_id, order_index, render_group_index, type, heading, content,
              raw_content, metadata, token_count
            )
            values ($1, $2, $3, 0, 'TEXT', $4, $5, $6, $7::jsonb, $8)
          `,
          [
            item.section.id,
            input.documentId,
            item.rank * 1000,
            item.section.heading,
            item.section.content,
            item.section.rawContent,
            JSON.stringify({ importedVia: "manual-structured" }),
            item.section.tokenCount
          ]
        );
        await client.query(
          `
            insert into source_chunks (
              id, source_id, document_id, source_type, external_source_id, heading, content,
              raw_content, rank, "references", metadata, embedding
            )
            values ($1, $2, $3, 'ARTICLE', $3::uuid::text, $4, $5, $6, $7, $8::uuid[], $9::jsonb, $10::vector)
          `,
          [
            item.chunk.id,
            input.sourceId,
            input.documentId,
            item.chunk.heading,
            item.chunk.content,
            item.chunk.rawContent,
            item.rank,
            [item.section.id],
            JSON.stringify({
              importedVia: "manual-structured",
              embeddingMode: "configured-client",
              manualChunkKey: input.originalChunks[item.rank]?.key ?? String(item.rank + 1)
            }),
            toVectorLiteral(item.chunk.embedding)
          ]
        );
        await client.query(
          `
            insert into events (
              id, source_id, document_id, chunk_id, source_type, external_source_id,
              level, rank, title, summary, content, category, keywords, priority, status,
              "references", metadata, title_embedding, content_embedding
            )
            values (
              $1, $2, $3, $4, 'ARTICLE', $3::uuid::text,
              0, $5, $6, $7, $8, $9, $10::text[], 'UNKNOWN', 'COMPLETED',
              $11::uuid[], $12::jsonb, $13::vector, $14::vector
            )
          `,
          [
            item.event.id,
            input.sourceId,
            input.documentId,
            item.chunk.id,
            item.rank,
            item.event.title,
            item.event.summary,
            item.event.content,
            item.event.category ?? null,
            item.event.keywords,
            [item.section.id],
            JSON.stringify({
              importedVia: "manual-structured",
              manualChunkKey: input.originalChunks[item.rank]?.key ?? String(item.rank + 1)
            }),
            toVectorLiteral(item.event.titleEmbedding),
            toVectorLiteral(item.event.contentEmbedding)
          ]
        );

        for (const entity of item.event.entities) {
          const saved = await upsertEntity({
            sourceId: input.sourceId,
            type: entity.type,
            name: entity.name,
            description: entity.description,
            embedding: entity.entityEmbedding
          }, client);
          await client.query(
            `
              insert into event_entities (id, event_id, entity_id, weight, description, embedding, metadata)
              values ($1, $2, $3, 1.0, $4, $5::vector, $6::jsonb)
              on conflict (event_id, entity_id) do update set
                description = excluded.description,
                embedding = excluded.embedding,
                metadata = event_entities.metadata || excluded.metadata
            `,
            [
              randomUUID(),
              item.event.id,
              saved.id,
              entity.relation || entity.description,
              toVectorLiteral(entity.relationEmbedding),
              JSON.stringify({ importedVia: "manual-structured" })
            ]
          );
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const manualIngestionService = new ManualIngestionService();

function readPositiveIntEnv(name: string, fallback: number, max: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function progressForOffset(offset: number, total: number, start: number, end: number) {
  if (total <= 0) {
    return end;
  }
  return start + (Math.min(Math.max(offset, 0), total) / total) * (end - start);
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
