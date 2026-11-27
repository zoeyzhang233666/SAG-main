import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import streamJson from "stream-json";
import pick from "stream-json/filters/Pick.js";
import streamArray from "stream-json/streamers/StreamArray.js";
import {
  normalizeManualJsonDocument,
  parseManualKnowledgeDocuments,
  type ManualImportFormat,
  type ManualKnowledgeDocument
} from "./manual-import.js";

export const MAX_STRUCTURED_TEXT_BYTES = 50 * 1024 ** 2;
const MAX_STRUCTURED_JSON_BYTES = 2 * 1024 ** 3;

interface ImportFileOptions {
  fileName: string;
  format: ManualImportFormat;
  fallbackTitle: string;
}

export async function stageStructuredImportFile(stream: Readable, options: ImportFileOptions) {
  const jsonFile = options.format === "json" ||
    (options.format === "auto" && /\.json$/i.test(options.fileName));
  const limit = jsonFile ? MAX_STRUCTURED_JSON_BYTES : MAX_STRUCTURED_TEXT_BYTES;
  const directory = await mkdtemp(join(tmpdir(), "sag-structured-import-"));
  const filePath = join(directory, "upload");
  const cleanup = () => rm(directory, { recursive: true, force: true });
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        callback(Object.assign(
          new Error(jsonFile ? "JSON 文件超过 2 GiB 导入上限" : "非 JSON 文件超过 50 MiB 导入上限"),
          { statusCode: 413 }
        ));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    // Let Fastify send an error response even when rejecting an incomplete upload.
    const abort = (error: Error) => meter.destroy(error);
    const close = () => {
      if (!stream.readableEnded) abort(new Error("导入文件传输已中断"));
    };
    stream.on("error", abort);
    stream.on("close", close);
    stream.pipe(meter);
    try {
      await pipeline(meter, createWriteStream(filePath, { mode: 0o600 }));
    } finally {
      stream.off("error", abort);
      stream.off("close", close);
      stream.unpipe(meter);
      if (!stream.destroyed && !stream.readableEnded) stream.resume();
    }
    if (!bytes) throw Object.assign(new Error("导入文件为空"), { statusCode: 400 });
  } catch (error) {
    await cleanup();
    throw error;
  }

  async function* readDocuments(): AsyncGenerator<ManualKnowledgeDocument> {
    if (bytes <= MAX_STRUCTURED_TEXT_BYTES) {
      yield* parseManualKnowledgeDocuments(await readFile(filePath, "utf8"), options);
      return;
    }

    // Multi-document SAG exports are consumed one document at a time.
    const entries = streamArray.streamArray({ highWaterMark: 1 });
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const prefix = Buffer.alloc(bom.length);
    const file = await open(filePath, "r");
    try {
      await file.read(prefix, 0, prefix.length, 0);
    } finally {
      await file.close();
    }
    const transfer = pipeline(
      createReadStream(filePath, { start: prefix.equals(bom) ? bom.length : 0 }),
      streamJson.parser(),
      pick.pick({ filter: "documents" }),
      entries
    );
    // The iterator delivers the same parser failure. Attach a handler immediately.
    void transfer.catch(() => {});
    let count = 0;
    try {
      for await (const entry of entries as AsyncIterable<{ key: number; value: unknown }>) {
        const document = normalizeManualJsonDocument(entry.value, entry.key, options.fallbackTitle);
        if (document) {
          count++;
          yield document;
        }
      }
      await transfer;
    } finally {
      entries.destroy();
      await transfer.catch(() => {});
    }
    if (!count) throw new Error("50 MiB 以上的 JSON 请使用包含 documents 数组的 SAG 项目导出格式");
  }

  return { bytes, cleanup, readDocuments, streamed: bytes > MAX_STRUCTURED_TEXT_BYTES };
}
