import { MAX_AGENT_QUEUED_MESSAGES } from "./canvas-agent-message-queue";
import { setCanvasAgentProcessing } from "./canvas-agent-timing";
import type { CanvasNode } from "@/services/api/canvas";
import type { CanvasAgentState, CanvasAgentTextTask, CanvasAssistantReference, CanvasAssistantSession } from "./canvas-agent-types";

const AUTO_TITLE_MAX_BYTES = 96;
// oxlint-disable-next-line no-control-regex -- ANSI sequences start with a control character.
const ANSI_CSI_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;

export function canvasAgentAutoTitle(text: string) {
  const normalized = text
    .replace(ANSI_CSI_SEQUENCE, "")
    .replace(/[\p{Cc}\p{Bidi_Control}\u200b\u2060]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "新对话";
  const encoder = new TextEncoder();
  let title = "";
  let bytes = 0;
  for (const character of normalized) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > AUTO_TITLE_MAX_BYTES) break;
    title += character;
    bytes += characterBytes;
  }
  return title.trimEnd() || "新对话";
}

export function canvasAgentTextTaskRows(tasks: Readonly<Record<string, CanvasAgentTextTask>>, nodes: readonly CanvasNode[]) {
  const nodeByID = new Map(nodes.map(node => [node.id, node]));
  const targets = new Map(Object.values(tasks).map(task => {
    const node = nodeByID.get(task.nodeId);
    const shotIndex = task.shotId ? node?.script_project?.shots.findIndex(shot => shot.id === task.shotId) ?? -1 : -1;
    const matches = task.shotId ? node?.type === "script" && shotIndex >= 0
      : task.kind === "media_prompt" ? node?.type === "image" || node?.type === "video" || node?.type === "audio"
        : node?.type === "text";
    const editable = Boolean(matches && node?.generation_status !== "loading" && !node?.script_operation);
    return [task.id, { node, shotIndex, editable }] as const;
  }));
  const statusOrder = { in_progress: 0, drafted: 1, failed: 2, interrupted: 3, pending: 4, blocked: 5, completed: 6 };
  const rows = Object.values(tasks).map(task => {
    const target = targets.get(task.id)!;
    const blockers = task.dependsOn.filter(id => tasks[id]?.status !== "completed" || !targets.get(id)?.editable);
    const status: keyof typeof statusOrder = task.status === "pending" && (blockers.length > 0 || !target.editable) ? "blocked" : task.status;
    return { task, ...target, blockers, status };
  });
  return rows.sort((left, right) => statusOrder[left.status] - statusOrder[right.status]
    || left.task.key.localeCompare(right.task.key)
    || left.task.id.localeCompare(right.task.id));
}

export function isCanvasAgentSession(value: unknown): value is CanvasAssistantSession {
  if (!record(value) || !strings(value, ["id", "title", "createdAt", "updatedAt"])) return false;
  if (!Array.isArray(value.messages) || !value.messages.every((message) => record(message)
    && strings(message, ["id", "text"]) && ["user", "assistant"].includes(String(message.role))
    && optionalStrings(message, ["activity", "questionAnswerFor", "steeringAssistantId", "replyToMessageID", "contextCheckpointBefore"])
    && (message.deliverableNodeIds === undefined || message.role === "assistant" && stringArray(message.deliverableNodeIds) && message.deliverableNodeIds.length <= 24)
    && (message.followUpActions === undefined || message.role === "assistant" && Array.isArray(message.followUpActions) && message.followUpActions.length <= 3
      && message.followUpActions.every(action => record(action) && strings(action, ["title", "prompt"])
        && String(action.title).trim().length > 0 && String(action.title).length <= 80 && String(action.prompt).trim().length > 0 && String(action.prompt).length <= 500))
    && (message.canvasChangeSummary === undefined || message.role === "assistant" && validCanvasAgentChangeSummary(message.canvasChangeSummary))
    && (message.workflowRuns === undefined || message.role === "assistant" && Array.isArray(message.workflowRuns) && message.workflowRuns.every(run =>
      record(run) && strings(run, ["id"]) && ["running", "success", "error", "interrupted"].includes(String(run.status))
      && Array.isArray(run.members) && run.members.every(member => record(member) && strings(member, ["nodeId", "title"])
        && optionalStrings(member, ["taskId"]) && ["waiting", "running", "success", "error", "changed", "interrupted", "skipped"].includes(String(member.status))
        && (member.progress === undefined || typeof member.progress === "number" && Number.isFinite(member.progress) && member.progress >= 0 && member.progress <= 100))))
    && (message.canvasChanges === undefined || message.role === "assistant" && Array.isArray(message.canvasChanges)
      && message.canvasChanges.every(change => record(change) && strings(change, ["id", "label"])
        && ["node", "connection"].includes(String(change.kind)) && ["added", "updated", "removed"].includes(String(change.action))))
    && ["elapsedMs", "processingStartedAt"].every((key) => message[key] === undefined || typeof message[key] === "number" && Number.isFinite(message[key]) && message[key] >= 0)
    && (message.agentStateBefore === undefined || isCanvasAgentState(message.agentStateBefore))
    && (message.status === undefined || ["thinking", "running", "waiting", "success", "error"].includes(String(message.status)))
    && (message.trace === undefined || Array.isArray(message.trace) && message.trace.every((entry) => record(entry) && typeof entry.id === "string" && (
      entry.type === "text" && typeof entry.text === "string"
      || entry.type === "reasoning" && typeof entry.text === "string" && typeof entry.isStreaming === "boolean"
      || entry.type === "question" && typeof entry.question === "string" && optionalStrings(entry, ["answer"]) && (entry.cancelled === undefined || typeof entry.cancelled === "boolean")
      || entry.type === "operation" && strings(entry, ["label", "detail"]) && optionalStrings(entry, ["nodeId"])
        && ["plan", "workflow", "read", "image", "create", "edit", "generate", "command", "file", "tool", "subagent"].includes(String(entry.kind))
        && ["running", "success", "error", "waiting", "changed"].includes(String(entry.status))
        && (entry.terminal === undefined || record(entry.terminal) && strings(entry.terminal, ["command", "output"]) && optionalStrings(entry.terminal, ["cwd"]) && (entry.terminal.exitCode === undefined || Number.isInteger(entry.terminal.exitCode)))
        && (entry.tool === undefined || record(entry.tool) && typeof entry.tool.name === "string")
        && (entry.subagent === undefined || record(entry.subagent) && optionalStrings(entry.subagent, ["prompt", "model"]) && Array.isArray(entry.subagent.agents) && entry.subagent.agents.every(agent => record(agent) && strings(agent, ["id", "status"]) && optionalStrings(agent, ["name", "message"])))
    )))
    && (message.references === undefined || (Array.isArray(message.references) && message.references.every((reference) => record(reference)
      && strings(reference, ["id", "type", "title"]) && ["image", "panorama", "text", "video", "audio", "config", "director", "script", "group"].includes(String(reference.type))
      && optionalStrings(reference, ["label", "dataUrl", "url", "storageKey", "mimeType", "text"])
      && (reference.source === undefined || reference.source === "attachment"))))
    && (message.feedback === undefined || validCanvasAgentMessageFeedback(message.feedback, message.role)))) return false;
  if (value.contextUsage !== undefined) {
    const usage = value.contextUsage;
    if (!record(usage) || typeof usage.model !== "string" || usage.basis !== "compression-budget" || typeof usage.compacting !== "boolean"
      || usage.inputTokens !== undefined && (!Number.isSafeInteger(usage.inputTokens) || Number(usage.inputTokens) < 0)
      || !Number.isSafeInteger(usage.usedTokens) || Number(usage.usedTokens) < 0 || !Number.isSafeInteger(usage.maxTokens) || Number(usage.maxTokens) <= 0) return false;
  }
  if (value.codexContextUsage !== undefined) {
    const usage = value.codexContextUsage;
    if (!record(usage) || !strings(usage, ["model", "threadId", "serviceId"]) || !Number.isSafeInteger(usage.tokens) || Number(usage.tokens) < 0
      || usage.contextWindow !== undefined && (!Number.isSafeInteger(usage.contextWindow) || Number(usage.contextWindow) <= 0)) return false;
  }
  if (value.goal !== undefined) {
    const goal = value.goal;
    if (!record(goal) || !strings(goal, ["objective"]) || !String(goal.objective).trim()
      || !["active", "paused", "blocked", "complete"].includes(String(goal.status))
      || !optionalStrings(goal, ["blocker"]) || (goal.status === "blocked") !== Boolean(String(goal.blocker ?? "").trim())
      || !Array.isArray(goal.criteria) || goal.criteria.length < 1 || goal.criteria.length > 12
      || !goal.criteria.every(item => record(item) && strings(item, ["id", "text"]) && typeof item.done === "boolean"
        && (goal.status !== "complete" || item.done === true))) return false;
  }
  if (value.textEditTasks !== undefined) {
    const tasks = value.textEditTasks;
    if (!record(tasks) || Object.keys(tasks).length > 32) return false;
    for (const [id, value] of Object.entries(tasks)) {
      if (!record(value) || value.id !== id || !strings(value, ["key", "nodeId", "question"])
        || !String(value.key).trim() || !String(value.nodeId).trim() || !String(value.question).trim()
        || !stringArray(value.dependsOn) || value.dependsOn.some(dependency => dependency === id)
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
        || !["pending", "in_progress", "drafted", "completed", "interrupted", "failed"].includes(String(value.status))
        || !optionalStrings(value, ["shotId", "proposalId", "ownerRunId", "ownerCallId"])
        || value.kind !== undefined && !["text", "script_shot", "media_prompt"].includes(String(value.kind))) return false;
    }
    if (Object.values(tasks).some(value => record(value) && Array.isArray(value.dependsOn)
      && value.dependsOn.some((dependency: unknown) => typeof dependency !== "string" || !Object.hasOwn(tasks, dependency)))) return false;
  }
  if (value.messageQueue !== undefined) {
    const queue = value.messageQueue;
    if (!record(queue) || typeof queue.paused !== "boolean" || queue.serverManaged !== undefined && typeof queue.serverManaged !== "boolean" || !optionalStrings(queue, ["steeringId"]) || !Array.isArray(queue.messages) || queue.messages.length > MAX_AGENT_QUEUED_MESSAGES) return false;
    const ids = new Set<string>();
    for (const item of queue.messages) {
      if (!record(item) || !strings(item, ["id", "text", "createdAt"]) || !String(item.id) || !String(item.text).trim() || ids.has(String(item.id)) || !Array.isArray(item.references) || !item.references.every(reference => record(reference) && strings(reference, ["id", "type", "title"]) && optionalStrings(reference, ["label", "url", "dataUrl", "storageKey", "mimeType", "text"]) && (reference.source === undefined || reference.source === "attachment"))) return false;
      ids.add(String(item.id));
    }
    if (queue.steeringId !== undefined && !ids.has(String(queue.steeringId))) return false;
  }
  const state = value.agentState;
  if (!isCanvasAgentState(state)) return false;
  return optionalStrings(value, ["contextCheckpoint", "codexThreadId", "codexServiceId", "resumeAssistantMessageId", "parentSessionId", "forkAtMessageId"])
    && (value.inheritedMessageCount === undefined || Number.isSafeInteger(value.inheritedMessageCount) && Number(value.inheritedMessageCount) >= 0)
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

export function parseCanvasAgentSessions(value: unknown): CanvasAssistantSession[] {
  const sessions = value ?? [];
  if (!Array.isArray(sessions) || !sessions.every(isCanvasAgentSession)) throw new Error("对话记录数据无效，原记录未被替换");
  const ids = sessions.map(session => session.id);
  if (ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) throw new Error("对话记录数据无效，原记录未被替换");
  return sessions;
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
    || !["clarification", "confirmation"].includes(String(value.pendingQuestion.kind)) || !stringArray(value.pendingQuestion.options) || value.pendingQuestion.questions != null && (!Array.isArray(value.pendingQuestion.questions) || value.pendingQuestion.questions.length > 4 || !value.pendingQuestion.questions.every(item => record(item) && typeof item.question === "string" && stringArray(item.options))))) return false;
  return true;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function strings(value: Record<string, unknown>, keys: string[]) { return keys.every((key) => typeof value[key] === "string"); }
function optionalStrings(value: Record<string, unknown>, keys: string[]) { return keys.every((key) => value[key] === undefined || typeof value[key] === "string"); }
function stringArray(value: unknown) { return Array.isArray(value) && value.every((item) => typeof item === "string"); }

function validCanvasAgentMessageFeedback(value: unknown, role: unknown) {
  if (role !== "assistant" || !record(value) || !["positive", "negative"].includes(String(value.rating))) return false;
  if (typeof value.version !== "string" || value.version.length === 0 || value.version.length > 128) return false;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 8192)) return false;
  return value.category === undefined || ["task-result", "instruction-following", "product-interaction", "service-stability", "resource-cost", "security-privacy-permission", "other"].includes(String(value.category));
}

function validCanvasAgentChangeSummary(value: unknown) {
  if (!record(value)) return false;
  const counts = ["added", "updated", "removed", "total"].map(key => value[key]);
  if (!counts.every(count => Number.isSafeInteger(count) && Number(count) >= 0)) return false;
  const [added, updated, removed, total] = counts.map(Number);
  return total <= 500 && total === added + updated + removed;
}

export function syncCanvasAgentSessions(
  sessions: readonly CanvasAssistantSession[],
  nodes: readonly CanvasNode[],
  restoreInterrupted = false,
) {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  return sessions.map((session): CanvasAssistantSession => {
    const resumeAssistantMessageId = restoreInterrupted
      ? session.messages.findLast((message) => message.role === "assistant" && (message.status === "thinking" || message.status === "running" || message.processingStartedAt !== undefined))?.id || session.resumeAssistantMessageId
      : session.resumeAssistantMessageId;
    const messages = session.messages.map((message) => {
      const interrupted = restoreInterrupted && (message.status === "thinking" || message.status === "running" || message.processingStartedAt !== undefined);
      const references = message.references?.map((reference) => {
        if (reference.source === "attachment") return reference;
        const node = nodeByID.get(reference.id);
        const content = node ? canvasAgentReferenceContent(node) : null;
        return content && Object.entries(content).some(([key, value]) => !Object.is(reference[key as keyof CanvasAssistantReference], value))
          ? { ...reference, ...content }
          : reference;
      });
      const unchangedReferences = references?.every((reference, index) => reference === message.references?.[index]) ?? !message.references;
      if (!interrupted && message.processingStartedAt === undefined && unchangedReferences) return message;
      const next = {
        ...setCanvasAgentProcessing(message, !interrupted && message.processingStartedAt !== undefined, Date.parse(session.updatedAt)),
        text: interrupted && !message.text
          ? session.engine === "codex"
            ? "重新连接本地 Codex 后将从原对话继续；已提交的任务会接回原结果。"
            : "正在恢复上次执行；已提交的任务会接回原结果，并从原对话继续。"
          : message.text,
        status: interrupted ? "waiting" : message.status,
        activity: interrupted ? undefined : message.activity,
        references: unchangedReferences ? message.references : references,
      };
      return Object.keys(next).every((key) => Object.is(next[key as keyof typeof next], message[key as keyof typeof message])) ? message : next;
    });
    if (resumeAssistantMessageId === session.resumeAssistantMessageId && messages.every((message, index) => message === session.messages[index])) return session;
    return { ...session, resumeAssistantMessageId, messages };
  });
}

export function clearCanvasAgentSessionReferences(
  sessions: readonly CanvasAssistantSession[],
  removedNodeIDs: ReadonlySet<string>,
) {
  return sessions.map((session): CanvasAssistantSession => {
    const messages = session.messages.map((message) => {
      let changed = false;
      const references = message.references?.map((reference) => {
        if (reference.source === "attachment" || !removedNodeIDs.has(reference.id) || reference.dataUrl === undefined && reference.url === undefined && reference.storageKey === undefined) return reference;
        changed = true;
        return { ...reference, dataUrl: undefined, url: undefined, storageKey: undefined };
      });
      return changed ? { ...message, references } : message;
    });
    return messages.every((message, index) => message === session.messages[index]) ? session : { ...session, messages };
  });
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
