import assert from "node:assert/strict";
import test from "node:test";

import {
  videoAudioControl,
  videoModelProfile,
  videoResolutionOptions,
  videoSecondsOptions,
  videoSizeOptions,
} from "../src/lib/video-model-capabilities.ts";

test("official provider profiles expose their documented controls", () => {
  assert.equal(videoModelProfile("grok-imagine-video-1.5"), "grok-15");
  assert.deepEqual(videoResolutionOptions("grok-imagine-video"), ["480p", "720p"]);
  assert.deepEqual(videoResolutionOptions("grok-imagine-video-1.5"), ["480p", "720p", "1080p"]);
  assert.deepEqual(videoSecondsOptions("grok-imagine-video-1.5"), Array.from({ length: 15 }, (_, i) => i + 1));

  assert.equal(videoModelProfile("kling-v3"), "kling-3");
  assert.deepEqual(videoSecondsOptions("kling-v3").slice(0, 3), [3, 4, 5]);
  assert.deepEqual(videoSizeOptions("kling-v3"), ["16:9", "9:16", "1:1"]);

  assert.equal(videoModelProfile("MiniMax-Hailuo-2.3"), "minimax-hailuo");
  assert.deepEqual(videoSizeOptions("MiniMax-Hailuo-2.3"), []);
  assert.deepEqual(videoResolutionOptions("MiniMax-Hailuo-2.3"), ["768P", "1080P"]);
  assert.equal(videoModelProfile("MiniMax-H3"), "minimax-h3");
  assert.deepEqual(videoResolutionOptions("MiniMax-H3"), ["768P", "2K"]);

  assert.equal(videoModelProfile("doubao-seedance-2-5-260628"), "seedance-25");
  assert.equal(videoSecondsOptions("doubao-seedance-2-5-260628")[0], -1);
  assert.equal(videoSecondsOptions("doubao-seedance-2-5-260628").at(-1), 30);
  assert.deepEqual(videoResolutionOptions("doubao-seedance-2-0-260128"), ["480p", "720p", "1080p", "4k"]);
  assert.equal(videoAudioControl("doubao-seedance-2-5-260628"), "toggle");
});
