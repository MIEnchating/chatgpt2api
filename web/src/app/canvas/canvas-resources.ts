import type { CanvasConnection, CanvasNode } from "@/lib/api";
import { buildCanvasInputIndex, canvasConfigInputLabel, canvasGenerationInputsFromIndex, type CanvasConfigInput, type CanvasInputIndex } from "./canvas-config-inputs.ts";

export type CanvasResourceLabel = {
  label: string;
  active: boolean;
};

export type CanvasResourceReference = CanvasResourceLabel & {
  id: string;
  nodeID: string;
  kind: "image" | "text";
  title: string;
  previewURL?: string;
  text?: string;
};

export function canvasResourceLabels(
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
  contextNodeID: string,
  inputIndex = buildCanvasInputIndex(nodes, connections),
) {
  const activeReferences = canvasNodeMentionReferencesFromIndex(contextNodeID, inputIndex);
  const activeByNodeID = new Map(activeReferences.map((reference) => [reference.nodeID, reference]));
  const counts = { image: 0, text: 0 };
  const labels = new Map<string, CanvasResourceLabel>();

  nodes.forEach((node) => {
    if (!isCanvasResourceNode(node)) return;
    if (node.type !== "image" && node.type !== "text") return;
    const kind = node.type === "image" ? "image" : "text";
    counts[kind] += 1;
    const active = activeByNodeID.get(node.id);
    labels.set(node.id, {
      label: active?.label || `${kind === "image" ? "图片" : "文本"}${counts[kind]}`,
      active: Boolean(active),
    });
  });

  return labels;
}

export function canvasNodeMentionReferences(
  nodeID: string,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
) {
  return canvasNodeMentionReferencesFromIndex(nodeID, buildCanvasInputIndex(nodes, connections));
}

export function canvasNodeMentionReferencesByNodeID(
  nodeIDs: readonly string[],
  inputIndex: CanvasInputIndex,
) {
  const references = new Map<string, CanvasResourceReference[]>();
  nodeIDs.forEach((nodeID) => references.set(nodeID, canvasNodeMentionReferencesFromIndex(nodeID, inputIndex)));
  return references;
}

function canvasNodeMentionReferencesFromIndex(nodeID: string, inputIndex: CanvasInputIndex) {
  if (!nodeID) return [];
  const inputs = canvasGenerationInputsFromIndex(nodeID, inputIndex);
  if (inputs.length) return inputs.map((input) => canvasInputReference(input, inputs));
  const node = inputIndex.nodeByID.get(nodeID);
  if (!isCanvasResourceNode(node)) return [];
  const input: CanvasConfigInput = node.type === "image"
    ? { nodeID: node.id, type: "image", title: node.title || "图片", url: String(node.url).trim() }
    : { nodeID: node.id, type: "text", title: node.title || "想法", text: String(node.prompt).trim() };
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

function isCanvasResourceNode(node?: CanvasNode): node is CanvasNode {
  if (!node) return false;
  if (node.type === "image") return Boolean(String(node.url || "").trim());
  if (node.type === "text") return Boolean(String(node.prompt || "").trim());
  return false;
}
