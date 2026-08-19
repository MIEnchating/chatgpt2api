import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCanvasClipboard, remapCanvasNodeReferences } from "../src/app/canvas/canvas-clipboard.ts";

function node(id, values = {}) {
  return { id, type: "image", x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1, ...values };
}

test("normalizes valid nodes and connections without changing their graph", () => {
  const result = normalizeCanvasClipboard({
    nodes: [node("a"), node("b", { type: "text", prompt: "想法" })],
    connections: [{ id: "a-b", from_node_id: "a", to_node_id: "b" }],
  });

  assert.deepEqual(result?.connections, [{ id: "a-b", from_node_id: "a", to_node_id: "b" }]);
  assert.equal(result?.nodes[1].prompt, "想法");
});

test("preserves generation configuration nodes in copied graphs", () => {
  const result = normalizeCanvasClipboard({
    nodes: [node("idea", { type: "text", prompt: "想法" }), node("config", { type: "config" })],
    connections: [{ id: "idea-config", from_node_id: "idea", to_node_id: "config" }],
  });
  assert.equal(result?.nodes[1].type, "config");
  assert.deepEqual(result?.connections, [{ id: "idea-config", from_node_id: "idea", to_node_id: "config" }]);
});

test("preserves video nodes and their generation settings in copied graphs", () => {
  const result = normalizeCanvasClipboard({
    nodes: [node("video", {
      type: "video",
      url: "/videos/example.mp4",
      generation_video_model: "sora-2",
      generation_video_size: "1280x720",
      generation_video_seconds: 8,
      generation_video_resolution: "1080p",
    })],
  });
  assert.equal(result?.nodes[0].type, "video");
  assert.equal(result?.nodes[0].url, "/videos/example.mp4");
  assert.equal(result?.nodes[0].generation_video_seconds, 8);
});

test("drops legacy parent ids because connections are the current graph source", () => {
  const result = normalizeCanvasClipboard({
    nodes: [node("parent"), node("child", { parent_id: "parent" })],
    connections: [{ id: "parent-child", from_node_id: "parent", to_node_id: "child" }],
  });
  assert.equal("parent_id" in result.nodes[1], false);
  assert.equal("parent_id" in remapCanvasNodeReferences({ ...result.nodes[1], parent_id: "parent" }, new Map([["parent", "copy"]])), false);
});

test("rejects malformed nodes instead of allowing invalid canvas state", () => {
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { width: 0 })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { type: "text", font_size: 40 })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { type: "video", generation_video_seconds: 0 })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { type: "video", generation_video_size: "800x600" })] }), null);
  assert.ok(normalizeCanvasClipboard({ nodes: [node("seedance", { type: "video", generation_video_resolution: "4k" })] }));
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { batch_child_ids: "child" })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { type: "config", composer_content: 42 })] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes: [node("bad", { generation_model: 42 })] }), null);
});

test("rejects dangling, duplicate, and self connections", () => {
  const nodes = [node("a"), node("b")];
  assert.equal(normalizeCanvasClipboard({ nodes, connections: [{ id: "x", from_node_id: "a", to_node_id: "missing" }] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes, connections: [{ id: "x", from_node_id: "a", to_node_id: "b" }, { id: "x", from_node_id: "b", to_node_id: "a" }] }), null);
  assert.equal(normalizeCanvasClipboard({ nodes, connections: [{ id: "x", from_node_id: "a", to_node_id: "a" }] }), null);
});

test("remaps composer and batch references when nodes are pasted", () => {
  const mapped = remapCanvasNodeReferences(node("config-copy", {
    type: "config",
    composer_content: "让 @[node:image-old] 参考 @[node:text-old]，保留 @[node:not-copied]",
    batch_child_ids: ["image-old", "not-copied"],
    batch_root_id: "root-old",
    batch_primary_id: "image-old",
  }), new Map([
    ["image-old", "image-new"],
    ["text-old", "text-new"],
    ["root-old", "root-new"],
  ]));
  assert.equal(mapped.composer_content, "让 @[node:image-new] 参考 @[node:text-new]，保留 @[node:not-copied]");
  assert.deepEqual(mapped.batch_child_ids, ["image-new"]);
  assert.equal(mapped.batch_root_id, "root-new");
  assert.equal(mapped.batch_primary_id, "image-new");
});

test("clears batch links that point outside the copied graph", () => {
  const mapped = remapCanvasNodeReferences(node("child-copy", { batch_root_id: "outside" }), new Map());
  assert.equal(mapped.batch_root_id, undefined);
});
