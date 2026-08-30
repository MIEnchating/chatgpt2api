import type { CanvasConnection, CanvasNode } from "@/services/api/canvas";
import { imageOutputCountLimit, supportsImageSize } from "../../lib/image-model-capabilities.ts";
import { CANVAS_CONFIG_REFERENCE_PATTERN, canvasConfigUsesConnectedText, canvasGenerationInputs } from "./canvas-config-inputs.ts";

export type CanvasGenerationContext = {
  prompt: string;
  referenceImageURLs: string[];
  firstFrameURL: string | null;
  lastFrameURL: string | null;
  referenceVideoURLs: string[];
  referenceAudioURLs: string[];
  textCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
};

export const INTERRUPTED_CANVAS_GENERATION_ERROR = "页面刷新后生成已中断，请重新生成。";
export const PENDING_CANVAS_GENERATION_RECOVERY_ERROR = "暂时无法同步后台任务，重新进入画布后将继续恢复。";

export function canvasGenerationNeedsRecovery(node: CanvasNode) {
  return Boolean(canvasGenerationRecoveryTaskID(node)) && (
    node.generation_status === "loading" ||
    node.generation_error === INTERRUPTED_CANVAS_GENERATION_ERROR ||
    node.generation_error === PENDING_CANVAS_GENERATION_RECOVERY_ERROR ||
    (node.generation_status === "success" && canvasURLIsStaleBlob(node.url))
  );
}

export function canvasURLIsStaleBlob(url: string | undefined) {
  return String(url || "").trim().toLowerCase().startsWith("blob:");
}

export function canvasGenerationRecoveryTaskID(node: CanvasNode) {
  return String(node.task_id || node.audio_task_id || "").trim();
}

export function markCanvasGenerationRecoveryPending(nodes: readonly CanvasNode[], taskID: string) {
  return nodes.map((node): CanvasNode => canvasGenerationRecoveryTaskID(node) === taskID && canvasGenerationNeedsRecovery(node) ? {
    ...node,
    generation_status: "error",
    generation_error: PENDING_CANVAS_GENERATION_RECOVERY_ERROR,
  } : node);
}

export function canvasGenerationCount(model: string, configured: number | undefined, override: number | undefined, retrying: boolean) {
  if (retrying) return 1;
  return Math.max(1, Math.min(imageOutputCountLimit(model), Math.floor(override ?? configured ?? 1)));
}

export function canvasGenerationModel(currentModel: string, sourceNode: CanvasNode, retryConfiguration: CanvasNode | null, retrying: boolean) {
  if (!retrying) return sourceNode.generation_model?.trim() || currentModel.trim();
  return sourceNode.generation_model?.trim() || retryConfiguration?.generation_model?.trim() || currentModel.trim();
}

export function canvasGenerationRequestSize(model: string, size: string | undefined, resolution: string | undefined) {
  const value = String(size || "").trim();
  if (!value || !supportsImageSize(model)) return undefined;
  // The UI follows the reference project's complete size contract. Provider
  // adapters perform model-specific normalization after this shared request.
  void resolution;
  return value;
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
  const usesConnectedText = sourceNode?.type === "config" && canvasConfigUsesConnectedText(inputs);
  if (sourceNode?.type === "config" && sourceNode.composer_content !== undefined) {
    return buildExplicitCanvasGenerationContext(prompt, inputs, sourceNode);
  }

  const textInputs: string[] = [];
  const referenceImageURLs: string[] = [];
  const referenceVideoURLs: string[] = [];
  const referenceAudioURLs: string[] = [];

  inputs.forEach((input) => {
    if (input.url) {
      if (input.type === "image") referenceImageURLs.push(input.url);
      if (input.type === "video") referenceVideoURLs.push(input.url);
      if (input.type === "audio") referenceAudioURLs.push(input.url);
      return;
    }
    if (!sourceNode?.exclude_upstream_text && input.text) textInputs.push(input.text);
  });

  const frames = canvasVideoFrameReferences(sourceNode, inputs);
  const frameURLs = new Set([frames.firstFrameURL, frames.lastFrameURL].filter((url): url is string => Boolean(url)));
  const effectiveReferenceImageURLs = referenceImageURLs.filter((url) => !frameURLs.has(url));
  const upstreamText = textInputs.join("\n\n");
  const localPrompt = prompt;
  return {
    prompt: upstreamText ? localPrompt ? `${localPrompt}\n\n${upstreamText}` : usesConnectedText ? upstreamText : `\n\n${upstreamText}` : localPrompt,
    referenceImageURLs: effectiveReferenceImageURLs,
    firstFrameURL: frames.firstFrameURL,
    lastFrameURL: frames.lastFrameURL,
    referenceVideoURLs,
    referenceAudioURLs,
    textCount: inputs.filter((input) => input.type === "text").length,
    imageCount: inputs.filter((input) => input.type === "image" && Boolean(input.url)).length,
    videoCount: referenceVideoURLs.length,
    audioCount: referenceAudioURLs.length,
  };
}

function buildExplicitCanvasGenerationContext(
  prompt: string,
  inputs: ReturnType<typeof canvasGenerationInputs>,
  sourceNode: CanvasNode,
): CanvasGenerationContext {
  const inputByID = new Map(inputs.map((input) => [input.nodeID, input]));
  const labelByID = new Map<string, string>();
  const textBlocks: string[] = [];
  const referenceImageURLs: string[] = [];
  const referenceVideoURLs: string[] = [];
  const referenceAudioURLs: string[] = [];
  let textCount = 0;
  let imageCount = 0;
  let videoCount = 0;
  let audioCount = 0;
  const resolvedPrompt = prompt.replace(CANVAS_CONFIG_REFERENCE_PATTERN, (_token, nodeID: string) => {
    const input = inputByID.get(nodeID);
    if (!input) return "";
    const existing = labelByID.get(input.nodeID);
    if (existing) return input.type === "text" ? `【${existing}】` : existing;
    if (input.type !== "text" && input.url) {
      const count = input.type === "image" ? imageCount : input.type === "video" ? videoCount : audioCount;
      const label = `${input.type === "image" ? "图片" : input.type === "video" ? "视频" : "音频"}${count + 1}`;
      if (input.type === "image") {
        imageCount += 1;
        referenceImageURLs.push(input.url);
      } else if (input.type === "video") {
        videoCount += 1;
        referenceVideoURLs.push(input.url);
      } else {
        audioCount += 1;
        referenceAudioURLs.push(input.url);
      }
      labelByID.set(input.nodeID, label);
      return label;
    }
    const label = `文本${textCount + 1}`;
    textCount += 1;
    labelByID.set(input.nodeID, label);
    textBlocks.push(`【${label}】\n${input.text || ""}`);
    return `【${label}】`;
  });
  const frames = canvasVideoFrameReferences(sourceNode, inputs);
  const frameURLs = new Set([frames.firstFrameURL, frames.lastFrameURL].filter((url): url is string => Boolean(url)));
  const effectiveReferenceImageURLs = referenceImageURLs.filter((url) => !frameURLs.has(url));
  return {
    prompt: textBlocks.length ? `${resolvedPrompt.trim()}\n\n${textBlocks.join("\n\n")}` : resolvedPrompt,
    referenceImageURLs: effectiveReferenceImageURLs,
    firstFrameURL: frames.firstFrameURL,
    lastFrameURL: frames.lastFrameURL,
    referenceVideoURLs,
    referenceAudioURLs,
    textCount,
    imageCount,
    videoCount,
    audioCount,
  };
}

function canvasVideoFrameReferences(
  sourceNode: CanvasNode | undefined,
  inputs: ReturnType<typeof canvasGenerationInputs>,
) {
  const imageURLByNodeID = new Map(inputs.filter((input) => input.type === "image" && input.url).map((input) => [input.nodeID, input.url as string]));
  return {
    firstFrameURL: sourceNode?.generation_video_first_frame_node_id
      ? imageURLByNodeID.get(sourceNode.generation_video_first_frame_node_id) || null
      : null,
    lastFrameURL: sourceNode?.generation_video_last_frame_node_id
      ? imageURLByNodeID.get(sourceNode.generation_video_last_frame_node_id) || null
      : null,
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

export function canvasVideoGenerationReferences(
  context: Pick<CanvasGenerationContext, "referenceImageURLs" | "firstFrameURL" | "lastFrameURL">,
  configuredImageURLs: readonly string[],
  frameReferencesEnabled: boolean,
) {
  const firstFrameURL = String(context.firstFrameURL || "").trim();
  const lastFrameURL = String(context.lastFrameURL || "").trim();
  const fallbackFrameURLs = frameReferencesEnabled ? [] : [firstFrameURL, lastFrameURL].filter(Boolean);
  return {
    referenceImageURLs: Array.from(new Set([
      ...configuredImageURLs.map((url) => url.trim()).filter(Boolean),
      ...context.referenceImageURLs.map((url) => url.trim()).filter(Boolean),
      ...fallbackFrameURLs,
    ])),
    firstFrameURL: frameReferencesEnabled ? firstFrameURL : "",
    lastFrameURL: frameReferencesEnabled ? lastFrameURL : "",
  };
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
