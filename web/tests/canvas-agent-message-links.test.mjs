import assert from "node:assert/strict";
import { test } from "bun:test";
import { canvasAgentArtifactNodes, canvasAgentEditBranch, canvasAgentReplyTarget } from "../src/app/canvas/agent/canvas-agent-message-links.ts";

test("assistant replies remain linked to the user request they answer", () => {
  const firstRequest = { id: "user-1", role: "user", text: "第一条" };
  const secondRequest = { id: "user-2", role: "user", text: "第二条" };
  const reply = { id: "assistant-1", role: "assistant", replyToMessageID: "user-1", text: "回复" };
  assert.equal(canvasAgentReplyTarget([firstRequest, secondRequest, reply], reply), firstRequest);
});

test("assistant artifact links include created media nodes once and ignore missing nodes", () => {
  const reply = {
    id: "assistant-1",
    role: "assistant",
    text: "角色图节点已就绪。",
    trace: [
      { id: "create-1", type: "operation", kind: "generate", status: "success", label: "图片节点已创建", detail: "", nodeId: "image-1" },
      { id: "update-1", type: "operation", kind: "edit", status: "success", label: "更新了节点", detail: "", nodeId: "image-1" },
      { id: "create-2", type: "operation", kind: "create", status: "success", label: "创建了节点", detail: "", nodeId: "text-1" },
      { id: "missing", type: "operation", kind: "generate", status: "success", label: "创建了节点", detail: "", nodeId: "removed" },
    ],
  };
  const nodes = [
    { id: "image-1", type: "image", title: "小猫主角·角色定妆照" },
    { id: "text-1", type: "text", title: "角色设定" },
  ];
  assert.deepEqual(canvasAgentArtifactNodes(reply, nodes), [nodes[0], nodes[1]]);
});

test("editing a user message forks the conversation at that request and restores its saved state", () => {
  const initialState = { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] };
  const stateAfterFirst = { ...initialState, phase: "concept", brief: "第一轮已确认的方向" };
  const firstRequest = { id: "user-1", role: "user", text: "先规划品牌方向", agentStateBefore: initialState };
  const firstReply = { id: "assistant-1", role: "assistant", replyToMessageID: "user-1", text: "我已整理方向" };
  const editedRequest = { id: "user-2", role: "user", text: "再生成角色图", agentStateBefore: stateAfterFirst, contextCheckpointBefore: "较早对话摘要" };
  const laterReply = { id: "assistant-2", role: "assistant", replyToMessageID: "user-2", text: "角色图已就绪" };
  const laterRequest = { id: "user-3", role: "user", text: "再调整一下颜色" };
  const laterResponse = { id: "assistant-3", role: "assistant", replyToMessageID: "user-3", text: "已调整颜色" };
  const session = {
    id: "session-1", title: "创作", messages: [firstRequest, firstReply, editedRequest, laterReply, laterRequest, laterResponse],
    protocolMessages: [
      { role: "user", messageID: "user-1", content: "先规划品牌方向" },
      { role: "assistant", content: "我已整理方向" },
      { role: "user", messageID: "user-2", content: "再生成角色图" },
      { role: "assistant", content: "调用生成工具", toolCalls: [{ id: "generation", name: "generate_image", arguments: { title: "角色图" } }] },
      { role: "tool", name: "generate_image", toolCallId: "generation", content: JSON.stringify({ ok: true, nodeId: "image-1", taskId: "task-1", status: "success" }) },
      { role: "assistant", content: "角色图已就绪" },
      { role: "user", messageID: "user-3", content: "再调整一下颜色" },
      { role: "assistant", content: "已调整颜色" },
    ],
  };
  const branch = canvasAgentEditBranch(session, editedRequest);
  assert.deepEqual(branch.messages.map((message) => message.id), ["user-1", "assistant-1"]);
  assert.deepEqual(branch.protocolMessages.map((message) => message.messageID || message.content), ["user-1", "我已整理方向"]);
  assert.deepEqual(branch.agentState, stateAfterFirst);
  assert.equal(branch.contextCheckpoint, "较早对话摘要");
});

test("legacy user messages can still be matched to their protocol request", () => {
  const initialState = { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] };
  const request = { id: "legacy-user", role: "user", text: "同一句" };
  const session = {
    id: "legacy", title: "旧对话", messages: [request],
    protocolMessages: [{ role: "user", content: "同一句" }, { role: "assistant", content: "回复" }],
  };
  assert.deepEqual(canvasAgentEditBranch(session, request), { messages: [], protocolMessages: [], agentState: initialState, contextCheckpoint: undefined });
});

test("an edited message still forks correctly after its protocol history was compacted", () => {
  const before = { phase: "concept", brief: "已确认的品牌方向", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] };
  const request = { id: "user-2", role: "user", text: "生成角色图", agentStateBefore: before, contextCheckpointBefore: "编辑前的历史摘要" };
  const session = {
    id: "session-1", title: "创作", messages: [{ id: "user-1", role: "user", text: "旧消息" }, request, { id: "assistant-2", role: "assistant", text: "后续回复" }],
    protocolMessages: [{ role: "user", content: "摘要后的当前对话" }, { role: "assistant", content: "已完成" }],
  };
  assert.deepEqual(canvasAgentEditBranch(session, request), {
    messages: [{ id: "user-1", role: "user", text: "旧消息" }],
    protocolMessages: [],
    agentState: before,
    contextCheckpoint: "编辑前的历史摘要",
  });
});
