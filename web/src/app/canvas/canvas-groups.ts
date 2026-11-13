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
  return findCanvasGroupDropTargetForNodes(movingNodes, nodes, movedIDs);
}

export function findCanvasGroupDropTargetForNodes(movingNodes: readonly CanvasNode[], groups: readonly CanvasNode[], movedIDs: ReadonlySet<string> = new Set()) {
  if (groups.some((group) => group.type === "group" && movedIDs.has(group.id))) return null;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group.type !== "group" || movedIDs.has(group.id)) continue;
    if (movingNodes.some((node) => {
      const centerX = node.x + node.width / 2;
      const centerY = node.y + node.height / 2;
      return centerX >= group.x && centerX <= group.x + group.width && centerY >= group.y && centerY <= group.y + group.height;
    })) return group;
  }
  return null;
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
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const group = nodes[index];
    if (group.type === "group" && centerX >= group.x && centerX <= group.x + group.width && centerY >= group.y && centerY <= group.y + group.height) return group.id;
  }
  return undefined;
}

export function expandCanvasRemovalNodeIDs(ids: ReadonlySet<string>, nodes: readonly CanvasNode[]) {
  const removed = new Set(ids);
  let changed = true;
  while (changed) {
    const before = removed.size;
    for (const node of nodes) {
      if (node.group_id && removed.has(node.group_id) || node.batch_root_id && removed.has(node.batch_root_id)) removed.add(node.id);
      if (removed.has(node.id)) node.batch_child_ids?.forEach((id) => removed.add(id));
    }
    changed = before !== removed.size;
  }
  return removed;
}
