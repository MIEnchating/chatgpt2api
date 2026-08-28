import { canonicalVideoModel, referenceWorkbenchSupportsVideoAudio } from "@/lib/video-model-capabilities";
import type { CanvasNode } from "@/services/api/canvas";

export const CANVAS_AGENT_PRIMARY_SCRIPT_NODE_SIZE = { width: 550, height: 600 };

export type CanvasAgentVideoDurationHint = {
  values: number[];
  range: string;
};

export function canvasAgentSourceNodeIDs(
  args: Record<string, unknown>,
  messageReferenceNodeIDs: readonly string[],
) {
  const source = Object.prototype.hasOwnProperty.call(args, "sourceNodeIds")
    ? args.sourceNodeIds
    : messageReferenceNodeIDs;
  if (!Array.isArray(source)) return [];
  return [...new Set(source
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

export function canvasAgentMediaLayoutSources(
  mode: "image" | "video" | "audio",
  nodes: readonly CanvasNode[],
  sourceNodes: readonly CanvasNode[],
) {
  if (mode === "image") return [];
  if (mode === "audio") return [...sourceNodes];
  return nodes.filter((node) => !node.group_id
    && (node.type === "text" || node.type === "image" || node.type === "panorama" || node.type === "group"));
}

export function canvasAgentNodePosition(
  size: { width: number; height: number },
  sourceNodes: readonly CanvasNode[],
  nodes: readonly CanvasNode[],
  canvasCenter: { x: number; y: number },
) {
  const gapX = 72;
  const gapY = 72;
  const columns = 3;
  const fallbackNodes = nodes.filter((node) => node.type !== "group"
    && node.type !== "config"
    && node.type !== "director"
    && !node.group_id
    && !node.exclude_upstream_text);
  const candidates = sourceNodes.length ? sourceNodes : fallbackNodes;
  const source = candidates.length
    ? candidates.reduce((rightmost, node) => node.x + node.width > rightmost.x + rightmost.width ? node : rightmost)
    : null;
  const startX = source ? source.x + source.width + 96 : canvasCenter.x - size.width / 2;
  const startY = source ? source.y : canvasCenter.y - size.height / 2;
  const collides = (x: number, y: number) => nodes.some((node) => x < node.x + node.width + gapX
    && x + size.width + gapX > node.x
    && y < node.y + node.height + gapY
    && y + size.height + gapY > node.y);
  const maxSlots = Math.max(30, (nodes.length + 1) * columns * 2);
  for (let slot = 0; slot < maxSlots; slot += 1) {
    const x = startX + (slot % columns) * (size.width + gapX);
    const y = startY + Math.floor(slot / columns) * (size.height + gapY);
    if (!collides(x, y)) return { x, y };
  }
  return {
    x: startX,
    y: Math.max(canvasCenter.y - size.height / 2, ...nodes.map((node) => node.y + node.height + gapY)),
  };
}

export function arrangeCanvasAgentNodes(nodes: readonly CanvasNode[], requestedNodeIDs: readonly string[]) {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  const targets = requestedNodeIDs.length
    ? requestedNodeIDs.flatMap((nodeID) => {
        const node = nodeByID.get(nodeID);
        return node ? [node] : [];
      })
    : nodes.filter((node) => !node.group_id && !node.batch_root_id);
  if (!targets.length) return { nodes: [...nodes], arrangedNodeIDs: [] as string[] };

  const startX = Math.min(...targets.map((node) => node.x));
  const startY = Math.min(...targets.map((node) => node.y));
  const positions = new Map<string, { x: number; y: number }>();
  let x = startX;
  let y = startY;
  let rowHeight = 0;
  targets.forEach((node, index) => {
    if (index > 0 && index % 4 === 0) {
      x = startX;
      y += rowHeight + 72;
      rowHeight = 0;
    }
    positions.set(node.id, { x, y });
    x += node.width + 72;
    rowHeight = Math.max(rowHeight, node.height);
  });
  targets.filter((node) => node.type === "group").forEach((group) => {
    const groupPosition = positions.get(group.id);
    if (!groupPosition) return;
    const offsetX = groupPosition.x - group.x;
    const offsetY = groupPosition.y - group.y;
    nodes.filter((node) => node.group_id === group.id && !positions.has(node.id)).forEach((node) => {
      positions.set(node.id, { x: node.x + offsetX, y: node.y + offsetY });
    });
  });
  return {
    nodes: nodes.map((node) => positions.has(node.id) ? { ...node, ...positions.get(node.id)! } : node),
    arrangedNodeIDs: targets.map((node) => node.id),
  };
}

export function canvasAgentVideoDurationHint(modelName: string): CanvasAgentVideoDurationHint {
  const key = canvasAgentVideoModelKey(modelName);
  if (key === "cogvideox-3" || key.includes("cogvideox-3")) return { values: [5, 10], range: "仅 5 或 10 秒" };
  if (key.includes("seedance")) return { values: [-1, 4, 5, 6, 8, 10, 12, 15], range: "智能或 4-15 秒" };
  if (isCanvasAgentKlingV3(key)) return { values: [3, 15], range: "3-15 秒" };
  if (isCanvasAgentKlingV26(key)) return { values: [5, 10], range: "仅 5 或 10 秒" };
  return { values: [6, 10, 12, 16, 20], range: "1-30 秒" };
}

export function validateCanvasAgentVideoSeconds(modelName: string, seconds: number) {
  if (!Number.isFinite(seconds)) return "视频时长无效，请先向用户确认单镜头时长";
  const key = canvasAgentVideoModelKey(modelName);
  if ((key === "cogvideox-3" || key.includes("cogvideox-3")) && seconds !== 5 && seconds !== 10) return "当前 CogVideoX-3 模型仅支持 5 或 10 秒";
  if (key.includes("seedance") && seconds !== -1 && (seconds < 4 || seconds > 15)) return "当前 Seedance 模型仅支持智能时长或 4-15 秒";
  if (isCanvasAgentKlingV3(key) && (seconds < 3 || seconds > 15)) return "当前 Kling 3 模型仅支持 3-15 秒";
  if (isCanvasAgentKlingV26(key) && seconds !== 5 && seconds !== 10) return "当前 Kling 2.6 模型仅支持 5 或 10 秒";
  if (!key.includes("seedance") && !key.includes("kling") && (seconds < 1 || seconds > 30)) return "当前视频模型仅支持 1-30 秒";
  return "";
}

export function canvasAgentVideoSupportsAudio(modelName: string) {
  return referenceWorkbenchSupportsVideoAudio(modelName);
}

function canvasAgentVideoModelKey(modelName: string) {
  return canonicalVideoModel(modelName).trim().toLowerCase().replace(/[._/]+/g, "-");
}

function isCanvasAgentKlingV3(key: string) {
  return key.includes("kling-v3") || key.includes("kling-3-0");
}

function isCanvasAgentKlingV26(key: string) {
  return key.includes("kling-v2-6") || key.includes("kling-2-6");
}
