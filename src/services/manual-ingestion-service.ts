import { randomUUID } from "node:crypto";
import { deterministicEmbedding } from "../ai/embedding-client.js";
import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";
import { pool } from "../db/pool.js";
import { createSource, upsertEntity } from "../db/repositories.js";
import { toVectorLiteral } from "../db/vector.js";
import { estimateTokens } from "../ingestion/chunking/markdown.js";
import type { ManualKnowledgeDocument } from "../ingestion/manual-import.js";
import type { IngestDocumentResult } from "../types.js";

export class ManualIngestionService {
  async ingest(
    input: {
      sourceId: string;
      document: ManualKnowledgeDocument;
      fileName?: string;
      format: string;
    },
    tenantId = config.DEFAULT_TENANT_ID
  ): Promise<IngestDocumentResult> {
    const traceId = randomUUID();
    const taskId = randomUUID();
    const documentId = randomUUID();
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
    const prepared = input.document.chunks.map((item, rank) => {
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
          embedding: deterministicEmbedding(`${item.heading}\n${item.content}`, SUPPORTED_EMBEDDING_DIMENSIONS)
        },
        event: {
          id: eventId,
          ...item.event,
          titleEmbedding: deterministicEmbedding(item.event.title, SUPPORTED_EMBEDDING_DIMENSIONS),
          contentEmbedding: deterministicEmbedding(`${item.event.title}\n\n${item.event.content}`, SUPPORTED_EMBEDDING_DIMENSIONS),
          entities: item.event.entities.map((entity) => ({
            ...entity,
            entityEmbedding: deterministicEmbedding(entity.name, SUPPORTED_EMBEDDING_DIMENSIONS),
            relationEmbedding: deterministicEmbedding(
              entity.description || `${item.event.title} ${entity.name}`,
              SUPPORTED_EMBEDDING_DIMENSIONS
            )
          }))
        }
      };
    });
    const documentContent = input.document.chunks
      .map((chunk) => `## ${chunk.heading}\n\n${chunk.content}`)
      .join("\n\n");

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
          insert into documents (id, source_id, title, content, status, parse_status, metadata)
          values ($1, $2, $3, $4, 'COMPLETED', 'COMPLETED', $5::jsonb)
        `,
        [
          documentId,
          source.id,
          input.document.title,
          documentContent,
          JSON.stringify({
            traceId,
            fileName: input.fileName ?? null,
            importedVia: "manual-structured",
            importFormat: input.format,
            localEmbedding: true
          })
        ]
      );

      for (const item of prepared) {
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
            documentId,
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
            source.id,
            documentId,
            item.chunk.heading,
            item.chunk.content,
            item.chunk.rawContent,
            item.rank,
            [item.section.id],
            JSON.stringify({
              importedVia: "manual-structured",
              localEmbedding: true,
              manualChunkKey: input.document.chunks[item.rank]?.key ?? String(item.rank + 1)
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
            source.id,
            documentId,
            item.chunk.id,
            item.rank,
            item.event.title,
            item.event.summary,
            item.event.content,
            item.event.category ?? null,
            item.event.keywords,
            [item.section.id],
            JSON.stringify({
              traceId,
              importedVia: "manual-structured",
              manualChunkKey: input.document.chunks[item.rank]?.key ?? String(item.rank + 1)
            }),
            toVectorLiteral(item.event.titleEmbedding),
            toVectorLiteral(item.event.contentEmbedding)
          ]
        );

        for (const entity of item.event.entities) {
          const saved = await upsertEntity({
            sourceId: source.id,
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
              entity.description,
              toVectorLiteral(entity.relationEmbedding),
              JSON.stringify({ importedVia: "manual-structured" })
            ]
          );
        }
      }

      await client.query("commit");
      return {
        sourceId: source.id,
        documentId,
        chunkCount: prepared.length,
        eventCount: prepared.length,
        taskId,
        traceId
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const manualIngestionService = new ManualIngestionService();
