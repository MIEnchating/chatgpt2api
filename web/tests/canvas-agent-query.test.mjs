import assert from "node:assert/strict";
import { test } from "bun:test";
import { queryCanvasAgentNodes } from "../src/app/canvas/agent/canvas-agent-query.ts";

test("Agent finds nodes beyond the initial context and paginates matching nodes", () => {
  const nodes = Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, type: i % 2 ? "text" : "image", title: `镜头 ${i}`, prompt: i >= 120 ? "夜景 PLAN" : "白天" }));
  const byId = queryCanvasAgentNodes(nodes, { nodeId: "n250" });
  assert.equal(byId.total, 1);
  assert.equal(byId.nodes[0].id, "n250");
  const result = queryCanvasAgentNodes(nodes, { keyword: "plan", type: "text", page: 2, pageSize: 20 });
  assert.equal(result.total, 90);
  assert.equal(result.nodes.length, 20);
  assert.equal(result.nodes[0].id, "n161");
  assert.equal(result.hasMore, true);
  const last = queryCanvasAgentNodes(nodes, { keyword: "plan", type: "text", page: 5, pageSize: 20 });
  assert.equal(last.nodes.length, 10);
  assert.equal(last.hasMore, false);
  assert.equal(queryCanvasAgentNodes(nodes, { keyword: "不存在" }).total, 0);
});
