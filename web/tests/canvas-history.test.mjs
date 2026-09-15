import assert from "node:assert/strict";
import test from "node:test";

import { appendCanvasHistorySnapshot, canvasHistoryKey, canvasHistoryStorageObjectIDs, canvasHistoryStorageObjectURLs, canvasHistoryLeaseExpired, commitCanvasGenerationHistory, restoreCanvasHistoryDocument } from "../src/app/canvas/canvas-history.ts";

function document(values = {}) {
  return {
    version: 1,
    id: "canvas-1",
    revision: 3,
    title: "画布",
    background: "dots",
    nodes: [],
    connections: [],
    viewport: { zoom: 1, x: 0, y: 0 },
    ...values,
  };
}

test("canvas history ignores viewport-only changes", () => {
  const before = document();
  const after = document({ viewport: { zoom: 2, x: -400, y: 120 } });
  assert.equal(canvasHistoryKey(before), canvasHistoryKey(after));
});

test("restoring history keeps the current viewport and server revision", () => {
  const current = document({ revision: 9, updated_at: "new", viewport: { zoom: 2, x: -400, y: 120 }, nodes: [{ id: "new" }] });
  const snapshot = document({ revision: 2, updated_at: "old", viewport: { zoom: 0.5, x: 10, y: 20 }, nodes: [{ id: "old" }] });
  assert.deepEqual(restoreCanvasHistoryDocument(current, snapshot), {
    ...snapshot,
    revision: 9,
    updated_at: "new",
    viewport: current.viewport,
  });
});

test("generation completion collapses every temporary loading snapshot", () => {
  const initial = document({ nodes: [{ id: "source", generation_status: "success" }] });
  const completed = document({ nodes: [{ id: "source", x: 40, generation_status: "success" }, { id: "result", generation_status: "success" }] });
  assert.deepEqual(commitCanvasGenerationHistory([initial], completed), [initial, completed]);
});

test("generation baseline captures edits made immediately before submission", () => {
  const initial = document({ nodes: [{ id: "source", prompt: "旧提示词" }] });
  const edited = document({ nodes: [{ id: "source", prompt: "刚输入的提示词" }] });
  assert.deepEqual(appendCanvasHistorySnapshot([initial], edited), [initial, edited]);
  assert.deepEqual(commitCanvasGenerationHistory(appendCanvasHistorySnapshot([initial], edited), edited), [initial, edited]);
});

test("history initializes from the current snapshot when no baseline exists", () => {
  const initial = document({ title: "初始画布" });
  assert.deepEqual(appendCanvasHistorySnapshot([], initial), [initial]);
});

test("generation cancellation does not add a duplicate of its base snapshot", () => {
  const initial = document({ nodes: [{ id: "source" }] });
  assert.deepEqual(commitCanvasGenerationHistory([initial], initial), [initial]);
});

test("generation completion keeps the configured history limit", () => {
  const history = Array.from({ length: 50 }, (_, index) => document({ title: `画布 ${index}` }));
  const completed = document({ title: "完成" });
  const result = commitCanvasGenerationHistory(history, completed, 50);
  assert.equal(result.length, 50);
  assert.equal(result[0].title, "画布 1");
  assert.equal(result.at(-1).title, "完成");
});


test("history retention includes redo and nested director or Agent references without inheriting stale claims", () => {
  const history = [document({ nodes: [{ url: "/api/files/video/content", director_project: { key: "server:director" } }], retained_storage_object_ids: ["stale"], agent_sessions: [{ messages: [{ image: "/api/files/agent/content" }] }] })];
  const redo = [document({ nodes: [{ storage_key: "server:redo", url: "/api/files/video/content" }] })];
  assert.deepEqual(canvasHistoryStorageObjectIDs(history, redo), ["agent", "director", "redo", "video"]);
  assert.deepEqual(canvasHistoryStorageObjectIDs([], redo), ["redo", "video"]);
});

test("expired browser history cannot renew an already elapsed lease", () => {
  assert.equal(canvasHistoryLeaseExpired(document(), 1000), false);
  assert.equal(canvasHistoryLeaseExpired(document({ retained_storage_objects_until: new Date(2000).toISOString() }), 1000), false);
  assert.equal(canvasHistoryLeaseExpired(document({ retained_storage_objects_until: new Date(2000).toISOString() }), 2000), true);
  assert.equal(canvasHistoryLeaseExpired(document({ retained_storage_objects_until: "invalid" }), 1000), true);
});


test("undo preserves the renewed server lease and never resurrects an old history lease", () => {
  const snapshot = document({ retained_storage_object_ids: ["old"], retained_storage_objects_until: "old expiry" });
  const current = document({ retained_storage_object_ids: ["new"], retained_storage_objects_until: "new expiry" });
  const restored = restoreCanvasHistoryDocument(current, snapshot);
  assert.deepEqual(restored.retained_storage_object_ids, ["new"]);
  assert.equal(restored.retained_storage_objects_until, "new expiry");
  assert.equal(restoreCanvasHistoryDocument(document(), snapshot).retained_storage_objects_until, undefined);
});


test("undo retains files referenced inside serialized tool results and Markdown messages", () => {
  const snapshot = document({ agent_sessions: [{ messages: [{ content: '{"url":"/api/files/tool/content"}' }, { content: "![picture](/api/files/markdown/content)" }, { content: '{"storage_key":"server:stored"}' }] }] });
  assert.deepEqual(canvasHistoryStorageObjectIDs([snapshot]), ["markdown", "stored", "tool"]);
});

test("history protects public storage links without inheriting expired URL leases", () => {
  const snapshot = document({ nodes: [{ url: "https://cdn.example.test/video.mp4" }], agent_sessions: [{ messages: [{ content: "[clip](https://cdn.example.test/audio.wav)" }] }], retained_storage_object_urls: ["https://cdn.example.test/expired.png"] });
  assert.deepEqual(canvasHistoryStorageObjectURLs([snapshot]), ["https://cdn.example.test/audio.wav", "https://cdn.example.test/audio.wav)", "https://cdn.example.test/video.mp4"]);
  const restored = restoreCanvasHistoryDocument(document({ retained_storage_object_urls: ["https://cdn.example.test/current.png"] }), snapshot);
  assert.deepEqual(restored.retained_storage_object_urls, ["https://cdn.example.test/current.png"]);
  assert.equal(restoreCanvasHistoryDocument(document(), snapshot).retained_storage_object_urls, undefined);
});

test("history retains complete public URLs with legal trailing punctuation", () => {
  for (const suffix of [".", ")", "]", ";", "}"]) {
    const url = `https://cdn.example.test/file${suffix}`;
    const urls = canvasHistoryStorageObjectURLs([document({ nodes: [{ url }] })]);
    assert.ok(urls.includes(url), `${url} must not be truncated`);
    const markdown = canvasHistoryStorageObjectURLs([document({ nodes: [{ prompt: `[file](${url})` }] })]);
    assert.ok(markdown.includes(url), `Markdown ${url} must not lose URL punctuation`);
  }
});
