import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VIDEO_MODEL,
  canonicalVideoModel,
  videoAudioControl,
  videoAudioGenerationDisabled,
  videoComposerAspectRatio,
  videoComposerPixelLabel,
  videoComposerSizeDescription,
  videoComposerSizeLabel,
  videoComposerWatermarkSupported,
  videoDefaultResolution,
  videoDefaultSeconds,
  videoDefaultSize,
  videoDurationSupported,
	videoAllowsCustomDimensions,
	videoAllowsCustomDuration,
	videoAllowsCustomResolution,
  supportsVideoMultimodalReferences,
  supportsVideoFrameReferences,
  videoMultimodalReferenceLimits,
  videoModelProfile,
  videoReferenceImageLimit,
  videoRequiresReferenceImage,
  videoRequiresReferenceVideo,
  videoResolutionIsValid,
  videoResolutionOptions,
  videoSecondsIsValid,
  videoWorkbenchDisplayResolution,
  videoWorkbenchDisplaySeconds,
  videoWorkbenchDisplaySize,
  videoWorkbenchMaterialSections,
  videoWorkbenchReferenceLimits,
  videoWorkbenchResolutionInputValue,
  videoWorkbenchValidatesReferenceVideoMetadata,
  videoWorkbenchRatioForSize,
  videoWorkbenchResolutionOptions,
  videoSecondsOptions,
  videoSizeIsValid,
  videoSizeOptions,
  videoWorkbenchResolutionForSize,
	videoWorkbenchSecondsOptions,
  videoWorkbenchResolutionForModelSize,
  videoWorkbenchSizeForResolution,
  videoWorkbenchSizeForModelResolution,
  videoWatermarkSupported,
	supportsKlingMode,
	supportsKlingMultiShot,
	supportsKlingNegativePrompt,
	usesReferenceSpecialVideoPanel,
} from "../src/lib/video-model-capabilities.ts";

test("uses the reference workbench default video model", () => {
  assert.equal(DEFAULT_VIDEO_MODEL, "grok-imagine-video");
});

test("reference project aliases resolve to one canonical model contract", () => {
  assert.equal(canonicalVideoModel("kling/text-to-video"), "kling-2.6/text-to-video");
  assert.equal(canonicalVideoModel("kling/v25-turbo-image-to-video-pro"), "kling/v2-5-turbo-image-to-video-pro");
  assert.equal(canonicalVideoModel("grok-imagine-1.5-video"), "grok-imagine-video-1-5-preview");
  assert.equal(videoModelProfile("kling/text-to-video"), "kling-kie-26");
  assert.equal(videoModelProfile("bytedance/seedance-1-5-pro"), "seedance-15");
});

test("reference project KIE model IDs resolve to functional video profiles", () => {
  assert.equal(videoModelProfile("kling/v2-1-pro"), "kling-kie-legacy");
  assert.equal(videoModelProfile("kling/ai-avatar-pro"), "kling-avatar");
  assert.equal(videoModelProfile("grok-imagine/image-to-video"), "grok-i2v");
  assert.equal(videoModelProfile("grok-imagine/text-to-video"), "grok-kie");
  assert.deepEqual(videoSecondsOptions("grok-imagine/text-to-video"), Array.from({ length: 25 }, (_, index) => index + 6));
  assert.equal(videoAudioControl("grok-imagine/text-to-video"), "none");
  assert.equal(videoModelProfile("wan/2-2-a14b-speech-to-video-turbo"), "wan-speech");
  assert.equal(videoModelProfile("wan/2-2-animate-move"), "wan-animate");
  assert.equal(videoModelProfile("bytedance/v1-pro-image-to-video"), "bytedance-v1-i2v");
  assert.equal(videoModelProfile("bytedance/seedance-2"), "seedance-20");
  assert.equal(videoModelProfile("kling/v3-turbo-text-to-video"), "kling-kie-v3");
  assert.equal(videoModelProfile("kling-2.6/image-to-video"), "kling-kie-26");
  assert.deepEqual(videoSecondsOptions("kling-2.6/image-to-video"), [5, 10]);
  assert.equal(videoAudioControl("kling-2.6/image-to-video"), "toggle");
  assert.equal(videoReferenceImageLimit("kling-2.6/image-to-video"), 2);
  assert.equal(videoReferenceImageLimit("kling/v3-turbo-image-to-video"), 2);
  assert.deepEqual(videoSecondsOptions("kling/v3-turbo-text-to-video"), Array.from({ length: 30 }, (_, index) => index + 1));
	assert.equal(videoSizeIsValid("kling/v3-turbo-text-to-video", "16:9"), true);
	assert.equal(videoSizeIsValid("kling/v3-turbo-text-to-video", "1536x864"), true);
  assert.deepEqual(videoResolutionOptions("hailuo/02-text-to-video-standard"), []);
  assert.deepEqual(videoSecondsOptions("hailuo/02-text-to-video-standard"), [5, 10]);
  assert.equal(videoDefaultSeconds("hailuo/02-text-to-video-standard"), 5);
  assert.deepEqual(videoResolutionOptions("hailuo/02-image-to-video-standard"), ["768P", "1080P"]);
  assert.equal(videoReferenceImageLimit("kling/v3-turbo-image-to-video"), 2);
  assert.equal(videoReferenceImageLimit("kling/v3-turbo-text-to-video"), 0);
  assert.equal(videoReferenceImageLimit("grok-imagine/text-to-video"), 0);
  assert.equal(videoReferenceImageLimit("grok-imagine/image-to-video"), 9);
  assert.deepEqual(videoMultimodalReferenceLimits("grok-imagine/image-to-video"), { image: 9, video: 0, audio: 0 });
  assert.equal(videoReferenceImageLimit("minimax-h3/text-to-video"), 0);
  assert.equal(supportsVideoMultimodalReferences("minimax-h3/text-to-video"), false);
  assert.equal(videoReferenceImageLimit("minimax-h3/image-to-video"), 2);
  assert.equal(videoReferenceImageLimit("minimax-h3/reference-to-video"), 0);
  assert.deepEqual(videoMultimodalReferenceLimits("minimax-h3/reference-to-video"), { image: 9, video: 3, audio: 3 });
  assert.equal(videoReferenceImageLimit("happyhorse/text-to-video"), 0);
  assert.equal(supportsVideoMultimodalReferences("happyhorse/text-to-video"), false);
  assert.equal(videoReferenceImageLimit("happyhorse/image-to-video"), 9);
  assert.equal(supportsVideoMultimodalReferences("happyhorse/image-to-video"), false);
  assert.equal(videoReferenceImageLimit("happyhorse-1-1/image-to-video"), 1);
  assert.deepEqual(videoMultimodalReferenceLimits("happyhorse/reference-to-video"), { image: 9, video: 0, audio: 0 });
  assert.equal(videoReferenceImageLimit("wan/2-7-image-to-video"), 2);
  assert.equal(videoReferenceImageLimit("bytedance/seedance-1.5-pro"), 9);
  assert.deepEqual(videoMultimodalReferenceLimits("wan/2-2-a14b-image-to-video-turbo"), { image: 0, video: 0, audio: 0 });
  assert.deepEqual(videoMultimodalReferenceLimits("wan/2-2-a14b-text-to-video-turbo"), { image: 0, video: 0, audio: 0 });
  assert.equal(videoWatermarkSupported("wan/2-5-image-to-video"), false);
  assert.equal(videoWatermarkSupported("wan/2-6-image-to-video"), false);
  assert.equal(videoModelProfile("wan/2-7-text-to-video"), "wan-kie-t2v");
});

test("manual quality remains visible and provider adapters normalize it", () => {
  assert.equal(videoResolutionIsValid("bytedance/v1-pro-image-to-video", "1440p", 8), true);
  assert.equal(videoResolutionIsValid("grok-imagine/image-to-video", "1440p", 8), true);
  assert.equal(videoResolutionIsValid("seedance-2.0", "1440p", 8), false);
	assert.equal(videoResolutionIsValid("kling/v3-turbo-text-to-video", "1440p", 8), true);
	assert.equal(videoAllowsCustomResolution("MiniMax-Hailuo-2.3"), true);
	assert.equal(videoAllowsCustomResolution("wan2.7-i2v-plus"), true);
	assert.equal(videoAllowsCustomResolution("viduq1"), true);
	assert.equal(videoAllowsCustomResolution("kling/v3-turbo-text-to-video"), true);
	assert.equal(videoAllowsCustomResolution("kling/v3-turbo-image-to-video"), true);
	assert.equal(videoAllowsCustomResolution("kling-2.6/text-to-video"), true);
});

test("official provider profiles expose their documented controls", () => {
  assert.equal(videoModelProfile("grok-imagine-video-1.5"), "grok-15");
  assert.deepEqual(videoResolutionOptions("grok-imagine-video"), ["480p", "720p"]);
  assert.deepEqual(videoResolutionOptions("grok-imagine-video-1.5"), ["480p", "720p", "1080p"]);
  assert.deepEqual(videoSecondsOptions("grok-imagine-video-1.5"), Array.from({ length: 15 }, (_, i) => i + 1));

  assert.equal(videoModelProfile("kling-v3"), "kling-3");
  assert.deepEqual(videoSecondsOptions("kling-v3").slice(0, 3), [3, 4, 5]);
  assert.deepEqual(videoSizeOptions("kling-v3"), ["16:9", "9:16", "1:1"]);
  assert.deepEqual(videoResolutionOptions("kling-v3"), ["720p", "1080p", "4k"]);
  assert.equal(videoAudioControl("kling-v3"), "toggle");
  assert.equal(videoWatermarkSupported("kling-v3"), false);
  assert.equal(videoComposerWatermarkSupported("kling-v3"), false);
  assert.equal(videoResolutionIsValid("custom-video-provider", "1440p"), true);
  assert.equal(videoResolutionIsValid("veo-3.1-generate-preview", "1080"), true);
  assert.equal(videoResolutionIsValid("veo-3.1-generate-preview", "1440"), true);

  for (const model of [
    "MiniMax-Hailuo-2.3",
    "grok-imagine-video",
    "viduq1",
    "pixverse-v6",
    "skyreels-v4",
    "happyhorse/text-to-video",
    "wan2.7-i2v-plus",
    "agnes-video-2.5",
    "flux-3-video",
    "CogVideoX-3",
  ]) {
    assert.equal(videoResolutionIsValid(model, "1440p", 5), true, `${model} keeps the reference project's manual quality field`);
  }

  assert.equal(videoModelProfile("MiniMax-Hailuo-2.3"), "minimax-hailuo");
  assert.deepEqual(videoSizeOptions("MiniMax-Hailuo-2.3"), []);
  assert.deepEqual(videoResolutionOptions("MiniMax-Hailuo-2.3"), ["768P", "1080P"]);
  assert.deepEqual(videoResolutionOptions("MiniMax-Hailuo-2.3", 10), ["768P"]);
  assert.equal(videoResolutionIsValid("MiniMax-Hailuo-2.3", "1080", 10), false);
  assert.equal(videoRequiresReferenceImage("MiniMax-Hailuo-2.3-Fast"), true);
  assert.equal(videoModelProfile("MiniMax-H3"), "minimax-h3");
  assert.deepEqual(videoResolutionOptions("MiniMax-H3"), ["768P", "2K"]);
  assert.deepEqual(videoSizeOptions("MiniMax-H3"), ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"]);
  assert.equal(videoReferenceImageLimit("MiniMax-H3"), 2);
  assert.equal(supportsVideoMultimodalReferences("MiniMax-H3"), true);
  assert.deepEqual(videoMultimodalReferenceLimits("MiniMax-H3"), { image: 9, video: 3, audio: 3 });
  assert.equal(supportsVideoMultimodalReferences("kling-v3"), false);
  assert.equal(videoWatermarkSupported("MiniMax-H3"), false);
  assert.equal(videoComposerWatermarkSupported("MiniMax-Hailuo-2.3"), false);

  assert.equal(videoModelProfile("sora-2"), "sora");
  assert.equal(videoModelProfile("sora-2-pro"), "sora-pro");
  assert.deepEqual(videoSecondsOptions("sora-2"), [4, 8, 12, 16, 20]);
  assert.deepEqual(videoSizeOptions("sora-2"), ["1280x720", "720x1280"]);
  assert.equal(videoComposerAspectRatio("1280x720"), "1280:720");
  assert.equal(videoComposerAspectRatio("720x1280"), "720:1280");
  assert.equal(videoComposerSizeDescription("sora-2", "", "1280x720"), undefined);
  assert.equal(videoComposerSizeDescription("kling-v3", "1080p", "16:9"), "1280x720");
  assert.equal(videoComposerSizeDescription("kling-v3", "1080p", "9:16"), "720x1280");
  assert.equal(videoComposerSizeDescription("kling-v3", "1080p", "1:1"), "960x960");
  assert.deepEqual(videoSizeOptions("sora-2-pro"), ["1280x720", "720x1280", "1792x1024", "1024x1792", "1920x1080", "1080x1920"]);
  assert.deepEqual(videoResolutionOptions("sora-2-pro"), []);
  assert.deepEqual(videoWorkbenchResolutionOptions("sora-2"), ["720p", "480p"]);
  assert.deepEqual(videoResolutionOptions("kling-v2-6-motion-control"), ["720p", "1080p"]);
	assert.deepEqual(videoWorkbenchResolutionOptions("kling-v2-6-motion-control"), ["720p", "480p"]);
	assert.equal(videoAllowsCustomResolution("kling-v2-6-motion-control"), true);
	assert.deepEqual(videoWorkbenchResolutionOptions("kling-2.6/motion-control"), ["720p", "480p"]);
  assert.equal(videoModelProfile("CogVideoX-3"), "cogvideox-3");
  assert.deepEqual(videoSecondsOptions("CogVideoX-3"), [5, 10]);
  assert.equal(videoSecondsIsValid("CogVideoX-3", 6), false);
  assert.equal(videoSecondsIsValid("CogVideoX-3", 10), true);
  assert.equal(videoAllowsCustomDuration("CogVideoX-3"), false);
  assert.equal(videoAllowsCustomDuration("kling-v2-6"), false);
  assert.equal(videoAllowsCustomDuration("kling-2.6/text-to-video"), true);
  assert.equal(videoAudioControl("CogVideoX-3"), "toggle");
  assert.equal(videoReferenceImageLimit("kling-v3"), 2);

  assert.equal(videoDefaultSeconds("grok-imagine-video-1.5"), 6);
  assert.equal(videoDefaultSeconds("doubao-seedance-2-5-260628"), 5);
  assert.equal(videoDefaultResolution("doubao-seedance-2-5-260628", 5), "720p");
  assert.equal(videoDefaultSize("doubao-seedance-2-5-260628"), "adaptive");

  assert.equal(videoWorkbenchSizeForResolution("1080p", "1280x720"), "1920x1080");
  assert.equal(videoWorkbenchSizeForResolution("720p", "720x1280"), "720x1280");
  assert.equal(videoWorkbenchSizeForResolution("4k", "auto"), "auto");
  assert.equal(videoWorkbenchResolutionForSize("1920x1080", "720p"), "1080p");
  assert.equal(videoWorkbenchSizeForModelResolution("CogVideoX-3", "4k", "1280x720"), "3840x2160");
  assert.equal(videoWorkbenchSizeForModelResolution("CogVideoX-3", "1080p", "720x1280"), "1080x1920");
  assert.equal(videoWorkbenchResolutionForModelSize("CogVideoX-3", "2048x1080", "720p"), "2k");
  assert.equal(videoWorkbenchSizeForModelResolution("sora-2-pro", "1080p", "1280x720"), "1920x1080");
  assert.equal(videoWorkbenchResolutionForModelSize("sora-2-pro", "1920x1080", "720p"), "1080p");

  assert.equal(videoModelProfile("doubao-seedance-2-5-260628"), "seedance-25");
  assert.equal(videoSecondsOptions("doubao-seedance-2-5-260628")[0], -1);
  assert.equal(videoSecondsOptions("doubao-seedance-2-5-260628").at(-1), 30);
  assert.equal(videoSecondsIsValid("doubao-seedance-2-5-260628", 30), false);
  assert.equal(videoSecondsIsValid("doubao-seedance-1-0-260128", -1), true);
  assert.deepEqual(videoWorkbenchSecondsOptions("doubao-seedance-1-0-260128"), [-1, 4, 5, 6, 8, 10, 12, 15]);
  assert.deepEqual(videoResolutionOptions("doubao-seedance-2-0-260128"), ["480p", "720p", "1080p", "4k"]);
  assert.deepEqual(videoSizeOptions("doubao-seedance-2-0-260128"), ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"]);
  assert.equal(videoComposerSizeLabel("4:3"), "标准横屏");
  assert.equal(videoComposerPixelLabel("1080p", "16:9"), "1920x1080");
  assert.equal(videoComposerPixelLabel("1080", "16:9"), "1920x1080");
  assert.equal(videoComposerSizeDescription("doubao-seedance-2-0-260128", "1080p", "16:9"), "1920x1080");
  assert.equal(supportsVideoMultimodalReferences("doubao-seedance-2-0-260128"), true);
  assert.deepEqual(videoMultimodalReferenceLimits("doubao-seedance-2-0-260128"), { image: 9, video: 3, audio: 3 });
  assert.equal(videoModelProfile("doubao-seedance-2-0-fast-260128"), "seedance-20-fast");
  assert.deepEqual(videoResolutionOptions("doubao-seedance-2-0-fast-260128"), ["480p", "720p"]);
  assert.deepEqual(videoWorkbenchResolutionOptions("doubao-seedance-2-0-fast-260128"), ["480p", "720p", "1080p"]);
  assert.deepEqual(videoWorkbenchSecondsOptions("doubao-seedance-2-0-fast-260128"), [-1, 4, 5, 6, 8, 10, 12, 15]);
  assert.equal(videoModelProfile("doubao-seedance-2-0-mini-260128"), "seedance-20-mini");
  assert.equal(videoModelProfile("doubao-seedance-future"), "seedance-20");
  assert.deepEqual(videoSizeOptions("doubao-seedance-future"), ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"]);
  assert.equal(videoSizeIsValid("doubao-seedance-future", "adaptive"), true);
  assert.deepEqual(videoWorkbenchResolutionOptions("doubao-seedance-future"), ["480p", "720p", "1080p"]);
  assert.equal(videoAudioControl("doubao-seedance-2-5-260628"), "toggle");
	assert.equal(videoComposerWatermarkSupported("doubao-seedance-2-5-260628"), true);
	assert.equal(videoComposerWatermarkSupported("bytedance/seedance-2"), true);
	assert.equal(usesReferenceSpecialVideoPanel("bytedance/seedance-2"), true);
  assert.equal(supportsVideoMultimodalReferences("doubao-seedance-2-5-260628"), true);

  assert.equal(videoModelProfile("veo-3.1-generate-preview"), "veo-31");
  assert.deepEqual(videoSizeOptions("veo-3.1-generate-preview"), ["16:9", "9:16"]);
  assert.deepEqual(videoResolutionOptions("veo-3.1-generate-preview"), ["720p", "1080p", "4k"]);
  assert.equal(videoAudioControl("veo-3.1-generate-preview"), "none");
  assert.equal(videoModelProfile("agnes-video-2.5"), "agnes-25");
  assert.equal(videoModelProfile("agnes-video"), "agnes");
  assert.equal(videoReferenceImageLimit("veo-3.1-generate-preview"), 2);
  assert.equal(supportsVideoMultimodalReferences("veo-3.1-generate-preview"), true);
  assert.deepEqual(videoMultimodalReferenceLimits("veo-3.1-generate-preview"), { image: 3, video: 0, audio: 0 });

  assert.equal(videoModelProfile("wan2.7-i2v-plus"), "wan-27-i2v");
  assert.equal(videoAudioControl("wan2.7-i2v-plus"), "none");
  assert.equal(videoAudioControl("wan2-6-video-to-video"), "none");
  assert.equal(videoAudioControl("wan2-6-flash-video-to-video"), "none");
  assert.equal(videoAudioControl("wan2-6-flash-text-to-video"), "none");
  assert.equal(videoAudioControl("wan/2-6-video-to-video"), "none");
  assert.equal(videoAudioControl("wan/2-6-flash-video-to-video"), "toggle");
  assert.equal(videoAudioControl("kling-text-to-video"), "toggle");
  assert.equal(videoAudioControl("kling-image-to-video"), "toggle");
  assert.equal(videoSecondsIsValid("grok-imagine/text-to-video", 1), true);
  assert.equal(videoSecondsIsValid("grok-imagine/text-to-video", 31), false);
  assert.equal(videoSecondsIsValid("doubao-seedance-2-5-260628", -1), true);
  assert.equal(videoSecondsIsValid("doubao-seedance-2-5-260628", 15), true);
  assert.equal(videoSecondsIsValid("doubao-seedance-2-5-260628", 30), false);
  assert.equal(supportsKlingMode("kling-3.0-omni/text-to-video"), true);
  assert.equal(supportsKlingMode("kling-3.0-omni/reference-to-video"), true);
  assert.deepEqual(videoResolutionOptions("wan2.7-i2v-plus"), ["480p", "720p", "1080p"]);
  assert.equal(videoReferenceImageLimit("wan2.7-i2v-plus"), 2);
  assert.equal(videoRequiresReferenceImage("wan2.7-i2v-plus"), false);
  assert.deepEqual(videoMultimodalReferenceLimits("wan2.7-i2v-plus"), { image: 2, video: 3, audio: 1 });

  assert.equal(videoModelProfile("wan/2-7-image-to-video"), "wan-27-kie-i2v");
	assert.deepEqual(videoMultimodalReferenceLimits("wan/2-7-image-to-video"), { image: 2, video: 1, audio: 1 });
  assert.equal(videoModelProfile("wan/2-7-r2v"), "wan-27-r2v");
  assert.deepEqual(videoMultimodalReferenceLimits("wan/2-7-r2v"), { image: 9, video: 3, audio: 1 });
  assert.equal(videoRequiresReferenceImage("wan/2-7-r2v"), false);
  assert.equal(videoRequiresReferenceVideo("wan/2-7-r2v"), false);
  assert.equal(videoRequiresReferenceImage("kling-2.6/motion-control"), true);
  assert.equal(videoRequiresReferenceVideo("kling-2.6/motion-control"), true);
  assert.equal(videoModelProfile("wan/2-7-videoedit"), "wan-videoedit");
  assert.deepEqual(videoMultimodalReferenceLimits("wan/2-7-videoedit"), { image: 1, video: 1, audio: 0 });
  assert.equal(videoModelProfile("wan/2-6-video-to-video"), "wan-v2v");
  assert.deepEqual(videoMultimodalReferenceLimits("wan/2-6-video-to-video"), { image: 0, video: 1, audio: 0 });
  assert.equal(videoReferenceImageLimit("wan/2-6-video-to-video"), 0);

  assert.equal(videoModelProfile("wan2.6-t2v"), "wan-t2v");
  assert.equal(videoAudioControl("wan2.6-t2v"), "none");
  assert.deepEqual(videoSizeOptions("wan2.6-t2v").slice(0, 3), ["832x480", "480x832", "624x624"]);
  assert.deepEqual(videoResolutionOptions("wan2.6-t2v"), []);

  assert.equal(videoModelProfile("viduq1"), "vidu");
  assert.equal(videoReferenceImageLimit("viduq1"), 2);
  assert.deepEqual(videoMultimodalReferenceLimits("viduq1"), { image: 0, video: 0, audio: 0 });
  assert.equal(supportsVideoMultimodalReferences("viduq1"), false);
  assert.equal(videoModelProfile("viduq3"), "vidu-q3");
  assert.equal(videoRequiresReferenceImage("viduq3"), true);

  assert.equal(videoModelProfile("jimeng_v30"), "jimeng");
  assert.deepEqual(videoSecondsOptions("jimeng_v30"), [5, 10]);
  assert.deepEqual(videoSizeOptions("jimeng_v30"), ["16:9", "9:16", "1:1", "4:3", "3:4"]);

  assert.equal(videoModelProfile("kling-3.0-omni/reference-to-video"), "kling-omni-reference");
  assert.deepEqual(videoMultimodalReferenceLimits("kling-3.0-omni/reference-to-video"), { image: 9, video: 1, audio: 0 });
  assert.equal(videoModelProfile("kling-2.6/motion-control"), "kling-motion");
  assert.deepEqual(videoMultimodalReferenceLimits("kling-2.6/motion-control"), { image: 1, video: 1, audio: 0 });
  assert.equal(videoModelProfile("gemini-omni-video"), "gemini-omni");
  assert.equal(videoModelProfile("pixverse-v6"), "pixverse");
  assert.equal(videoModelProfile("skyreels-v4"), "skyreels");
  assert.equal(videoModelProfile("happyhorse/video-edit"), "happyhorse");
  assert.equal(videoModelProfile("infinitalk/from-audio"), "infinitalk");
  assert.equal(videoModelProfile("topaz/video-upscale"), "topaz-video");
  assert.equal(videoModelProfile("flux-3-video"), "flux-3-video");
  assert.deepEqual(videoResolutionOptions("flux-3-video"), ["720p", "1080p"]);
  assert.equal(videoModelProfile("kling-v3-omni"), "kling-omni");
});

test("model switches preserve raw settings while specialized panels normalize display values", () => {
  assert.equal(videoWorkbenchDisplaySize("doubao-seedance-2-5-260628", "1280x720"), "16:9");
  assert.equal(videoWorkbenchDisplayResolution("doubao-seedance-2-0-fast-260128", "1080"), "720p");
  assert.equal(videoWorkbenchDisplaySeconds("doubao-seedance-2-5-260628", "6"), "6");
  assert.equal(videoWorkbenchDisplaySeconds("kling-v3", "20"), "15");
  assert.equal(videoWorkbenchDisplaySeconds("kling-v2-6-motion-control", "12"), "12");
  assert.equal(videoWorkbenchDisplaySize("sora-2", "1280x720"), "1280x720");
  assert.equal(videoWorkbenchDisplaySize("sora-2", "16:9"), "1280x720");
  assert.equal(videoWorkbenchDisplaySize("sora-2", "9:16"), "720x1280");
  assert.equal(videoWorkbenchDisplaySize("sora-2", "1:1"), "1280x720");
  assert.equal(videoWorkbenchDisplaySize("sora-2", "adaptive"), "1280x720");
  assert.equal(videoWorkbenchDisplaySize("sora-2", "auto"), "auto");
  assert.equal(videoWorkbenchRatioForSize("1:1"), "1:1");
  assert.equal(videoWorkbenchRatioForSize("720x1280"), "9:16");
  assert.equal(videoWorkbenchResolutionInputValue("720p"), "720");
  assert.equal(videoWorkbenchResolutionInputValue("1440p"), "1440");
  assert.equal(videoWorkbenchSizeForModelResolution("sora-2", "1", "1920x1080"), "1920x1080");
  assert.equal(videoWorkbenchSizeForModelResolution("sora-2", "72", "1920x1080"), "1920x1080");
  assert.equal(videoWorkbenchSizeForModelResolution("sora-2", "1440", "1920x1080"), "1920x1080");
  assert.equal(videoWorkbenchSizeForModelResolution("CogVideoX-3", "1440", "720x1280"), "720x1280");
});

test("exact KIE endpoint capabilities do not inherit unsupported controls", () => {
	assert.deepEqual(videoSizeOptions("kling-2.6/image-to-video"), []);
	assert.deepEqual(videoResolutionOptions("kling-2.6/image-to-video"), []);
	assert.deepEqual(videoSizeOptions("kling/v3-turbo-image-to-video"), []);
	assert.equal(videoAllowsCustomDimensions("kling/v3-turbo-image-to-video"), true);
	assert.deepEqual(videoSizeOptions("kling/v2-1-pro"), []);
  assert.deepEqual(videoResolutionOptions("kling/v2-1-pro"), []);
  assert.deepEqual(videoSizeOptions("minimax-h3/image-to-video"), []);
  assert.deepEqual(videoSizeOptions("happyhorse/image-to-video"), []);
  assert.deepEqual(videoSizeOptions("happyhorse/video-edit"), []);
  assert.equal(videoAudioControl("grok-imagine-video-1-5-preview"), "none");
  assert.deepEqual(videoMultimodalReferenceLimits("gemini-omni-video"), { image: 9, video: 3, audio: 0 });
	assert.deepEqual(videoMultimodalReferenceLimits("wan/2-6-video-to-video"), { image: 0, video: 1, audio: 0 });
	assert.deepEqual(videoSizeOptions("wan/2-6-text-to-video"), []);
	assert.deepEqual(videoResolutionOptions("kling-3.0/video"), []);
	assert.equal(videoWatermarkSupported("kling-3.0/video"), false);
	assert.deepEqual(videoResolutionOptions("kling-2.6/motion-control"), []);
	assert.deepEqual(videoResolutionOptions("kling-3.0/motion-control"), []);
});

test("reference workbench exposes only effective video audio and duration controls", () => {
  assert.equal(videoAudioControl("kling-3-0-turbo"), "none");
	assert.equal(videoReferenceImageLimit("kling-3-0-turbo"), 1);
	assert.equal(videoReferenceImageLimit("kling-3.0/video"), 2);
	assert.deepEqual(videoSizeOptions("kling-3-0-turbo").slice(0, 3), ["1280x720", "720x1280", "1024x1024"]);
	assert.deepEqual(videoWorkbenchSecondsOptions("kling-3-0-turbo"), [6, 10, 12, 16, 20]);
  assert.equal(videoAllowsCustomDimensions("kling-3-0-turbo"), true);
  assert.equal(videoAllowsCustomResolution("kling-3-0-turbo"), true);
  assert.equal(videoAllowsCustomDimensions("sora-2"), true);
  assert.equal(videoAllowsCustomDimensions("sora-2-pro"), true);
  assert.equal(videoAllowsCustomDimensions("veo-3.1-generate-preview"), true);
  assert.equal(videoAllowsCustomDimensions("grok-imagine-video-1.5"), true);
	assert.equal(supportsKlingMode("kling-3-0-turbo"), false);
	assert.equal(supportsKlingMultiShot("kling-3-0-turbo"), false);
	assert.equal(supportsKlingNegativePrompt("kling-3-0-turbo"), false);
	assert.equal(videoReferenceImageLimit("MiniMax-Hailuo-2.3"), 1);
  assert.equal(videoAudioControl("kling-3.0-omni/transformation"), "toggle");
  assert.equal(videoAudioControl("viduq3-pro"), "toggle");
  assert.equal(videoAudioControl("viduq3-turbo"), "toggle");
  assert.equal(videoAudioControl("pixverse-v6"), "toggle");
  assert.equal(videoAudioControl("pixverse-v5"), "none");
  assert.equal(videoAudioControl("veo-3.1-generate-preview"), "none");
  assert.equal(videoAudioControl("veo3.1-official"), "toggle");
  assert.equal(videoAudioControl("wan2.7-i2v-plus"), "none");
  assert.equal(videoDurationSupported("kling-2.6/motion-control"), false);
  assert.equal(videoDurationSupported("kling-v2-6-motion-control"), false);
  assert.equal(videoDurationSupported("gemini-omni-flash-preview"), true);
	assert.equal(videoAudioControl("grok-imagine-video"), "none");
	assert.equal(videoAudioControl("grok-imagine-video-1.5"), "none");
	assert.deepEqual(videoMultimodalReferenceLimits("grok-imagine-video-1.5"), { image: 9, video: 0, audio: 0 });
});

test("reference workbench separates material limits from provider capabilities", () => {
  assert.deepEqual(videoWorkbenchReferenceLimits("sora-2"), { image: 9, video: 3, audio: 3 });
  assert.deepEqual(videoWorkbenchReferenceLimits("gemini-omni-video"), { image: 9, video: 3, audio: 3 });
  assert.deepEqual(videoWorkbenchReferenceLimits("kling-3.0-omni/reference-to-video"), { image: 9, video: 1, audio: 0 });
  assert.deepEqual(videoWorkbenchReferenceLimits("kling-3.0-omni/transformation"), { image: 4, video: 1, audio: 0 });
  assert.deepEqual(videoWorkbenchReferenceLimits("kling-2.6/motion-control"), { image: 9, video: 3, audio: 3 });
  assert.deepEqual(videoWorkbenchReferenceLimits("kling/ai-avatar-v1-pro"), { image: 9, video: 3, audio: 3 });
  assert.equal(supportsVideoFrameReferences("MiniMax-H3"), true);
  assert.equal(supportsVideoFrameReferences("doubao-seedance-2-0-260128"), true);
  assert.equal(supportsVideoFrameReferences("veo-3.1-generate-preview"), false);
  assert.equal(supportsVideoFrameReferences("sora-2"), false);
  assert.equal(videoAudioGenerationDisabled("kling-v2-6", "std", 0, 0), true);
  assert.equal(videoAudioGenerationDisabled("kling-v2-6", "pro", 1, 0), false);
  assert.equal(videoAudioGenerationDisabled("kling-v2-6", "pro", 2, 0), true);
  assert.equal(videoAudioGenerationDisabled("kling-3.0-omni/reference-to-video", "pro", 1, 1), true);
  assert.equal(videoWorkbenchValidatesReferenceVideoMetadata("doubao-seedance-2-0-260128"), true);
  assert.equal(videoWorkbenchValidatesReferenceVideoMetadata("kling-2.6/motion-control"), true);
  assert.equal(videoWorkbenchValidatesReferenceVideoMetadata("kling/ai-avatar-v1-pro"), true);
  assert.equal(videoWorkbenchValidatesReferenceVideoMetadata("kling-v3"), false);
  assert.equal(videoWorkbenchValidatesReferenceVideoMetadata("MiniMax-H3"), false);
  assert.equal(videoWorkbenchValidatesReferenceVideoMetadata("minimax-h3/reference-to-video"), true);
  assert.equal(videoWorkbenchValidatesReferenceVideoMetadata("agnes-video-2.5"), false);
  assert.deepEqual(videoWorkbenchMaterialSections("sora-2"), { image: true, video: true, audio: true, imageLabel: "参考图" });
  assert.deepEqual(videoWorkbenchMaterialSections("kling-v3"), { image: true, video: false, audio: false, imageLabel: "首尾帧" });
  assert.deepEqual(videoWorkbenchMaterialSections("kling-3.0-omni/text-to-video"), { image: false, video: false, audio: false, imageLabel: "参考图" });
  assert.deepEqual(videoWorkbenchMaterialSections("kling-3.0-omni/reference-to-video"), { image: true, video: true, audio: false, imageLabel: "参考图" });
});

test("Veo frame slots follow the reference channel gate", () => {
  assert.equal(supportsVideoFrameReferences("veo-3.1-generate-preview"), false);
  assert.equal(supportsVideoFrameReferences("veo-3.1-generate-preview", "gemini"), true);
  assert.equal(supportsVideoFrameReferences("veo3.1-official"), true);
});
