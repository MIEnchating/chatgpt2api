import assert from "node:assert/strict";
import test from "node:test";

import {
  CANVAS_GROUP_PADDING,
  canvasNodeBounds,
  detachCanvasNodesFromRemovedGroups,
  expandCanvasGroupNodeIDs,
  findCanvasGroupDropTarget,
  findContainingCanvasGroupID,
  snapCanvasNodesIntoGroup,
} from "../src/app/canvas/canvas-groups.ts";

function node(id, values = {}) {
  return { id, type: "image", x: 0, y: 0, width: 100, height: 100, scale_x: 1, scale_y: 1, ...values };
}

test("group bounds and padding match the reference project", () => {
  assert.equal(CANVAS_GROUP_PADDING, 24);
  assert.deepEqual(canvasNodeBounds([node("a", { x: 10, y: 20 }), node("b", { x: 180, y: -10, width: 80, height: 140 })]), {
    left: 10,
    top: -10,
    right: 260,
    bottom: 130,
  });
});

test("dragging a group expands the moving set to its direct children", () => {
  const nodes = [node("group", { type: "group" }), node("a", { group_id: "group" }), node("b", { group_id: "group" }), node("outside")];
  assert.deepEqual([...expandCanvasGroupNodeIDs(new Set(["group"]), nodes)], ["group", "a", "b"]);
});

test("ordinary nodes use their center to enter and leave the topmost group", () => {
  const bottom = node("bottom", { type: "group", width: 300, height: 300 });
  const top = node("top", { type: "group", x: 20, y: 20, width: 300, height: 300 });
  const moving = node("moving", { x: 50, y: 50 });
  const nodes = [bottom, top, moving];
  assert.equal(findCanvasGroupDropTarget(new Set(["moving"]), nodes)?.id, "top");
  assert.equal(findContainingCanvasGroupID(moving, nodes), "top");
  assert.equal(findCanvasGroupDropTarget(new Set(["top"]), nodes), null);
});

test("dropping nodes clamps their bounds inside the group and records membership", () => {
  const group = node("group", { type: "group", x: 100, y: 100, width: 300, height: 260 });
  const moving = node("moving", { x: 20, y: 40, width: 120, height: 100 });
  const next = snapCanvasNodesIntoGroup(new Set(["moving"]), [group, moving], group);
  assert.deepEqual(next[1], { ...moving, x: 124, y: 124, group_id: "group" });
});

test("deleting a group keeps its children and removes only membership", () => {
  const group = node("group", { type: "group" });
  const child = node("child", { group_id: "group" });
  assert.deepEqual(detachCanvasNodesFromRemovedGroups([group, child], new Set(["group"])), [{ ...child, group_id: undefined }]);
});
