import { describe, expect, it } from "vitest";
import { readSseStream } from "../web/src/lib/api.js";

function responseFromChunks(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

describe("readSseStream", () => {
  it("handles split frames and completes only after a done event", async () => {
    const events: Array<{ type: string; delta?: string }> = [];
    const response = responseFromChunks([
      'event: assistant_delta\ndata: {"type":"assistant_',
      'delta","delta":"hello"}\n\n',
      'event: done\ndata: {"type":"done"}\n\n',
    ]);

    await readSseStream<{ type: string; delta?: string }>(
      response,
      (event) => events.push(event),
    );

    expect(events).toEqual([
      { type: "assistant_delta", delta: "hello" },
      { type: "done" },
    ]);
  });

  it("rejects a server error event", async () => {
    const response = responseFromChunks([
      'event: error\ndata: {"message":"upstream timeout"}\n\n',
    ]);

    await expect(readSseStream(response, () => undefined)).rejects.toThrow(
      "upstream timeout",
    );
  });

  it("rejects an early EOF without a done event", async () => {
    const response = responseFromChunks([
      'data: {"type":"assistant_delta","delta":"draft"}\n\n',
    ]);

    await expect(readSseStream(response, () => undefined)).rejects.toThrow(
      "完成事件到达前提前中断",
    );
  });
});

it("rejects a mismatched event name and event data", async () => {
  const response = new Response('event: delta\ndata: {"type":"done"}\n\n');
  await expect(readSseStream(response, () => undefined)).rejects.toThrow("事件名称");
});

it("rejects a frame from a different run before accepting completion", async () => {
  const response = new Response([
    'event: stage\ndata: {"type":"stage","runId":"one","sequence":1}\n\n',
    'event: done\ndata: {"type":"done","runId":"two","sequence":2}\n\n',
  ].join(""));
  await expect(readSseStream(response, () => undefined)).rejects.toThrow("运行标识");
});
