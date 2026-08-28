import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const engineSource = readFileSync(new URL("../src/app/canvas/canvas-engine.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8");

test("text nodes render content without an inline editor", () => {
  assert.match(engineSource, /node\.prompt \|\| <span className="text-muted-foreground">暂无文字内容<\/span>/);
  assert.doesNotMatch(engineSource, /CanvasResourceMentionTextarea/);
  assert.doesNotMatch(engineSource, /contentEditable/);
});

test("text content stays editable only in the side panel", () => {
  const panelSource = pageSource.slice(
    pageSource.indexOf("function CanvasTextContentPanel"),
    pageSource.indexOf("function CanvasNodePromptPanel"),
  );
  assert.match(pageSource, /placeholder="输入文字内容"/);
  assert.match(pageSource, /<CanvasTextContentPanel/);
  assert.match(pageSource, /onContentChange=\{\(value, commit\) => updateNodePrompt\(node\.id, value, commit\)\}/);
  assert.doesNotMatch(panelSource, /CanvasInlineModelSelect/);
  assert.doesNotMatch(panelSource, /生成文本/);
});
