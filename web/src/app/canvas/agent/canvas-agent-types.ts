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

export type CanvasAgentState = {
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
  | { role: "user" | "system"; content: CanvasAgentContent }
  | { role: "assistant"; content?: string; reasoningContent?: string; responseItems?: Record<string, unknown>[]; toolCalls?: CanvasAgentToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export type CanvasAssistantMessageStatus = "thinking" | "running" | "waiting" | "success" | "error";

export type CanvasAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: CanvasAssistantMessageStatus;
  activity?: string;
  references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
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
  activeSkillIds?: string[];
  imageQuality: string;
  imageSize: string;
  videoQuality: string;
  videoSize: string;
};
