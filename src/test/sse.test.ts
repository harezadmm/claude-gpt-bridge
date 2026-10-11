import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSse, sseJson } from "../sse.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const m of parseSse(streamOf(chunks))) out.push(m);
  return out;
}

test("parses events split across chunks", async () => {
  const msgs = await collect(['event: response.created\ndata: {"a":', '1}\n\nevent: done\ndata: x\n\n']);
  assert.deepEqual(msgs, [
    { event: "response.created", data: '{"a":1}' },
    { event: "done", data: "x" },
  ]);
});

test("handles CRLF, comments, and multi-line data", async () => {
  const msgs = await collect([": keepalive\r\ndata: a\r\ndata: b\r\n\r\n"]);
  assert.deepEqual(msgs, [{ event: "message", data: "a\nb" }]);
});

test("flushes a final event without trailing blank line", async () => {
  const msgs = await collect(["data: tail"]);
  assert.deepEqual(msgs, [{ event: "message", data: "tail" }]);
});

test("sseJson returns null for [DONE] and non-JSON", () => {
  assert.equal(sseJson({ event: "message", data: "[DONE]" }), null);
  assert.equal(sseJson({ event: "message", data: "nope" }), null);
  assert.deepEqual(sseJson({ event: "message", data: '{"k":2}' }), { k: 2 });
});
