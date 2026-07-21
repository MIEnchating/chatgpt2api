import assert from "node:assert/strict";
import test from "node:test";

import { canvasExportBounds, canvasExportTransform } from "../src/app/canvas/canvas-export.ts";

test("export bounds cover every node with stable padding", () => {
  assert.deepEqual(canvasExportBounds([
    { x: 100, y: 40, width: 320, height: 240 },
    { x: -80, y: 360, width: 180, height: 120 },
  ], 32), { minX: -112, minY: 8, width: 564, height: 504 });
});

test("export transform moves world bounds into the image origin", () => {
  assert.equal(canvasExportTransform({ minX: -112, minY: 8, width: 564, height: 504 }), "translate(112px, -8px) scale(1)");
});
