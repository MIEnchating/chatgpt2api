import type { CanvasAgentFeedbackInput, CanvasAssistantReference } from "@/services/api/canvas";

export type {
  CanvasAgentFeedbackCategory,
  CanvasAgentFeedbackInput,
  CanvasAssistantReference,
  CanvasInsertAssetPayload,
  CanvasPendingAgentAsset,
  CanvasPendingAgentRequest,
} from "@/services/api/canvas";

export type CanvasAgentPhase =
  | "intake"
  | "concept"
  | "script"
  | "breakdown"
  | "references"
  | "storyboard"
  | "video"
  | "audio"
  | "review"
  | "complete";

export type CanvasAgentPlan = {
  explanation: string;
  steps: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" | "deferred" }>;
};

export type CanvasAgentQuestion = {
  questions?: Array<{ question: string; options: string[] }>;
  id: string;
  question: string;
  reason: string;
  options: string[];
  kind: "clarification" | "confirmation";
  purpose?: "media_generation" | "workflow_review" | "delete_node";
  nodeId?: string;
  nodeIds?: string[];
  request: string;
};

export type CanvasAgentState = {
  pendingModelTaskId?: string;
  mediaGenerationDeferred?: boolean;
  plan?: CanvasAgentPlan;
  pendingQuestion?: CanvasAgentQuestion;
  phase: CanvasAgentPhase;
  brief?: string;
  targetDurationSeconds?: number;
  approvedPlan?: string;
  approvedNodeIds: string[];
  referenceNodeIds: string[];
  pendingTaskIds: string[];
  completedTaskIds: string[];
};

export type CanvasAgentContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
>;

export type CanvasAgentToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsError?: string;
};

export type CanvasAgentProtocolMessage =
  | { role: "user" | "system"; messageID?: string; content: CanvasAgentContent }
  | { role: "assistant"; content?: string; reasoningContent?: string; responseItems?: Record<string, unknown>[]; toolCalls?: CanvasAgentToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export type CanvasAssistantMessageStatus = "thinking" | "running" | "waiting" | "success" | "error";

export type CanvasAgentMessageFeedback = CanvasAgentFeedbackInput & {
  version: string;
  createdAt: string;
  updatedAt: string;
};

export type CanvasAgentTraceEntry =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "reasoning"; text: string; isStreaming: boolean }
  | { id: string; type: "question"; question: string; answer?: string; cancelled?: boolean }
  | {
    id: string;
    type: "operation";
    kind: "plan" | "workflow" | "read" | "image" | "create" | "edit" | "generate" | "command" | "file" | "tool" | "subagent";
    label: string;
    status: "running" | "success" | "error" | "waiting" | "changed";
    detail: string;
    resolvedBy?: string;
    nodeId?: string;
    workflowRunId?: string;
    terminal?: { command: string; output: string; cwd?: string; exitCode?: number };
    tool?: { name: string; input?: unknown; output?: unknown };
    subagent?: { prompt?: string; model?: string; agents: { id: string; name?: string; status: string; message?: string }[] };
  };

export type CanvasAgentModelAttempt = {
  runId: string;
  requestId: string;
  step: number;
  attempt: number;
  purpose: "summary" | "turn" | "review";
  status: "running" | "success" | "retryable_error" | "error" | "cancelled";
  failureCode?: "RATE_LIMIT" | "SERVER" | "TIMEOUT" | "TRANSPORT" | "AUTH" | "EMPTY_RESPONSE";
  retryAt?: string;
  retryDelayMs?: number;
  retryWaitMs?: number;
  rateLimited?: boolean;
  elapsedMs?: number;
  httpStatus?: number;
  validationFailed?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number };
};

export type CanvasAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  replyToMessageID?: string;
  text: string;
  questionAnswerFor?: string;
  steeringAssistantId?: string;
  agentStateBefore?: CanvasAgentState;
  contextCheckpointBefore?: string;
  status?: CanvasAssistantMessageStatus;
  activity?: string;
  interactionMode?: "conversation";
  elapsedMs?: number;
  readOnly?: boolean;
  goalMediaRestricted?: boolean;
  modelAttempts?: CanvasAgentModelAttempt[];
  workflowRuns?: CanvasAgentWorkflowRun[];
  processingStartedAt?: number;
  trace?: CanvasAgentTraceEntry[];
  deliverableNodeIds?: string[];
  followUpActions?: { title: string; prompt: string }[];
  canvasChangeSummary?: { added: number; updated: number; removed: number; total: number };
  canvasChanges?: { id: string; kind: "node" | "connection"; action: "added" | "updated" | "removed"; label: string }[];
  references?: CanvasAssistantReference[];
  feedback?: CanvasAgentMessageFeedback;
};

export type CanvasAgentWorkflowRun = {
  id: string;
  status: "running" | "success" | "error" | "interrupted";
  members: {
    nodeId: string;
    title: string;
    status: "waiting" | "running" | "success" | "error" | "changed" | "interrupted" | "skipped";
    taskId?: string;
    progress?: number;
  }[];
};

export type CanvasAgentTextTask = {
  id: string;
  key: string;
  nodeId: string;
  shotId?: string;
  kind?: "text" | "script_shot" | "media_prompt";
  question: string;
  dependsOn: string[];
  revision: number;
  status: "pending" | "in_progress" | "drafted" | "completed" | "interrupted" | "failed";
  proposalId?: string;
};

export type CanvasAgentQueuedMessage = { id: string; text: string; references: CanvasAssistantReference[]; createdAt: string; readOnly?: boolean; modelRequestLimit?: number };
export type CanvasAgentMessageQueue = { messages: CanvasAgentQueuedMessage[]; paused: boolean; steeringId?: string; serverManaged?: boolean };

export type CanvasAgentContextUsage = { model: string; usedTokens: number; inputTokens?: number; maxTokens: number; compacting: boolean; basis: "compression-budget" };
export type CanvasCodexContextUsage = { model: string; tokens: number; contextWindow?: number; threadId: string; serviceId: string };

export type CanvasAgentGoal = {
  objective: string;
  criteria: { id: string; text: string; done: boolean }[];
  status: "active" | "paused" | "blocked" | "complete";
  blocker?: string;
};

export type CanvasAssistantSession = {
  engine?: "native" | "codex";
  resumeAssistantMessageId?: string;
  id: string;
  parentSessionId?: string;
  forkAtMessageId?: string;
  inheritedMessageCount?: number;
  title: string;
  messages: CanvasAssistantMessage[];
  agentState: CanvasAgentState;
  protocolMessages: CanvasAgentProtocolMessage[];
  contextCheckpoint?: string;
  goal?: CanvasAgentGoal;
  textEditTasks?: Record<string, CanvasAgentTextTask>;
  messageQueue?: CanvasAgentMessageQueue;
  contextUsage?: CanvasAgentContextUsage;
  codexContextUsage?: CanvasCodexContextUsage;
  codexThreadId?: string;
  codexServiceId?: string;
  activeSkillIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export type CanvasAgentConfig = {
  textModel?: string;
  imageModel?: string;
  videoModel?: string;
  codexModel?: string;
  codexEffort?: string;
  contextWindowTokens?: number;
  modelRequestLimit?: number;
  autoGenerateMedia?: boolean;
  textApiMode?: "chat" | "responses";
  textReasoningEnabled?: boolean;
  textStreaming?: boolean;
  activeSkillIds?: string[];
};
