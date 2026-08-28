import assert from "node:assert/strict";
import test from "node:test";

import { CANVAS_VIDEO_MAX_BYTES, canvasVideoDisplaySize, canvasVideoFileError } from "../src/app/canvas/canvas-video-import.ts";

test("canvas video imports accept the backend MP4 and MOV contract", () => {
  assert.equal(canvasVideoFileError({ name: "clip.mp4", type: "video/mp4", size: 10 }), "");
  assert.equal(canvasVideoFileError({ name: "clip.mov", type: "video/quicktime", size: 10 }), "");
  assert.equal(canvasVideoFileError({ name: "clip.webm", type: "video/webm", size: 10 }), "视频仅支持 MP4 或 MOV 格式");
  assert.equal(canvasVideoFileError({ name: "clip.mp4", type: "video/mp4", size: CANVAS_VIDEO_MAX_BYTES + 1 }), "视频不能超过 50 MiB");
});

test("imported video nodes preserve ratio within the reference 420 pixel bound", () => {
  assert.deepEqual(canvasVideoDisplaySize(1920, 1080), { width: 420, height: 236.25 });
  assert.deepEqual(canvasVideoDisplaySize(1080, 1920), { width: 236.25, height: 420 });
  assert.deepEqual(canvasVideoDisplaySize(320, 240), { width: 320, height: 240 });
});
