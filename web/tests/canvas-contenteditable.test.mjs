import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getContentEditableMentionKeyAction,
  moveContentEditableMentionIndex,
  serializeContentEditable,
} from "../src/app/canvas/canvas-contenteditable.ts";

const agentPromptSource = readFileSync(new URL("../src/app/canvas/canvas-agent-prompt-chip-input.tsx", import.meta.url), "utf8");
const configComposerSource = readFileSync(new URL("../src/app/canvas/canvas-config-composer.tsx", import.meta.url), "utf8");

test("contenteditable mention keys resolve navigation without wrapping business state into the helper", () => {
  assert.deepEqual(getContentEditableMentionKeyAction("ArrowDown", 4), { type: "move", offset: 1 });
  assert.deepEqual(getContentEditableMentionKeyAction("ArrowUp", 4), { type: "move", offset: -1 });
  assert.deepEqual(getContentEditableMentionKeyAction("Enter", 4), { type: "select" });
  assert.deepEqual(getContentEditableMentionKeyAction("Escape", 4), { type: "close" });
  assert.equal(getContentEditableMentionKeyAction("Tab", 4), null);
  assert.equal(getContentEditableMentionKeyAction("Enter", 0), null);
  assert.equal(moveContentEditableMentionIndex(1, 4, 1), 2);
  assert.equal(moveContentEditableMentionIndex(3, 4, 1), 0);
  assert.equal(moveContentEditableMentionIndex(0, 4, -1), 3);
  assert.equal(moveContentEditableMentionIndex(2, 0, 1), 2);
});

test("contenteditable serialization preserves reference formats, block lines, and strips caret markers", () => {
  const OriginalHTMLElement = globalThis.HTMLElement;
  class TestHTMLElement {
    constructor(tagName, dataset, childNodes) {
      this.nodeType = 1;
      this.tagName = tagName;
      this.dataset = dataset;
      this.childNodes = childNodes;
    }
  }
  const text = (value) => ({ nodeType: 3, textContent: value });
  const element = (tagName, dataset = {}, childNodes = []) => new TestHTMLElement(tagName, dataset, childNodes);
  globalThis.HTMLElement = TestHTMLElement;
  try {
    const editor = {
      childNodes: [
        text("\uFEFF开头"),
        element("SPAN", { referenceNodeId: "image-1" }),
        element("DIV", {}, [text("下一行")]),
      ],
    };

    assert.equal(
      serializeContentEditable(editor, (node) => node.dataset.referenceNodeId ? `@[node:${node.dataset.referenceNodeId}]` : undefined),
      "开头@[node:image-1]\n下一行",
    );
  } finally {
    if (OriginalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = OriginalHTMLElement;
  }
});

test("both canvas editors keep business-specific reference deletion behavior on the shared DOM helper", () => {
  for (const source of [agentPromptSource, configComposerSource]) {
    assert.match(source, /insertPlainTextAtContentEditableSelection\(text\)/);
    assert.match(source, /getContentEditableMentionKeyAction\(event\.key, candidates\.length\)/);
    assert.match(source, /setActiveIndex\(\(index\) => moveContentEditableMentionIndex\(index, candidates\.length, mentionAction\.offset\)\)/);
    assert.doesNotMatch(source, /function deleteAdjacentReference|function adjacentReferenceNode|function findReferenceSibling/);
  }
  assert.match(agentPromptSource, /deleteAdjacentContentEditableReference\(event\.key, "refLabel", \{ trimAdjacentWhitespace: true \}\)/);
  assert.match(configComposerSource, /deleteAdjacentContentEditableReference\(event\.key, "referenceNodeId"\)/);
});

test("serializes browser placeholder lines and block boundaries exactly once", () => {
  const OriginalHTMLElement = globalThis.HTMLElement;
  class Element {
    constructor(tagName, childNodes = [], dataset = {}) { Object.assign(this, { nodeType: 1, tagName, childNodes, dataset }); }
  }
  globalThis.HTMLElement = Element;
  const text = (textContent) => ({ nodeType: 3, textContent });
  const block = (...children) => new Element("DIV", children);
  const br = () => new Element("BR");
  const serialize = (...childNodes) => serializeContentEditable({ childNodes }, (node) => node.dataset.refLabel);
  try {
    assert.equal(serialize(text("第一行"), block(br())), "第一行\n");
    assert.equal(serialize(block(text("第一行")), text("第二行")), "第一行\n第二行");
    assert.equal(serialize(text("第一行"), block(br()), block(text("第三行"))), "第一行\n\n第三行");
    assert.equal(serialize(block(text("第一行"), br()), block(text("第二行"))), "第一行\n第二行");
    assert.equal(serialize(text("前"), br(), text("后"), br()), "前\n后");
    assert.equal(serialize(text("前"), br(), block(text("后"))), "前\n后");
    assert.equal(serialize(text("前"), br(), br()), "前\n");
    assert.equal(serialize(block(new Element("SPAN", [], { refLabel: "图片1" })), block(text("说明"))), "图片1\n说明");
  } finally { globalThis.HTMLElement = OriginalHTMLElement; }
});
