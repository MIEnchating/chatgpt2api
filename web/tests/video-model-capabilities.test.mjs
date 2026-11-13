import assert from "node:assert/strict";
import test from "node:test";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };

import {
  activeVideoModelContracts,
  installVideoModelContracts,
} from "../src/lib/video-model-contracts.ts";

import {
  canonicalVideoModel,
  resolveVideoSeconds,
  resolveConfiguredVideoModel,
  supportsVideoFrameReferences,
  supportsVideoMultimodalReferences,
  videoAudioControl,
  videoDefaultResolution,
  videoDefaultSeconds,
  videoDefaultSize,
  videoModelRequiresHTTPSReferences,
  videoReferenceImageLimit,
  videoRequiresMultimodalReferenceMode,
  videoRequiresReferenceAudio,
  videoRequiresReferenceImage,
  videoRequiresReferenceVideo,
  videoResolutionOptions,
  videoSecondsOptions,
  videoSizeOptions,
  videoWorkbenchMaterialSections,
  videoWorkbenchDisplayResolution,
  videoWorkbenchReferenceLimits,
} from "../src/lib/video-model-capabilities.ts";

installVideoModelContracts(structuredClone(contractDocument.contracts));

test("provider upload allows local references before HTTPS URL replacement", () => {
  const contract = structuredClone(contractDocument.contracts[0]);
  contract.provider = { base_url: "https://openai.fit", auth_mode: "bearer", auth_header: "" };
  contract.transport.local_material = "url";
  assert.equal(videoModelRequiresHTTPSReferences(contract), true);
  contract.transport.material_upload = { base_url: "https://openai.fit", path: "/v1/uploads", encoding: "multipart", field: "file", url_field: "url", base64_format: "", max_bytes: 104857600 };
  assert.equal(videoModelRequiresHTTPSReferences(contract), false);
});

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

test("preserves a valid stored duration while model contracts are unavailable", () => {
  assert.equal(resolveVideoSeconds("unconfigured/video", 8), 8);
  assert.equal(resolveVideoSeconds("unconfigured/video", 0), 0);
});

test("normalizes a stored duration against an installed model contract", () => {
  assert.equal(resolveVideoSeconds("minimax-h3-768p", 8), 8);
  assert.equal(resolveVideoSeconds("minimax-h3-768p", 3), 5);
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

test("requires HTTPS references only for MiniMax URL transport", () => {
  const urlContract = structuredClone(contractDocument.contracts[0]);
  urlContract.transport.local_material = "url";
  assert.equal(videoModelRequiresHTTPSReferences(urlContract), true);
  assert.equal(videoModelRequiresHTTPSReferences(contractDocument.contracts[0]), false);
  const openAIFitContract = structuredClone(contractDocument.contracts[0]);
  openAIFitContract.driver = "custom-video";
  openAIFitContract.provider = { base_url: "https://openai.fit", auth_mode: "bearer", auth_header: "" };
  openAIFitContract.transport.local_material = "url";
  assert.equal(videoModelRequiresHTTPSReferences(openAIFitContract), true);
});

test("canonicalizes resolution casing to the contract spelling", () => {
  const chovyContract = structuredClone(contractDocument.contracts[0]);
  chovyContract.models = ["minimax-h3-chovy"];
  chovyContract.capability.resolutions = ["480P", "768P", "1088P", "1440P"];
  chovyContract.capability.default_resolution = "480P";
  assert.equal(videoWorkbenchDisplayResolution(chovyContract, "480p"), "480P");
  assert.equal(videoWorkbenchDisplayResolution(chovyContract, "1088p"), "1088P");
});

test("does not expose reference uploads for frame-only image mode", () => {
  const frameOnlyContract = structuredClone(contractDocument.contracts[0]);
  frameOnlyContract.models = ["frame-only-model"];
  frameOnlyContract.capability.references = { image: 0, video: 0, audio: 0, total: 0 };
  frameOnlyContract.generation.modes = frameOnlyContract.generation.modes.filter((mode) => mode.kind !== "reference");

  assert.deepEqual(videoWorkbenchMaterialSections(frameOnlyContract), {
    image: false,
    video: false,
    audio: false,
    imageLabel: "首尾帧",
  });
});

test("reads an explicit preview contract without mutating the runtime registry", () => {
  const previewContract = structuredClone(contractDocument.contracts[0]);
  previewContract.models = ["preview-only-model"];
  previewContract.capability.sizes = ["3:2"];
  previewContract.capability.seconds = [7];
  previewContract.capability.default_size = "3:2";
  previewContract.capability.default_seconds = 7;
  const registryBefore = activeVideoModelContracts();

  assert.deepEqual(videoSizeOptions(previewContract), ["3:2"]);
  assert.deepEqual(videoSecondsOptions(previewContract), [7]);
  assert.equal(videoDefaultSize(previewContract), "3:2");
  assert.equal(videoDefaultSeconds(previewContract), 7);
  assert.deepEqual(activeVideoModelContracts(), registryBefore);
});
