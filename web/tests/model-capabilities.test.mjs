import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { filterModelsByCapability } from "../src/lib/model-capabilities.ts";
import { activeVideoModelContracts, installVideoModelContracts } from "../src/lib/video-model-contracts.ts";

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


test("keeps MiniMax M3 language models out of fetched video candidates", () => {
  const textModels = ["minimax-m2.5", "minimax-m3", "MiniMax-M3", "minimax/minimax-m3", "minimax-m3-preview"];
  const videos = ["minimax-video-01", "hailuo-02", "doubao-seedance-2.0"];
  assert.deepEqual(filterModelsByCapability([...textModels, ...videos], "text"), textModels);
  assert.deepEqual(filterModelsByCapability([...textModels, ...videos], "video"), videos);
});

test("keeps MiniMax H3 video models in fetched video candidates", () => {
  assert.deepEqual(filterModelsByCapability(["minimax-h3-768p", "minimax-m2.5"], "video"), ["minimax-h3-768p"]);
});

test("classifies Seedance short names without treating SDXL as video", () => {
  assert.deepEqual(filterModelsByCapability(["sd2.5 720p", "vendor/sd2-0", "seedance2-5", "sdxl"], "video"), ["sd2.5 720p", "vendor/sd2-0", "seedance2-5"]);
});

test("recognizes all 24 imported video models when filtering fetched IDs", () => {
  const previous = activeVideoModelContracts();
  const contracts = ["xzapi", "dramaya-wan-3"].flatMap((name) => {
    const document = JSON.parse(readFileSync(new URL(`../../integrations/newapi/${name}/contract.json`, import.meta.url)));
    return document.contracts.filter((item) => item.enabled).map((item) => item.contract);
  });
  const videos = contracts.flatMap((contract) => contract.models);
  try {
    installVideoModelContracts(contracts);
    assert.equal(videos.length, 24);
    const fetched = [...videos, "gpt-5.5", "sdxl", "gpt-4o-mini-tts"];
    assert.deepEqual(filterModelsByCapability(fetched, "video"), videos);
    assert.deepEqual(filterModelsByCapability(fetched, "text"), ["gpt-5.5"]);
    assert.deepEqual(filterModelsByCapability(fetched, "image"), ["sdxl"]);
    assert.deepEqual(filterModelsByCapability(fetched, "audio"), ["gpt-4o-mini-tts"]);
    assert.deepEqual(filterModelsByCapability([videos[0]], "video", { [videos[0]]: "text" }), []);
    assert.deepEqual(filterModelsByCapability([videos[0]], "text", { [videos[0]]: "text" }), [videos[0]]);
    installVideoModelContracts([]);
    assert.deepEqual(filterModelsByCapability(["ch0101-sd-2.0-480p"], "video"), []);
  } finally {
    installVideoModelContracts(previous);
  }
});
