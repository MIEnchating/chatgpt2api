import assert from "node:assert/strict";
import test from "node:test";

import { canvasFloatingPanelPlacement, canvasNodeToolbarPlacement } from "../src/app/canvas/canvas-floating-panel.ts";

test("keeps the parameter panel inside a narrow viewport", () => {
  const placement = canvasFloatingPanelPlacement({
    anchor: { left: 250, right: 330, top: 500, bottom: 540 },
    viewportWidth: 360,
    viewportHeight: 640,
  });

  assert.equal(placement.width, 336);
  assert.equal(placement.left, 12);
  assert.equal(placement.left + placement.width, 348);
  assert.equal(placement.direction, "above");
  assert.equal(placement.maxHeight, 480);
});

test("opens below when the anchor is near the top edge", () => {
  const placement = canvasFloatingPanelPlacement({
    anchor: { left: 40, right: 140, top: 52, bottom: 92 },
    viewportWidth: 390,
    viewportHeight: 844,
  });

  assert.equal(placement.direction, "below");
  assert.equal(placement.maxHeight, 732);
});

test("uses the side with more room when neither side fits the preferred height", () => {
  const placement = canvasFloatingPanelPlacement({
    anchor: { left: 80, right: 180, top: 210, bottom: 250 },
    viewportWidth: 320,
    viewportHeight: 420,
  });

  assert.equal(placement.direction, "above");
  assert.equal(placement.maxHeight, 190);
});

test("mobile node toolbar spans the viewport and clears the top controls", () => {
  assert.deepEqual(canvasNodeToolbarPlacement({ nodeCenterX: -200, nodeTopY: 40, viewportWidth: 390 }), {
    compact: true,
    left: 12,
    right: 12,
    top: 116,
  });
});

test("desktop node toolbar keeps following the node", () => {
  assert.deepEqual(canvasNodeToolbarPlacement({ nodeCenterX: 860, nodeTopY: 320, viewportWidth: 1440 }), {
    compact: false,
    left: 860,
    top: 320,
  });
});
