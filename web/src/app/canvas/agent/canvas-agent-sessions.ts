import { setCanvasAgentProcessing } from "./canvas-agent-timing";
import type { CanvasNode } from "@/services/api/canvas";
import type { CanvasAgentState, CanvasAssistantReference, CanvasAssistantSession } from "./canvas-agent-types";

export const MAX_CANVAS_AGENT_SESSIONS = 24;

export function canCreateCanvasAgentSession(sessions: readonly CanvasAssistantSession[]) {
  return sessions.length < MAX_CANVAS_AGENT_SESSIONS;
}

export function isCanvasAgentSession(value: unknown): value is CanvasAssistantSession {
  if (!record(value) || !strings(value, ["id", "title", "createdAt", "updatedAt"])) return false;
  if (!Array.isArray(value.messages) || !value.messages.every((message) => record(message)
    && strings(message, ["id", "text"]) && ["user", "assistant"].includes(String(message.role))
    && optionalStrings(message, ["activity", "questionAnswerFor", "replyToMessageID", "contextCheckpointBefore"])
    && ["elapsedMs", "processingStartedAt"].every((key) => message[key] === undefined || typeof message[key] === "number" && Number.isFinite(message[key]) && message[key] >= 0)
    && (message.agentStateBefore === undefined || isCanvasAgentState(message.agentStateBefore))
    && (message.status === undefined || ["thinking", "running", "waiting", "success", "error"].includes(String(message.status)))
    && (message.trace === undefined || Array.isArray(message.trace) && message.trace.every((entry) => record(entry) && typeof entry.id === "string" && (
      entry.type === "text" && typeof entry.text === "string"
      || entry.type === "question" && typeof entry.question === "string" && optionalStrings(entry, ["answer"]) && (entry.cancelled === undefined || typeof entry.cancelled === "boolean")
      || entry.type === "operation" && strings(entry, ["label", "detail"]) && optionalStrings(entry, ["nodeId"])
        && ["plan", "workflow", "read", "image", "create", "edit", "generate", "command", "file", "tool"].includes(String(entry.kind))
        && ["running", "success", "error", "waiting", "changed"].includes(String(entry.status))
    )))
    && (message.references === undefined || (Array.isArray(message.references) && message.references.every((reference) => record(reference)
      && strings(reference, ["id", "type", "title"]) && ["image", "panorama", "text", "video", "audio", "config", "director", "group"].includes(String(reference.type))
      && optionalStrings(reference, ["label", "dataUrl", "url", "storageKey", "mimeType", "text"])
      && (reference.source === undefined || reference.source === "attachment")))))) return false;
  const state = value.agentState;
  if (!isCanvasAgentState(state)) return false;
  return optionalStrings(value, ["contextCheckpoint", "codexThreadId", "codexServiceId", "resumeAssistantMessageId"])
    && (value.engine === undefined || value.engine === "native" || value.engine === "codex")
    && (value.activeSkillIds === undefined || stringArray(value.activeSkillIds))
    && Array.isArray(value.protocolMessages) && value.protocolMessages.every((message) => {
      if (!record(message)) return false;
      if (message.role === "tool") return strings(message, ["content", "toolCallId", "name"]);
      if (message.role === "assistant") return optionalStrings(message, ["content", "reasoningContent"])
        && (message.responseItems === undefined || (Array.isArray(message.responseItems) && message.responseItems.every(record)))
        && (message.toolCalls === undefined || (Array.isArray(message.toolCalls) && message.toolCalls.every((call) => record(call) && strings(call, ["id", "name"]) && record(call.arguments) && optionalStrings(call, ["argumentsError"]))));
      return ["user", "system"].includes(String(message.role)) && optionalStrings(message, ["messageID"]) && (typeof message.content === "string" || (Array.isArray(message.content) && message.content.every((part) => record(part)
        && ((part.type === "text" && typeof part.text === "string") || (part.type === "image_url" && record(part.image_url) && typeof part.image_url.url === "string")))));
    });
}

function isCanvasAgentState(value: unknown): value is CanvasAgentState {
  if (!record(value) || !["intake", "concept", "script", "breakdown", "references", "storyboard", "video", "audio", "review", "complete"].includes(String(value.phase))
    || !["approvedNodeIds", "referenceNodeIds", "pendingTaskIds", "completedTaskIds"].every((key) => stringArray(value[key]))
    || !optionalStrings(value, ["brief", "approvedPlan", "pendingModelTaskId"])
    || (value.mediaGenerationDeferred !== undefined && typeof value.mediaGenerationDeferred !== "boolean")
    || (value.targetDurationSeconds !== undefined && (typeof value.targetDurationSeconds !== "number" || !Number.isFinite(value.targetDurationSeconds) || value.targetDurationSeconds <= 0))) return false;
  if (value.plan !== undefined && (!record(value.plan) || typeof value.plan.explanation !== "string" || !Array.isArray(value.plan.steps)
    || !value.plan.steps.every((step) => record(step) && strings(step, ["id", "title"]) && ["pending", "in_progress", "completed", "deferred"].includes(String(step.status))))) return false;
  if (value.pendingQuestion !== undefined && (!record(value.pendingQuestion) || !strings(value.pendingQuestion, ["id", "question", "reason", "request"]) || !optionalStrings(value.pendingQuestion, ["purpose"])
    || value.pendingQuestion.purpose !== undefined && !["media_generation", "workflow_review", "delete_node"].includes(String(value.pendingQuestion.purpose))
    || !["clarification", "confirmation"].includes(String(value.pendingQuestion.kind)) || !stringArray(value.pendingQuestion.options))) return false;
  return true;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function strings(value: Record<string, unknown>, keys: string[]) { return keys.every((key) => typeof value[key] === "string"); }
function optionalStrings(value: Record<string, unknown>, keys: string[]) { return keys.every((key) => value[key] === undefined || typeof value[key] === "string"); }
function stringArray(value: unknown) { return Array.isArray(value) && value.every((item) => typeof item === "string"); }

export function syncCanvasAgentSessions(
  sessions: readonly CanvasAssistantSession[],
  nodes: readonly CanvasNode[],
  restoreInterrupted = false,
) {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  return sessions.map((session): CanvasAssistantSession => ({
    ...session,
    resumeAssistantMessageId: restoreInterrupted
      ? session.messages.findLast((message) => message.role === "assistant" && (message.status === "thinking" || message.status === "running" || message.processingStartedAt !== undefined))?.id || session.resumeAssistantMessageId
      : session.resumeAssistantMessageId,
    messages: session.messages.map((message) => {
      const interrupted = restoreInterrupted && (message.status === "thinking" || message.status === "running" || message.processingStartedAt !== undefined);
      return {
        ...setCanvasAgentProcessing(message, !interrupted && message.processingStartedAt !== undefined, Date.parse(session.updatedAt)),
        text: interrupted && !message.text
          ? session.engine === "codex"
            ? "重新连接本地 Codex 后将从原对话继续；已提交的任务会接回原结果。"
            : "正在恢复上次执行；已提交的任务会接回原结果，并从原对话继续。"
          : message.text,
        status: interrupted ? "waiting" : message.status,
        activity: interrupted ? undefined : message.activity,
        references: message.references?.map((reference) => {
          const node = nodeByID.get(reference.id);
          const content = node ? canvasAgentReferenceContent(node) : null;
          return content ? { ...reference, ...content } : reference;
        }),
      };
    }),
  }));
}

export function clearCanvasAgentSessionReferences(
  sessions: readonly CanvasAssistantSession[],
  removedNodeIDs: ReadonlySet<string>,
) {
  return sessions.map((session): CanvasAssistantSession => ({
    ...session,
    messages: session.messages.map((message) => ({
      ...message,
      references: message.references?.map((reference) => removedNodeIDs.has(reference.id) ? {
        ...reference,
        dataUrl: undefined,
        url: undefined,
        storageKey: undefined,
      } : reference),
    })),
  }));
}

function canvasAgentReferenceContent(node: CanvasNode): Partial<CanvasAssistantReference> | null {
  if (node.type === "text") return node.prompt ? { text: node.prompt } : null;
  if (!node.url) return null;
  if (node.type === "image" || node.type === "panorama") {
    return { dataUrl: undefined, url: node.url, storageKey: node.storage_key, mimeType: node.mime_type };
  }
  if (node.type === "video" || node.type === "audio") {
    return { dataUrl: undefined, url: node.url, storageKey: node.storage_key, mimeType: node.mime_type };
  }
  return null;
}
