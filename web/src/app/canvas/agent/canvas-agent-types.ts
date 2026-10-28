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
  purpose?: "media_generation";
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
  | { id: string; type: "question"; question: string; answer?: string; cancelled?: boolean }
  | {
    id: string;
    type: "operation";
    kind: "read" | "image" | "create" | "edit" | "generate" | "command" | "file" | "tool";
    label: string;
    status: "running" | "success" | "error" | "waiting";
    detail: string;
    nodeId?: string;
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
  trace?: CanvasAgentTraceEntry[];
  references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
  engine?: "native" | "codex";
  resumeAssistantMessageId?: string;
  id: string;
  title: string;
  messages: CanvasAssistantMessage[];
  agentState: CanvasAgentState;
  protocolMessages: CanvasAgentProtocolMessage[];
  contextCheckpoint?: string;
  codexThreadId?: string;
  codexServiceId?: string;
  activeSkillIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export type CanvasAgentConfig = {
  autoGenerateMedia?: boolean;
  textApiMode?: "chat" | "responses";
  textReasoningEnabled?: boolean;
  textStreaming?: boolean;
  activeSkillIds?: string[];
};
