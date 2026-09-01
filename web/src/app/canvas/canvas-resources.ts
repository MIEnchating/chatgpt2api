import type { CanvasConnection, CanvasNode } from "@/services/api/canvas";
import { buildCanvasInputIndex, canvasConfigInputLabel, canvasGenerationInputsFromIndex, type CanvasConfigInput, type CanvasInputIndex } from "./canvas-config-inputs.ts";

export type CanvasResourceReference = {
  id: string;
  nodeID: string;
  kind: "image" | "video" | "audio" | "text";
  label: string;
  title: string;
  previewURL?: string;
  text?: string;
  active: boolean;
};

export function buildAllCanvasResourceReferences(nodes: readonly CanvasNode[]) {
  const counts: Record<CanvasResourceReference["kind"], number> = { image: 0, video: 0, audio: 0, text: 0 };
  return nodes.flatMap((node): CanvasResourceReference[] => {
    const kind = canvasResourceKind(node);
    if (!kind) return [];
    counts[kind] += 1;
    const label = `${{ image: "图片", video: "视频", audio: "音频", text: "文本" }[kind]}${counts[kind]}`;
    return [{
      id: node.id,
      nodeID: node.id,
      kind,
      label,
      title: node.title || label,
      previewURL: node.url,
      text: kind === "text" ? node.prompt : undefined,
      active: true,
    }];
  });
}

export function canvasNodeMentionReferences(
  nodeID: string,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
) {
  return canvasNodeMentionReferencesFromIndex(nodeID, buildCanvasInputIndex(nodes, connections));
}

function canvasNodeMentionReferencesFromIndex(nodeID: string, inputIndex: CanvasInputIndex) {
  if (!nodeID) return [];
  const inputs = canvasGenerationInputsFromIndex(nodeID, inputIndex);
  if (inputs.length) return inputs.map((input) => canvasInputReference(input, inputs));
  const node = inputIndex.nodeByID.get(nodeID);
  const input = node ? canvasNodeInput(node) : null;
  if (!input) return [];
  return [canvasInputReference(input, [input])];
}

function canvasInputReference(input: CanvasConfigInput, inputs: readonly CanvasConfigInput[]): CanvasResourceReference {
  return {
    id: input.nodeID,
    nodeID: input.nodeID,
    kind: input.type,
    label: canvasConfigInputLabel(input, inputs),
    title: input.title,
    previewURL: input.url,
    text: input.text,
    active: true,
  };
}

function canvasNodeInput(node: CanvasNode): CanvasConfigInput | null {
  const url = String(node.url || "").trim();
  if ((node.type === "image" || node.type === "panorama") && url) {
    return { nodeID: node.id, type: "image", title: node.title || (node.type === "panorama" ? "全景图" : "图片"), url };
  }
  if ((node.type === "video" || node.type === "audio") && url) {
    return { nodeID: node.id, type: node.type, title: node.title || (node.type === "video" ? "视频" : "音频"), url };
  }
  const text = String(node.prompt || "").trim();
  if (node.type === "text" && text) {
    return { nodeID: node.id, type: "text", title: node.title || "文字", text };
  }
  return null;
}

function canvasResourceKind(node: CanvasNode): CanvasResourceReference["kind"] | null {
  return canvasNodeInput(node)?.type || null;
}
