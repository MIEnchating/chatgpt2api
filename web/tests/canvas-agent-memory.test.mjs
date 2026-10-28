import assert from "node:assert/strict";
import { test } from "bun:test";
import { compactCanvasAgentHistory, estimateCanvasAgentTokens } from "../src/app/canvas/agent/canvas-agent-memory.ts";

function history() {
  return [
    { role: "user", content: "保留红色衣服" },
    { role: "assistant", toolCalls: [{ id: "a", name: "get_canvas_summary", arguments: {} }] },
    { role: "tool", toolCallId: "a", name: "get_canvas_summary", content: "真实节点" },
    { role: "assistant", content: "已确认" },
    { role: "user", content: "下一步" },
  ];
}

test("summarizes complete old turns while keeping the active turn intact", async () => {
  const messages = history();
  let captured;
  const result = await compactCanvasAgentHistory({ messages, summarize: async (_, text) => { captured = JSON.parse(text); return "红衣约束，节点 ID a 需核对"; } });
  assert.deepEqual(captured, messages.slice(0, 4));
  assert.deepEqual(result.messages, [messages[4]]);
  assert.equal(result.checkpoint, "红衣约束，节点 ID a 需核对");
  assert.equal(messages.length, 5);
});

test("summary failure leaves all original messages and prior checkpoint untouched", async () => {
  const messages = history();
  const before = structuredClone(messages);
  for (const summarize of [async () => "", async () => { throw new Error("offline"); }]) {
    await assert.rejects(compactCanvasAgentHistory({ messages, checkpoint: "原摘要", summarize }));
    assert.deepEqual(messages, before);
  }
});

test("token estimates account for UTF-8 text rather than message count", () => {
  assert.ok(estimateCanvasAgentTokens("文".repeat(10_000)) > 10_000);
  assert.ok(estimateCanvasAgentTokens("x".repeat(100_000)) > 30_000);
});

test("does not compact the only unfinished user turn", async () => {
  const messages = [{ role: "user", content: "long current prompt" }];
  const result = await compactCanvasAgentHistory({ messages, summarize: async () => { throw new Error("must not call"); } });
  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

test("treats image bytes as media and keeps encrypted reasoning out of summaries", async () => {
  const largeImage = "data:image/png;base64," + "A".repeat(200000);
  assert.ok(estimateCanvasAgentTokens({ type: "image_url", image_url: { url: largeImage } }) < 3000);
  let summaryInput;
  await compactCanvasAgentHistory({ messages: [
    { role: "user", content: [{ type: "text", text: "红衣" }, { type: "image_url", image_url: { url: largeImage } }] },
    { role: "assistant", content: "完成", responseItems: [{ type: "reasoning", encrypted_content: "opaque-reasoning" }] },
    { role: "user", content: "下一步" },
  ], summarize: async (_, history) => { summaryInput = history; return "红衣"; } });
  assert.doesNotMatch(summaryInput, /opaque-reasoning|data:image/);
  assert.match(summaryInput, /红衣/);
});

test("compacts completed tool rounds within the active user turn without orphaning calls", async () => {
  const messages = history().slice(0, 4);
  const result = await compactCanvasAgentHistory({
    messages, checkpoint: "原约束", includeActiveProgress: true,
    summarize: async (previous, text) => {
      assert.equal(previous, "原约束");
      assert.deepEqual(JSON.parse(text), messages.slice(1));
      return "原约束；已调用 a 查询节点，未提交生成";
    },
  });
  assert.equal(result.compacted, true);
  assert.deepEqual(result.messages, [messages[0]]);
  assert.match(result.checkpoint, /已调用 a/);
  assert.equal(messages.length, 4);
});

test("never compacts incomplete or orphaned tool results in the active turn", async () => {
  for (const messages of [history().slice(0, 2), [history()[0], history()[2]]]) {
    const result = await compactCanvasAgentHistory({ messages, includeActiveProgress: true, summarize: async () => { throw new Error("must not summarize"); } });
    assert.equal(result.compacted, false);
    assert.equal(result.messages, messages);
  }
});
