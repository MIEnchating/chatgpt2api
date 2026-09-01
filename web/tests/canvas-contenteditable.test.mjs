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
