import assert from "node:assert/strict";
import test from "node:test";

import {
  filterCanvasResourceMentions,
  findCanvasResourceMention,
  consumeCanvasResourceMention,
  isCanvasPromptSubmitKey,
  remapCanvasResourceLabels,
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

test("selecting a resource consumes the mention without inserting node text or a label", () => {
  assert.deepEqual(consumeCanvasResourceMention("让 @风格 保持主体", { start: 2, query: "风格" }, 5), {
    value: "让  保持主体",
    cursor: 2,
  });
});

test("adding a reference to an empty prompt leaves it empty", () => {
  assert.deepEqual(consumeCanvasResourceMention("@文本2", { start: 0, query: "文本2" }, 4), { value: "", cursor: 0 });
});

test("adding a reference preserves user text around the mention and its cursor", () => {
  assert.deepEqual(consumeCanvasResourceMention("前文 @参考 后文", { start: 3, query: "参考" }, 6), { value: "前文  后文", cursor: 3 });
});

test("removing a reference clears its label and renumbers remaining mentions in one pass", () => {
  const before = [{ nodeID: "a", label: "图片1" }, { nodeID: "b", label: "图片2" }, { nodeID: "c", label: "图片10" }];
  const after = [{ nodeID: "b", label: "图片1" }, { nodeID: "c", label: "图片2" }];
  assert.equal(remapCanvasResourceLabels("图片1 图片2 图片10 图片100", before, after), " 图片1 图片2 图片100");
});

test("reference removal preserves stable IDs and strips only detached tokens", () => {
  const before = [{ nodeID: "图片1-a", label: "图片1" }, { nodeID: "图片2-b", label: "图片2" }];
  const after = [{ nodeID: "图片2-b", label: "图片1" }];
  assert.equal(remapCanvasResourceLabels("@[node:图片1-a] @[node:图片2-b] 图片2", before, after), " @[node:图片2-b] 图片1");
});
