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
  assert.match(videoReferenceCombinationError({
    model: "minimax-h3-768p",
    referenceImageURLs: [
      "https://cdn.example.com/first.png",
      "https://cdn.example.com/last.png",
      "https://cdn.example.com/extra.png",
    ],
  }), /不能使用参考图片/);
  assert.match(videoReferenceCombinationError({
    model: "minimax-h3-768p",
    firstFrameURL: "https://cdn.example.com/first.png",
    referenceImageURLs: ["https://cdn.example.com/extra.png"],
  }), /不能使用参考图片/);
});

test("rejects excess image-mode materials instead of silently truncating them", () => {
  assert.throws(() => normalizeVideoRequest({
    model: "minimax-h3-768p",
    referenceImageURLs: [
      "https://cdn.example.com/first.png",
      "https://cdn.example.com/last.png",
      "https://cdn.example.com/extra.png",
    ],
  }), /不能使用参考图片/);
});

test("keeps shared prompt and stored-duration normalization deterministic", () => {
  assert.equal(composeVideoPrompt("user", "system"), "system\n\nuser");
  assert.equal(normalizeStoredVideoSeconds(4000), 4000);
});


test("validates cross-field rules using all request parameters and capability defaults", () => {
  const previous = activeVideoModelContracts();
  const contract = structuredClone(contractDocument.contracts[0]);
  contract.capability.audio_control = "toggle";
  contract.request.generate_audio_field = "generate_audio";
  contract.rules = [
    { when: { field: "first_frame", operator: "present" }, require: ["generate_audio", "duration", "size", "resolution"], message: "首帧需要声音和完整参数" },
    { when: { field: "generate_audio", operator: "present" }, require_any: ["first_frame", "reference_image"], message: "声音需要图片" },
  ];
  try {
    installVideoModelContracts([contract]);
    const input = { model: contract.models[0], firstFrameURL: "https://cdn.example.com/first.png", generateAudio: true };
    assert.equal(videoReferenceCombinationError(input), "");
    assert.equal(videoReferenceCombinationError({ ...input, generateAudio: false }), "首帧需要声音和完整参数");
    assert.throws(() => videoGenerationTaskRequestBody({ ...input, generateAudio: false, clientTaskId: "invalid", prompt: "animate" }), /首帧需要声音/);
    assert.equal(videoGenerationTaskRequestBody({ ...input, clientTaskId: "valid", prompt: "animate" }).generate_audio, true);
    contract.capability.audio_control = "always";
    installVideoModelContracts([contract]);
    assert.equal(videoReferenceCombinationError({ ...input, generateAudio: undefined }), "");
    assert.equal(videoReferenceCombinationError({ model: contract.models[0], referenceMode: "reference", ordinaryReferenceImageCount: 1 }), "");
  } finally {
    installVideoModelContracts(previous);
  }
});

test("counts pending local reference images before upload", () => {
  const previous = activeVideoModelContracts();
  const contract = structuredClone(contractDocument.contracts[0]);
  contract.rules = [];
  try {
    installVideoModelContracts([contract]);
    const input = { model: contract.models[0], ordinaryReferenceImageCount: 1 };
    assert.equal(videoReferenceCombinationError(input), "");
    assert.doesNotThrow(() => normalizeVideoRequest({ ...input, referenceMode: "reference" }));
  } finally {
    installVideoModelContracts(previous);
  }
});

test("validates hidden duration using the default that the server receives", () => {
  const previous = activeVideoModelContracts();
  const contract = structuredClone(contractDocument.contracts[0]);
  contract.rules = [
    { when: { field: "first_frame", operator: "present" }, ui: { hide: ["duration"] }, message: "hide duration" },
    { when: { field: "duration", operator: "equals", value: "8" }, require: ["reference_video"], message: "eight requires video" },
  ];
  try {
    installVideoModelContracts([contract]);
    const request = videoGenerationTaskRequestBody({ model: contract.models[0], clientTaskId: "hidden-duration", prompt: "boat", seconds: 8, firstFrameURL: "https://media.example/first.png" });
    assert.equal(request.seconds, undefined);
  } finally {
    installVideoModelContracts(previous);
  }
});

test("does not count an explicit frame alias as an ordinary image", () => {
  const input = {
    model: contractDocument.contracts[0].models[0], firstFrameURL: "https://media.example/first.png",
    referenceImageURLs: ["https://media.example/first.png"],
  };
  assert.equal(videoReferenceCombinationError(input), "");
  assert.deepEqual(normalizeVideoRequest(input).referenceImageURLs, []);
});

test("uses one visibility snapshot for validation and the submitted request", () => {
  const previous = activeVideoModelContracts();
  const contract = structuredClone(contractDocument.contracts[0]);
  contract.capability.audio_control = "toggle";
  contract.request.generate_audio_field = "generate_audio";
  contract.rules = [
    { when: { field: "duration", operator: "equals", value: "8" }, ui: { hide: ["duration"] }, message: "hide selected duration" },
    { when: { field: "duration", operator: "equals", value: "5" }, ui: { hide: ["generate_audio"] }, message: "hide audio for the default duration" },
    { when: { field: "first_frame", operator: "present" }, require: ["generate_audio"], message: "frame requires audio" },
  ];
  try {
    installVideoModelContracts([contract]);
    const input = {
      model: contract.models[0], clientTaskId: "visibility-snapshot", prompt: "animate",
      seconds: 8, generateAudio: true, firstFrameURL: "https://media.example/first.png",
    };
    assert.equal(videoReferenceCombinationError(input), "");
    const request = videoGenerationTaskRequestBody(input);
    assert.equal(request.seconds, undefined);
    assert.equal(request.generate_audio, true);
    assert.equal(request.first_frame_url, input.firstFrameURL);
  } finally {
    installVideoModelContracts(previous);
  }
});
