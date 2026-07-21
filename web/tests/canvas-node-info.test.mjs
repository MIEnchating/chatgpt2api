import assert from "node:assert/strict";
import test from "node:test";

import { canvasGenerationStatusLabel, canvasNodeInfoJSON } from "../src/app/canvas/canvas-node-info.ts";

test("node information JSON redacts embedded image payloads", () => {
  const json = canvasNodeInfoJSON({ url: "data:image/png;base64,very-large-payload", prompt: "保留文字" });
  assert.equal(json.includes("very-large-payload"), false);
  assert.equal(json.includes("[base64 image]"), true);
  assert.equal(json.includes("保留文字"), true);
});

test("node information JSON keeps ordinary image URLs", () => {
  assert.equal(canvasNodeInfoJSON({ url: "https://image.example/a.png" }).includes("https://image.example/a.png"), true);
});

test("node information distinguishes idle and failed generation states", () => {
  assert.equal(canvasGenerationStatusLabel("idle"), "待生成");
  assert.equal(canvasGenerationStatusLabel("loading"), "生成中");
  assert.equal(canvasGenerationStatusLabel("success"), "已完成");
  assert.equal(canvasGenerationStatusLabel("error"), "生成失败");
});
