import assert from "node:assert/strict";
import test from "node:test";

import { canvasCenteredNodePosition, canvasCroppedNodeSize, canvasEmptyImageFrameFromSize, canvasImageReplacementFrame, canvasNodeAspectRatio, canvasNodeSizeFromRatio } from "../src/app/canvas/canvas-node-geometry.ts";

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
    x: 156.66666666666669,
    y: 50,
    width: 226.66666666666666,
    height: 340,
  });
  assert.equal(canvasEmptyImageFrameFromSize({ x: 0, y: 0, width: 340, height: 240 }, ""), null);
});

test("generated media frames follow the reference aspect-ratio sizing contract", () => {
  assert.deepEqual(canvasNodeSizeFromRatio("16:9", 420, 236), { width: 420, height: 236.25 });
  assert.deepEqual(canvasNodeSizeFromRatio("9:16", 420, 236), { width: 236.25, height: 420 });
  assert.deepEqual(canvasNodeSizeFromRatio("1536x1024", 340, 240), { width: 340, height: 226.66666666666666 });
  assert.deepEqual(canvasNodeSizeFromRatio("auto", 340, 240), null);
});


test("ratio changes preserve a resized node's longest edge and center", () => {
  let node = { x: 20, y: 40, width: 800, height: 450 };
  const center = { x: 420, y: 265 };
  for (const ratio of ["9:16", "16:9", "1:1", "9:16", "16:9"]) {
    node = canvasEmptyImageFrameFromSize(node, ratio);
    assert.equal(Math.max(node.width, node.height), 800);
    assert.equal(node.x + node.width / 2, center.x);
    assert.equal(node.y + node.height / 2, center.y);
  }
});
