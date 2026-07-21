import type { CanvasConnection, CanvasNode } from "@/lib/api";

export type CanvasConnectionHandleType = "source" | "target";
export type CanvasConnectionOrigin = { nodeID: string; handleType: CanvasConnectionHandleType };
export type CanvasPoint = { x: number; y: number };
export type CanvasConnectionDropTarget = { nodeID: string; isNearNode: boolean };

const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;

export function canvasConnectionPath(start: CanvasPoint, end: CanvasPoint) {
  const curvature = Math.max(Math.abs(end.x - start.x) * 0.5, 50);
  return `M ${start.x} ${start.y} C ${start.x + curvature} ${start.y}, ${end.x - curvature} ${end.y}, ${end.x} ${end.y}`;
}

export function activeCanvasConnectionPath(start: CanvasPoint, end: CanvasPoint) {
  const curvature = Math.abs(end.x - start.x) * 0.5;
  return `M ${start.x} ${start.y} C ${start.x + curvature} ${start.y}, ${end.x - curvature} ${end.y}, ${end.x} ${end.y}`;
}

export function resolveCanvasConnection(
  origin: CanvasConnectionOrigin,
  otherNodeID: string,
  nodes: readonly CanvasNode[],
) {
  const first = nodes.find((node) => node.id === origin.nodeID);
  const second = nodes.find((node) => node.id === otherNodeID);
  if (!first || !second || first.id === second.id) return null;
  if (first.type === "config" && second.type === "config") return null;
  if (second.type === "config") return { sourceID: first.id, targetID: second.id };
  if (first.type === "config" && origin.handleType === "target") return { sourceID: second.id, targetID: first.id };
  return { sourceID: first.id, targetID: second.id };
}

export function canCreateCanvasConnection(
  sourceID: string,
  targetID: string,
  connections: readonly CanvasConnection[],
  nodes: readonly CanvasNode[] = [],
) {
  if (!sourceID || !targetID || sourceID === targetID) return false;
  const source = nodes.find((node) => node.id === sourceID);
  const target = nodes.find((node) => node.id === targetID);
  if (source?.type === "config" && target?.type === "config") return false;
  return !connections.some((connection) => connection.from_node_id === sourceID && connection.to_node_id === targetID);
}

export function canvasConnectionRelations(activeNodeID: string, connections: readonly CanvasConnection[]) {
  const nodeIDs = new Set<string>();
  const connectionIDs = new Set<string>();
  if (!activeNodeID) return { nodeIDs, connectionIDs };

  nodeIDs.add(activeNodeID);
  connections.forEach((connection) => {
    if (connection.from_node_id !== activeNodeID && connection.to_node_id !== activeNodeID) return;
    connectionIDs.add(connection.id);
    nodeIDs.add(connection.from_node_id);
    nodeIDs.add(connection.to_node_id);
  });
  return { nodeIDs, connectionIDs };
}

export function findCanvasConnectionDropTarget({
  nodes,
  point,
  zoom,
  origin,
  canConnect,
}: {
  nodes: readonly CanvasNode[];
  point: CanvasPoint;
  zoom: number;
  origin: CanvasConnectionOrigin;
  canConnect: (origin: CanvasConnectionOrigin, otherNodeID: string) => boolean;
}): CanvasConnectionDropTarget {
  const scale = Math.max(zoom, 0.05);
  const radius = CONNECTION_HANDLE_HIT_RADIUS / scale;
  const padding = CONNECTION_NODE_HIT_PADDING / scale;
  let isNearNode = false;
  let bestNodeID = "";
  let bestPriority = Number.POSITIVE_INFINITY;

  [...nodes].reverse().forEach((node) => {
    const anchor = origin.handleType === "source"
      ? { x: node.x, y: node.y + node.height / 2 }
      : { x: node.x + node.width, y: node.y + node.height / 2 };
    const dx = point.x - anchor.x;
    const dy = point.y - anchor.y;
    const hitsHandle = dx * dx + dy * dy <= radius * radius;
    const hitsInside = point.x >= node.x
      && point.x <= node.x + node.width
      && point.y >= node.y
      && point.y <= node.y + node.height;
    const hitsExpanded = point.x >= node.x - padding
      && point.x <= node.x + node.width + padding
      && point.y >= node.y - padding
      && point.y <= node.y + node.height + padding;
    if (!hitsHandle && !hitsInside && !hitsExpanded) return;

    isNearNode = true;
    if (node.id === origin.nodeID || !canConnect(origin, node.id)) return;

    const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
    if (priority < bestPriority) {
      bestNodeID = node.id;
      bestPriority = priority;
    }
  });

  return { nodeID: bestNodeID, isNearNode };
}
