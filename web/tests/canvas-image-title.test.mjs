import assert from "node:assert/strict";
import test from "node:test";

import { canvasImageTitle } from "../src/app/canvas/canvas-image-title.ts";

test("canvas image titles prefer prompt text", () => {
  assert.equal(canvasImageTitle("image.png", "  雨夜中的白猫  "), "雨夜中的白猫");
});

test("generic and storage filenames do not leak into node titles", () => {
  assert.equal(canvasImageTitle("image.png"), "图片");
  assert.equal(canvasImageTitle("clipboard-image-2.webp"), "图片");
  assert.equal(canvasImageTitle("1784598744_b41fb8af-11e4-8d5a-28c6-1ddf3653a659.png"), "图片");
});

test("descriptive filenames keep their useful base name", () => {
  assert.equal(canvasImageTitle("campaign-cover.final.png"), "campaign-cover.final");
  assert.equal(canvasImageTitle("产品主视觉.jpg"), "产品主视觉");
});
