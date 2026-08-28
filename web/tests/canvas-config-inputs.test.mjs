import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanvasInputIndex,
  canGenerateCanvasConfig,
  canvasConfigInputLabel,
  canvasConfigInputs,
  canvasConfigUsesConnectedText,
  canvasGenerationInputsFromIndex,
  canvasConfigPromptDisplay,
  canvasConfigPromptValue,
  insertCanvasConfigReference,
} from "../src/app/canvas/canvas-config-inputs.ts";

function node(id, type, values = {}) {
  return { id, type, x: 0, y: 0, width: 100, height: 100, scale_x: 1, scale_y: 1, ...values };
}

test("configuration inputs follow connection order and ignore empty nodes", () => {
  const nodes = [
    node("config", "config"),
    node("idea", "text", { title: "主体", prompt: "白猫" }),
    node("image", "image", { title: "参考", url: "/images/a.png" }),
    node("empty", "image"),
  ];
  const connections = [
    { id: "image-config", from_node_id: "image", to_node_id: "config" },
    { id: "idea-config", from_node_id: "idea", to_node_id: "config" },
    { id: "empty-config", from_node_id: "empty", to_node_id: "config" },
  ];
  const inputs = canvasConfigInputs("config", nodes, connections);
  assert.deepEqual(inputs.map((input) => input.nodeID), ["image", "idea"]);
  assert.equal(canvasConfigInputLabel(inputs[0], inputs), "图片1");
  assert.equal(canvasConfigInputLabel(inputs[1], inputs), "文本1");
});

test("empty media nodes are not coerced into configuration text inputs", () => {
  const nodes = [
    node("config", "config"),
    node("video", "video", { prompt: "视频描述" }),
    node("audio", "audio", { prompt: "音频描述" }),
    node("panorama", "panorama", { prompt: "全景描述" }),
    node("image", "image", { prompt: "图片描述" }),
  ];
  const inputs = canvasConfigInputs("config", nodes, [
    { id: "video-config", from_node_id: "video", to_node_id: "config" },
    { id: "audio-config", from_node_id: "audio", to_node_id: "config" },
    { id: "panorama-config", from_node_id: "panorama", to_node_id: "config" },
    { id: "image-config", from_node_id: "image", to_node_id: "config" },
  ]);
  assert.deepEqual(inputs, []);
});

test("shared input index preserves direct and connected generation semantics", () => {
  const nodes = [
    node("source", "image", { url: "source.png" }),
    node("idea", "text", { prompt: "保留构图" }),
    node("reference", "image", { url: "reference.png" }),
    node("config", "config"),
    node("direct", "image"),
  ];
  const connections = [
    { id: "source-config", from_node_id: "source", to_node_id: "config" },
    { id: "idea-config", from_node_id: "idea", to_node_id: "config" },
    { id: "reference-config", from_node_id: "reference", to_node_id: "config" },
    { id: "idea-direct", from_node_id: "idea", to_node_id: "direct" },
  ];
  const index = buildCanvasInputIndex(nodes, connections);

  assert.deepEqual(index.configInputsByNodeID.get("config").map((input) => input.nodeID), ["source", "idea", "reference"]);
  assert.deepEqual(canvasGenerationInputsFromIndex("source", index).map((input) => input.nodeID), ["idea", "reference"]);
  assert.deepEqual(canvasGenerationInputsFromIndex("direct", index).map((input) => input.nodeID), ["idea"]);
});

test("configuration prompt labels round-trip to stable node references", () => {
  const inputs = [
    { nodeID: "image-a", type: "image", title: "A", url: "/a.png" },
    { nodeID: "text-a", type: "text", title: "说明", text: "保持配色" },
  ];
  const stored = "让 @[node:image-a] 遵循 @[node:text-a]";
  const display = canvasConfigPromptDisplay(stored, inputs);
  assert.equal(display, "让 @图片1 遵循 @文本1");
  assert.equal(canvasConfigPromptValue(display, inputs), stored);
});

test("inserting a reference preserves surrounding text and returns the caret", () => {
  assert.deepEqual(insertCanvasConfigReference("生成海报", "图片1", 2, 2), {
    value: "生成 @图片1 海报",
    cursor: 8,
  });
});

test("configuration generation requires prompt text or at least one usable input", () => {
  const config = node("config", "config");
  assert.equal(canGenerateCanvasConfig(config, []), false);
  assert.equal(canGenerateCanvasConfig({ ...config, composer_content: "生成海报" }, []), true);
  assert.equal(canGenerateCanvasConfig(config, [{ nodeID: "image", type: "image", title: "参考", url: "/a.png" }]), true);
  assert.equal(canGenerateCanvasConfig({ ...config, generation_mode: "audio" }, [{ nodeID: "audio", type: "audio", title: "参考音频", url: "/a.mp3" }]), false);
  assert.equal(canGenerateCanvasConfig({ ...config, generation_mode: "audio" }, [{ nodeID: "text", type: "text", title: "台词", text: "你好" }]), true);
});

test("an explicitly cleared composer cannot generate from deleted references", () => {
  const inputs = [{ nodeID: "text", type: "text", title: "文字", text: "已连接文字" }];
  assert.equal(canGenerateCanvasConfig(node("config", "config", { composer_content: "" }), inputs), false);
  assert.equal(canGenerateCanvasConfig(node("config", "config", { composer_content: "继续生成" }), inputs), true);
});

test("configuration prompt ownership switches only for non-empty connected text", () => {
  assert.equal(canvasConfigUsesConnectedText([]), false);
  assert.equal(canvasConfigUsesConnectedText([{ nodeID: "empty", type: "text", title: "空文字", text: "  " }]), false);
  assert.equal(canvasConfigUsesConnectedText([{ nodeID: "idea", type: "text", title: "创意", text: "白猫" }]), true);
});
