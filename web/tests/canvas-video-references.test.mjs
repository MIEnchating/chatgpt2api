import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasVideoReferences } from "../src/app/canvas/canvas-video-references.tsx";

function renderReferences(capabilities) {
  return renderToStaticMarkup(createElement(CanvasVideoReferences, {
    node: {}, inputs: [], materials: [], uploading: "", mode: "reference",
    supportsFrames: false, supportsLastFrame: false, supportsMultimodal: true,
    supportsText: true, onChange() {}, async onUpload() {}, ...capabilities,
  }));
}

test("reference-only MiniMax contracts do not offer an unsupported first-frame mode", () => {
  const html = renderReferences({});
  assert.doesNotMatch(html, /aria-label="参考模式"/);
  assert.doesNotMatch(html, />首帧</);
  assert.match(html, /不添加参考素材时使用文生视频/);
});

test("contracts with both material modes offer frames and multimodal references", () => {
  const html = renderReferences({ supportsFrames: true, supportsLastFrame: true });
  assert.match(html, /aria-label="参考模式"/);
  assert.match(html, /首尾帧/);
  assert.match(html, /多模态参考/);
});

test("material-required contracts do not advertise text generation", () => {
  assert.doesNotMatch(renderReferences({ supportsText: false }), /不添加参考素材时使用文生视频/);
});
