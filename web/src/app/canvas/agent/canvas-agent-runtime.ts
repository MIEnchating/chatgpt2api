import { canvasAgentActionTrace } from "./canvas-agent-trace";
import { canvasAgentPlan, resolveCanvasAgentQuestion, canvasAgentQuestionMediaChoice, canvasAgentUserMediaChoice } from "./canvas-agent-interaction";
import { canvasAgentPendingMediaNodeIDs } from "./canvas-agent-execution";
import { type AgentSkill } from "@/services/api/agent-skills";
import { type CanvasAgentContext } from "./canvas-agent-context";
import { canvasAgentActionLabel, isCanvasAgentMediaAction, normalizeCanvasAgentAction, type CanvasAgentAction, type CanvasAgentToolResult } from "./canvas-agent-tools";
import type { CanvasAgentProtocolMessage, CanvasAgentState, CanvasAgentTraceEntry, CanvasAssistantMessageStatus, CanvasAssistantReference } from "./canvas-agent-types";



export type CanvasAgentRuntimeEvent = { status: CanvasAssistantMessageStatus; label: string };

export type RunCanvasAgentInput = {
  conversationOnly?: boolean;
  model: string;
  apiMode?: "chat" | "responses";
  reasoningEnabled?: boolean;
  stream?: boolean;
  contextCheckpoint?: string;
  activeSkills?: AgentSkill[];
  relayTokenName: string;
  configuredSystemPrompt?: string;
  initialState: CanvasAgentState;
  protocolMessages: CanvasAgentProtocolMessage[];
  protocolMessageID?: string;
  userText: string;
  resume?: boolean;
  editPreviousRequest?: boolean;
  mediaGenerationChoice?: "generate" | "defer";
  onMediaGenerationChoice?: (choice: "generate" | "defer") => void;
  onWorkflowReviewAnswer?: (answer: string) => Promise<CanvasAgentState>;
  references: CanvasAssistantReference[];
  getContext: (state: CanvasAgentState) => CanvasAgentContext;
  executeAction: (action: CanvasAgentAction, onProgress?: (result: CanvasAgentToolResult) => void) => Promise<CanvasAgentToolResult>;
  persist?: () => Promise<void>;
  onEvent?: (event: CanvasAgentRuntimeEvent) => void;
  onTrace?: (entry: CanvasAgentTraceEntry) => void;
  onCheckpoint?: (checkpoint: { state: CanvasAgentState; protocolMessages: CanvasAgentProtocolMessage[]; contextCheckpoint?: string }) => void;
  signal?: AbortSignal;
};

export function createCanvasAgentState(): CanvasAgentState {
  return { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] };
}

export async function resumeCanvasAgentMedia(input: RunCanvasAgentInput) {
  let state = input.initialState;
  let protocolMessages = [...input.protocolMessages];
  const mediaGenerationChoice = input.mediaGenerationChoice || (state.pendingQuestion
    ? canvasAgentQuestionMediaChoice(state.pendingQuestion, input.userText)
    : !input.resume || input.editPreviousRequest ? canvasAgentUserMediaChoice(input.userText) : undefined);
  let answeredMediaQuestion = false;
  if (mediaGenerationChoice) {
    state = { ...state, mediaGenerationDeferred: mediaGenerationChoice === "defer" };
    input.onMediaGenerationChoice?.(mediaGenerationChoice);
    if (state.pendingQuestion) {
      const resolved = resolveCanvasAgentQuestion(state, protocolMessages, input.userText);
      state = resolved.state;
      protocolMessages = resolved.protocolMessages;
      answeredMediaQuestion = true;
    }
    if (input.resume || answeredMediaQuestion) protocolMessages.push({ role: "user", content: mediaGenerationChoice === "generate"
      ? "用户本轮明确授权立即生成已有待处理节点。该授权覆盖此前的暂缓选择和全局手动生成设置，立即提交生成并等待真实结果；不得重复询问、拒绝或将该步骤标为暂缓。只复用已有节点，不重复创建。"
      : "暂不生成，继续规划。保留已有节点和提示词，将生成及依赖成品的步骤标为 deferred，继续无需成品的方案、文案和提示词。不要把暂缓当成已生成，也不要再次询问同一个生成选择。" });
    input.onCheckpoint?.({ state, protocolMessages, contextCheckpoint: input.contextCheckpoint });
  }
  if (input.editPreviousRequest || (!input.resume && mediaGenerationChoice !== "generate") || state.pendingQuestion || state.mediaGenerationDeferred || (state.mediaGenerationDeferred !== false && input.getContext(state).generation.autoGenerateMedia !== true)) return { initialState: state, protocolMessages, mediaGenerationChoice };
  const actions = canvasAgentPendingMediaNodeIDs(protocolMessages).map((nodeId) => normalizeCanvasAgentAction("generate_node", { nodeId }));
  if (!actions.length) return { initialState: state, protocolMessages, mediaGenerationChoice };
  throwIfAborted(input.signal);
  const batchStart = protocolMessages.length;
  protocolMessages.push({ role: "assistant", toolCalls: actions }, ...actions.map((action) => ({
    role: "tool" as const, name: action.name, toolCallId: action.id,
    content: JSON.stringify({ ok: false, nodeId: action.arguments.nodeId, code: "execution_not_started", message: "准备继续已有节点的生成" }),
  })));
  const checkpoint = () => input.onCheckpoint?.({ state, protocolMessages: persistProtocolMessages(protocolMessages), contextCheckpoint: input.contextCheckpoint });
  checkpoint();
  const results = await executeActions(actions, state, input.executeAction, (action, result, nextState) => {
    state = nextState;
    input.onTrace?.(canvasAgentActionTrace(action, { nodeId: action.arguments.nodeId, ...result }));
    protocolMessages = protocolMessages.map((message, index) => index > batchStart && message.role === "tool" && message.toolCallId === action.id
      ? { ...message, content: JSON.stringify({ nodeId: action.arguments.nodeId, ...result }) } : message);
    checkpoint();
  }, input.signal, input.onEvent, input.persist);
  if (results.interrupted || input.signal?.aborted) throw abortError();
  return { initialState: results.state, protocolMessages, mediaGenerationChoice };
}

export function canvasAgentWaitingReason(state: CanvasAgentState, messages: readonly CanvasAgentProtocolMessage[], nodes?: readonly { id: string; status?: string }[]) {
  if (state.pendingQuestion) return "等待回答";
  const latest = new Map<string, { submitted?: boolean; status?: string }>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    try {
      const result = JSON.parse(message.content);
      if (typeof result.nodeId === "string" && typeof result.status === "string") latest.set(result.nodeId, { ...latest.get(result.nodeId), ...result });
    } catch { /* Invalid historical results are not completion evidence. */ }
  }
  for (const node of nodes || []) {
    const result = latest.get(node.id);
    if (result && node.status) latest.set(node.id, { ...result, status: node.status });
  }
  const results = [...latest.values()];
  const manual = results.filter((result) => result.submitted === false && result.status === "idle").length;
  if (manual && !state.mediaGenerationDeferred) return `待手动生成 · ${manual} 个节点`;
  const failed = results.filter((result) => result.status === "error" || result.status === "failed").length;
  if (failed) return `生成失败 · ${failed} 个节点`;
  const running = results.filter((result) => ["loading", "running", "queued"].includes(result.status || "")).length;
  if (running) return `等待生成结果 · ${running} 个节点`;
  if (state.pendingTaskIds.length) return `等待生成结果 · ${state.pendingTaskIds.length} 个任务`;
  return "";
}

async function executeActions(
  actions: CanvasAgentAction[], initialState: CanvasAgentState,
  executeAction: (action: CanvasAgentAction, onProgress?: (result: CanvasAgentToolResult) => void) => Promise<CanvasAgentToolResult>,
  recordResult: (action: CanvasAgentAction, result: CanvasAgentToolResult, state: CanvasAgentState) => void,
  signal?: AbortSignal, onEvent?: (event: CanvasAgentRuntimeEvent) => void, persist?: () => Promise<void>,
) {
  let state = initialState;
  let interrupted = false;
  const finish = (action: CanvasAgentAction, result: CanvasAgentToolResult) => {
    if (action.name === "update_plan" && result.ok) state = { ...state, plan: canvasAgentPlan(action) };
    else if (action.name === "set_agent_state" && result.ok) state = applyAgentState(state, action.arguments);
    else state = applyTaskResult(state, result);
    recordResult(action, result, state);
    return { action, result };
  };
  const unknownResult = { ok: false, code: "execution_unknown", message: "此调用已开始，但尚未取得结果。若运行中断，操作可能已生效或媒体仍在生成；先查询当前画布和任务状态，不得直接重复提交。" };
  const executeOne = async (action: CanvasAgentAction) => {
    if (signal?.aborted || interrupted) return finish(action, { ok: false, code: "execution_not_started", message: "运行已停止，此调用未执行。" });
    onEvent?.({ status: "running", label: canvasAgentActionLabel(action) });
    recordResult(action, unknownResult, state);
    // A checkpoint or event listener can stop the run before the tool starts.
    if (signal?.aborted) return finish(action, { ok: false, code: "execution_not_started", message: "运行已停止，此调用未执行。" });
    let result: CanvasAgentToolResult;
    let progressResult = unknownResult as CanvasAgentToolResult;
    try {
      await persist?.();
      throwIfAborted(signal);
      result = await waitForAction(executeAction(action, (progress) => {
        if (signal?.aborted) return;
        progressResult = progress;
        state = applyTaskResult(state, progress);
        recordResult(action, progress, state);
      }), signal);
    } catch (error) {
      interrupted ||= Boolean(signal?.aborted) || (error instanceof Error && error.name === "AbortError");
      result = interrupted ? progressResult : { ...progressResult, ok: false, code: "tool_execution_failed", message: error instanceof Error ? error.message : "工具执行失败" };
    }
    return finish(action, result);
  };
  const items = actions.every(isCanvasAgentMediaAction)
    ? await Promise.all(actions.map(executeOne))
    : await actions.reduce<Promise<Array<{ action: CanvasAgentAction; result: CanvasAgentToolResult }>>>(async (pending, action) => {
      const completed = await pending;
      if (completed.some(({ result }) => !result.ok)) return [...completed, finish(action, { ok: false, code: "dependency_failed", message: "前面的操作失败或中断，本操作未执行。请先核对结果并重新规划。" })];
      return [...completed, await executeOne(action)];
    }, Promise.resolve([]));
  return { items, state, interrupted };
}

function waitForAction(task: Promise<CanvasAgentToolResult>, signal?: AbortSignal): Promise<CanvasAgentToolResult> {
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(abortError()); };
    signal.addEventListener("abort", abort, { once: true });
    // Late tool settlements must not update a stopped run's checkpoints.
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function persistProtocolMessages(messages: CanvasAgentProtocolMessage[]) { return messages.map((message): CanvasAgentProtocolMessage => (message.role === "user" || message.role === "system") && Array.isArray(message.content) ? { ...message, content: message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "本轮包含图片引用；媒体内容未写入会话记录。" } : message); }
export function applyAgentState(state: CanvasAgentState, patch: Record<string, unknown>): CanvasAgentState { return { ...state, phase: typeof patch.phase === "string" ? patch.phase as CanvasAgentState["phase"] : state.phase, brief: typeof patch.brief === "string" ? patch.brief : state.brief, targetDurationSeconds: typeof patch.targetDurationSeconds === "number" ? patch.targetDurationSeconds : state.targetDurationSeconds, approvedPlan: typeof patch.approvedPlan === "string" ? patch.approvedPlan : state.approvedPlan, approvedNodeIds: Array.isArray(patch.approvedNodeIds) ? patch.approvedNodeIds as string[] : state.approvedNodeIds, referenceNodeIds: Array.isArray(patch.referenceNodeIds) ? patch.referenceNodeIds as string[] : state.referenceNodeIds }; }
export function applyTaskResult(state: CanvasAgentState, result: CanvasAgentToolResult): CanvasAgentState { const taskId = typeof result.taskId === "string" ? result.taskId : ""; if (!taskId) return state; const completed = result.status === "success" || result.status === "completed"; const terminal = completed || result.status === "error" || result.status === "failed" || result.status === "cancelled"; return { ...state, pendingTaskIds: terminal ? state.pendingTaskIds.filter((id) => id !== taskId) : [...new Set([...state.pendingTaskIds, taskId])], completedTaskIds: completed ? [...new Set([...state.completedTaskIds, taskId])] : state.completedTaskIds }; }
function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
function abortError() { const error = new Error("Agent 已停止"); error.name = "AbortError"; return error; }
