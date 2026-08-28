import type { CanvasAgentContext } from "./canvas-agent-context";
import { requestCanvasAgentTurn } from "./canvas-agent-request";
import { buildCanvasAgentSkillPrompt } from "./canvas-agent-skills";
import { CANVAS_AGENT_TOOLS, canvasAgentActionLabel, isCanvasAgentMediaAction, normalizeCanvasAgentAction, userLikelyRequestedCanvasAction, type CanvasAgentAction, type CanvasAgentToolResult } from "./canvas-agent-tools";
import type { CanvasAgentContent, CanvasAgentProtocolMessage, CanvasAgentState, CanvasAssistantMessageStatus, CanvasAssistantReference } from "./canvas-agent-types";

const MAX_AGENT_STEPS = 12;
const MAX_PROTOCOL_MESSAGES = 120;

export type CanvasAgentRuntimeEvent = { status: CanvasAssistantMessageStatus; label: string };

export type RunCanvasAgentInput = {
  model: string;
  relayTokenName: string;
  configuredSystemPrompt?: string;
  initialState: CanvasAgentState;
  protocolMessages: CanvasAgentProtocolMessage[];
  userText: string;
  references: CanvasAssistantReference[];
  getContext: (state: CanvasAgentState) => CanvasAgentContext;
  executeAction: (action: CanvasAgentAction) => Promise<CanvasAgentToolResult>;
  onEvent?: (event: CanvasAgentRuntimeEvent) => void;
  onCheckpoint?: (checkpoint: { state: CanvasAgentState; protocolMessages: CanvasAgentProtocolMessage[] }) => void;
  signal?: AbortSignal;
};

export function createCanvasAgentState(): CanvasAgentState {
  return { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] };
}

export async function runCanvasAgent(input: RunCanvasAgentInput) {
  let state = input.initialState;
  let hasExecutedActions = false;
  let protocolMessages = trimProtocolMessages([...input.protocolMessages, { role: "user" as const, content: buildUserContent(input.userText, input.references, input.model) }]);
  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    throwIfAborted(input.signal);
    input.onEvent?.({ status: "thinking", label: step ? "正在根据画布结果继续" : "正在理解画布和创作目标" });
    const turn = await requestCanvasAgentTurn({
      model: input.model,
      relayTokenName: input.relayTokenName,
      prompt: input.userText,
      systemPrompt: combineCanvasAgentSystemPrompt(
        input.configuredSystemPrompt,
        buildCanvasAgentSkillPrompt(state.phase, input.userText, input.getContext(state)),
      ),
      messages: protocolMessages,
      tools: CANVAS_AGENT_TOOLS,
      signal: input.signal,
    });
    const nativeActions = turn.toolCalls.map((toolCall) => normalizeCanvasAgentAction(toolCall.name, toolCall.arguments, toolCall.id));
    const arrangeRequested = /整理|排列|排序|对齐|布局|排版|重新摆放/.test(input.userText) && !/(不要|别|无需|不用).{0,8}(整理|排列|排序|对齐|布局|排版|重新摆放)/.test(input.userText);
    const actions = nativeActions.filter((action) => action.name !== "arrange_nodes" || arrangeRequested);
    if (!actions.length) {
      const reply = turn.content.trim();
      if (!hasExecutedActions && userLikelyRequestedCanvasAction(input.userText) && !looksLikeClarifyingQuestion(reply)) {
        const unsupported = "当前文本模型没有返回可执行的画布工具指令。可以继续讨论文本内容，但无法自动创建节点或执行生成；请更换支持 Tool Calling 的文本模型。";
        protocolMessages = trimProtocolMessages([...protocolMessages, { role: "assistant", content: unsupported }]);
        return { reply: unsupported, state, protocolMessages: persistProtocolMessages(protocolMessages) };
      }
      const finalReply = reply || "我已经读取当前画布。请告诉我下一步要继续完善哪一部分。";
      protocolMessages = trimProtocolMessages([...protocolMessages, { role: "assistant", content: finalReply }]);
      return { reply: finalReply, state, protocolMessages: persistProtocolMessages(protocolMessages) };
    }
    input.onEvent?.({ status: "running", label: actions.length === 1 ? canvasAgentActionLabel(actions[0]) : `正在执行 ${actions.length} 个画布操作` });
    const assistantToolMessage: CanvasAgentProtocolMessage = {
      role: "assistant",
      content: turn.content || undefined,
      ...(turn.reasoningContent !== undefined ? { reasoningContent: turn.reasoningContent } : {}),
      toolCalls: actions.map((action) => ({ id: action.id, name: action.name, arguments: action.arguments })),
    };
    const results = await executeActions(actions, state, input.executeAction, input.signal, input.onEvent);
    hasExecutedActions = true;
    state = results.state;
    protocolMessages = trimProtocolMessages([
      ...protocolMessages,
      assistantToolMessage,
      ...results.items.map(({ action, result }) => ({
        role: "tool" as const,
        toolCallId: action.id,
        name: action.name,
        content: JSON.stringify(result),
      })),
    ]);
    input.onCheckpoint?.({ state, protocolMessages: persistProtocolMessages(protocolMessages) });
  }
  const reply = "本轮已达到安全操作步数上限，已完成的节点和任务均已保存。你可以让我继续下一步。";
  return { reply, state, protocolMessages: persistProtocolMessages([...protocolMessages, { role: "assistant", content: reply }]) };
}

async function executeActions(actions: CanvasAgentAction[], initialState: CanvasAgentState, executeAction: (action: CanvasAgentAction) => Promise<CanvasAgentToolResult>, signal?: AbortSignal, onEvent?: (event: CanvasAgentRuntimeEvent) => void) {
  let state = initialState;
  const executeOne = async (action: CanvasAgentAction) => {
    throwIfAborted(signal);
    onEvent?.({ status: "running", label: canvasAgentActionLabel(action) });
    try {
      const result = await executeAction(action);
      if (action.name === "set_agent_state" && result.ok) state = applyAgentState(state, action.arguments);
      else state = applyTaskResult(state, result);
      return { action, result };
    } catch (error) {
      return { action, result: { ok: false, code: "tool_execution_failed", message: error instanceof Error ? error.message : "工具执行失败" } };
    }
  };
  const items = actions.every(isCanvasAgentMediaAction)
    ? await Promise.all(actions.map(executeOne))
    : await actions.reduce<Promise<Array<{ action: CanvasAgentAction; result: CanvasAgentToolResult }>>>(async (pending, action) => [...await pending, await executeOne(action)], Promise.resolve([]));
  return { items, state };
}

function buildUserContent(text: string, references: CanvasAssistantReference[], model: string): CanvasAgentContent {
  const referenceText = references.length ? `\n\n本次输入中的节点占位与真实节点一一对应，请按占位分别理解和操作：${references.map((item) => `${item.label || item.title} → 节点 ${item.id}（${item.title}）`).join("；")}` : "";
  const imageReferences = references.filter((item) => item.dataUrl && (item.dataUrl.startsWith("data:image/") || /^https?:\/\//.test(item.dataUrl)));
  const imageOrderText = imageReferences.length ? `\n随消息附带的图片顺序：${imageReferences.map((item, index) => `第 ${index + 1} 张 = ${item.label || item.title}`).join("；")}` : "";
  const images = supportsImageInput(model) ? imageReferences.map((item) => ({ type: "image_url" as const, image_url: { url: item.dataUrl as string } })) : [];
  return images.length ? [{ type: "text", text: text + referenceText + imageOrderText }, ...images] : text + referenceText;
}

function supportsImageInput(model: string) { return model.trim().toLowerCase() === "mimo-v2.5" || /gpt-(?:4o|4\.1|5)|(?:^|[\\/_-])o[134](?:[\\/_-]|$)|gemini|claude|qwen.*(?:vl|vision)|glm-4v|pixtral|llava|internvl|deepseek.*vl|vision/i.test(model); }
function combineCanvasAgentSystemPrompt(configured: string | undefined, agentPrompt: string) { const prefix = configured?.trim() || ""; return prefix ? `${prefix}\n\n${agentPrompt}` : agentPrompt; }
function looksLikeClarifyingQuestion(text: string) { return /[?？]|请(?:告诉|选择|确认|提供)|需要.{0,12}(?:吗|呢)|希望.{0,12}(?:吗|呢)/.test(text); }
function trimProtocolMessages(messages: CanvasAgentProtocolMessage[]) { const result = messages.slice(-MAX_PROTOCOL_MESSAGES); while (result[0]?.role === "tool") result.shift(); return result; }
function persistProtocolMessages(messages: CanvasAgentProtocolMessage[]) { return messages.map((message): CanvasAgentProtocolMessage => (message.role === "user" || message.role === "system") && Array.isArray(message.content) ? { role: message.role, content: message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "本轮包含图片引用；媒体内容未写入会话记录。" } : message); }
function applyAgentState(state: CanvasAgentState, patch: Record<string, unknown>): CanvasAgentState { return { ...state, phase: typeof patch.phase === "string" ? patch.phase as CanvasAgentState["phase"] : state.phase, brief: typeof patch.brief === "string" ? patch.brief : state.brief, targetDurationSeconds: typeof patch.targetDurationSeconds === "number" ? patch.targetDurationSeconds : state.targetDurationSeconds, approvedPlan: typeof patch.approvedPlan === "string" ? patch.approvedPlan : state.approvedPlan, approvedNodeIds: Array.isArray(patch.approvedNodeIds) ? patch.approvedNodeIds as string[] : state.approvedNodeIds, referenceNodeIds: Array.isArray(patch.referenceNodeIds) ? patch.referenceNodeIds as string[] : state.referenceNodeIds }; }
function applyTaskResult(state: CanvasAgentState, result: CanvasAgentToolResult): CanvasAgentState { const taskId = typeof result.taskId === "string" ? result.taskId : ""; if (!taskId) return state; const completed = result.status === "success" || result.status === "completed"; const terminal = completed || result.status === "error" || result.status === "failed"; return { ...state, pendingTaskIds: terminal ? state.pendingTaskIds.filter((id) => id !== taskId) : [...new Set([...state.pendingTaskIds, taskId])], completedTaskIds: completed ? [...new Set([...state.completedTaskIds, taskId])] : state.completedTaskIds }; }
function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
function abortError() { const error = new Error("Agent 已停止"); error.name = "AbortError"; return error; }
