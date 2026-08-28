import type { CanvasConnection, CanvasNode } from "@/services/api/canvas";
import type { CanvasAgentState } from "./canvas-agent-types";

export type CanvasAgentGenerationConfig = {
  textModel: string;
  imageModel: string;
  videoModel: string;
  audioModel: string;
  imageQuality: string;
  imageSize: string;
  videoQuality: string;
  videoSize: string;
  imageCount: number;
  videoSeconds: number;
  videoGenerateAudio: boolean;
  videoSupportsAudio: boolean;
  audioVoice: string;
  audioLanguage: string;
  audioFormat: string;
  audioSpeed: number;
};

export type CanvasAgentContextNode = {
  id: string;
  type: CanvasNode["type"];
  title: string;
  text?: string;
  mediaUrl?: string;
  hasMedia?: boolean;
  status?: string;
  progress?: number;
  prompt?: string;
  model?: string;
  size?: string;
  seconds?: number;
  generateAudio?: boolean;
  taskId?: string;
  error?: string;
  groupId?: string;
};

export type CanvasAgentContext = {
  project: { id: string; title: string; nodeCount: number; connectionCount: number };
  agentState: CanvasAgentState;
  selectedNodeIds: string[];
  nodes: CanvasAgentContextNode[];
  connections: CanvasConnection[];
  generation: CanvasAgentGenerationConfig;
  tasks: Array<{ nodeId: string; type: CanvasNode["type"]; status: string; taskId: string; error?: string }>;
};

export function buildCanvasAgentContext(input: {
  projectId: string;
  projectTitle: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  selectedNodeIds: Iterable<string>;
  generation: CanvasAgentGenerationConfig;
  agentState: CanvasAgentState;
}): CanvasAgentContext {
  const selectedNodeIds = Array.from(input.selectedNodeIds);
  const prioritizedIds = new Set([...selectedNodeIds, ...input.agentState.approvedNodeIds, ...input.agentState.referenceNodeIds]);
  input.connections.forEach((connection) => {
    if (prioritizedIds.has(connection.from_node_id) || prioritizedIds.has(connection.to_node_id)) {
      prioritizedIds.add(connection.from_node_id);
      prioritizedIds.add(connection.to_node_id);
    }
  });
  input.nodes.forEach((node) => {
    if (node.generation_status === "loading" || node.generation_status === "error") prioritizedIds.add(node.id);
  });
  const orderedNodes = [
    ...input.nodes.filter((node) => prioritizedIds.has(node.id)),
    ...input.nodes.filter((node) => !prioritizedIds.has(node.id)),
  ].slice(0, 120);
  const included = new Set(orderedNodes.map((node) => node.id));
  return {
    project: { id: input.projectId, title: input.projectTitle, nodeCount: input.nodes.length, connectionCount: input.connections.length },
    agentState: input.agentState,
    selectedNodeIds,
    nodes: orderedNodes.map(summarizeCanvasAgentNode),
    connections: input.connections.filter((connection) => included.has(connection.from_node_id) && included.has(connection.to_node_id)),
    generation: input.generation,
    tasks: orderedNodes.flatMap((node) => node.task_id || node.audio_task_id ? [{ nodeId: node.id, type: node.type, status: node.generation_status || "idle", taskId: node.task_id || node.audio_task_id || "", ...(node.generation_error ? { error: node.generation_error } : {}) }] : []),
  };
}

export function summarizeCanvasAgentNode(node: CanvasNode): CanvasAgentContextNode {
  const isText = node.type === "text";
  const model = node.type === "video" ? node.generation_video_model : node.type === "audio" ? node.generation_audio_model : node.type === "config" && node.generation_mode === "text" ? node.generation_text_model : node.generation_model;
  const size = node.type === "video" ? node.generation_video_size : node.generation_size;
  return {
    id: node.id,
    type: node.type,
    title: node.title || node.type,
    text: isText && node.prompt ? node.prompt.slice(0, 4000) : undefined,
    mediaUrl: !isText && node.url && !node.url.startsWith("data:") ? node.url : undefined,
    hasMedia: !isText ? Boolean(node.url) : undefined,
    status: node.generation_status || "idle",
    progress: node.generation_progress,
    prompt: node.prompt?.slice(0, 4000),
    model,
    size,
    seconds: node.generation_video_seconds,
    generateAudio: node.generation_video_audio,
    taskId: node.task_id || node.audio_task_id,
    error: node.generation_error,
    groupId: node.group_id,
  };
}

export function summarizeCanvasAgentTask(node: CanvasNode) {
  const isText = node.type === "text";
  return {
    type: node.type,
    status: node.generation_status || "idle",
    taskId: node.task_id || node.audio_task_id || undefined,
    progress: node.generation_progress,
    error: node.generation_error,
    mediaUrl: !isText && node.url && !node.url.startsWith("data:") ? node.url : undefined,
  };
}

export function serializeCanvasAgentContext(context: CanvasAgentContext) {
  return JSON.stringify(context);
}
