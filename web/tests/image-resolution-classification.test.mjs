import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateImageSize,
  getImageSizeRequirementLabel,
  isHighResolutionImageSize,
} from "../src/app/image/image-options.ts";

test("1080P requests remain regular resolution across aspect ratios", () => {
  const fullHD = calculateImageSize("1080p", "16:9");
  const ultrawide = calculateImageSize("1080p", "21:9");

  assert.equal(fullHD, "1920x1088");
  assert.equal(isHighResolutionImageSize(fullHD, { mode: "ratio", resolution: "1080p" }), false);
  assert.equal(isHighResolutionImageSize(ultrawide, { mode: "ratio", resolution: "1080p" }), false);
  assert.equal(getImageSizeRequirementLabel(fullHD, { mode: "ratio", resolution: "1080p" }), "常规分辨率");
});

test("2K and 4K presets are high resolution even for wide aspect ratios", () => {
  const wide2K = calculateImageSize("2k", "3:1");

  assert.equal(wide2K, "2048x688");
  assert.equal(isHighResolutionImageSize(wide2K, { mode: "ratio", resolution: "2k" }), true);
  assert.equal(isHighResolutionImageSize(calculateImageSize("4k", "16:9"), { mode: "ratio", resolution: "4k" }), true);
});

test("custom and legacy dimensions use a 2K longest-edge fallback", () => {
  assert.equal(isHighResolutionImageSize("1920x1080", { mode: "custom", resolution: "auto" }), false);
  assert.equal(isHighResolutionImageSize("2048x1024", { mode: "custom", resolution: "auto" }), true);
  assert.equal(isHighResolutionImageSize("1920x1080"), false);
  assert.equal(isHighResolutionImageSize("2048x1024"), true);
});
