import { canvasAgentImageURL } from "./canvas-agent-attachments";
import type { CanvasAgentToolResult } from "./canvas-agent-tools";

export async function canvasAgentToolContent(result: CanvasAgentToolResult, signal: AbortSignal) {
  const content: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }> = [
    { type: "inputText", text: JSON.stringify(Object.fromEntries(Object.entries(result).filter(([key]) => key !== "agentState" && key !== "reviewPrompts"))) },
  ];
  const value = result.reference || result.node;
  if (result.ok && value && typeof value === "object") {
    const ref = value as Record<string, unknown>;
    const url = ref.url || ref.mediaUrl;
    if ((ref.type === "image" || ref.type === "panorama") && typeof url === "string" && url) {
      const imageUrl = await canvasAgentImageURL({ id: String(ref.id), title: String(ref.title || "参考图"), type: ref.type, url }, signal);
      content.push({ type: "inputImage", imageUrl });
    }
  }
  signal.throwIfAborted();
  return content;
}
