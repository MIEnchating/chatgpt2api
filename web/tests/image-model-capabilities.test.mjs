import assert from "node:assert/strict";
import test from "node:test";

import {
  imageModelRoute,
  imageOutputCountLimit,
  imageReferenceImageLimit,
  supportsImageEditing,
  supportsImageExactDimensions,
  supportsImageMask,
  supportsImageAspectRatio,
  supportsImageOutputControls,
  supportsImageQuality,
  supportsImageQualityValue,
  supportsImageResolution,
  supportsImageSize,
  supportsImageStreaming,
  supportsStructuredImageParameters,
} from "../src/lib/image-model-capabilities.ts";

const OFFICIAL_XAI_IMAGE_MODELS = [
  "grok-imagine-image",
  "grok-imagine-image-2026-03-02",
  "grok-imagine-image-quality",
  "grok-imagine-image-quality-20260403",
  "grok-imagine-image-quality-latest",
  "grok-imagine-image-pro",
  "grok-imagine-image-2.0",
];

test("all current official xAI image model IDs expose official generation parameters", () => {
  for (const model of OFFICIAL_XAI_IMAGE_MODELS) {
    assert.equal(imageModelRoute(model), "xai-image", model);
    assert.equal(imageReferenceImageLimit(model), 0, model);
    assert.equal(supportsImageEditing(model), false, model);
    assert.equal(supportsImageExactDimensions(model), false, model);
    assert.equal(supportsImageMask(model), false, model);
    assert.equal(supportsImageOutputControls(model), false, model);
    assert.equal(supportsImageStreaming(model), false, model);
    assert.equal(supportsImageSize(model), true, model);
    assert.equal(supportsStructuredImageParameters(model), true, model);
    assert.equal(supportsImageAspectRatio(model, "19.5:9"), true, model);
    assert.equal(supportsImageAspectRatio(model, "21:9"), false, model);
    assert.equal(supportsImageResolution(model, "1k"), true, model);
    assert.equal(supportsImageResolution(model, "2k"), true, model);
    assert.equal(supportsImageResolution(model, "4k"), false, model);
  }
  assert.equal(supportsImageQuality("grok-imagine-image-2.0"), true);
  assert.equal(supportsImageQualityValue("grok-imagine-image-2.0", "low"), true);
  assert.equal(supportsImageQualityValue("grok-imagine-image-2.0", "medium"), true);
  assert.equal(supportsImageQualityValue("grok-imagine-image-2.0", "high"), false);
  assert.equal(supportsImageQuality("grok-imagine-image"), false);
});

test("NewAPI's built-in legacy xAI image model uses the same constrained route", () => {
  const model = "grok-2-image-1212";
  assert.equal(imageModelRoute(model), "xai-image");
  assert.equal(imageReferenceImageLimit(model), 0);
  assert.equal(supportsImageEditing(model), false);
  assert.equal(supportsImageMask(model), false);
  assert.equal(supportsImageOutputControls(model), false);
  assert.equal(supportsImageQuality(model), false);
  assert.equal(supportsImageStreaming(model), false);
  assert.equal(supportsImageSize(model), false);
  assert.equal(supportsStructuredImageParameters(model), false);
});

test("current official Gemini image IDs use the Gemini route", () => {
  for (const model of [
    "gemini-3.1-flash-lite-image",
    "gemini-3.1-flash-image",
    "gemini-3-pro-image",
    "gemini-2.5-flash-image",
  ]) {
    assert.equal(imageModelRoute(model), "google-gemini-image", model);
    assert.equal(supportsImageSize(model), true, model);
    assert.equal(supportsImageExactDimensions(model), false, model);
    assert.equal(supportsStructuredImageParameters(model), true, model);
    assert.equal(supportsImageMask(model), false, model);
  }
});

test("Gemini image ratios and resolutions follow the current official model tables", () => {
  assert.equal(supportsImageAspectRatio("gemini-3.1-flash-image", "1:8"), true);
  assert.equal(supportsImageAspectRatio("gemini-3-pro-image", "1:8"), false);
  assert.equal(supportsImageAspectRatio("gemini-3.1-flash-lite-image", "1:8"), false);
  assert.equal(supportsImageAspectRatio("gemini-3.1-flash-lite-image", "4:5"), true);
  assert.equal(supportsImageResolution("gemini-3.1-flash-image", "512"), true);
  assert.equal(supportsImageResolution("gemini-3-pro-image", "512"), false);
  assert.equal(supportsImageResolution("gemini-3.1-flash-lite-image", "2k"), false);
  assert.equal(supportsImageResolution("gemini-2.5-flash-image", "1k"), false);
});

test("other NewAPI image models retain compatible ratios without claiming structured controls", () => {
  const model = "codex-gpt-image-2";
  assert.equal(supportsImageSize(model), true);
  assert.equal(supportsImageAspectRatio(model, "16:9"), true);
  assert.equal(supportsStructuredImageParameters(model), false);
});

test("mask editing is limited to the OpenAI-compatible image route", () => {
  assert.equal(supportsImageMask("gpt-image-2"), true);
  assert.equal(supportsImageMask("custom-image-channel"), true);
  assert.equal(supportsImageMask("gemini-3.1-flash-image"), false);
  assert.equal(supportsImageMask("grok-imagine-image-2.0"), false);
});

test("structured image capability matching is case insensitive", () => {
  assert.equal(supportsStructuredImageParameters(" GPT-IMAGE-2 "), true);
  assert.equal(supportsStructuredImageParameters(" GEMINI-3.1-FLASH-IMAGE "), true);
  assert.equal(supportsImageExactDimensions(" GPT-IMAGE-2 "), true);
  assert.equal(supportsImageExactDimensions(" GEMINI-3.1-FLASH-IMAGE "), false);
});

test("image output and reference limits follow provider capabilities exposed by NewAPI", () => {
  assert.equal(imageOutputCountLimit("gpt-image-2"), 10);
  assert.equal(imageReferenceImageLimit("gpt-image-2"), 10);
  assert.equal(imageOutputCountLimit("gpt-image-1.5"), 10);
  assert.equal(imageReferenceImageLimit("gpt-image-1.5"), 10);
  assert.equal(imageOutputCountLimit("gemini-3.1-flash-image"), 4);
  assert.equal(imageOutputCountLimit("grok-imagine-image-2.0"), 4);
  assert.equal(imageOutputCountLimit("custom-image-channel"), 4);
  assert.equal(imageReferenceImageLimit("codex-gpt-image-2"), 4);
});
