import assert from "node:assert/strict";
import { test } from "bun:test";
import { isCanvasAgentConversation } from "../src/app/canvas/agent/canvas-agent-conversation.ts";
test("standalone social and guidance requests use the conversational path", () => {
  for (const text of ["你好啊", "你可以干什么呢？", " Hello! ", "谢谢", "引导对话", "给我一些建议", "结合刚才的内容给我一些方向"]) assert.equal(isCanvasAgentConversation(text), true, text);
  for (const text of ["你好，帮我生成海报", "你可以生成一段视频吗", "引导对话，直接生成音频", "继续", "确认", "谢谢，继续生成下一张"]) assert.equal(isCanvasAgentConversation(text), false, text);
});
