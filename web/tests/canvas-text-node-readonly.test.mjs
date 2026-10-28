import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const engineSource = readFileSync(new URL("../src/app/canvas/canvas-engine.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8");

test("text nodes render content without an inline editor", () => {
  assert.match(engineSource, /node\.prompt \|\| <span[^>]*>等待生成结果/);
  assert.doesNotMatch(engineSource, /CanvasResourceMentionTextarea/);
  assert.doesNotMatch(engineSource, /contentEditable/);
});

test("text generation input stays separate from the read-only result", () => {
  const panelSource = pageSource.slice(
    pageSource.indexOf("function CanvasTextPromptPanel"),
    pageSource.indexOf("function CanvasNodePromptPanel"),
  );
  assert.match(panelSource, /aria-label="文本生成要求"/);
  assert.match(panelSource, /useState\(node\.composer_content \|\| ""\)/);
  assert.match(pageSource, /<CanvasTextPromptPanel/);
  assert.match(pageSource, /onPromptChange=\{\(value, commit\) => updateNodeComposerContent\(node\.id, value, commit\)\}/);
  assert.doesNotMatch(panelSource, /onPromptChange.*node\.prompt/);
});
