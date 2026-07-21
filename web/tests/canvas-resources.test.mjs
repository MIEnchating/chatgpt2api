import assert from "node:assert/strict";
import test from "node:test";

import { canvasNodeMentionReferences, canvasResourceLabels } from "../src/app/canvas/canvas-resources.ts";

function node(id, type, values = {}) {
  return { id, type, x: 0, y: 0, width: 100, height: 100, scale_x: 1, scale_y: 1, ...values };
}

test("resources are numbered by type and direct inputs are active", () => {
  const nodes = [
    node("image-a", "image", { url: "a.png" }),
    node("text-a", "text", { prompt: "first" }),
    node("image-b", "image", { url: "b.png" }),
    node("target", "image"),
  ];
  const labels = canvasResourceLabels(nodes, [
    { id: "a-target", from_node_id: "image-a", to_node_id: "target" },
    { id: "text-target", from_node_id: "text-a", to_node_id: "target" },
  ], "target");

  assert.deepEqual(labels.get("image-a"), { label: "图片1", active: true });
  assert.deepEqual(labels.get("image-b"), { label: "图片2", active: false });
  assert.deepEqual(labels.get("text-a"), { label: "文本1", active: true });
  assert.equal(labels.has("target"), false);
});

test("a resource activates itself when it has no connected input", () => {
  const image = node("image", "image", { url: "image.png" });
  assert.deepEqual(canvasResourceLabels([image], [], image.id).get(image.id), { label: "图片1", active: true });
});

test("active inputs are renumbered in request order like the reference project", () => {
  const nodes = [
    node("unused-image", "image", { url: "unused.png" }),
    node("second-input", "image", { url: "second.png" }),
    node("first-input", "image", { url: "first.png" }),
    node("target", "image"),
  ];
  const labels = canvasResourceLabels(nodes, [
    { id: "first-target", from_node_id: "first-input", to_node_id: "target" },
    { id: "second-target", from_node_id: "second-input", to_node_id: "target" },
  ], "target");

  assert.deepEqual(labels.get("unused-image"), { label: "图片1", active: false });
  assert.deepEqual(labels.get("first-input"), { label: "图片1", active: true });
  assert.deepEqual(labels.get("second-input"), { label: "图片2", active: true });
});

test("a configuration input can mention the configuration's other resources", () => {
  const nodes = [
    node("source", "image", { url: "source.png", title: "主体" }),
    node("idea", "text", { prompt: "保留构图", title: "要求" }),
    node("reference", "image", { url: "reference.png", title: "风格图" }),
    node("config", "config"),
  ];
  const connections = [
    { id: "source-config", from_node_id: "source", to_node_id: "config" },
    { id: "idea-config", from_node_id: "idea", to_node_id: "config" },
    { id: "reference-config", from_node_id: "reference", to_node_id: "config" },
  ];

  assert.deepEqual(canvasNodeMentionReferences("source", nodes, connections), [
    { id: "idea", nodeID: "idea", kind: "text", label: "文本1", title: "要求", text: "保留构图", previewURL: undefined, active: true },
    { id: "reference", nodeID: "reference", kind: "image", label: "图片1", title: "风格图", text: undefined, previewURL: "reference.png", active: true },
  ]);

  const labels = canvasResourceLabels(nodes, connections, "source");
  assert.deepEqual(labels.get("source"), { label: "图片1", active: false });
  assert.deepEqual(labels.get("idea"), { label: "文本1", active: true });
  assert.deepEqual(labels.get("reference"), { label: "图片1", active: true });
});
