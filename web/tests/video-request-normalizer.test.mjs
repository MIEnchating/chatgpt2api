import assert from "node:assert/strict";
import test from "node:test";
import contractDocument from "../../internal/protocol/video_model_contracts.json" with { type: "json" };

import { activeVideoModelContracts, installVideoModelContracts } from "../src/lib/video-model-contracts.ts";

import {
  composeVideoPrompt,
  normalizeStoredVideoSeconds,
  normalizeVideoRequest,
  videoGenerationTaskRequestBody,
  videoReferenceCombinationError,
  videoWorkbenchReferenceLimitError,
} from "../src/lib/video-request-normalizer.ts";

installVideoModelContracts(structuredClone(contractDocument.contracts));

test("does not infer provider behavior for an unconfigured model", () => {
  assert.throws(() => normalizeVideoRequest({ model: "kling/text-to-video", size: "16:9", seconds: 7 }), /未配置启用的视频模型契约/);
  assert.throws(() => videoGenerationTaskRequestBody({ clientTaskId: "task-1", prompt: "animate", model: "kling/text-to-video" }), /未配置启用的视频模型契约/);
});

test("rejects a material mode that the matched contract does not declare", () => {
  const previous = activeVideoModelContracts();
  const textOnly = structuredClone(contractDocument.contracts[0]);
  textOnly.name = "Text only video";
  textOnly.models = ["text-only-video"];
  textOnly.generation.modes = textOnly.generation.modes.filter((mode) => mode.kind === "text");
  textOnly.generation.default_mode = textOnly.generation.modes[0].id;
  try {
    installVideoModelContracts([textOnly]);
    assert.throws(() => normalizeVideoRequest({
      model: "text-only-video",
      firstFrameURL: "https://cdn.example.com/first.png",
    }), /不支持图生视频/);
  } finally {
    installVideoModelContracts(previous);
  }
});

test("normalizes declared video parameters without vendor-specific clamps", () => {
  const request = normalizeVideoRequest({
    model: "minimax-h3-768p",
    size: "9:16",
    seconds: 13,
    resolution: "768p",
    generateAudio: false,
    watermark: true,
  });
  assert.equal(request.model, "minimax-h3-768p");
  assert.equal(request.size, "9:16");
  assert.equal(request.seconds, 13);
  assert.equal(request.resolution, "768p");
  assert.equal(request.generateAudio, true);
  assert.equal(request.watermark, true);

  const textRequest = videoGenerationTaskRequestBody({
    clientTaskId: "task-text-video",
    prompt: "雪山日出，云海翻涌",
    model: "minimax-h3-768p",
    size: "16:9",
    seconds: 8,
    resolution: "768p",
  });
  assert.equal(textRequest.generation_mode, "text-to-video");
  assert.equal(textRequest.reference_image_urls, undefined);
  assert.equal(textRequest.reference_video_urls, undefined);
  assert.equal(textRequest.reference_audio_urls, undefined);
});

test("uses contract modes and fields in the task request", () => {
  const request = videoGenerationTaskRequestBody({
    clientTaskId: "task-2",
    prompt: "camera push",
    model: "minimax-h3-768p-enhanced",
    size: "auto",
    seconds: 8,
    resolution: "768p",
    firstFrameURL: "https://cdn.example.com/first.png",
    lastFrameURL: "https://cdn.example.com/last.png",
  });
  assert.equal(request.model, "minimax-h3-768p-enhanced");
  assert.equal(request.generation_mode, "image-to-video");
  assert.equal(request.reference_mode, "first-frame");
  assert.equal(request.first_frame_url, "https://cdn.example.com/first.png");
  assert.equal(request.last_frame_url, "https://cdn.example.com/last.png");
});

test("clears hidden rule fields before selecting the mode and building the request", () => {
  const previous = activeVideoModelContracts();
  const contract = structuredClone(contractDocument.contracts[0]);
  contract.models = ["conditional-ui-video"];
  contract.rules = [{
    when: { field: "first_frame", operator: "present" },
    ui: { hide: ["reference_image", "reference_video", "reference_audio", "duration", "resolution"] },
    message: "首帧模式隐藏普通参考素材",
  }];
  try {
    installVideoModelContracts([contract]);
    const request = videoGenerationTaskRequestBody({
      clientTaskId: "task-ui-rule",
      prompt: "animate",
      model: "conditional-ui-video",
      seconds: 8,
      resolution: "768p",
      firstFrameURL: "https://cdn.example.com/first.png",
      referenceImageURLs: ["https://cdn.example.com/reference.png"],
      referenceVideoURLs: ["https://cdn.example.com/reference.mp4"],
      referenceAudioURLs: ["https://cdn.example.com/reference.mp3"],
    });
    assert.equal(request.generation_mode, "image-to-video");
    assert.equal(request.first_frame_url, "https://cdn.example.com/first.png");
    assert.equal(request.reference_image_urls, undefined);
    assert.equal(request.reference_video_urls, undefined);
    assert.equal(request.reference_audio_urls, undefined);
    assert.equal(request.seconds, undefined);
    assert.equal(request.resolution, undefined);
  } finally {
    installVideoModelContracts(previous);
  }
});

test("validates contract material limits and rules", () => {
  assert.equal(videoWorkbenchReferenceLimitError("minimax-h3-768p", 10, 0, 0), "当前模型参考图最多 9 张");
  assert.match(videoReferenceCombinationError({
    model: "minimax-h3-768p",
    lastFrameURL: "https://cdn.example.com/last.png",
  }), /首帧/);
  assert.equal(videoReferenceCombinationError({
    model: "minimax-h3-768p",
    referenceMode: "reference",
    referenceImageURLs: ["https://cdn.example.com/ref.png"],
  }), "");
});

test("keeps shared prompt and stored-duration normalization deterministic", () => {
  assert.equal(composeVideoPrompt("user", "system"), "system\n\nuser");
  assert.equal(normalizeStoredVideoSeconds(4000), 3600);
});
