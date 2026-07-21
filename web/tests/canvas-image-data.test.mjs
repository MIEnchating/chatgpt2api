import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanvasGridLines,
  canvasImageAngleLabel,
  canvasImageAnglePrompt,
  clampCanvasGrid,
  findCanvasGridLineSpot,
  nextCanvasUpscaleTarget,
  resolveCanvasUpscaleSize,
} from "../src/app/canvas/canvas-image-data.ts";

test("canvas image tools clamp grid sizes and preserve proportional upscale dimensions", () => {
  assert.equal(clampCanvasGrid(0), 1);
  assert.equal(clampCanvasGrid(4.6), 5);
  assert.equal(clampCanvasGrid(99), 12);
  assert.deepEqual(buildCanvasGridLines(4), [0.25, 0.5, 0.75]);
  assert.deepEqual(resolveCanvasUpscaleSize(800, 400, 2048), { width: 2048, height: 1024 });
  assert.deepEqual(resolveCanvasUpscaleSize(800, 400, 9999), { width: 4096, height: 2048 });
  assert.equal(nextCanvasUpscaleTarget(900), 1024);
  assert.equal(nextCanvasUpscaleTarget(1024), 2048);
  assert.equal(nextCanvasUpscaleTarget(3000), 4096);
  assert.equal(nextCanvasUpscaleTarget(4096), 4096);
});

test("canvas split lines are inserted in the largest available gap", () => {
  assert.equal(findCanvasGridLineSpot([]), 0.5);
  assert.equal(findCanvasGridLineSpot([0.5]), 0.25);
  assert.equal(findCanvasGridLineSpot([0.25, 0.5]), 0.75);
});

test("angle labels and prompts match the reference project semantics", () => {
  const params = { horizontalAngle: -30, pitchAngle: 12, cameraDistance: 4.8, wideAngle: true };
  assert.equal(canvasImageAngleLabel(params), "AI 多角度：向左旋转 30 度，俯视 12 度，镜头距离 4.8，广角镜头");
  assert.equal(canvasImageAnglePrompt(params), "基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。AI 多角度：向左旋转 30 度，俯视 12 度，镜头距离 4.8，广角镜头。");
});
