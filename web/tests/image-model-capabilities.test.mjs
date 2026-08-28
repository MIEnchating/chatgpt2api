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
    assert.equal(imageReferenceImageLimit(model), 4, model);
    assert.equal(supportsImageEditing(model), true, model);
    assert.equal(supportsImageExactDimensions(model), false, model);
    assert.equal(supportsImageMask(model), false, model);
    assert.equal(supportsImageOutputControls(model), false, model);
    assert.equal(supportsImageStreaming(model), true, model);
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
  assert.equal(imageReferenceImageLimit(model), 4);
  assert.equal(supportsImageEditing(model), true);
  assert.equal(supportsImageMask(model), false);
  assert.equal(supportsImageOutputControls(model), false);
  assert.equal(supportsImageQuality(model), false);
  assert.equal(supportsImageStreaming(model), true);
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

test("KIE image resolution controls follow the reference model contracts", () => {
  assert.equal(supportsImageResolution("bytedance/seedream-v4-text-to-image", "2k"), true);
  assert.equal(supportsImageResolution("seedream/4.5-text-to-image", "2k"), false);
  assert.equal(supportsImageQuality("seedream/4.5-text-to-image"), true);
  assert.equal(supportsImageResolution("seedream/5-pro-text-to-image", "2k"), false);
  assert.equal(supportsImageQuality("seedream/5-pro-text-to-image"), true);
  assert.equal(supportsImageResolution("nano-banana-2-lite", "2k"), false);
  assert.equal(supportsImageResolution("nano-banana-2", "2k"), true);
});

test("APIMart image capability branches match the reference contracts", () => {
  const contracts = [
    { model: "gpt-image-2-official", count: 15, refs: Infinity, quality: true, output: true, resolutions: ["1k", "2k", "4k"] },
    { model: "gpt-image-2-apimart", count: 15, refs: Infinity, quality: true, output: false, resolutions: ["1k", "2k", "4k"] },
    { model: "gpt-4o-image-apimart", count: 15, refs: Infinity, quality: false, output: false, resolutions: [] },
    { model: "gpt-image-1-apimart", count: 15, refs: Infinity, quality: true, output: true, resolutions: [] },
    { model: "gemini-3.1-flash-lite-image-apimart", count: 15, refs: Infinity, quality: false, output: false, resolutions: ["1k"] },
    { model: "gemini-31-image-apimart", count: 1, refs: Infinity, quality: false, output: false, resolutions: ["1k", "2k", "4k"] },
    { model: "nano-banana2-apimart", count: 1, refs: Infinity, quality: false, output: false, resolutions: ["1k", "2k", "4k"] },
    { model: "gemini-3-pro-image-apimart", count: 1, refs: Infinity, quality: false, output: false, resolutions: ["1k", "2k", "4k"] },
    { model: "gemini-2.5-flash-image-apimart", count: 1, refs: Infinity, quality: false, output: false, resolutions: ["1k"] },
    { model: "imagen-4-0-apimart", count: 1, refs: 0, quality: false, output: false, resolutions: [] },
    { model: "seedream-5-0-pro", count: 1, refs: 10, quality: false, output: false, resolutions: ["1k", "2k"] },
    { model: "seedream-5-apimart", count: 15, refs: Infinity, quality: false, output: true, resolutions: ["2k", "4k"] },
    { model: "seedream-4.5-apimart", count: 15, refs: Infinity, quality: false, output: false, resolutions: ["2k", "4k"] },
    { model: "qwen-image-apimart", count: 15, refs: Infinity, quality: false, output: false, resolutions: ["1k", "2k"] },
    { model: "z-image-apimart", count: 1, refs: 0, quality: false, output: false, resolutions: ["1k", "2k"] },
    { model: "grok-imagine-edit-apimart", count: 15, refs: Infinity, quality: false, output: false, resolutions: [] },
    { model: "wan2.7-image-apimart", count: 15, refs: Infinity, quality: false, output: false, resolutions: ["1k", "2k", "4k"] },
    { model: "flux-2-image-apimart", count: 1, refs: Infinity, quality: false, output: false, resolutions: ["1k", "2k", "4k"] },
  ];
  for (const contract of contracts) {
    assert.equal(imageModelRoute(contract.model), "apimart-image", contract.model);
    assert.equal(imageOutputCountLimit(contract.model), contract.count, contract.model);
    assert.equal(imageReferenceImageLimit(contract.model), contract.refs, contract.model);
    assert.equal(supportsImageEditing(contract.model), contract.refs > 0, contract.model);
    assert.equal(supportsImageMask(contract.model), false, contract.model);
    assert.equal(supportsImageStreaming(contract.model), false, contract.model);
    assert.equal(supportsStructuredImageParameters(contract.model), true, contract.model);
    assert.equal(supportsImageQuality(contract.model), contract.quality, contract.model);
    assert.equal(supportsImageOutputControls(contract.model), contract.output, contract.model);
    for (const resolution of ["1k", "2k", "4k"]) {
      assert.equal(supportsImageResolution(contract.model, resolution), contract.resolutions.includes(resolution), `${contract.model}:${resolution}`);
    }
  }
  assert.equal(supportsImageAspectRatio("seedream-5-0-pro", "3:1"), true);
  assert.equal(supportsImageAspectRatio("seedream-5-0-pro", "1:8"), false);
});

test("official and KIE image IDs are not inferred as APIMart without a provider suffix", () => {
  for (const model of ["gpt-image-1", "gemini-3.1-flash-image", "gemini-2.5-flash-image", "grok-imagine-image", "nano-banana-pro", "z-image"]) {
    assert.notEqual(imageModelRoute(model), "apimart-image", model);
  }
});

test("image output limit follows the reference API while reference limits follow provider capabilities", () => {
  assert.equal(imageOutputCountLimit("gpt-image-2"), 15);
  assert.equal(imageReferenceImageLimit("gpt-image-2"), 10);
  assert.equal(imageOutputCountLimit("gpt-image-1.5"), 15);
  assert.equal(imageReferenceImageLimit("gpt-image-1.5"), 10);
  assert.equal(imageOutputCountLimit("gemini-3.1-flash-image"), 15);
  assert.equal(imageOutputCountLimit("grok-imagine-image-2.0"), 15);
  assert.equal(imageOutputCountLimit("custom-image-channel"), 15);
  assert.equal(imageReferenceImageLimit("codex-gpt-image-2"), 4);
});
