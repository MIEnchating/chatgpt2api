import assert from "node:assert/strict";
import test from "node:test";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };

import { installVideoModelContracts } from "../src/lib/video-model-contracts.ts";

import {
  canonicalVideoModel,
  resolveConfiguredVideoModel,
  supportsVideoFrameReferences,
  supportsVideoMultimodalReferences,
  videoAudioControl,
  videoDefaultResolution,
  videoDefaultSeconds,
  videoDefaultSize,
  videoReferenceImageLimit,
  videoRequiresMultimodalReferenceMode,
  videoRequiresReferenceAudio,
  videoRequiresReferenceImage,
  videoRequiresReferenceVideo,
  videoResolutionOptions,
  videoSecondsOptions,
  videoSizeOptions,
  videoWorkbenchMaterialSections,
  videoWorkbenchReferenceLimits,
} from "../src/lib/video-model-capabilities.ts";

installVideoModelContracts(structuredClone(contractDocument.contracts));

test("preserves upstream model IDs instead of rewriting provider aliases", () => {
  assert.equal(canonicalVideoModel("  kling/text-to-video  "), "kling/text-to-video");
});

test("selects video defaults only from the globally configured model list", () => {
  const configured = ["minimax-h3-768p", "sora-2"];
  assert.equal(resolveConfiguredVideoModel(configured, "disabled-model", "sora-2", "minimax-h3-768p"), "sora-2");
  assert.equal(resolveConfiguredVideoModel(configured, "disabled-model"), "minimax-h3-768p");
  assert.equal(resolveConfiguredVideoModel([], "grok-imagine-video"), "");
});

test("returns no inferred capability for a model without a contract", () => {
  assert.deepEqual(videoSizeOptions("unconfigured/video"), []);
  assert.deepEqual(videoSecondsOptions("unconfigured/video"), []);
  assert.deepEqual(videoResolutionOptions("unconfigured/video"), []);
  assert.equal(videoDefaultSeconds("unconfigured/video"), 0);
  assert.equal(videoAudioControl("unconfigured/video"), "none");
});

test("reads every creator capability from the matching contract", () => {
  const model = "minimax-h3-768p";
  assert.deepEqual(videoSizeOptions(model), ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  assert.deepEqual(videoSecondsOptions(model), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(videoResolutionOptions(model), ["768p"]);
  assert.equal(videoDefaultSize(model), "16:9");
  assert.equal(videoDefaultSeconds(model), 5);
  assert.equal(videoDefaultResolution(model), "768p");
  assert.equal(videoReferenceImageLimit(model), 2);
  assert.equal(videoAudioControl(model), "always");
  assert.equal(supportsVideoFrameReferences(model), true);
  assert.equal(supportsVideoMultimodalReferences(model), true);
  assert.deepEqual(videoWorkbenchReferenceLimits(model), { image: 9, video: 3, audio: 3 });
  assert.deepEqual(videoWorkbenchMaterialSections(model), { image: true, video: true, audio: true, imageLabel: "参考图" });
  assert.equal(videoRequiresReferenceImage(model), false);
  assert.equal(videoRequiresReferenceVideo(model), false);
  assert.equal(videoRequiresReferenceAudio(model), false);
  assert.equal(videoRequiresMultimodalReferenceMode(model), false);
});
