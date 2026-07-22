import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanvasInputIndex,
  canGenerateCanvasConfig,
  canvasConfigInputLabel,
  canvasConfigInputs,
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
});
