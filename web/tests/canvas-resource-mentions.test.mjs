import assert from "node:assert/strict";
import test from "node:test";

import {
  filterCanvasResourceMentions,
  findCanvasResourceMention,
  insertCanvasResourceMention,
  isCanvasPromptSubmitKey,
} from "../src/app/canvas/canvas-resource-mentions.ts";

test("plain enter submits while modified enter and IME confirmation do not", () => {
  assert.equal(isCanvasPromptSubmitKey({ key: "Enter" }), true);
  assert.equal(isCanvasPromptSubmitKey({ key: "Enter", shiftKey: true }), false);
  assert.equal(isCanvasPromptSubmitKey({ key: "Enter", ctrlKey: true }), false);
  assert.equal(isCanvasPromptSubmitKey({ key: "Enter", metaKey: true }), false);
  assert.equal(isCanvasPromptSubmitKey({ key: "Enter", nativeEvent: { isComposing: true } }), false);
  assert.equal(isCanvasPromptSubmitKey({ key: "Enter", keyCode: 229 }), false);
});

const references = [
  { id: "image", nodeID: "image", kind: "image", label: "图片1", title: "风格参考", previewURL: "image.png", active: true },
  { id: "text", nodeID: "text", kind: "text", label: "文本1", title: "构图要求", text: "居中构图", active: true },
  { id: "inactive", nodeID: "inactive", kind: "image", label: "图片2", title: "未连接", active: false },
];

test("resource mention starts only after a standalone at sign", () => {
  assert.deepEqual(findCanvasResourceMention("参考 @图", 5, references), { start: 3, query: "图" });
  assert.deepEqual(findCanvasResourceMention("@", 1, references), { start: 0, query: "" });
  assert.equal(findCanvasResourceMention("mail@example.com", 16, references), null);
  assert.equal(findCanvasResourceMention("参考 @图", 5, []), null);
});

test("resource mention filters active references by label, title, kind, and text", () => {
  assert.deepEqual(filterCanvasResourceMentions({ start: 0, query: "" }, references).map((item) => item.id), ["image", "text"]);
  assert.deepEqual(filterCanvasResourceMentions({ start: 0, query: "风格" }, references).map((item) => item.id), ["image"]);
  assert.deepEqual(filterCanvasResourceMentions({ start: 0, query: "居中" }, references).map((item) => item.id), ["text"]);
});

test("selecting a resource replaces the mention query with its numbered label", () => {
  assert.deepEqual(insertCanvasResourceMention("让 @风格 保持主体", { start: 2, query: "风格" }, 5, references[0]), {
    value: "让 图片1  保持主体",
    cursor: 6,
  });
});
