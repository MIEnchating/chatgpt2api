import assert from "node:assert/strict";
import test from "node:test";

import { canvasGenerationActiveNodeID, placeCanvasGenerationResultNodes, setCanvasConfigGenerationStatus } from "../src/app/canvas/canvas-generation-layout.ts";

test("specialized image tools select their result while ordinary generation keeps the source active", () => {
  assert.equal(canvasGenerationActiveNodeID("source", "result", true, false), "source");
  assert.equal(canvasGenerationActiveNodeID("source", "result", true, true), "result");
  assert.equal(canvasGenerationActiveNodeID("source", "source", false, true), "source");
});

function node(id, type = "image", values = {}) {
  return { id, type, x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1, ...values };
}

test("a blank image is replaced in place and batch children are appended", () => {
  const source = node("source", "text");
  const blank = node("blank");
  const tail = node("tail", "text");
  const root = node("blank", "image", { generation_status: "loading", batch_child_ids: ["child"] });
  const child = node("child", "image", { batch_root_id: "blank" });

  assert.deepEqual(
    placeCanvasGenerationResultNodes([source, blank, tail], blank.id, [root, child]).map((item) => item.id),
    ["source", "blank", "tail", "child"],
  );
});

test("downstream generation results are appended without moving the source node", () => {
  const source = node("config", "config");
  const tail = node("tail", "text");
  const result = node("result");
  assert.deepEqual(
    placeCanvasGenerationResultNodes([source, tail], source.id, [result]).map((item) => item.id),
    ["config", "tail", "result"],
  );
});

test("replacing a failed batch removes stale children while preserving root order", () => {
  const root = node("root", "image", { batch_child_ids: ["old-a", "old-b"] });
  const nextRoot = node("root", "image", { generation_status: "loading" });
  const nodes = [node("before", "text"), root, node("old-a"), node("between", "text"), node("old-b")];
  assert.deepEqual(
    placeCanvasGenerationResultNodes(nodes, root.id, [nextRoot], new Set(["old-a", "old-b"])).map((item) => item.id),
    ["before", "root", "between"],
  );
});

test("only configuration nodes receive generation lifecycle status", () => {
  const config = node("config", "config");
  const image = node("image");
  const loading = setCanvasConfigGenerationStatus([config, image], "config", "loading", "", "task-1");
  assert.deepEqual(loading[0], { ...config, generation_status: "loading", generation_error: "", task_id: "task-1" });
  assert.equal(loading[1], image);

  const failed = setCanvasConfigGenerationStatus(loading, "config", "error", "生成失败", "task-1");
  assert.equal(failed[0].generation_status, "error");
  assert.equal(failed[0].generation_error, "生成失败");
});
