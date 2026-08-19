import assert from "node:assert/strict";
import test from "node:test";

import { getImageSizeSelectionFromSize } from "../src/app/image/image-options.ts";

test("saved Gemini resolution overrides ratio-only size inference", () => {
  const selection = getImageSizeSelectionFromSize("16:9", "2k");

  assert.equal(selection.mode, "ratio");
  assert.equal(selection.aspectRatio, "16:9");
  assert.equal(selection.resolution, "2k");
});

test("invalid saved resolution falls back to inferred size data", () => {
  const selection = getImageSizeSelectionFromSize("2048x2048", "not-a-resolution");

  assert.equal(selection.aspectRatio, "1:1");
  assert.equal(selection.resolution, "2k");
});
