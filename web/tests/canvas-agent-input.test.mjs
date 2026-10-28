import assert from "node:assert/strict";
import { test } from "bun:test";
import { splitCanvasAgentContent, splitCanvasAgentText, summarizeCanvasAgentMaterial } from "../src/app/canvas/agent/canvas-agent-input.ts";
import { estimateCanvasAgentTokens } from "../src/app/canvas/agent/canvas-agent-memory.ts";
import { limitCanvasAgentContext } from "../src/app/canvas/agent/canvas-agent-context.ts";

const images = (count) => Array.from({ length: count }, (_, index) => [
  { type: "text", text: `原始图片 ${index + 1}，节点 node-${index}` },
  { type: "image_url", image_url: { url: `data:image/png;base64,${index}` } },
]).flat();

test("batches every image exactly once with its original caption and node ID", () => {
  const content = [{ type: "text", text: "先做白底图，再做宣传图" }, ...images(31)];
  const batches = splitCanvasAgentContent(content);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), content);
  for (const batch of batches) {
    assert.ok(estimateCanvasAgentTokens(batch) <= 8_000);
    for (const [index, part] of batch.entries()) {
      if (part.type !== "image_url") continue;
      assert.equal(batch[index - 1].type, "text");
      assert.ok(batch[index - 1].text.endsWith(`node-${part.image_url.url.split(",")[1]}`));
    }
  }
});

test("splits long Unicode text without losing characters or JSON escaping costs", () => {
  const text = '🙂要求\n"真实摄影"\\禁止改结构'.repeat(4_000);
  const chunks = splitCanvasAgentText(text, 1_000);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => estimateCanvasAgentTokens(JSON.stringify(chunk)) <= 1_010));
  assert.ok(chunks.every((chunk) => !chunk.includes("\ufffd")));
});

test("splits rejected analysis batches further and carries forward successful analysis", async () => {
  const accepted = [];
  let rejected = 0;
  const result = await summarizeCanvasAgentMaterial({
    content: images(9),
    summarize: async (previous, batch) => {
      const imageParts = batch.filter((part) => part.type === "image_url");
      if (imageParts.length > 1) { rejected += 1; throw new Error("maximum context length exceeded"); }
      accepted.push(imageParts[0].image_url.url);
      return `${previous || ""} ${batch[0].text}`;
    },
  });
  assert.ok(rejected > 0);
  assert.equal(new Set(accepted).size, 9);
  assert.equal(accepted.length, 9);
  for (let index = 0; index < 9; index += 1) assert.ok(result.includes(`node-${index}`));
});

test("does not drop an image when even an individual image exceeds model capacity", async () => {
  let requests = 0;
  await assert.rejects(summarizeCanvasAgentMaterial({ content: images(1), summarize: async () => {
    requests += 1;
    throw new Error("maximum context length exceeded");
  } }), /context length/);
  assert.equal(requests, 1);
});

test("stops analysis on abort and rejects empty or oversized summaries", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(summarizeCanvasAgentMaterial({ content: images(12), signal: controller.signal, summarize: async () => {
    calls += 1;
    controller.abort();
    return "summary";
  } }), { name: "AbortError" });
  assert.equal(calls, 1);
  for (const summary of ["", "字".repeat(4_000)]) {
    await assert.rejects(summarizeCanvasAgentMaterial({ content: images(1), summarize: async () => summary }), /有效的摘要/);
  }
});

test("large canvas uses a bounded node index without changing original contents", () => {
  const context = {
    project: { id: "project", title: "Product", nodeCount: 120, connectionCount: 0 },
    agentState: { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] },
    selectedNodeIds: ["node-0"],
    nodes: Array.from({ length: 120 }, (_, index) => ({ id: `node-${index}`, type: "text", title: `产品 ${index}`, text: "不能改变结构".repeat(600), prompt: "长提示词".repeat(600) })),
    connections: [], generation: {}, tasks: [],
  };
  const before = structuredClone(context);
  const limited = limitCanvasAgentContext(context, 2_000);
  assert.ok(estimateCanvasAgentTokens(limited) <= 2_000);
  assert.deepEqual(limited.selectedNodeIds, ["node-0"]);
  assert.equal(limited.nodes[0].id, "node-0");
  assert.equal(limited.nodes[0].detailsOmitted, true);
  assert.equal(limited.omittedNodeCount, 120 - limited.nodes.length);
  assert.deepEqual(context, before);
});
