import assert from "node:assert/strict";
import test from "node:test";

import {
  videoAudioControl,
  supportsVideoMultimodalReferences,
  videoMultimodalReferenceLimits,
  videoModelProfile,
  videoReferenceImageLimit,
  videoRequiresReferenceImage,
  videoResolutionOptions,
  videoSecondsOptions,
  videoSizeOptions,
  videoWatermarkSupported,
} from "../src/lib/video-model-capabilities.ts";

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
  assert.equal(videoWatermarkSupported("kling-v3"), true);

  assert.equal(videoModelProfile("MiniMax-Hailuo-2.3"), "minimax-hailuo");
  assert.deepEqual(videoSizeOptions("MiniMax-Hailuo-2.3"), []);
  assert.deepEqual(videoResolutionOptions("MiniMax-Hailuo-2.3"), ["768P", "1080P"]);
  assert.deepEqual(videoResolutionOptions("MiniMax-Hailuo-2.3", 10), ["768P"]);
  assert.equal(videoRequiresReferenceImage("MiniMax-Hailuo-2.3-Fast"), true);
  assert.equal(videoModelProfile("MiniMax-H3"), "minimax-h3");
  assert.deepEqual(videoResolutionOptions("MiniMax-H3"), ["768P", "2K"]);
  assert.deepEqual(videoSizeOptions("MiniMax-H3"), ["16:9", "21:9", "4:3", "1:1", "3:4", "9:16"]);
  assert.equal(videoReferenceImageLimit("MiniMax-H3"), 1);
  assert.equal(supportsVideoMultimodalReferences("MiniMax-H3"), true);
  assert.deepEqual(videoMultimodalReferenceLimits("MiniMax-H3"), { image: 9, video: 3, audio: 3 });
  assert.equal(supportsVideoMultimodalReferences("kling-v3"), false);
  assert.equal(videoWatermarkSupported("MiniMax-H3"), false);

  assert.equal(videoModelProfile("sora-2"), "sora");
  assert.equal(videoModelProfile("sora-2-pro"), "sora-pro");
  assert.deepEqual(videoSecondsOptions("sora-2"), [4, 8, 12, 16, 20]);
  assert.deepEqual(videoSizeOptions("sora-2"), ["1280x720", "720x1280"]);
  assert.deepEqual(videoSizeOptions("sora-2-pro"), ["1280x720", "720x1280", "1792x1024", "1024x1792", "1920x1080", "1080x1920"]);
  assert.deepEqual(videoResolutionOptions("sora-2-pro"), []);

  assert.equal(videoModelProfile("doubao-seedance-2-5-260628"), "seedance-25");
  assert.equal(videoSecondsOptions("doubao-seedance-2-5-260628")[0], -1);
  assert.equal(videoSecondsOptions("doubao-seedance-2-5-260628").at(-1), 30);
  assert.deepEqual(videoResolutionOptions("doubao-seedance-2-0-260128"), ["480p", "720p", "1080p", "4k"]);
  assert.equal(videoModelProfile("doubao-seedance-2-0-fast-260128"), "seedance-20-fast");
  assert.deepEqual(videoResolutionOptions("doubao-seedance-2-0-fast-260128"), ["480p", "720p"]);
  assert.equal(videoModelProfile("doubao-seedance-2-0-mini-260128"), "seedance-20-mini");
  assert.equal(videoModelProfile("doubao-seedance-future"), "vendor-unknown");
  assert.deepEqual(videoSizeOptions("doubao-seedance-future"), []);
  assert.deepEqual(videoResolutionOptions("doubao-seedance-future"), []);
  assert.equal(videoAudioControl("doubao-seedance-2-5-260628"), "toggle");
});
