import assert from "node:assert/strict";
import test from "node:test";

import {
  canvasBatchMotion,
  duplicateCanvasNodeGroup,
  detachCanvasBatchRootForReplacement,
  expandCanvasBatchNodeIDs,
  isCanvasBatchChildHidden,
  reconcileCanvasBatchesAfterRemoval,
  setCanvasBatchPrimary,
  syncCanvasBatchRootAfterRetry,
  visibleCanvasNodes,
} from "../src/app/canvas/canvas-batches.ts";

function node(id, values = {}) {
  return { id, type: "image", x: 0, y: 0, width: 100, height: 100, scale_x: 1, scale_y: 1, ...values };
}

test("collapsed batch children are hidden while expanded children remain visible", () => {
  const collapsed = node("root", { batch_child_ids: ["a", "b"], batch_expanded: false });
  const childA = node("a", { batch_root_id: "root" });
  const childB = node("b", { batch_root_id: "root" });
  const nodes = [collapsed, childA, childB, node("standalone")];
  assert.equal(isCanvasBatchChildHidden(childA, nodes), true);
  assert.deepEqual(visibleCanvasNodes(nodes).map((item) => item.id), ["root", "standalone"]);
  assert.deepEqual(visibleCanvasNodes(nodes, new Set(["root"])).map((item) => item.id), ["root", "a", "b", "standalone"]);
  assert.equal(isCanvasBatchChildHidden(childA, [{ ...collapsed, batch_expanded: true }, childA, childB]), false);
});

test("a batch without an explicit expansion flag starts collapsed like the reference project", () => {
  const root = node("root", { batch_child_ids: ["a", "b"] });
  const childA = node("a", { batch_root_id: "root" });
  const childB = node("b", { batch_root_id: "root" });
  assert.deepEqual(visibleCanvasNodes([root, childA, childB]).map((item) => item.id), ["root"]);
});

test("batch children animate toward the same stack positions as the reference project", () => {
  const root = node("root", { x: 100, y: 80, batch_child_ids: ["a", "b"] });
  const childA = node("a", { x: 500, y: 240, batch_root_id: "root" });
  const childB = node("b", { x: 900, y: 520, batch_root_id: "root" });
  const nodeByID = new Map([root, childA, childB].map((item) => [item.id, item]));
  assert.deepEqual(canvasBatchMotion(childA, nodeByID), { x: -366, y: -146, index: 0 });
  assert.deepEqual(canvasBatchMotion(childB, nodeByID), { x: -752, y: -418, index: 1 });
  assert.equal(canvasBatchMotion(node("orphan", { batch_root_id: "missing" }), nodeByID), undefined);
});

test("moving or deleting a batch root includes all batch children", () => {
  const nodes = [node("root", { batch_child_ids: ["a", "b"] }), node("a", { batch_root_id: "root" }), node("b", { batch_root_id: "root" })];
  assert.deepEqual([...expandCanvasBatchNodeIDs(new Set(["root"]), nodes)], ["root", "a", "b"]);
  assert.deepEqual(reconcileCanvasBatchesAfterRemoval(nodes, new Set(["root", "a", "b"])), []);
});

test("removing a child dissolves a batch that only has one result left", () => {
  const root = node("root", { url: "old", batch_child_ids: ["a", "b"], batch_primary_id: "a", batch_expanded: true });
  const childA = node("a", { url: "a.png", batch_root_id: "root" });
  const childB = node("b", { url: "b.png", thumbnail_url: "b-thumb.png", natural_width: 2048, natural_height: 1024, free_resize: true, batch_root_id: "root" });
  const next = reconcileCanvasBatchesAfterRemoval([root, childA, childB], new Set(["a"]));
  assert.deepEqual(next[0], { id: "root", type: "image", x: 0, y: 0, width: 100, height: 100, scale_x: 1, scale_y: 1, url: "b.png", thumbnail_url: "b-thumb.png", natural_width: 2048, natural_height: 1024, free_resize: true });
  assert.equal(next[1].batch_root_id, undefined);
});

test("removing the primary child selects a complete replacement preview", () => {
  const root = node("root", { url: "a.png", natural_width: 1024, natural_height: 1024, batch_child_ids: ["a", "b", "c"], batch_primary_id: "a", batch_expanded: true });
  const childA = node("a", { url: "a.png", batch_root_id: "root" });
  const childB = node("b", { url: "b.png", thumbnail_url: "b-thumb.png", natural_width: 1536, natural_height: 1024, free_resize: false, batch_root_id: "root" });
  const childC = node("c", { url: "c.png", batch_root_id: "root" });
  const next = reconcileCanvasBatchesAfterRemoval([root, childA, childB, childC], new Set(["a"]));
  assert.deepEqual(next[0], {
    ...root,
    url: "b.png",
    thumbnail_url: "b-thumb.png",
    natural_width: 1536,
    natural_height: 1024,
    free_resize: false,
    batch_child_ids: ["b", "c"],
    batch_primary_id: "b",
  });
  assert.equal(next[1].batch_root_id, "root");
  assert.equal(next[2].batch_root_id, "root");
});

test("a batch child can become the root preview", () => {
  const root = node("root", { batch_child_ids: ["a", "b"], batch_primary_id: "a" });
  const childA = node("a", { url: "a.png", batch_root_id: "root" });
  const childB = node("b", { url: "b.png", thumbnail_url: "b-thumb.png", width: 320, height: 180, batch_root_id: "root" });
  const next = setCanvasBatchPrimary([root, childA, childB], "b");
  assert.deepEqual(next[0], { ...root, url: "b.png", thumbnail_url: "b-thumb.png", width: 320, height: 180, batch_primary_id: "b" });
});

test("retrying the current or first usable batch child refreshes the root", () => {
  const failedRoot = node("root", { generation_status: "error", generation_error: "全部失败", batch_child_ids: ["a", "b"] });
  const retriedA = node("a", { url: "a.png", width: 320, height: 180, generation_status: "success", batch_root_id: "root" });
  const failedB = node("b", { generation_status: "error", batch_root_id: "root" });
  const recovered = syncCanvasBatchRootAfterRetry([failedRoot, retriedA, failedB], "a");
  assert.deepEqual(recovered[0], {
    ...failedRoot,
    url: "a.png",
    thumbnail_url: "",
    width: 320,
    height: 180,
    batch_primary_id: "a",
    generation_status: "success",
    generation_error: "",
  });

  const retriedPrimary = node("a", { url: "a-v2.png", batch_root_id: "root" });
  const refreshed = syncCanvasBatchRootAfterRetry([{ ...recovered[0], batch_primary_id: "a" }, retriedPrimary, failedB], "a");
  assert.equal(refreshed[0].url, "a-v2.png");
});

test("retrying a non-primary batch child preserves an existing usable preview", () => {
  const root = node("root", { url: "a.png", batch_child_ids: ["a", "b"], batch_primary_id: "a", generation_status: "success" });
  const childA = node("a", { url: "a.png", batch_root_id: "root" });
  const childB = node("b", { url: "b-v2.png", batch_root_id: "root" });
  const next = syncCanvasBatchRootAfterRetry([root, childA, childB], "b");
  assert.deepEqual(next[0], root);
});

test("replacing a batch root removes stale children and their internal edges", () => {
  const root = node("root", { batch_child_ids: ["a", "b"], batch_primary_id: "a" });
  const childA = node("a", { batch_root_id: "root" });
  const childB = node("b", { batch_root_id: "root" });
  const source = node("source", { type: "text" });
  const result = detachCanvasBatchRootForReplacement(
    [source, root, childA, childB],
    [
      { id: "source-root", from_node_id: "source", to_node_id: "root" },
      { id: "root-a", from_node_id: "root", to_node_id: "a" },
      { id: "root-b", from_node_id: "root", to_node_id: "b" },
    ],
    "root",
  );
  assert.deepEqual(result.nodes.map((item) => item.id), ["source", "root"]);
  assert.deepEqual(result.connections.map((item) => item.id), ["source-root"]);
  assert.deepEqual([...result.removedNodeIDs], ["a", "b"]);
});

test("duplicating a batch remaps the complete group and its internal connections", () => {
  const root = node("root", { title: "结果组", batch_child_ids: ["a", "b"], batch_primary_id: "b", batch_expanded: false });
  const childA = node("a", { batch_root_id: "root" });
  const childB = node("b", { batch_root_id: "root" });
  let index = 0;
  const duplicated = duplicateCanvasNodeGroup("root", [root, childA, childB], [
    { id: "root-a", from_node_id: "root", to_node_id: "a" },
    { id: "root-b", from_node_id: "root", to_node_id: "b" },
  ], (type) => `${type}-copy-${++index}`, () => "now");

  assert.ok(duplicated);
  const [rootCopy, childACopy, childBCopy] = duplicated.nodes;
  assert.equal(rootCopy.title, "结果组 Copy");
  assert.deepEqual(rootCopy.batch_child_ids, [childACopy.id, childBCopy.id]);
  assert.equal(rootCopy.batch_primary_id, childBCopy.id);
  assert.equal(childACopy.batch_root_id, rootCopy.id);
  assert.equal(childBCopy.batch_root_id, rootCopy.id);
  assert.deepEqual(duplicated.connections.map((connection) => [connection.from_node_id, connection.to_node_id]), [
    [rootCopy.id, childACopy.id],
    [rootCopy.id, childBCopy.id],
  ]);
  assert.equal(duplicated.selectedNodeID, rootCopy.id);
});

test("duplicating one batch child produces a valid standalone node", () => {
  const child = node("child", { batch_root_id: "root" });
  const duplicated = duplicateCanvasNodeGroup("child", [child], [], () => "child-copy", () => "now");
  assert.ok(duplicated);
  assert.equal(duplicated.nodes[0].batch_root_id, undefined);
});
