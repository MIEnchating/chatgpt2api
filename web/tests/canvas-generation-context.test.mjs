import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERRUPTED_CANVAS_GENERATION_ERROR,
  buildCanvasGenerationContext,
  buildCanvasImageReferencePrompt,
  canvasGenerationCount,
  canvasGenerationReferenceImageURLs,
  findCanvasRetryConfigurationNode,
  restoreInterruptedCanvasGenerations,
} from "../src/app/canvas/canvas-generation-context.ts";

function node(id, type, values = {}) {
  return { id, type, x: 0, y: 0, width: 100, height: 100, scale_x: 1, scale_y: 1, ...values };
}

test("reference image prompts use the same numbered labels as the canvas", () => {
  assert.equal(buildCanvasImageReferencePrompt("  让图片1参考图片2的配色  ", 2), "参考图片编号：图片1、图片2。请按这些编号理解提示词中的图片引用。\n\n让图片1参考图片2的配色");
  assert.equal(buildCanvasImageReferencePrompt("  原始提示词  ", 0), "原始提示词");
  assert.equal(buildCanvasImageReferencePrompt("", 1), "参考图片编号：图片1。请按这些编号理解提示词中的图片引用。\n\n");
});

test("tool-specific and retry generation force a single output", () => {
  assert.equal(canvasGenerationCount(4, undefined, false), 4);
  assert.equal(canvasGenerationCount(4, 1, false), 1);
  assert.equal(canvasGenerationCount(4, 8, true), 1);
  assert.equal(canvasGenerationCount(20, undefined, false), 10);
});

test("generation context appends direct upstream text in connection order", () => {
  const nodes = [
    node("target", "image"),
    node("first", "text", { prompt: "第一段" }),
    node("second", "text", { prompt: "第二段" }),
    node("indirect", "text", { prompt: "不应读取" }),
  ];
  const connections = [
    { id: "first-target", from_node_id: "first", to_node_id: "target" },
    { id: "second-target", from_node_id: "second", to_node_id: "target" },
    { id: "indirect-first", from_node_id: "indirect", to_node_id: "first" },
  ];

  assert.deepEqual(buildCanvasGenerationContext("target", nodes, connections, "当前提示词"), {
    prompt: "当前提示词\n\n第一段\n\n第二段",
    referenceImageURLs: [],
    textCount: 2,
    imageCount: 0,
  });
});

test("generation context collects direct upstream images and ignores their prompts", () => {
  const nodes = [
    node("target", "image"),
    node("image-a", "image", { url: "/images/a.png", prompt: "图片自身提示词" }),
    node("image-b", "image", { url: "/images/b.png" }),
  ];
  const connections = [
    { id: "a-target", from_node_id: "image-a", to_node_id: "target" },
    { id: "b-target", from_node_id: "image-b", to_node_id: "target" },
  ];

  assert.deepEqual(buildCanvasGenerationContext("target", nodes, connections, "修改图片"), {
    prompt: "修改图片",
    referenceImageURLs: ["/images/a.png", "/images/b.png"],
    textCount: 0,
    imageCount: 2,
  });
});

test("blank upstream image nodes contribute prompt text like the reference project", () => {
  const nodes = [
    node("target", "image"),
    node("blank-image", "image", { prompt: "赛博朋克夜景" }),
  ];
  const connections = [{ id: "blank-target", from_node_id: "blank-image", to_node_id: "target" }];

  assert.deepEqual(buildCanvasGenerationContext("target", nodes, connections, "增加雨雾"), {
    prompt: "增加雨雾\n\n赛博朋克夜景",
    referenceImageURLs: [],
    textCount: 1,
    imageCount: 0,
  });
});

test("generation context keeps the original behavior without direct upstream inputs", () => {
  const nodes = [node("target", "image"), node("other", "text", { prompt: "无关内容" })];
  assert.deepEqual(buildCanvasGenerationContext("target", nodes, [], "  当前提示词  "), {
    prompt: "当前提示词",
    referenceImageURLs: [],
    textCount: 0,
    imageCount: 0,
  });
});

test("a blank generation node can use connected text without duplicating it", () => {
  const nodes = [node("idea", "text", { prompt: "一只白猫" }), node("target", "image", { prompt: "" })];
  const connections = [{ id: "idea-target", from_node_id: "idea", to_node_id: "target" }];
  assert.equal(buildCanvasGenerationContext("target", nodes, connections, "").prompt, "一只白猫");
});

test("a generation configuration node combines connected text and image inputs", () => {
  const nodes = [
    node("config", "config", { prompt: "补充柔和光线" }),
    node("idea", "text", { prompt: "一只白猫" }),
    node("reference", "image", { url: "/images/reference.png" }),
  ];
  const connections = [
    { id: "idea-config", from_node_id: "idea", to_node_id: "config" },
    { id: "reference-config", from_node_id: "reference", to_node_id: "config" },
  ];
  assert.deepEqual(buildCanvasGenerationContext("config", nodes, connections, "补充柔和光线"), {
    prompt: "补充柔和光线\n\n一只白猫",
    referenceImageURLs: ["/images/reference.png"],
    textCount: 1,
    imageCount: 1,
  });
});

test("a node connected to a configuration uses the configuration's other inputs", () => {
  const nodes = [
    node("source", "image", { url: "/images/source.png" }),
    node("config", "config"),
    node("idea", "text", { prompt: "保留暖色调" }),
    node("reference", "image", { url: "/images/reference.png" }),
    node("direct", "text", { prompt: "不应读取自己的直接上游" }),
  ];
  const connections = [
    { id: "direct-source", from_node_id: "direct", to_node_id: "source" },
    { id: "source-config", from_node_id: "source", to_node_id: "config" },
    { id: "idea-config", from_node_id: "idea", to_node_id: "config" },
    { id: "reference-config", from_node_id: "reference", to_node_id: "config" },
  ];

  assert.deepEqual(buildCanvasGenerationContext("source", nodes, connections, "修改主体"), {
    prompt: "修改主体\n\n保留暖色调",
    referenceImageURLs: ["/images/reference.png"],
    textCount: 1,
    imageCount: 1,
  });
});

test("configuration references select and order only the explicitly mentioned inputs", () => {
  const nodes = [
    node("config", "config", { composer_content: "让 @[node:image-b] 参考 @[node:text-a]" }),
    node("text-a", "text", { prompt: "保留主体" }),
    node("image-a", "image", { url: "/images/a.png" }),
    node("image-b", "image", { url: "/images/b.png" }),
  ];
  const connections = [
    { id: "a-config", from_node_id: "image-a", to_node_id: "config" },
    { id: "text-config", from_node_id: "text-a", to_node_id: "config" },
    { id: "b-config", from_node_id: "image-b", to_node_id: "config" },
  ];
  assert.deepEqual(buildCanvasGenerationContext("config", nodes, connections, "让 @[node:image-b] 参考 @[node:text-a]"), {
    prompt: "让 图片1 参考 【文本1】\n\n【文本1】\n保留主体",
    referenceImageURLs: ["/images/b.png"],
    textCount: 1,
    imageCount: 1,
  });
});

test("plain composer content does not implicitly attach every connected resource", () => {
  const nodes = [
    node("config", "config", { composer_content: "只生成一张极简海报" }),
    node("image", "image", { url: "/images/reference.png" }),
    node("text", "text", { prompt: "不应自动附带" }),
  ];
  const connections = [
    { id: "image-config", from_node_id: "image", to_node_id: "config" },
    { id: "text-config", from_node_id: "text", to_node_id: "config" },
  ];
  assert.deepEqual(buildCanvasGenerationContext("config", nodes, connections, "只生成一张极简海报"), {
    prompt: "只生成一张极简海报",
    referenceImageURLs: [],
    textCount: 0,
    imageCount: 0,
  });
});

test("a populated source image replaces upstream image references", () => {
  assert.deepEqual(canvasGenerationReferenceImageURLs(node("target", "image", { url: "/images/source.png" }), ["/images/upstream-a.png", "/images/upstream-b.png"], 4), ["/images/source.png"]);
  assert.deepEqual(canvasGenerationReferenceImageURLs(node("target", "image"), ["a", "b", "c"], 2), ["a", "b"]);
});

test("loading nodes become retryable after the canvas reloads", () => {
  const loading = node("loading", "image", { generation_status: "loading" });
  const success = node("success", "image", { generation_status: "success" });
  assert.deepEqual(restoreInterruptedCanvasGenerations([loading, success]), [
    { ...loading, generation_status: "error", generation_error: INTERRUPTED_CANVAS_GENERATION_ERROR },
    success,
  ]);
});

test("retry fallback finds the nearest upstream generation configuration", () => {
  const nodes = [node("config", "config"), node("root", "image"), node("child", "image")];
  const connections = [
    { id: "config-root", from_node_id: "config", to_node_id: "root" },
    { id: "root-child", from_node_id: "root", to_node_id: "child" },
  ];
  assert.equal(findCanvasRetryConfigurationNode("child", nodes, connections)?.id, "config");
  assert.equal(findCanvasRetryConfigurationNode("config", nodes, connections), null);
});
