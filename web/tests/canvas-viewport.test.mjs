import assert from "node:assert/strict";
import test from "node:test";

import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  canvasGridMetrics,
  canvasConnectionInViewport,
  buildCanvasConnectionIndex,
  canvasConnectionsInViewport,
  canvasConnectionIndexMatchesGeometry,
  canvasNodesInViewport,
  clampCanvasZoom,
  resetCanvasViewport,
  setCanvasViewportZoom,
  updateCanvasConnectionGeometry,
  updateCanvasConnectionIndex,
  zoomCanvasViewport,
} from "../src/app/canvas/canvas-viewport.ts";

function canvasNodeGeometry(nodes) {
  return new Map(nodes.map(({ id, x, y, width, height }) => [id, { x, y, width, height }]));
}

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
    size: 19.200000000000003,
    x: 5,
    y: 7,
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

test("connection culling retains curves crossing the viewport and removes remote curves", () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const size = { width: 800, height: 600 };
  assert.equal(canvasConnectionInViewport({ x: -500, y: 100 }, { x: 1400, y: 100 }, viewport, size), true);
  assert.equal(canvasConnectionInViewport({ x: -500, y: -1000 }, { x: 1400, y: -1000 }, viewport, size), false);
  assert.equal(canvasConnectionInViewport({ x: 2000, y: 100 }, { x: 3000, y: 100 }, viewport, size), false);
});

test("moving a node incrementally updates only its incident connection cells", () => {
  const connections = [
    { from_node_id: "a", to_node_id: "b" },
    { from_node_id: "b", to_node_id: "c" },
    { from_node_id: "c", to_node_id: "d" },
    { from_node_id: "e", to_node_id: "f" },
  ];
  const nodes = [
    { id: "a", x: 0, y: 0, width: 100, height: 100 },
    { id: "b", x: 500, y: 0, width: 100, height: 100 },
    { id: "c", x: 5000, y: 0, width: 100, height: 100 },
    { id: "d", x: 6000, y: 0, width: 100, height: 100 },
    { id: "e", x: 15000, y: 0, width: 100, height: 100 },
    { id: "f", x: 16000, y: 0, width: 100, height: 100 },
  ];
  const originalGeometry = canvasNodeGeometry(nodes);
  const index = buildCanvasConnectionIndex(connections, originalGeometry);
  const stableCellKeys = index.connectionCells[3];
  const stableCellValues = stableCellKeys.map((key) => index.cells.get(key));
  const nextNodes = nodes.map((node) => node.id === "b" ? { ...node, x: 1600 } : node);
  const nextGeometry = canvasNodeGeometry(nextNodes);
  assert.equal(updateCanvasConnectionIndex(index, nextGeometry, ["b"]), index);
  const rebuilt = buildCanvasConnectionIndex(connections, nextGeometry);
  assert.deepEqual(index.bounds, rebuilt.bounds);
  assert.deepEqual(index.connectionCells, rebuilt.connectionCells);
  assert.deepEqual([...index.cells].sort(), [...rebuilt.cells].sort());
  assert.deepEqual([...index.spanning], [...rebuilt.spanning]);
  assert.deepEqual(canvasConnectionsInViewport(index, { x: -1500, y: 0, zoom: 1 }, { width: 800, height: 600 }), canvasConnectionsInViewport(rebuilt, { x: -1500, y: 0, zoom: 1 }, { width: 800, height: 600 }));
  assert.equal(canvasConnectionIndexMatchesGeometry(index, nextGeometry), true);
  assert.equal(index.connectionCells[3].every((key, position) => key === stableCellKeys[position] && index.cells.get(key) === stableCellValues[position]), true);
  const snapshot = [...nextNodes];
  assert.equal(updateCanvasConnectionGeometry(index, new Map([["b", nextGeometry.get("b")]]), snapshot), index);
  assert.equal(index.nodesSnapshot, snapshot);
});

test("incremental connection indexes remove dangling edges when nodes disappear", () => {
  const connections = [{ from_node_id: "a", to_node_id: "b" }, { from_node_id: "b", to_node_id: "c" }];
  const nodes = [
    { id: "a", x: 0, y: 0, width: 100, height: 100 },
    { id: "b", x: 300, y: 0, width: 100, height: 100 },
    { id: "c", x: 600, y: 0, width: 100, height: 100 },
  ];
  const index = buildCanvasConnectionIndex(connections, canvasNodeGeometry(nodes));
  const remaining = canvasNodeGeometry(nodes.filter((node) => node.id !== "b"));
  updateCanvasConnectionIndex(index, remaining);
  const rebuilt = buildCanvasConnectionIndex(connections, remaining);
  assert.deepEqual(index.bounds, rebuilt.bounds);
  assert.deepEqual(index.connectionCells, rebuilt.connectionCells);
  assert.deepEqual([...index.cells].sort(), [...rebuilt.cells].sort());
  assert.deepEqual([...index.spanning], [...rebuilt.spanning]);
});

test("incremental connection indexes retain geometry without copying media or script content", () => {
  const geometry = { x: 0, y: 0, width: 300, height: 200 };
  const index = buildCanvasConnectionIndex([], new Map([["a", geometry]]));
  const current = { ...geometry, x: 100, url: "data:image/png;base64,large-media", script_project: { shots: [{ prompt: "large script" }] } };
  updateCanvasConnectionGeometry(index, new Map([["a", current]]));
  assert.deepEqual(index.geometryByNode.get("a"), { x: 100, y: 0, width: 300, height: 200 });
});
