import assert from "node:assert/strict";
import test from "node:test";

import {
  activeCanvasConnectionPath,
  canCreateCanvasConnection,
  canvasConnectionPath,
  canvasConnectionRelations,
  findCanvasConnectionDropTarget,
  resolveCanvasConnection,
} from "../src/app/canvas/canvas-connections.ts";

function node(id, x, y, width = 100, height = 100) {
  return { id, type: "image", x, y, width, height };
}

test("saved and active connection paths match the reference project formulas", () => {
  assert.equal(canvasConnectionPath({ x: 100, y: 50 }, { x: 140, y: 80 }), "M 100 50 C 150 50, 90 80, 140 80");
  assert.equal(activeCanvasConnectionPath({ x: 100, y: 50 }, { x: 140, y: 80 }), "M 100 50 C 120 50, 120 80, 140 80");
  assert.equal(canvasConnectionPath({ x: 100, y: 50 }, { x: 300, y: 80 }), "M 100 50 C 200 50, 200 80, 300 80");
});

test("ordinary nodes keep the drag origin as the upstream node from either handle", () => {
  const nodes = [node("a", 0, 0), { ...node("b", 200, 0), type: "text" }];
  assert.deepEqual(resolveCanvasConnection({ nodeID: "a", handleType: "source" }, "b", nodes), { sourceID: "a", targetID: "b" });
  assert.deepEqual(resolveCanvasConnection({ nodeID: "a", handleType: "target" }, "b", nodes), { sourceID: "a", targetID: "b" });
  assert.equal(resolveCanvasConnection({ nodeID: "a", handleType: "source" }, "a", nodes), null);
  assert.equal(resolveCanvasConnection({ nodeID: "missing", handleType: "source" }, "b", nodes), null);
});

test("configuration node direction matches the reference project", () => {
  const nodes = [
    node("image", 0, 0),
    { ...node("config-a", 200, 0), type: "config" },
    { ...node("config-b", 400, 0), type: "config" },
  ];
  assert.deepEqual(resolveCanvasConnection({ nodeID: "image", handleType: "target" }, "config-a", nodes), { sourceID: "image", targetID: "config-a" });
  assert.deepEqual(resolveCanvasConnection({ nodeID: "config-a", handleType: "target" }, "image", nodes), { sourceID: "image", targetID: "config-a" });
  assert.deepEqual(resolveCanvasConnection({ nodeID: "config-a", handleType: "source" }, "image", nodes), { sourceID: "config-a", targetID: "image" });
  assert.equal(resolveCanvasConnection({ nodeID: "config-a", handleType: "source" }, "config-b", nodes), null);
});

test("connection validation rejects only self and same-direction duplicates", () => {
  const connections = [{ id: "ab", from_node_id: "a", to_node_id: "b" }];
  assert.equal(canCreateCanvasConnection("a", "a", connections), false);
  assert.equal(canCreateCanvasConnection("a", "b", connections), false);
  assert.equal(canCreateCanvasConnection("b", "a", connections), true);
  assert.equal(canCreateCanvasConnection("b", "c", connections), true);
});

test("generation configuration nodes accept inputs but cannot connect to each other", () => {
  const nodes = [{ ...node("text", 0, 0), type: "text" }, { ...node("config-a", 200, 0), type: "config" }, { ...node("config-b", 400, 0), type: "config" }];
  const connections = [];
  assert.equal(canCreateCanvasConnection("text", "config-a", connections, nodes), true);
  assert.equal(canCreateCanvasConnection("config-a", "config-b", connections, nodes), false);
});

test("hover relations include only directly connected nodes and edges", () => {
  const connections = [
    { id: "ab", from_node_id: "a", to_node_id: "b" },
    { id: "ca", from_node_id: "c", to_node_id: "a" },
    { id: "bd", from_node_id: "b", to_node_id: "d" },
  ];
  const related = canvasConnectionRelations("a", connections);
  assert.deepEqual([...related.nodeIDs], ["a", "b", "c"]);
  assert.deepEqual([...related.connectionIDs], ["ab", "ca"]);
});

test("connection drop uses the reference hit padding and reports invalid nearby nodes", () => {
  const nodes = [node("source", 0, 0), node("target", 200, 0)];
  const origin = { nodeID: "source", handleType: "source" };
  const canConnect = (_current, otherNodeID) => otherNodeID === "target";

  assert.deepEqual(findCanvasConnectionDropTarget({ nodes, point: { x: 175, y: 50 }, zoom: 1, origin, canConnect }), {
    nodeID: "target",
    isNearNode: true,
  });
  assert.deepEqual(findCanvasConnectionDropTarget({ nodes, point: { x: 20, y: 20 }, zoom: 1, origin, canConnect }), {
    nodeID: "",
    isNearNode: true,
  });
  assert.deepEqual(findCanvasConnectionDropTarget({ nodes, point: { x: 500, y: 500 }, zoom: 1, origin, canConnect }), {
    nodeID: "",
    isNearNode: false,
  });
});

test("connection drop prefers an inside hit and the topmost node at equal priority", () => {
  const nodes = [node("bottom", 200, 0), node("top", 200, 0)];
  const origin = { nodeID: "source", handleType: "source" };
  const result = findCanvasConnectionDropTarget({
    nodes,
    point: { x: 250, y: 50 },
    zoom: 1,
    origin,
    canConnect: () => true,
  });
  assert.deepEqual(result, { nodeID: "top", isNearNode: true });
});

test("connection hit regions scale with canvas zoom", () => {
  const nodes = [node("source", 0, 0), node("target", 200, 0)];
  const origin = { nodeID: "source", handleType: "source" };
  const canConnect = (_current, otherNodeID) => otherNodeID === "target";
  assert.equal(findCanvasConnectionDropTarget({ nodes, point: { x: 180, y: 50 }, zoom: 2, origin, canConnect }).nodeID, "target");
  assert.equal(findCanvasConnectionDropTarget({ nodes, point: { x: 170, y: 50 }, zoom: 2, origin, canConnect }).isNearNode, false);
});
