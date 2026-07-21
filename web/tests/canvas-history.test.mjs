import assert from "node:assert/strict";
import test from "node:test";

import { appendCanvasHistorySnapshot, canvasHistoryKey, commitCanvasGenerationHistory, restoreCanvasHistoryDocument } from "../src/app/canvas/canvas-history.ts";

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
