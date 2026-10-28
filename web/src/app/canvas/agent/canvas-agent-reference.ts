import type { CanvasAssistantReference } from "./canvas-agent-types";
import type { CanvasResourceReference } from "@/app/canvas/canvas-resources";

export function pendingCanvasAgentReferences(references: readonly CanvasResourceReference[], selectedNodeIDs: readonly string[], clickedNodeID: string | null, composerReferenceNodeIDs: readonly string[], removedReferenceNodeIDs: ReadonlySet<string>) {
  if (clickedNodeID) {
    const clicked = references.find((reference) => reference.nodeID === clickedNodeID);
    return clicked && !composerReferenceNodeIDs.includes(clickedNodeID) ? [clicked] : [];
  }
  if (selectedNodeIDs.length !== 1) return [];
  const selectedNodeID = selectedNodeIDs[0];
  if (composerReferenceNodeIDs.includes(selectedNodeID) || removedReferenceNodeIDs.has(selectedNodeID)) return [];
  return references.filter((reference) => reference.nodeID === selectedNodeID);
}

export function describeCanvasAgentReference(reference: CanvasAssistantReference) {
  return reference.source === "attachment"
    ? `${reference.label || reference.title} → 附件 ${reference.id}（消息附件，尚未添加到画布，不是节点；生成图片或视频时通过 attachmentIds 引用）${reference.text ? `：${reference.text}` : ""}`
    : `${reference.label || reference.title} → 节点 ${reference.id}（${reference.title}）`;
}

export function canvasAgentAttachmentURLs(references: readonly CanvasAssistantReference[], type: CanvasAssistantReference["type"]) {
  return [...new Set(references.filter((item) => item.source === "attachment" && item.type === type).map((item) => item.url || "").filter(Boolean))];
}
