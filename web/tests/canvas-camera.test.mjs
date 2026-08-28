import assert from "node:assert/strict";
import test from "node:test";

import {
  APERTURES,
  CAMERA_PROFILES,
  DEFAULT_CAMERA_CONTROL,
  FOCAL_LENGTHS,
  LENS_PROFILES,
  applyCameraPrompt,
} from "../src/app/canvas/canvas-camera.ts";

test("camera options match the reference project", () => {
  assert.deepEqual(FOCAL_LENGTHS, [14, 18, 24, 35, 40, 50, 65, 85, 100, 135, 200]);
  assert.deepEqual(APERTURES, [1.2, 1.4, 1.8, 2, 2.8, 4, 5.6, 8, 11, 16]);
  assert.equal(CAMERA_PROFILES.length, 8);
  assert.equal(LENS_PROFILES.length, 8);
  assert.deepEqual(DEFAULT_CAMERA_CONTROL, {
    enabled: false,
    camera: CAMERA_PROFILES[0].id,
    lens: LENS_PROFILES[0].id,
    focal_length: 50,
    aperture: 4,
  });
});

test("disabled camera control leaves the authored prompt unchanged", () => {
  assert.equal(applyCameraPrompt("雨夜街道", DEFAULT_CAMERA_CONTROL), "雨夜街道");
  assert.equal(applyCameraPrompt("雨夜街道", undefined), "雨夜街道");
});

test("enabled camera control appends optical direction and guardrails", () => {
  const prompt = applyCameraPrompt("雨夜街道", {
    ...DEFAULT_CAMERA_CONTROL,
    enabled: true,
    focal_length: 85,
    aperture: 1.8,
  });
  assert.match(prompt, /^雨夜街道, the following parameters describe the virtual camera/);
  assert.match(prompt, /do not add any physical camera, lens, tripod/);
  assert.match(prompt, /85mm short-telephoto portrait perspective/);
  assert.match(prompt, /shot at f\/1\.8, very shallow depth of field/);
  assert.match(prompt, /focal: 85mm · aperture: f\/1\.8\]$/);
});
