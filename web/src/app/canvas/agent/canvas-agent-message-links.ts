import type { CanvasAssistantMessage } from "./canvas-agent-types";
import { canvasAgentPlan } from "./canvas-agent-interaction";
import { applyAgentState, applyTaskResult, createCanvasAgentState } from "./canvas-agent-runtime";
import type { CanvasAgentToolResult } from "./canvas-agent-tools";
import type { CanvasAgentProtocolMessage, CanvasAssistantSession } from "./canvas-agent-types";

export function canvasAgentReplyTarget(messages: readonly CanvasAssistantMessage[], assistant: CanvasAssistantMessage) {
  const linked = assistant.replyToMessageID
    ? messages.find((message) => message.id === assistant.replyToMessageID && message.role === "user")
    : undefined;
  if (linked) return linked;
  const index = messages.findIndex((message) => message.id === assistant.id);
  return messages.slice(0, index).findLast((message) => message.role === "user");
}

export function canvasAgentArtifactNodes<T extends { id: string; type: string }>(message: CanvasAssistantMessage, nodes: readonly T[]) {
  const nodeIDs = new Set(message.trace?.flatMap((entry) => entry.type === "operation" && ["create", "edit", "generate"].includes(entry.kind) && entry.nodeId ? [entry.nodeId] : []) || []);
  return [...nodeIDs].flatMap((id) => {
    const node = nodes.find((item) => item.id === id);
    return node ? [node] : [];
  });
}

export function canvasAgentProtocolUserMessageIndex(protocolMessages: readonly CanvasAgentProtocolMessage[], userMessage: CanvasAssistantMessage, sessionMessages: readonly CanvasAssistantMessage[]) {
  const linkedIndex = protocolMessages.findIndex((message) => message.role === "user" && message.messageID === userMessage.id);
  if (linkedIndex >= 0) return linkedIndex;
  const content = userMessage.text.trim();
  if (!content) return -1;
  const referenceIDs = userMessage.references?.map((reference) => reference.id) || [];
  const matches = (message: CanvasAgentProtocolMessage) => {
    if (message.role !== "user") return false;
    const text = protocolContentText(message.content);
    return text.includes(content) && referenceIDs.every((id) => text.includes(id));
  };
  const targetIndex = sessionMessages.findIndex((message) => message.id === userMessage.id);
  const equivalentVisible = sessionMessages.slice(0, targetIndex + 1).filter((message) => message.role === "user"
    && message.text.trim() === content
    && (message.references || []).map((reference) => reference.id).join("\u0000") === referenceIDs.join("\u0000"));
  const candidates = protocolMessages.flatMap((message, index) => matches(message) ? [index] : []);
  const occurrence = equivalentVisible.findIndex((message) => message.id === userMessage.id);
  if (candidates.length >= equivalentVisible.length) return candidates[occurrence] ?? -1;
  return candidates.length === 1 && occurrence === equivalentVisible.length - 1 ? candidates[0] : -1;
}

export function canvasAgentStateFromProtocol(protocolMessages: readonly CanvasAgentProtocolMessage[]) {
  let state = createCanvasAgentState();
  const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  for (const message of protocolMessages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls || []) calls.set(call.id, call);
      continue;
    }
    if (message.role === "user") {
      const content = protocolContentText(message.content);
      if (content.startsWith("暂不生成，继续规划")) state = { ...state, mediaGenerationDeferred: true };
      else if (content.startsWith("立即生成已有待处理节点")) state = { ...state, mediaGenerationDeferred: false };
      continue;
    }
    if (message.role !== "tool") continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    let result: CanvasAgentToolResult;
    try {
      const parsed: unknown = JSON.parse(message.content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      if (typeof (parsed as Record<string, unknown>).ok !== "boolean") continue;
      result = parsed as CanvasAgentToolResult;
    } catch { continue; }
    if (call.name === "ask_user_question") state = { ...state, pendingQuestion: undefined };
    else if (result.ok === true && call.name === "update_plan") state = { ...state, plan: canvasAgentPlan({ id: message.toolCallId, name: call.name, arguments: call.arguments }) };
    else if (result.ok === true && call.name === "set_agent_state") state = applyAgentState(state, call.arguments);
    else state = applyTaskResult(state, result);
  }
  return state;
}

export function canvasAgentEditBranch(session: CanvasAssistantSession, userMessage: CanvasAssistantMessage) {
  const messageIndex = session.messages.findIndex((message) => message.id === userMessage.id && message.role === "user" && !message.questionAnswerFor);
  if (messageIndex < 0) return undefined;
  const protocolIndex = canvasAgentProtocolUserMessageIndex(session.protocolMessages, userMessage, session.messages);
  const hasSnapshot = Boolean(userMessage.agentStateBefore);
  if (protocolIndex < 0 && !hasSnapshot) return undefined;
  const protocolMessages = protocolIndex < 0 ? [] : session.protocolMessages.slice(0, protocolIndex);
  return {
    messages: session.messages.slice(0, messageIndex),
    protocolMessages,
    agentState: userMessage.agentStateBefore || canvasAgentStateFromProtocol(protocolMessages),
    contextCheckpoint: hasSnapshot ? userMessage.contextCheckpointBefore : undefined,
  };
}

function protocolContentText(content: CanvasAgentProtocolMessage["content"]) {
  return !content ? "" : typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
