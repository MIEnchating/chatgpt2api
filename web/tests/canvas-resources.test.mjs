import assert from "node:assert/strict";
import test from "node:test";

import { canvasNodeReferenceCandidates } from "../src/app/canvas/canvas-resources.ts";

import { buildCanvasGenerationContext } from "../src/app/canvas/canvas-generation-context.ts";

function node(id, type, values = {}) {
  return { id, type, x: 0, y: 0, width: 100, height: 100, scale_x: 1, scale_y: 1, ...values };
}

test("video, audio, and panorama resources match the reference canvas index", () => {
  const nodes = [
    node("target", "text"),
    node("panorama", "panorama", { url: "panorama.png", title: "场景" }),
    node("image", "image", { url: "image.png" }),
    node("video", "video", { url: "video.mp4", title: "动作" }),
    node("audio", "audio", { url: "audio.mp3", title: "对白" }),
  ];
  assert.deepEqual(canvasNodeReferenceCandidates("target", nodes, []).filter((reference) => reference.nodeID === "panorama"), [
    { id: "panorama", nodeID: "panorama", kind: "image", label: "图片1", title: "场景", text: undefined, previewURL: "panorama.png", active: true },
  ]);
  assert.deepEqual(canvasNodeReferenceCandidates("target", nodes, []).filter((reference) => reference.nodeID === "video"), [
    { id: "video", nodeID: "video", kind: "video", label: "视频1", title: "动作", text: undefined, previewURL: "video.mp4", active: true },
  ]);
  assert.deepEqual(canvasNodeReferenceCandidates("target", nodes, []).filter((reference) => reference.nodeID === "audio"), [
    { id: "audio", nodeID: "audio", kind: "audio", label: "音频1", title: "对白", text: undefined, previewURL: "audio.mp3", active: true },
  ]);
});

test("connected image references are numbered in request order", () => {
  const nodes = [
    node("unused-image", "image", { url: "unused.png" }),
    node("second-input", "image", { url: "second.png" }),
    node("first-input", "image", { url: "first.png" }),
    node("target", "image"),
  ];
  const references = canvasNodeReferenceCandidates("target", nodes, [
    { id: "first-target", from_node_id: "first-input", to_node_id: "target" },
    { id: "second-target", from_node_id: "second-input", to_node_id: "target" },
  ]);

  assert.deepEqual(references.map((reference) => [reference.nodeID, reference.label]), [
    ["first-input", "图片1"],
    ["second-input", "图片2"],
    ["unused-image", "图片3"],
  ]);
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

  assert.deepEqual(canvasNodeReferenceCandidates("source", nodes, connections), [
    { id: "idea", nodeID: "idea", kind: "text", label: "文本1", title: "要求", text: "保留构图", previewURL: undefined, active: true },
    { id: "reference", nodeID: "reference", kind: "image", label: "图片1", title: "风格图", text: undefined, previewURL: "reference.png", active: true },
  ]);

});

test("mention candidates exclude self, empty resources, and downstream cycles", () => {
  const nodes = [node("target", "text", { prompt: "result" }), node("source", "text", { prompt: "reference" }), node("child", "image", { url: "child.png" }), node("descendant", "text", { prompt: "later" }), node("empty", "image"), node("group", "group")];
  const connections = [{ from_node_id: "target", to_node_id: "child" }, { from_node_id: "child", to_node_id: "descendant" }];
  assert.deepEqual(canvasNodeReferenceCandidates("target", nodes, connections).map((reference) => reference.nodeID), ["source"]);
});

test("selecting an unconnected image preserves request numbering regardless of canvas order", () => {
  const nodes = [node("unused", "image", { url: "unused.png" }), node("chosen", "image", { url: "chosen.png" }), node("first", "image", { url: "first.png" }), node("target", "text")];
  const connections = [{ from_node_id: "first", to_node_id: "target" }];
  const chosen = canvasNodeReferenceCandidates("target", nodes, connections).find((reference) => reference.nodeID === "chosen");
  assert.equal(chosen.label, "图片2");
  connections.push({ from_node_id: chosen.nodeID, to_node_id: "target" });
  const candidates = canvasNodeReferenceCandidates("target", nodes, connections);
  assert.equal(candidates.filter((reference) => reference.nodeID === "chosen").length, 1);
  assert.equal(candidates.find((reference) => reference.nodeID === "chosen").label, "图片2");
  assert.deepEqual(buildCanvasGenerationContext("target", nodes, connections, "参考图片2").referenceImageURLs, ["first.png", "chosen.png"]);
});

test("direct mentions remain generation inputs when a node also feeds a configuration", () => {
  const nodes = [node("target", "text"), node("shared", "image", { url: "shared.png" }), node("explicit", "text", { prompt: "new reference" }), node("config", "config")];
  const connections = [{ from_node_id: "target", to_node_id: "config" }, { from_node_id: "shared", to_node_id: "config" }, { from_node_id: "explicit", to_node_id: "target" }];
  const context = buildCanvasGenerationContext("target", nodes, connections, "combine");
  assert.match(context.prompt, /new reference/);
  assert.deepEqual(context.referenceImageURLs, ["shared.png"]);
  assert.deepEqual(canvasNodeReferenceCandidates("target", nodes, connections).map((reference) => reference.nodeID), ["shared", "explicit"]);
});
