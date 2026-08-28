import assert from "node:assert/strict";
import test from "node:test";

import {
  PANORAMA_IMAGE_SIZE,
  PANORAMA_NODE_SIZE,
  buildPanoramaPrompt,
  isStrictPanoramaSize,
  panoramaGenerationCount,
  panoramaGenerationQuality,
  panoramaProxyURL,
  panoramaRetryPrompt,
  panoramaRetryReferenceURLs,
} from "../src/app/canvas/canvas-panorama.ts";

test("generated panorama proxy follows the reference same-origin and private-host rules", () => {
  assert.equal(panoramaProxyURL("/images/panorama.png", "app.example.com"), "/images/panorama.png");
  assert.equal(panoramaProxyURL("https://app.example.com/panorama.png", "app.example.com"), "https://app.example.com/panorama.png");
  assert.equal(panoramaProxyURL("http://127.0.0.1/panorama.png", "app.example.com"), "http://127.0.0.1/panorama.png");
  assert.equal(panoramaProxyURL("https://cdn.example.com/panorama.png", "app.example.com"), "/api/proxy-image?url=https%3A%2F%2Fcdn.example.com%2Fpanorama.png");
});

test("panorama contract keeps the reference project's fixed image and node sizes", () => {
  assert.equal(PANORAMA_IMAGE_SIZE, "2:1");
  assert.deepEqual(PANORAMA_NODE_SIZE, { width: 340, height: 170 });
  assert.equal(isStrictPanoramaSize(2048, 1024), true);
  assert.equal(isStrictPanoramaSize(1920, 1080), false);
  assert.equal(isStrictPanoramaSize(0, 0), false);
});

test("text panorama prompt uses the complete spherical fallback", () => {
  const prompt = buildPanoramaPrompt("  雨夜街道  ", false);
  assert.match(prompt, /^这是文字生成720度球形全景任务。/);
  assert.match(prompt, /水平视角覆盖完整360度/);
  assert.match(prompt, /垂直视角覆盖从天空或天花板到地面或地板的完整180度/);
  assert.match(prompt, /雨夜街道$/);
  assert.doesNotMatch(prompt, /\{\{/);
});

test("image panorama prompt uses the image-edit fallback", () => {
  const prompt = buildPanoramaPrompt("保留主体", true);
  assert.match(prompt, /^这是图生720度球形全景任务。/);
  assert.match(prompt, /不要简单拉伸原图/);
  assert.match(prompt, /保留主体$/);
});

test("panorama retry reuses the saved final prompt and original edit references", () => {
  assert.equal(panoramaRetryPrompt("  已保存的完整全景提示词  "), "已保存的完整全景提示词");
  assert.equal(panoramaRetryPrompt(undefined), "");
  assert.deepEqual(panoramaRetryReferenceURLs("edit", [" /images/a.png ", "/images/a.png", "/images/b.png"]), ["/images/a.png", "/images/b.png"]);
  assert.deepEqual(panoramaRetryReferenceURLs("generation", ["/images/a.png"]), []);
});

test("panorama maps automatic quality to the reference project's medium request", () => {
  assert.equal(panoramaGenerationQuality(undefined), "medium");
  assert.equal(panoramaGenerationQuality("auto"), "medium");
  assert.equal(panoramaGenerationQuality("high"), "high");
});

test("panorama generation count follows the reference project's fixed 1 to 15 range", () => {
  assert.equal(panoramaGenerationCount(undefined), 1);
  assert.equal(panoramaGenerationCount(-3.8), 3);
  assert.equal(panoramaGenerationCount(20), 15);
});
