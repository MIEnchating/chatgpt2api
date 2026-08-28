import type { CanvasNode } from "@/services/api/canvas";
import type { CanvasAssistantReference, CanvasAssistantSession } from "./canvas-agent-types";

export function syncCanvasAgentSessions(
  sessions: readonly CanvasAssistantSession[],
  nodes: readonly CanvasNode[],
  restoreInterrupted = false,
) {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  return sessions.map((session): CanvasAssistantSession => ({
    ...session,
    messages: session.messages.map((message) => {
      const interrupted = restoreInterrupted && (message.status === "thinking" || message.status === "running");
      return {
        ...message,
        text: interrupted && !message.text
          ? "上次 Agent 执行因页面关闭而中断；已提交的媒体任务会继续恢复，你可以让我从当前画布继续。"
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
    return { dataUrl: node.url, url: undefined, storageKey: node.storage_key, mimeType: node.mime_type };
  }
  if (node.type === "video" || node.type === "audio") {
    return { dataUrl: undefined, url: node.url, storageKey: node.storage_key, mimeType: node.mime_type };
  }
  return null;
}
