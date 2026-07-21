import assert from "node:assert/strict";
import test from "node:test";

import { canvasCenteredNodePosition, canvasCroppedNodeSize, canvasEmptyImageFrameFromSize, canvasImageReplacementFrame, canvasNodeAspectRatio } from "../src/app/canvas/canvas-node-geometry.ts";

test("locked resizing follows natural image dimensions", () => {
  assert.equal(canvasNodeAspectRatio({ width: 400, height: 400, natural_width: 1600, natural_height: 900 }), 1600 / 900);
});

test("locked resizing falls back to current node dimensions", () => {
  assert.equal(canvasNodeAspectRatio({ width: 320, height: 180 }), 320 / 180);
});

test("cropped nodes keep the crop ratio without exceeding the source width", () => {
  assert.deepEqual(canvasCroppedNodeSize(400, 1200, 600), { width: 400, height: 200 });
  assert.deepEqual(canvasCroppedNodeSize(500, 160, 320), { width: 220, height: 440 });
});

test("library images are centered at their insertion point using the fitted node size", () => {
  assert.deepEqual(canvasCenteredNodePosition({ x: 500, y: 300 }, 640, 320), { x: 180, y: 140 });
  assert.deepEqual(canvasCenteredNodePosition({ x: 200, y: 400 }, 240, 480), { x: 80, y: 160 });
});

test("upload replacement keeps the node top-left anchor like the reference canvas", () => {
  assert.deepEqual(canvasImageReplacementFrame({ x: 120, y: -80 }, 640, 360), {
    x: 120,
    y: -80,
    width: 640,
    height: 360,
  });
});

test("empty image parameter changes resize around the current center", () => {
  assert.deepEqual(canvasEmptyImageFrameFromSize({ x: 100, y: 100, width: 340, height: 240 }, "1536x1024"), {
    x: 100,
    y: 106.66666666666667,
    width: 340,
    height: 226.66666666666666,
  });
  assert.deepEqual(canvasEmptyImageFrameFromSize({ x: 100, y: 100, width: 340, height: 240 }, "1024x1536"), {
    x: 190,
    y: 100,
    width: 160,
    height: 240,
  });
  assert.equal(canvasEmptyImageFrameFromSize({ x: 0, y: 0, width: 340, height: 240 }, ""), null);
});
