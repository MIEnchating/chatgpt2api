import type { CanvasAssistantReference } from "@/services/api/canvas";

export type {
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
    terminal?: { command: string; output: string; cwd?: string; exitCode?: number };
    tool?: { name: string; input?: unknown; output?: unknown };
    subagent?: { prompt?: string; model?: string; agents: { id: string; status: string; message?: string }[] };
  };

export type CanvasAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  replyToMessageID?: string;
  text: string;
  questionAnswerFor?: string;
  agentStateBefore?: CanvasAgentState;
  contextCheckpointBefore?: string;
  status?: CanvasAssistantMessageStatus;
  activity?: string;
  interactionMode?: "conversation";
  elapsedMs?: number;
  processingStartedAt?: number;
  trace?: CanvasAgentTraceEntry[];
  references?: CanvasAssistantReference[];
};

export type CanvasAgentQueuedMessage = { id: string; text: string; references: CanvasAssistantReference[]; createdAt: string };
export type CanvasAgentMessageQueue = { messages: CanvasAgentQueuedMessage[]; paused: boolean; steeringId?: string };

export type CanvasAgentContextUsage = { model: string; usedTokens: number; inputTokens?: number; maxTokens: number; compacting: boolean; basis: "compression-budget" };

export type CanvasAssistantSession = {
  engine?: "native" | "codex";
  resumeAssistantMessageId?: string;
  id: string;
  title: string;
  messages: CanvasAssistantMessage[];
  agentState: CanvasAgentState;
  protocolMessages: CanvasAgentProtocolMessage[];
  contextCheckpoint?: string;
  messageQueue?: CanvasAgentMessageQueue;
  contextUsage?: CanvasAgentContextUsage;
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
  autoGenerateMedia?: boolean;
  textApiMode?: "chat" | "responses";
  textReasoningEnabled?: boolean;
  textStreaming?: boolean;
  activeSkillIds?: string[];
};
