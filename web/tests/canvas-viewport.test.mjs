import assert from "node:assert/strict";
import test from "node:test";

import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  canvasGridMetrics,
  canvasNodesInViewport,
  clampCanvasZoom,
  resetCanvasViewport,
  setCanvasViewportZoom,
  zoomCanvasViewport,
} from "../src/app/canvas/canvas-viewport.ts";

test("canvas zoom uses the reference project range", () => {
  assert.equal(clampCanvasZoom(0), CANVAS_MIN_ZOOM);
  assert.equal(clampCanvasZoom(2), 2);
  assert.equal(clampCanvasZoom(8), CANVAS_MAX_ZOOM);
});

test("reset viewport centers the world origin at 100 percent zoom like the reference project", () => {
  assert.deepEqual(resetCanvasViewport({ width: 1280, height: 720 }), {
    zoom: 1,
    x: 640,
    y: 360,
  });
});

test("toolbar zoom keeps the world point at the viewport center fixed", () => {
  const current = { zoom: 1, x: 100, y: -40 };
  const size = { width: 1200, height: 800 };
  const next = setCanvasViewportZoom(current, size, 2);
  assert.deepEqual(next, { zoom: 2, x: -400, y: -480 });
  assert.equal((size.width / 2 - next.x) / next.zoom, (size.width / 2 - current.x) / current.zoom);
  assert.equal((size.height / 2 - next.y) / next.zoom, (size.height / 2 - current.y) / current.zoom);
});

test("toolbar zoom uses the same scale limits as wheel zoom", () => {
  assert.equal(setCanvasViewportZoom({ zoom: 1, x: 0, y: 0 }, { width: 1000, height: 600 }, 20).zoom, CANVAS_MAX_ZOOM);
  assert.equal(setCanvasViewportZoom({ zoom: 1, x: 0, y: 0 }, { width: 1000, height: 600 }, 0).zoom, CANVAS_MIN_ZOOM);
});

test("wheel zoom keeps the world point under the pointer fixed", () => {
  const current = { zoom: 1, x: 100, y: 50 };
  const pointer = { x: 300, y: 250 };
  const next = zoomCanvasViewport(current, pointer, -100);
  assert.equal(next.zoom, 1.1);
  assert.equal((pointer.x - next.x) / next.zoom, (pointer.x - current.x) / current.zoom);
  assert.equal((pointer.y - next.y) / next.zoom, (pointer.y - current.y) / current.zoom);
});

test("canvas grid follows viewport translation and zoom", () => {
  assert.deepEqual(canvasGridMetrics({ zoom: 1, x: 101, y: -50 }), {
    size: 48,
    x: 5,
    y: -2,
    dotSize: 1.15,
  });
  assert.deepEqual(canvasGridMetrics({ zoom: 0.1, x: 5, y: 7 }), {
    size: 4.800000000000001,
    x: 0.1999999999999993,
    y: 2.1999999999999993,
    dotSize: 0.8,
  });
});

test("canvas only renders nodes near the visible world bounds", () => {
  const nodes = [
    { id: "visible", x: 100, y: 100, width: 200, height: 160 },
    { id: "near", x: 1050, y: 100, width: 200, height: 160 },
    { id: "far", x: 1600, y: 100, width: 200, height: 160 },
    { id: "left", x: -900, y: 100, width: 200, height: 160 },
  ];
  assert.deepEqual(
    canvasNodesInViewport(nodes, { zoom: 1, x: 0, y: 0 }, { width: 1000, height: 700 }).map((node) => node.id),
    ["visible", "near"],
  );
  assert.deepEqual(
    canvasNodesInViewport(nodes, { zoom: 0.5, x: 0, y: 0 }, { width: 1000, height: 700 }).map((node) => node.id),
    ["visible", "near", "far"],
  );
});
