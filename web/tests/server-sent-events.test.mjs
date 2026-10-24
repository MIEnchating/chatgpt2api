import assert from "node:assert/strict";
import test from "node:test";
import { assertServerSentEventContentType, readServerSentEvents } from "../src/lib/server-sent-events.ts";

test("SSE decodes split UTF-8, CRLF boundaries, comments and multiline data", async () => {
  const encoded = new TextEncoder().encode(': heartbeat\r\ndata: {"message":\r\ndata: "读取文档"}\r\n\r\ndata: finished\n\n');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const events = [];
  await readServerSentEvents(stream, (data) => events.push(data));
  assert.deepEqual(events, ['{"message":\n"读取文档"}', "finished"]);
});

test("SSE dispatches progress before the response closes", async () => {
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  let delivered;
  const first = new Promise(resolve => { delivered = resolve; });
  const reading = readServerSentEvents(stream, delivered);
  controller.enqueue(new TextEncoder().encode('data: {"stage":"reading_document"}\n\n'));
  assert.equal(await first, '{"stage":"reading_document"}');
  controller.close();
  await reading;
});

test("SSE rejects incomplete events and propagates server failures", async () => {
  await assert.rejects(readServerSentEvents(new Response('data: {"stage":"completed"}').body, () => {}), /事件不完整/);
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"stage":"failed","message":"无法读取文档"}\n\n')); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readServerSentEvents(stream, data => { throw new Error(JSON.parse(data).message); }), /无法读取文档/);
  assert.equal(cancelled, true);
});

test("SSE cancels a blocked read and releases its lock", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream({});
  const reading = readServerSentEvents(stream, assert.fail, { signal: controller.signal });
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(stream.locked, false);
});

test("SSE bounds individual event sizes, including many data lines", async () => {
  await assert.rejects(readServerSentEvents(new Response("data: abcdefghijklmnop\n\n").body, assert.fail, { maxEventCharacters: 10 }), /大小限制/);
  await assert.rejects(readServerSentEvents(new Response("data: abc\ndata: def\ndata: ghi\n\n").body, assert.fail, { maxEventCharacters: 20 }), /大小限制/);
  await readServerSentEvents(new Response(": heartbeat").body, assert.fail);
});

test("SSE rejects non-stream responses and detects a stalled connection", async () => {
  assertServerSentEventContentType("text/event-stream; charset=utf-8");
  assert.throws(() => assertServerSentEventContentType("application/json"), /SSE/);
  const stream = new ReadableStream({});
  await assert.rejects(readServerSentEvents(stream, assert.fail, { idleTimeoutMs: 5 }), /未收到数据/);
  assert.equal(stream.locked, false);
});
