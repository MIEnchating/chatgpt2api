import type { CanvasConnection, CanvasNode } from "@/services/api/canvas";
import { canCreateCanvasConnection } from "./canvas-connections.ts";
import { buildCanvasInputIndex, canvasConfigInputLabel, canvasGenerationInputsFromIndex, type CanvasConfigInput } from "./canvas-config-inputs.ts";

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

// Existing inputs keep their numbering; a newly chosen resource takes the next slot.
export function canvasNodeReferenceCandidates(nodeID: string, nodes: readonly CanvasNode[], connections: readonly CanvasConnection[]) {
  const inputs = canvasGenerationInputsFromIndex(nodeID, buildCanvasInputIndex(nodes, connections));
  const connected = inputs.filter((input) => input.nodeID !== nodeID);
  const connectedIDs = new Set(connected.map((input) => input.nodeID));
  const descendants = new Set([nodeID]);
  const queue = [nodeID];
  while (queue.length) {
    const current = queue.pop();
    connections.filter((edge) => edge.from_node_id === current).forEach((edge) => {
      if (descendants.has(edge.to_node_id)) return;
      descendants.add(edge.to_node_id);
      queue.push(edge.to_node_id);
    });
  }
  const available = nodes.flatMap((node) => {
    if (connectedIDs.has(node.id) || descendants.has(node.id) || !canCreateCanvasConnection(node.id, nodeID, connections, nodes)) return [];
    const input = canvasNodeInput(node);
    return input ? [canvasInputReference(input, [...connected, input])] : [];
  });
  return [...connected.map((input) => canvasInputReference(input, connected)), ...available];
}
