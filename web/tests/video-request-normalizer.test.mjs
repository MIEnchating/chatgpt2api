import assert from "node:assert/strict";
import test from "node:test";

import { composeVideoPrompt, normalizeStoredVideoSeconds, normalizeVideoKlingElementList, normalizeVideoRequest, normalizeVideoSubmissionSeconds, validateVideoKlingElementList, videoAudioGenerationError, videoGenerationTaskRequestBody, videoHasKlingElementReferences, videoReferenceCombinationError, videoSubmissionIncludesSeconds, videoWorkbenchReferenceLimitError } from "../src/lib/video-request-normalizer.ts";
import { videoResolutionOptions, videoSecondsOptions, videoSizeOptions, videoMultimodalReferenceLimits } from "../src/lib/video-model-capabilities.ts";
import { videoTurnFieldsFromNormalizedRequest } from "../src/app/image/video-task-state.ts";

test("normalizes aliases before applying the provider request contract", () => {
  const request = normalizeVideoRequest({ model: "kling/text-to-video", size: "16:9", seconds: 7 });
  assert.equal(request.model, "kling-2.6/text-to-video");
  assert.equal(request.profile, "kling-kie-26");
  assert.equal(request.size, "16:9");
	// The reference project's generic panel preserves the typed duration;
	// provider-specific enum conversion happens at submission time.
	assert.equal(request.seconds, 7);
});

test("matches the reference workbench audio toggle and Kling v2.6 mode rule", () => {
  assert.equal(normalizeVideoRequest({ model: "kling/text-to-video", generateAudio: true }).generateAudio, true);
  assert.equal(normalizeVideoRequest({ model: "kling-v2-6", videoMode: "std", generateAudio: true }).generateAudio, false);
  assert.equal(normalizeVideoRequest({ model: "kling-v2-6", videoMode: "pro", generateAudio: true }).generateAudio, true);
  assert.equal(normalizeVideoRequest({ model: "wan/2-6-flash-video-to-video", generateAudio: true }).generateAudio, true);
});

test("matches the reference workbench Kling audio reference limits", () => {
  const klingV26 = normalizeVideoRequest({
    model: "kling-v2-6",
    videoMode: "pro",
    generateAudio: true,
    referenceImageURLs: ["https://cdn.example.com/one.png", "https://cdn.example.com/two.png"],
  });
  assert.equal(klingV26.generateAudio, true);
  assert.deepEqual(klingV26.referenceImageURLs, ["https://cdn.example.com/one.png", "https://cdn.example.com/two.png"]);
  assert.equal(videoAudioGenerationError("kling-v2-6", true, "std", 1), "Kling v2.6 音频生成需要 pro 模式");
  assert.equal(videoAudioGenerationError("kling-v2-6", true, "pro", 2), "Kling v2.6 开启音频时最多 1 张参考图");
  assert.equal(videoAudioGenerationError("kling-v2-6", true, "pro", 1), "");

  const klingOmni = normalizeVideoRequest({
    model: "kling-3.0-omni/reference-to-video",
    videoMode: "pro",
    generateAudio: true,
    referenceVideoURLs: ["https://cdn.example.com/reference.mp4"],
  });
  assert.equal(klingOmni.generateAudio, false);
});

test("rejects stale Kling workbench material instead of silently slicing it", () => {
  assert.equal(videoWorkbenchReferenceLimitError("kling-v3", 3, 0, 0), "Kling 参考图最多 2 张");
  assert.equal(videoWorkbenchReferenceLimitError("kling-3.0-omni/transformation", 5, 1, 0), "Kling 参考图最多 4 张");
  assert.equal(videoWorkbenchReferenceLimitError("kling-3.0-omni/reference-to-video", 9, 2, 0), "Kling 参考视频最多 1 个");
  assert.equal(videoWorkbenchReferenceLimitError("sora-2", 10, 4, 4), "");
});

test("preserves both KIE Kling 3 universal frame images", () => {
  const request = normalizeVideoRequest({
    model: "kling-3.0/video",
    referenceImageURLs: ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"],
  });
  assert.equal(request.referenceMode, "first-frame");
  assert.deepEqual(request.referenceImageURLs, ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"]);
});

test("normalizes provider values to the nearest documented contract", () => {
  const sora = normalizeVideoRequest({
    model: "sora-2",
    size: "adaptive",
    seconds: 7,
    resolution: "720p",
    generateAudio: true,
    watermark: true,
  });
  assert.equal(sora.size, "1280x720");
  assert.equal(sora.seconds, 8);
  assert.equal(sora.resolution, "720p");
  assert.equal(sora.generateAudio, undefined);
  assert.equal(sora.watermark, undefined);
});

test("keeps generic workbench duration input until the provider boundary", () => {
  assert.equal(normalizeVideoRequest({ model: "grok-imagine/text-to-video", seconds: 1 }).seconds, 1);
  assert.equal(normalizeVideoRequest({ model: "MiniMax-Hailuo-2.3", seconds: 7 }).seconds, 6);
  assert.equal(normalizeVideoRequest({ model: "MiniMax-Hailuo-02", seconds: 5 }).seconds, 5);
  assert.equal(normalizeVideoRequest({ model: "veo-3.1-generate-preview", seconds: 4 }).seconds, 4);
  assert.equal(normalizeVideoRequest({ model: "wan2-6-image-to-video", seconds: 7 }).seconds, 7);
  assert.equal(normalizeVideoRequest({ model: "wan2-6", seconds: 7 }).seconds, 5);
  assert.equal(normalizeVideoRequest({ model: "custom-video-provider", seconds: 99 }).seconds, 30);
});

test("normalizes provider duration only at the creation submission boundary", () => {
  assert.equal(normalizeVideoRequest({ model: "grok-imagine/text-to-video", seconds: 1 }).seconds, 1);
  assert.equal(normalizeVideoSubmissionSeconds("grok-imagine/text-to-video", 1), 6);
  assert.equal(normalizeVideoSubmissionSeconds("MiniMax-H3", 2), 4);
  assert.equal(normalizeVideoSubmissionSeconds("kling-v2-6", 7), 5);
  assert.equal(normalizeVideoSubmissionSeconds("kling-2.6/text-to-video", 7), 7);
  assert.equal(normalizeVideoSubmissionSeconds("kling/v2-1-pro", 7), 7);
  assert.equal(normalizeVideoSubmissionSeconds("CogVideoX-3", 6), 5);
  assert.equal(normalizeVideoSubmissionSeconds("CogVideoX-3", 9), 10);
  assert.equal(normalizeVideoSubmissionSeconds("veo3.1", 4), 8);
  assert.equal(normalizeVideoSubmissionSeconds("veo3.1-official", 6), 8);
  assert.equal(normalizeVideoSubmissionSeconds("veo-3.1-generate-preview", 4), 8);
  assert.equal(videoSubmissionIncludesSeconds("gemini-omni-flash-preview"), false);
  assert.equal(videoSubmissionIncludesSeconds("kling-2.6/motion-control"), false);
  assert.equal(videoSubmissionIncludesSeconds("kling-v3-motion-control"), false);
  assert.equal(videoSubmissionIncludesSeconds("omni-flash-ext"), true);
});

test("matches the reference workbench Seedance smart-duration submission", () => {
  assert.equal(normalizeVideoSubmissionSeconds("bytedance/seedance-2", -1), 1);
  assert.equal(normalizeVideoSubmissionSeconds("doubao-seedance-2-5", -1), 1);
  assert.equal(normalizeVideoSubmissionSeconds("doubao-seedance-1-0", 1), 4);
  assert.equal(normalizeVideoSubmissionSeconds("doubao-seedance-1-0", -1), 1);
  assert.equal(normalizeVideoSubmissionSeconds("bytedance/seedance-1.5-pro", 15), 15);
});

test("Kling 3.0 Turbo keeps the generic workbench 1-30 second range", () => {
  assert.equal(normalizeVideoSubmissionSeconds("kling-3-0-turbo", 20), 20);
  assert.equal(normalizeVideoSubmissionSeconds("kling-3-0-turbo", 30), 30);
});

test("preserves smart duration while normalizing persisted video seconds", () => {
  assert.equal(normalizeStoredVideoSeconds(-1), -1);
  assert.equal(normalizeStoredVideoSeconds(0), 1);
  assert.equal(normalizeStoredVideoSeconds(99), 60);
  assert.equal(normalizeStoredVideoSeconds("invalid"), undefined);
});

test("switches multimodal references to reference mode and applies limits", () => {
  const request = normalizeVideoRequest({
    model: "MiniMax-H3",
    size: "16:9",
    seconds: 9,
    resolution: "invalid",
    referenceMode: "first-frame",
    referenceImageURLs: Array.from({ length: 10 }, (_, index) => `https://cdn.example.com/${index}.png`),
    referenceVideoURLs: Array.from({ length: 4 }, (_, index) => `https://cdn.example.com/${index}.mp4`),
    referenceAudioURLs: Array.from({ length: 4 }, (_, index) => `https://cdn.example.com/${index}.mp3`),
  });
  assert.equal(request.referenceMode, "reference");
  assert.equal(request.size, "16:9");
  assert.equal(request.seconds, 9);
  assert.equal(request.resolution, "768P");
  assert.equal(request.referenceImageURLs.length, 9);
  assert.equal(request.referenceVideoURLs.length, 3);
  assert.equal(request.referenceAudioURLs.length, 3);
});

test("maps MiniMax H3 manual quality and only keeps the Seedance creator watermark", () => {
  const h3 = normalizeVideoRequest({ model: "MiniMax-H3", resolution: "1440", watermark: true });
  assert.equal(h3.resolution, "768P");
  assert.equal(h3.watermark, undefined);

  const h3High = normalizeVideoRequest({ model: "MiniMax-H3", resolution: "1080", watermark: true });
  assert.equal(h3High.resolution, "2K");

  const hailuo = normalizeVideoRequest({ model: "MiniMax-Hailuo-2.3", watermark: true });
  assert.equal(hailuo.watermark, undefined);

  const seedance = normalizeVideoRequest({ model: "bytedance/seedance-2", watermark: true });
  assert.equal(seedance.watermark, true);
});

test("converts generic pixel dimensions to official aspect-ratio fields", () => {
  assert.equal(normalizeVideoRequest({ model: "MiniMax-H3", size: "1280x720", seconds: 6, resolution: "720p" }).size, "16:9");
  assert.equal(normalizeVideoRequest({ model: "veo-3.1-generate-preview", size: "720x1280", seconds: 8, resolution: "720p" }).size, "9:16");
});

test("keeps motion-control quality for provider mode mapping", () => {
  const kie = normalizeVideoRequest({ model: "kling-2.6/motion-control", resolution: "1080p" });
  assert.equal(kie.resolution, "1080p");

  const apimart = normalizeVideoRequest({ model: "kling-v2-6-motion-control", resolution: "1080p" });
  assert.equal(apimart.resolution, "1080p");
  const invalidAPIMart = normalizeVideoRequest({ model: "kling-v2-6-motion-control", resolution: "1440p" });
  assert.equal(invalidAPIMart.resolution, "1440p");
});

test("keeps workbench references until the MiniMax H3 endpoint contract is validated", () => {
  const request = normalizeVideoRequest({
    model: "minimax-h3/text-to-video",
    size: "16:9",
    referenceMode: "reference",
    referenceImageURLs: ["https://cdn.example.com/stale.png"],
    referenceVideoURLs: ["https://cdn.example.com/stale.mp4"],
    referenceAudioURLs: ["https://cdn.example.com/stale.mp3"],
  });
  assert.equal(request.referenceMode, "reference");
  assert.equal(request.size, "16:9");
  assert.deepEqual(request.referenceImageURLs, ["https://cdn.example.com/stale.png"]);
  assert.deepEqual(request.referenceVideoURLs, ["https://cdn.example.com/stale.mp4"]);
  assert.deepEqual(request.referenceAudioURLs, ["https://cdn.example.com/stale.mp3"]);
});

test("keeps MiniMax H3 first and last images in frame mode", () => {
  const firstFrame = normalizeVideoRequest({
    model: "MiniMax-H3",
    size: "16:9",
    seconds: 6,
    resolution: "768P",
    referenceImageURLs: ["https://cdn.example.com/frame.png"],
  });
  assert.equal(firstFrame.referenceMode, "first-frame");
  assert.equal(firstFrame.size, "adaptive");
  assert.deepEqual(firstFrame.referenceImageURLs, ["https://cdn.example.com/frame.png"]);

  const frames = normalizeVideoRequest({
    model: "MiniMax-H3",
    size: "16:9",
    seconds: 6,
    resolution: "768P",
    referenceImageURLs: ["https://cdn.example.com/one.png", "https://cdn.example.com/two.png"],
  });
  assert.equal(frames.referenceMode, "first-frame");
  assert.equal(frames.size, "adaptive");
  assert.deepEqual(frames.referenceImageURLs, ["https://cdn.example.com/one.png", "https://cdn.example.com/two.png"]);
});

test("keeps MiniMax H3 reference ratio and normalizes text adaptive ratio", () => {
  const reference = normalizeVideoRequest({
    model: "MiniMax-H3",
    size: "21:9",
    referenceMode: "reference",
    referenceImageURLs: ["https://cdn.example.com/reference.png"],
  });
  assert.equal(reference.referenceMode, "reference");
  assert.equal(reference.size, "21:9");

  const text = normalizeVideoRequest({ model: "MiniMax-H3", size: "adaptive" });
  assert.equal(text.referenceMode, "first-frame");
  assert.equal(text.size, "16:9");
});

test("keeps multiple KIE Grok image inputs as image-to-video assets", () => {
  const request = normalizeVideoRequest({
    model: "grok-imagine/image-to-video",
    seconds: 8,
    resolution: "1080p",
    referenceImageURLs: Array.from({ length: 10 }, (_, index) => `https://cdn.example.com/grok-${index}.png`),
  });
  assert.equal(request.referenceMode, "reference");
  assert.equal(request.referenceImageURLs.length, 9);
});

test("keeps optional Grok 1.5 image references in the unified request", () => {
  const request = normalizeVideoRequest({
    model: "grok-imagine-video-1.5",
    size: "3:2",
    seconds: 10,
    resolution: "1080p",
    referenceImageURLs: ["https://cdn.example.com/grok.png"],
  });
  assert.equal(request.referenceMode, "first-frame");
  assert.deepEqual(request.referenceImageURLs, ["https://cdn.example.com/grok.png"]);
  assert.equal(request.size, "3:2");
});

test("keeps the reference workbench image envelope for Grok2API models", () => {
  const references = Array.from(
    { length: 10 },
    (_, index) => `https://cdn.example.com/grok2api-${index}.png`,
  );
  const defaultGrok = normalizeVideoRequest({
    model: "grok-imagine-video",
    referenceImageURLs: references,
  });
  assert.equal(defaultGrok.referenceMode, "reference");
  assert.deepEqual(defaultGrok.referenceImageURLs, references.slice(0, 9));

  const grok15 = normalizeVideoRequest({
    model: "grok-imagine-video-1.5",
    referenceImageURLs: references,
  });
  assert.equal(grok15.referenceMode, "reference");
  assert.deepEqual(grok15.referenceImageURLs, references.slice(0, 9));
});

test("keeps ordinary Grok2API references out of named frame slots", () => {
  const references = Array.from(
    { length: 9 },
    (_, index) => `https://cdn.example.com/grok2api-${index}.png`,
  );
  const body = videoGenerationTaskRequestBody({
    clientTaskId: "video-grok-15",
    prompt: "animate the references",
    model: "grok-imagine-video-1.5",
    referenceImageURLs: references,
  });
  assert.deepEqual(body.reference_image_urls, references);
  assert.equal("first_frame_url" in body, false);
  assert.equal("last_frame_url" in body, false);

  const frames = videoGenerationTaskRequestBody({
    clientTaskId: "video-explicit-frames",
    prompt: "interpolate the frames",
    model: "veo-3.1-generate-preview",
    firstFrameURL: references[0],
    lastFrameURL: references[1],
  });
  assert.equal(frames.first_frame_url, references[0]);
  assert.equal(frames.last_frame_url, references[1]);
});

test("preserves two frame images for CogVideoX-3", () => {
  const request = normalizeVideoRequest({
    model: "CogVideoX-3",
    size: "1920x1080",
    seconds: 10,
    resolution: "4k",
    referenceImageURLs: ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"],
  });
  assert.equal(request.referenceMode, "first-frame");
  assert.deepEqual(request.referenceImageURLs, ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"]);
});

test("preserves reference-workbench custom controls for generic video models", () => {
  const request = normalizeVideoRequest({
    model: "custom-video-provider",
    size: "1536x864",
    seconds: 17,
    resolution: "1440",
  });
  assert.equal(request.size, "1536x864");
  assert.equal(request.seconds, 17);
  assert.equal(request.resolution, "1440p");
  assert.equal(request.generateAudio, undefined);
  assert.equal(request.watermark, undefined);
});

test("preserves generic workbench image batches instead of truncating them to frame limits", () => {
  const request = normalizeVideoRequest({
    model: "sora-2",
    prompt: "animate",
    referenceImageURLs: [
      "https://cdn.example.com/one.png",
      "https://cdn.example.com/two.png",
      "https://cdn.example.com/three.png",
    ],
  });
  assert.equal(request.referenceMode, "reference");
  assert.deepEqual(request.referenceImageURLs, [
    "https://cdn.example.com/one.png",
    "https://cdn.example.com/two.png",
    "https://cdn.example.com/three.png",
  ]);
});

test("preserves manual quality for every generic reference-workbench model", () => {
  const models = [
    "grok-imagine-video",
    "viduq1",
    "pixverse-v6",
    "skyreels-v4",
    "happyhorse/text-to-video",
    "wan2.7-i2v-plus",
    "agnes-video-2.5",
    "flux-3-video",
    "CogVideoX-3",
  ];
  for (const model of models) {
    assert.equal(normalizeVideoRequest({ model, seconds: 5, resolution: "1440p" }).resolution, "1440p", model);
  }
});

test("keeps Kling advanced controls and drops them for unrelated providers", () => {
  const controls = {
    negativePrompt: "blur",
    multiShot: true,
    shotType: "customize",
    multiPrompt: [{ prompt: "shot one", duration: 3 }],
    elementList: [{ name: "hero", references: [] }],
    characterOrientation: "image",
  };
	const kling = normalizeVideoRequest({ model: "kling-3.0/video", seconds: 5, resolution: "1080p", watermark: true, ...controls });
  assert.equal(kling.negativePrompt, undefined);
  assert.equal(kling.multiShot, true);
  assert.equal(kling.shotType, undefined);
  assert.deepEqual(kling.multiPrompt, controls.multiPrompt);
  assert.deepEqual(kling.elementList, []);
  assert.equal(kling.characterOrientation, undefined);
	assert.equal(kling.videoMode, "std");
	assert.equal(kling.resolution, undefined);
	assert.equal(kling.watermark, undefined);

	const apimart = normalizeVideoRequest({ model: "kling-v3", seconds: 5, videoMode: "4k", ...controls });
	assert.equal(apimart.negativePrompt, "blur");
	assert.equal(apimart.shotType, "customize");
	assert.equal(apimart.videoMode, "4k");

  const generic = normalizeVideoRequest({ model: "custom-video-provider", seconds: 5, ...controls });
  assert.equal(generic.negativePrompt, undefined);
  assert.equal(generic.multiShot, undefined);
  assert.equal(generic.elementList, undefined);
});

test("validates and normalizes Kling element resources like the reference workbench", () => {
  const valid = [{
    name: " hero ",
    description: " lead character ",
    references: [
      { kind: "image", url: "https://cdn.example.com/hero-front.png" },
      { kind: "video", url: "https://cdn.example.com/hero-motion.mp4" },
    ],
  }];
  assert.equal(validateVideoKlingElementList(valid), "");
  assert.deepEqual(normalizeVideoKlingElementList(valid), [{
    name: "hero",
    description: "lead character",
    references: [
      { kind: "image", url: "https://cdn.example.com/hero-front.png" },
      { kind: "video", url: "https://cdn.example.com/hero-motion.mp4" },
    ],
  }]);
  assert.equal(videoHasKlingElementReferences(valid), true);
  assert.equal(videoHasKlingElementReferences([{ name: "unused", references: [] }]), false);
  assert.match(validateVideoKlingElementList([{ ...valid[0], name: "" }]), /填写名称/);
  assert.match(validateVideoKlingElementList([{ ...valid[0], references: valid[0].references.slice(0, 1) }]), /2-4/);
  assert.match(validateVideoKlingElementList([{ ...valid[0], references: [{ kind: "image", url: "data:image/png;base64,abc" }, valid[0].references[1]] }]), /公网可访问/);
  assert.match(validateVideoKlingElementList([valid[0], valid[0], valid[0], valid[0]]), /最多支持 3/);
});

test("adds the reference workbench default shot for Kling custom multi-shot", () => {
  const kie = normalizeVideoRequest({ model: "kling-3.0/video", multiShot: true, multiPrompt: [] });
  assert.deepEqual(kie.multiPrompt, [{ prompt: "", duration: 1 }]);

  const apimart = normalizeVideoRequest({ model: "kling-v3", multiShot: true, shotType: "customize", multiPrompt: [] });
  assert.deepEqual(apimart.multiPrompt, [{ prompt: "", duration: 1 }]);
});

test("persists normalized Kling controls into the creator queue record", () => {
  const normalized = normalizeVideoRequest({
    model: "kling-3.0/video",
    size: "16:9",
    seconds: 6,
    multiShot: true,
    shotType: "customize",
    multiPrompt: [],
    negativePrompt: "stale unsupported value",
  });
  const turn = videoTurnFieldsFromNormalizedRequest(normalized);

  assert.equal(turn.videoMultiShot, true);
  assert.deepEqual(turn.videoMultiPrompt, [{ prompt: "", duration: 1 }]);
  assert.equal(turn.videoShotType, undefined);
  assert.equal(turn.videoNegativePrompt, undefined);
});

test("keeps motion-control character orientation only for motion models", () => {
  const request = normalizeVideoRequest({
    model: "kling-3.0/motion-control",
    seconds: 5,
    characterOrientation: "image",
  });
  assert.equal(request.characterOrientation, "image");
});

test("normalizes manually entered resolution numbers before submission", () => {
  const request = normalizeVideoRequest({
    model: "veo-3.1-generate-preview",
    size: "16:9",
    seconds: 8,
    resolution: "1080",
  });
  assert.equal(request.resolution, "1080p");
});

test("normalizes KIE Grok mode without adding unsupported audio controls", () => {
  const request = normalizeVideoRequest({
    model: "grok-imagine/text-to-video",
    size: "16:9",
    seconds: 30,
    resolution: "1080p",
    generateAudio: true,
    videoMode: "spicy",
  });
  assert.equal(request.seconds, 30);
  assert.equal(request.videoMode, "spicy");
  assert.equal(request.generateAudio, undefined);

  assert.equal(normalizeVideoRequest({ model: "grok-imagine/text-to-video", videoMode: "invalid" }).videoMode, "normal");
});

test("reads model capabilities from the shared contract", () => {
  assert.deepEqual(videoSizeOptions("kling-v3"), ["16:9", "9:16", "1:1"]);
  assert.ok(videoSecondsOptions("sora-2").includes(20));
  assert.deepEqual(videoResolutionOptions("MiniMax-H3"), ["768P", "2K"]);
  assert.deepEqual(videoMultimodalReferenceLimits("MiniMax-H3"), { image: 9, video: 3, audio: 3 });
  assert.deepEqual(videoMultimodalReferenceLimits("doubao-seedance-2-0-260128"), { image: 9, video: 3, audio: 3 });
});

test("keeps Seedance multimodal references in the unified request", () => {
  const request = normalizeVideoRequest({
    model: "doubao-seedance-2-0-260128",
    size: "16:9",
    seconds: 8,
    resolution: "1080p",
    referenceVideoURLs: ["https://cdn.example.com/reference.mp4"],
    referenceAudioURLs: ["https://cdn.example.com/reference.mp3"],
  });
  assert.equal(request.referenceMode, "reference");
  assert.deepEqual(request.referenceVideoURLs, ["https://cdn.example.com/reference.mp4"]);
  assert.deepEqual(request.referenceAudioURLs, ["https://cdn.example.com/reference.mp3"]);
});

test("keeps Gemini Omni workbench audio references for provider validation", () => {
  const request = normalizeVideoRequest({
    model: "gemini-omni-video",
    size: "16:9",
    seconds: 6,
    resolution: "720p",
    referenceImageURLs: ["https://cdn.example.com/reference.png"],
    referenceAudioURLs: ["https://cdn.example.com/reference.mp3"],
  });
  assert.deepEqual(request.referenceImageURLs, ["https://cdn.example.com/reference.png"]);
  assert.deepEqual(request.referenceAudioURLs, ["https://cdn.example.com/reference.mp3"]);
});

test("keeps Wan first and last frames out of reference mode", () => {
  const request = normalizeVideoRequest({
    model: "wan2.7-i2v-plus",
    seconds: 10,
    resolution: "1080p",
    referenceImageURLs: ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"],
  });
  assert.equal(request.referenceMode, "first-frame");
  assert.deepEqual(request.referenceImageURLs, ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"]);
});

test("keeps APIMart Wan 2.7 reference videos", () => {
	const request = normalizeVideoRequest({
		model: "wan2.7-i2v-plus",
		seconds: 10,
		resolution: "1080p",
		referenceImageURLs: ["https://cdn.example.com/first.png"],
		referenceVideoURLs: ["https://cdn.example.com/source.mp4"],
	});
	assert.equal(request.referenceMode, "reference");
	assert.deepEqual(request.referenceVideoURLs, ["https://cdn.example.com/source.mp4"]);
});

test("keeps Vidu workbench images until the provider boundary", () => {
  const firstTail = normalizeVideoRequest({
    model: "viduq1",
    seconds: 5,
    resolution: "1080p",
    referenceImageURLs: ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"],
  });
  assert.equal(firstTail.referenceMode, "first-frame");

  const references = normalizeVideoRequest({
    model: "viduq1",
    seconds: 5,
    resolution: "1080p",
    referenceImageURLs: ["https://cdn.example.com/1.png", "https://cdn.example.com/2.png", "https://cdn.example.com/3.png"],
  });
  assert.equal(references.referenceMode, "reference");
  assert.equal(references.referenceImageURLs.length, 3);
});

test("preserves Wan video and audio roles for provider-specific modes", () => {
	const imageToVideo = normalizeVideoRequest({
		model: "wan/2-7-image-to-video",
		seconds: 10,
		resolution: "1080p",
		referenceImageURLs: ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"],
		referenceVideoURLs: ["https://cdn.example.com/source.mp4"],
	});
	assert.equal(imageToVideo.referenceMode, "reference");
	assert.deepEqual(imageToVideo.referenceImageURLs, ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"]);
	assert.deepEqual(imageToVideo.referenceVideoURLs, ["https://cdn.example.com/source.mp4"]);

  const videoEdit = normalizeVideoRequest({
    model: "wan/2-7-videoedit",
    size: "16:9",
    seconds: 10,
    resolution: "1080p",
    referenceImageURLs: ["https://cdn.example.com/style.png"],
    referenceVideoURLs: ["https://cdn.example.com/source.mp4"],
  });
  assert.equal(videoEdit.referenceMode, "reference");
  assert.deepEqual(videoEdit.referenceImageURLs, ["https://cdn.example.com/style.png"]);
  assert.deepEqual(videoEdit.referenceVideoURLs, ["https://cdn.example.com/source.mp4"]);

  const r2v = normalizeVideoRequest({
    model: "wan/2-7-r2v",
    size: "9:16",
    seconds: 5,
    resolution: "720p",
    referenceImageURLs: ["https://cdn.example.com/character.png"],
    referenceVideoURLs: ["https://cdn.example.com/motion.mp4"],
    referenceAudioURLs: ["https://cdn.example.com/voice.mp3"],
  });
  assert.equal(r2v.referenceMode, "reference");
  assert.equal(r2v.referenceAudioURLs.length, 1);
});

test("keeps HappyHorse workbench video inputs for provider validation", () => {
	const request = normalizeVideoRequest({
		model: "happyhorse/reference-to-video",
		referenceMode: "reference",
		referenceImageURLs: ["https://cdn.example.com/character.png"],
		referenceVideoURLs: ["https://cdn.example.com/ignored.mp4"],
	});
	assert.deepEqual(request.referenceImageURLs, ["https://cdn.example.com/character.png"]);
	assert.deepEqual(request.referenceVideoURLs, ["https://cdn.example.com/ignored.mp4"]);
});

test("forces Veo to eight seconds only for quality and reference modes that require it", () => {
  const highResolution = normalizeVideoRequest({
    model: "veo-3.1-generate-preview",
    size: "16:9",
    seconds: 6,
    resolution: "4k",
  });
  assert.equal(highResolution.seconds, 8);

  const imageToVideo = normalizeVideoRequest({
    model: "veo-3.1-generate-preview",
    size: "16:9",
    seconds: 4,
    resolution: "720p",
    referenceImageURLs: ["https://cdn.example.com/frame.png"],
  });
  assert.equal(imageToVideo.seconds, 8);

  const plain720p = normalizeVideoRequest({
    model: "veo-3.1-generate-preview",
    size: "16:9",
    seconds: 6,
    resolution: "720p",
  });
  assert.equal(plain720p.seconds, 6);

  const explicitFrames = normalizeVideoRequest({
    model: "veo-3.1-generate-preview",
    size: "16:9",
    seconds: 4,
    resolution: "720p",
    firstFrameURL: "https://cdn.example.com/first.png",
    lastFrameURL: "https://cdn.example.com/last.png",
  });
  assert.equal(explicitFrames.seconds, 8);
});

test("normalizes manual Veo quality to official provider values", () => {
  assert.equal(normalizeVideoRequest({ model: "veo-3.1-generate-preview", resolution: "1440p" }).resolution, "720p");
  assert.equal(normalizeVideoRequest({ model: "veo-3.1-generate-preview", resolution: "2k" }).resolution, "1080p");
  assert.equal(normalizeVideoRequest({ model: "veo-3.1-generate-preview", resolution: "4k" }).resolution, "4k");
  assert.equal(normalizeVideoRequest({ model: "veo-3-generate-preview", resolution: "4k" }).resolution, "1080p");
});

test("keeps Veo 3.1 frame and asset reference roles separate", () => {
  const frames = normalizeVideoRequest({
    model: "veo-3.1-generate-preview",
    seconds: 4,
    resolution: "720p",
    referenceMode: "first-frame",
    referenceImageURLs: ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"],
  });
  assert.equal(frames.referenceMode, "first-frame");
  assert.equal(frames.seconds, 8);
  assert.deepEqual(frames.referenceImageURLs, ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"]);

  const assets = normalizeVideoRequest({
    model: "veo-3.1-generate-preview",
    seconds: 4,
    resolution: "720p",
    referenceMode: "reference",
    referenceImageURLs: [
      "https://cdn.example.com/one.png",
      "https://cdn.example.com/two.png",
      "https://cdn.example.com/three.png",
    ],
  });
  assert.equal(assets.referenceMode, "reference");
  assert.equal(assets.seconds, 8);
  assert.equal(assets.referenceImageURLs.length, 3);
});

test("matches reference-workbench video material combination errors", () => {
  assert.equal(videoReferenceCombinationError({
    model: "veo-3.1-generate-preview",
    lastFrameURL: "https://cdn.example.com/last.png",
  }), "请先添加首帧图片");
  assert.equal(videoReferenceCombinationError({
    model: "veo-3.1-generate-preview",
    firstFrameURL: "https://cdn.example.com/first.png",
    referenceMode: "reference",
    referenceImageURLs: ["https://cdn.example.com/reference.png"],
  }), "首尾帧模式不能与普通参考图同时使用");
  assert.equal(videoReferenceCombinationError({
    model: "veo-3-generate-preview",
    referenceMode: "reference",
    referenceImageURLs: ["https://cdn.example.com/reference.png"],
  }), "当前 Veo 模型不支持尾帧或普通参考图");
  assert.equal(videoReferenceCombinationError({
    model: "veo-3.1-generate-preview",
    referenceMode: "reference",
    referenceImageURLs: Array.from({ length: 4 }, (_, index) => `https://cdn.example.com/${index}.png`),
  }), "Veo 3.1 参考图最多 3 张");
  assert.equal(videoReferenceCombinationError({
    model: "veo-3.1-generate-preview",
    referenceVideoURLs: ["https://cdn.example.com/reference.mp4"],
  }), "Gemini Veo 不支持普通参考视频，请移除后重试");
  assert.equal(videoReferenceCombinationError({
    model: "Agnes-Video-2.5",
    firstFrameURL: "https://cdn.example.com/first.png",
    ordinaryReferenceImageCount: 1,
  }), "Agnes Video 2.5 的首尾帧不能和普通参考素材同时使用");
  assert.equal(videoReferenceCombinationError({
    model: "MiniMax-H3",
    referenceMode: "reference",
    referenceAudioURLs: ["https://cdn.example.com/reference.mp3"],
  }), "MiniMax H3 参考音频需要同时提供参考图片或参考视频");
  assert.equal(videoReferenceCombinationError({
    model: "CogVideoX-3",
    referenceAudioURLs: ["https://cdn.example.com/reference.mp3"],
  }), "CogVideoX-3 不支持参考视频或参考音频");
});

test("persists explicit frame slots separately from ordinary reference images", () => {
  const request = normalizeVideoRequest({
    model: "veo-3.1-generate-preview",
    size: "16:9",
    seconds: 8,
    resolution: "720p",
    referenceMode: "reference",
    firstFrameURL: "https://cdn.example.com/first.png",
    lastFrameURL: "https://cdn.example.com/last.png",
    referenceImageURLs: ["https://cdn.example.com/reference.png"],
  });
  assert.equal(request.firstFrameURL, "https://cdn.example.com/first.png");
  assert.equal(request.lastFrameURL, "https://cdn.example.com/last.png");
  assert.deepEqual(request.referenceImageURLs, ["https://cdn.example.com/reference.png"]);

  const turn = videoTurnFieldsFromNormalizedRequest(request);
  assert.equal(turn.videoFirstFrameURL, request.firstFrameURL);
  assert.equal(turn.videoLastFrameURL, request.lastFrameURL);
  assert.deepEqual(turn.videoReferenceImageURLs, request.referenceImageURLs);

  const staleReferenceMode = normalizeVideoRequest({
    model: "veo-3.1-generate-preview",
    referenceMode: "reference",
    firstFrameURL: "https://cdn.example.com/first.png",
    lastFrameURL: "https://cdn.example.com/last.png",
  });
  assert.equal(staleReferenceMode.referenceMode, "first-frame");
});

test("composes only the video system prompt and current user prompt", () => {
  assert.equal(
    composeVideoPrompt("镜头向前推进", "保持电影感"),
    "保持电影感\n\n镜头向前推进",
  );
  assert.equal(composeVideoPrompt("镜头向前推进", ""), "镜头向前推进");
});
