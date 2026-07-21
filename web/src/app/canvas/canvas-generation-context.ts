import type { CanvasConnection, CanvasNode } from "@/lib/api";
import { CANVAS_CONFIG_REFERENCE_PATTERN, canvasGenerationInputs } from "./canvas-config-inputs.ts";

export type CanvasGenerationContext = {
  prompt: string;
  referenceImageURLs: string[];
  textCount: number;
  imageCount: number;
};

export const INTERRUPTED_CANVAS_GENERATION_ERROR = "页面刷新后生成已中断，请重新生成。";

export function canvasGenerationCount(configured: number | undefined, override: number | undefined, retrying: boolean) {
  if (retrying) return 1;
  return Math.max(1, Math.min(10, Math.floor(override ?? configured ?? 1)));
}

export function buildCanvasImageReferencePrompt(prompt: string, referenceCount: number) {
  const text = prompt.trim();
  const count = Math.max(0, Math.floor(referenceCount));
  if (!count) return text;
  const labels = Array.from({ length: count }, (_, index) => `图片${index + 1}`);
  return `参考图片编号：${labels.join("、")}。请按这些编号理解提示词中的图片引用。\n\n${text}`;
}

export function buildCanvasGenerationContext(
  nodeID: string,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
  prompt: string,
): CanvasGenerationContext {
  const sourceNode = nodes.find((node) => node.id === nodeID);
  const inputs = canvasGenerationInputs(nodeID, nodes, connections);
  const currentPrompt = prompt.trim();
  if (sourceNode?.type === "config" && Boolean(sourceNode.composer_content?.trim())) {
    return buildExplicitCanvasGenerationContext(currentPrompt, inputs);
  }

  const textInputs: string[] = [];
  const referenceImageURLs: string[] = [];

  inputs.forEach((input) => {
    if (input.type === "image" && input.url) {
      referenceImageURLs.push(input.url);
      return;
    }
    if (input.text) textInputs.push(input.text);
  });

  const upstreamText = textInputs.join("\n\n");
  return {
    prompt: upstreamText ? `${currentPrompt}\n\n${upstreamText}`.trim() : currentPrompt,
    referenceImageURLs,
    textCount: textInputs.length,
    imageCount: referenceImageURLs.length,
  };
}

function buildExplicitCanvasGenerationContext(
  prompt: string,
  inputs: ReturnType<typeof canvasGenerationInputs>,
): CanvasGenerationContext {
  const inputByID = new Map(inputs.map((input) => [input.nodeID, input]));
  const labelByID = new Map<string, string>();
  const textBlocks: string[] = [];
  const referenceImageURLs: string[] = [];
  let textCount = 0;
  let imageCount = 0;
  const resolvedPrompt = prompt.replace(CANVAS_CONFIG_REFERENCE_PATTERN, (_token, nodeID: string) => {
    const input = inputByID.get(nodeID);
    if (!input) return "";
    const existing = labelByID.get(input.nodeID);
    if (existing) return input.type === "text" ? `【${existing}】` : existing;
    if (input.type === "image" && input.url) {
      const label = `图片${imageCount + 1}`;
      imageCount += 1;
      labelByID.set(input.nodeID, label);
      referenceImageURLs.push(input.url);
      return label;
    }
    const label = `文本${textCount + 1}`;
    textCount += 1;
    labelByID.set(input.nodeID, label);
    textBlocks.push(`【${label}】\n${input.text || ""}`);
    return `【${label}】`;
  });
  const text = resolvedPrompt.trim();
  return {
    prompt: textBlocks.length ? `${text}\n\n${textBlocks.join("\n\n")}`.trim() : text,
    referenceImageURLs,
    textCount,
    imageCount,
  };
}

export function canvasGenerationReferenceImageURLs(
  node: CanvasNode,
  upstreamURLs: readonly string[],
  maximum: number,
) {
  const sourceURL = String(node.url || "").trim();
  if (sourceURL) return [sourceURL];
  return upstreamURLs.slice(0, Math.max(0, maximum));
}

export function restoreInterruptedCanvasGenerations(nodes: readonly CanvasNode[]) {
  return nodes.map((node): CanvasNode => node.generation_status === "loading" ? {
    ...node,
    generation_status: "error",
    generation_error: INTERRUPTED_CANVAS_GENERATION_ERROR,
  } : node);
}

export function findCanvasRetryConfigurationNode(
  nodeID: string,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
) {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  const queue = connections.filter((connection) => connection.to_node_id === nodeID).map((connection) => connection.from_node_id);
  const visited = new Set<string>();
  while (queue.length) {
    const currentID = queue.shift();
    if (!currentID || visited.has(currentID)) continue;
    visited.add(currentID);
    const node = nodeByID.get(currentID);
    if (node?.type === "config") return node;
    connections
      .filter((connection) => connection.to_node_id === currentID)
      .forEach((connection) => queue.push(connection.from_node_id));
  }
  return null;
}
