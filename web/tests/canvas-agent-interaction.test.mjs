import assert from "node:assert/strict";
import { test } from "bun:test";
import { canvasAgentQuestionMediaChoice } from "../src/app/canvas/agent/canvas-agent-interaction.ts";

const question = { id: "q", purpose: "media_generation", kind: "confirmation", question: "要生成这些节点吗？", reason: "", options: [], request: "" };

test("media confirmation treats negated generation answers as deferral", () => {
  for (const answer of ["不要生成", "不用生成", "不必立即生成", "不可以", "不同意", "别生成", "暂不生成，继续规划", "没确认", "还没同意", "尚未确认", "没有批准"]) {
    assert.equal(canvasAgentQuestionMediaChoice(question, answer), "defer", answer);
  }
});

test("media confirmation keeps affirmative answers as generation", () => {
  for (const answer of ["立即生成", "可以", "确认", "好的，不用担心，生成吧", "不用确认直接生成", "没问题，开始生成"]) {
    assert.equal(canvasAgentQuestionMediaChoice(question, answer), "generate", answer);
  }
});
