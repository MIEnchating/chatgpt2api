import test from "node:test";
import assert from "node:assert/strict";
import { createCanvasAlignmentContext, calculateCanvasAlignment } from "../src/app/canvas/canvas-alignment.ts";

test("drag alignment snaps group bounds without changing the relative positions", () => {
  const nodes = [{ id: "a", type: "image", x: 0, y: 0, width: 100, height: 100 }, { id: "b", type: "image", x: 150, y: 0, width: 100, height: 100 }, { id: "target", type: "image", x: 400, y: 300, width: 250, height: 100 }];
  const context = createCanvasAlignmentContext(nodes, new Set(["a", "b"]));
  const result = calculateCanvasAlignment(context, { x: 396, y: 297 }, 6);
  assert.deepEqual(result, { offset: { x: 400, y: 300 }, guides: { vertical: 400, horizontal: 300 } });
  assert.deepEqual(calculateCanvasAlignment(context, { x: 390, y: 290 }, 6).offset, { x: 390, y: 290 });
  assert.equal(createCanvasAlignmentContext(nodes, new Set()), null);
});

test("alignment threshold is measured in screen pixels across zoom levels", () => {
  const context = { x: [0, 50, 100], y: [0, 50, 100], targets: [{ x: [200, 250, 300], y: [400, 450, 500] }] };
  assert.equal(calculateCanvasAlignment(context, { x: 190, y: 100 }, 6 / 0.5).offset.x, 200);
  assert.equal(calculateCanvasAlignment(context, { x: 190, y: 100 }, 6 / 2).offset.x, 190);
});
