import { videoAudioControl, videoSecondsOptions } from "@/lib/video-model-capabilities";
import { videoModelContract } from "@/lib/video-model-contracts";
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
  const values = videoSecondsOptions(modelName);
  if (values.length === 0) return { values: [], range: "未配置视频模型契约" };
  return { values, range: values.length === 1 ? `仅 ${values[0]} 秒` : `可选 ${values.join("、")} 秒` };
}

export function validateCanvasAgentVideoSeconds(modelName: string, seconds: number) {
  if (!Number.isFinite(seconds)) return "视频时长无效，请先向用户确认单镜头时长";
  if (!videoModelContract(modelName)) return `视频模型 ${modelName || "未选择"} 未配置启用的视频模型契约`;
  const options = videoSecondsOptions(modelName);
  if (!options.includes(seconds)) return `当前视频模型仅支持 ${options.join("、")} 秒`;
  return "";
}

export function canvasAgentVideoSupportsAudio(modelName: string) {
  return videoAudioControl(modelName) !== "none";
}
