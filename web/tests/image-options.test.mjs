import assert from "node:assert/strict";
import test from "node:test";

import {
  IMAGE_ASPECT_RATIO_PRESET_OPTIONS,
  IMAGE_WORKBENCH_QUALITY_OPTIONS,
  buildCustomImageSize,
  calculateDefaultImageSize,
  getImageSizeSelectionFromSize,
  imageWorkbenchAcceptsReferenceImages,
  imageWorkbenchReferenceImageLimit,
  imageWorkbenchSupportsSize,
  normalizeReferenceImageQuality,
  resolveReferenceImageRequestSize,
} from "../src/app/image/image-options.ts";

test("reference-project size presets and fallback dimensions stay aligned", () => {
  assert.equal(IMAGE_ASPECT_RATIO_PRESET_OPTIONS.length, 16);
  assert.equal(IMAGE_ASPECT_RATIO_PRESET_OPTIONS.some((option) => option.label.includes("自定义")), false);
  assert.deepEqual(
    IMAGE_ASPECT_RATIO_PRESET_OPTIONS.map((option) => option.label),
    ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "1:1(2k)", "16:9(2k)", "9:16(2k)", "21:9(2k)", "16:9(4k)", "9:16(4k)", "21:9(4k)", "auto"],
  );
  assert.equal(calculateDefaultImageSize("16:9"), "1920x1080");
  assert.equal(calculateDefaultImageSize("9:16"), "1080x1920");
  assert.equal(calculateDefaultImageSize("21:9"), "1568x672");
});

test("image workbench keeps the reference project's model-independent quality choices", () => {
  assert.deepEqual(
    IMAGE_WORKBENCH_QUALITY_OPTIONS.map(({ value, label }) => ({ value, label })),
    [
      { value: "", label: "自动" },
      { value: "high", label: "高" },
      { value: "medium", label: "中" },
      { value: "low", label: "低" },
    ],
  );
});

test("image workbench does not hide size or reference inputs by provider", () => {
  for (const model of [
    "gpt-image-2",
    "gemini-3.1-flash-image",
    "grok-imagine-image",
    "glm-image",
    "imagen-4-0-apimart",
    "custom-image-channel",
  ]) {
    assert.equal(imageWorkbenchSupportsSize(model), true, model);
    assert.equal(imageWorkbenchAcceptsReferenceImages(model), true, model);
    assert.equal(imageWorkbenchReferenceImageLimit(model), Number.POSITIVE_INFINITY, model);
  }
});

test("custom dimensions only snap when 16-multiple alignment is enabled", () => {
  assert.equal(buildCustomImageSize("999", "777", true), "1008x784");
  assert.equal(buildCustomImageSize("999", "777", false), "999x777");
  assert.equal(buildCustomImageSize("100", "100", true), "112x112");
  assert.equal(buildCustomImageSize("5000", "4000", true), "5008x4000");
});

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

test("ratio-only requests use the reference service quality-to-pixel algorithm", () => {
  assert.equal(normalizeReferenceImageQuality(""), "auto");
  assert.equal(normalizeReferenceImageQuality("2K"), "medium");
  assert.equal(normalizeReferenceImageQuality("unknown"), "auto");
  assert.equal(resolveReferenceImageRequestSize("auto", "16:9"), "1280x720");
  assert.equal(resolveReferenceImageRequestSize("low", "1:1"), "1024x1024");
  assert.equal(resolveReferenceImageRequestSize("medium", "16:9"), "2816x1584");
  assert.equal(resolveReferenceImageRequestSize("high", "9:16"), "2160x3840");
  assert.equal(resolveReferenceImageRequestSize("auto", "2048x1152"), "2048x1152");
  assert.equal(resolveReferenceImageRequestSize("auto", "auto"), undefined);
});
