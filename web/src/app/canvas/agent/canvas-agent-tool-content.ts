import { canvasAgentImageURL } from "./canvas-agent-attachments";
import type { CanvasAgentToolResult } from "./canvas-agent-tools";

export async function canvasAgentToolContent(result: CanvasAgentToolResult, signal: AbortSignal) {
  const content: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }> = [
    { type: "inputText", text: JSON.stringify(Object.fromEntries(Object.entries(result).filter(([key]) => key !== "agentState" && key !== "reviewPrompts"))) },
  ];
  const value = result.reference || result.node;
  if (result.ok && Array.isArray(result.frames)) {
    for (const frame of result.frames) {
      if (!frame || typeof frame !== "object" || typeof frame.timestampMs !== "number") continue;
      content.push({ type: "inputText", text: `视频时间 ${frame.timestampMs} 毫秒${typeof frame.sameAsMs === "number" ? `，与 ${frame.sameAsMs} 毫秒画面相同` : ""}` });
      if (typeof frame.url === "string" && frame.url) {
        const imageUrl = await canvasAgentImageURL({ id: String(frame.timestampMs), title: "视频抽帧", type: "image", url: frame.url }, signal);
        content.push({ type: "inputImage", imageUrl });
      }
    }
  }
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
