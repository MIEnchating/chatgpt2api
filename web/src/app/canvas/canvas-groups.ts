import type { CanvasNode } from "@/services/api/canvas";

export const CANVAS_GROUP_PADDING = 24;

export function canvasNodeBounds(nodes: readonly CanvasNode[]) {
  return nodes.reduce(
    (bounds, node) => ({
      left: Math.min(bounds.left, node.x),
      top: Math.min(bounds.top, node.y),
      right: Math.max(bounds.right, node.x + node.width),
      bottom: Math.max(bounds.bottom, node.y + node.height),
    }),
    { left: Number.POSITIVE_INFINITY, top: Number.POSITIVE_INFINITY, right: Number.NEGATIVE_INFINITY, bottom: Number.NEGATIVE_INFINITY },
  );
}

export function expandCanvasGroupNodeIDs(ids: ReadonlySet<string>, nodes: readonly CanvasNode[]) {
  const expanded = new Set(ids);
  nodes.forEach((node) => {
    if (node.group_id && ids.has(node.group_id)) expanded.add(node.id);
  });
  return expanded;
}

export function findCanvasGroupDropTarget(movedIDs: ReadonlySet<string>, nodes: readonly CanvasNode[]) {
  if (nodes.some((node) => movedIDs.has(node.id) && node.type === "group")) return null;
  const movingNodes = nodes.filter((node) => movedIDs.has(node.id) && node.type !== "group");
  return [...nodes].reverse().find((group) => {
    if (group.type !== "group" || movedIDs.has(group.id)) return false;
    return movingNodes.some((node) => {
      const centerX = node.x + node.width / 2;
      const centerY = node.y + node.height / 2;
      return centerX >= group.x && centerX <= group.x + group.width && centerY >= group.y && centerY <= group.y + group.height;
    });
  }) || null;
}

export function snapCanvasNodesIntoGroup(movedIDs: ReadonlySet<string>, nodes: readonly CanvasNode[], group: CanvasNode) {
  const movingNodes = nodes.filter((node) => movedIDs.has(node.id) && node.type !== "group");
  if (!movingNodes.length) return [...nodes];

  const bounds = canvasNodeBounds(movingNodes);
  const left = group.x + CANVAS_GROUP_PADDING;
  const top = group.y + CANVAS_GROUP_PADDING;
  const right = group.x + group.width - CANVAS_GROUP_PADDING;
  const bottom = group.y + group.height - CANVAS_GROUP_PADDING;
  const dx = bounds.left < left ? left - bounds.left : bounds.right > right ? right - bounds.right : 0;
  const dy = bounds.top < top ? top - bounds.top : bounds.bottom > bottom ? bottom - bounds.bottom : 0;

  return nodes.map((node) => movedIDs.has(node.id) && node.type !== "group"
    ? { ...node, x: node.x + dx, y: node.y + dy, group_id: group.id }
    : node);
}

export function findContainingCanvasGroupID(node: CanvasNode, nodes: readonly CanvasNode[]) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  return [...nodes].reverse().find((group) => group.type === "group"
    && centerX >= group.x
    && centerX <= group.x + group.width
    && centerY >= group.y
    && centerY <= group.y + group.height)?.id;
}

export function detachCanvasNodesFromRemovedGroups(nodes: readonly CanvasNode[], removedIDs: ReadonlySet<string>) {
  return nodes
    .filter((node) => !removedIDs.has(node.id))
    .map((node) => node.group_id && removedIDs.has(node.group_id) ? { ...node, group_id: undefined } : node);
}
