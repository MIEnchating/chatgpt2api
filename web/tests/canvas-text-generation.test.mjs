import assert from "node:assert/strict";
import test from "node:test";

import { canvasTextGenerationPlan, resolveCanvasTextModel } from "../src/app/canvas/canvas-text-generation.ts";

function node(type, values = {}) {
  return { id: "node", type, x: 0, y: 0, width: 340, height: 240, scale_x: 1, scale_y: 1, ...values };
}

test("canvas and Agent resolve text models only from the configured list", () => {
  assert.equal(resolveCanvasTextModel("gpt-5.4", ["gpt-5.5", "gpt-5.4"]), "gpt-5.4");
  assert.equal(resolveCanvasTextModel("", ["gpt-5.3", "gpt-5.5"]), "gpt-5.3");
  assert.equal(resolveCanvasTextModel("", []), "");
});

test("regenerates an existing text result in the same node without children", () => {
  assert.deepEqual(canvasTextGenerationPlan(node("text", {
    prompt: "原始文案",
    composer_content: "改得更简洁",
    generation_count: 8,
  })), {
    sourceContent: "原始文案",
    instruction: "改得更简洁",
    requestPrompt: "请根据要求修改以下文本。\n\n原文：\n原始文案\n\n修改要求：\n改得更简洁",
    count: 1,
    createsChildNodes: false,
  });
});

test("generates into an empty text node in place", () => {
  assert.deepEqual(canvasTextGenerationPlan(node("text", { composer_content: "写一段开场白" })), {
    sourceContent: "",
    instruction: "写一段开场白",
    requestPrompt: "写一段开场白",
    count: 1,
    createsChildNodes: false,
  });
});

test("text input is independent from the existing result and overwrite uses both", () => {
  const source = node("text", { prompt: "已有生成结果", composer_content: "改为两句话" });
  const plan = canvasTextGenerationPlan(source);
  assert.equal(plan.instruction, "改为两句话");
  assert.equal(plan.sourceContent, "已有生成结果");
  assert.equal(plan.createsChildNodes, false);
  assert.ok(plan.requestPrompt.includes("已有生成结果"));
  assert.ok(plan.requestPrompt.includes("改为两句话"));
  assert.equal(source.prompt, "已有生成结果");
  assert.equal(source.composer_content, "改为两句话");
  assert.equal(canvasTextGenerationPlan(node("text", { prompt: "已有生成结果" })).instruction, "");
});

test("config text generation clamps count and uses composer input", () => {
  const plan = canvasTextGenerationPlan(node("config", {
    prompt: "旧提示词",
    composer_content: "生成角色小传",
    generation_count: 99,
  }));
  assert.equal(plan.requestPrompt, "生成角色小传");
  assert.equal(plan.count, 15);
  assert.equal(plan.createsChildNodes, true);
});
