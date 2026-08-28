import assert from "node:assert/strict";
import test from "node:test";

import { filterModelsByCapability } from "../src/lib/model-capabilities.ts";

const models = ["gpt-5.5", "gpt-image-2", "sora-2", "gpt-4o-mini-tts"];

test("classifies fetched models into text, image, video, and audio groups", () => {
  assert.deepEqual(filterModelsByCapability(models, "text"), ["gpt-5.5"]);
  assert.deepEqual(filterModelsByCapability(models, "image"), ["gpt-image-2"]);
  assert.deepEqual(filterModelsByCapability(models, "video"), ["sora-2"]);
  assert.deepEqual(filterModelsByCapability(models, "audio"), ["gpt-4o-mini-tts"]);
});

test("classifies reference-project video model families", () => {
  const videoModels = [
    "gemini-omni-flash-preview",
    "gemini-omni-video",
    "runway-aleph",
    "infinitalk-v1",
    "wan2.7-r2v",
    "wan/2-7-videoedit",
    "grok-imagine/upscale",
    "grok-imagine/extend",
  ];
  assert.deepEqual(filterModelsByCapability(videoModels, "video"), videoModels);
});
