import type { CanvasConnection, CanvasNode } from "@/services/api/canvas";

export type CanvasBatchRootReplacement = {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  removedNodeIDs: Set<string>;
};

function canvasBatchChildIDs(node: CanvasNode) {
  return Array.from(new Set((node.batch_child_ids || []).filter(Boolean)));
}

function canvasBatchRoot(node: CanvasNode, nodes: readonly CanvasNode[]) {
  if (!node.batch_root_id) return null;
  return nodes.find((item) => item.id === node.batch_root_id) || null;
}

export function isCanvasBatchChildHidden(node: CanvasNode, nodes: readonly CanvasNode[], transientVisibleRootIDs: ReadonlySet<string> = new Set()) {
  const root = canvasBatchRoot(node, nodes);
  return Boolean(root && !root.batch_expanded && !transientVisibleRootIDs.has(root.id));
}

export function visibleCanvasNodes(nodes: readonly CanvasNode[], transientVisibleRootIDs: ReadonlySet<string> = new Set()) {
  return nodes.filter((node) => !isCanvasBatchChildHidden(node, nodes, transientVisibleRootIDs));
}

export function canvasBatchMotion(node: CanvasNode, nodeByID: ReadonlyMap<string, CanvasNode>) {
  if (!node.batch_root_id) return undefined;
  const root = nodeByID.get(node.batch_root_id);
  if (!root) return undefined;
  const index = Math.max(0, canvasBatchChildIDs(root).indexOf(node.id));
  return {
    x: root.x + 34 + index * 14 - node.x,
    y: root.y + 14 + index * 8 - node.y,
    index,
  };
}

export function expandCanvasBatchNodeIDs(ids: ReadonlySet<string>, nodes: readonly CanvasNode[]) {
  const expanded = new Set(ids);
  nodes.forEach((node) => {
    if (!ids.has(node.id)) return;
    canvasBatchChildIDs(node).forEach((childID) => expanded.add(childID));
  });
  return expanded;
}

export function reconcileCanvasBatchesAfterRemoval(nodes: readonly CanvasNode[], removedIDs: ReadonlySet<string>) {
  const remaining = nodes.filter((node) => !removedIDs.has(node.id));
  const nodeByID = new Map(remaining.map((node) => [node.id, node]));
  return remaining.map((node): CanvasNode => {
    if (node.batch_root_id) {
      const root = nodeByID.get(node.batch_root_id);
      const remainingSiblingIDs = root ? canvasBatchChildIDs(root).filter((childID) => nodeByID.has(childID)) : [];
      if (remainingSiblingIDs.length <= 1) {
        const { batch_root_id: _root, ...standalone } = node;
        return standalone;
      }
    }
    const childIDs = canvasBatchChildIDs(node).filter((childID) => nodeByID.has(childID));
    if (!node.batch_child_ids || childIDs.length === node.batch_child_ids.length) return node;
    if (childIDs.length <= 1) {
      const { batch_child_ids: _children, batch_primary_id: _primary, batch_expanded: _expanded, ...standalone } = node;
      const primary = childIDs[0] ? nodeByID.get(childIDs[0]) : null;
      return primary?.url ? { ...standalone, ...canvasBatchPreview(primary) } : standalone;
    }
    const primaryID = childIDs.includes(node.batch_primary_id || "") ? node.batch_primary_id : childIDs[0];
    const primary = primaryID ? nodeByID.get(primaryID) : null;
    return {
      ...node,
      batch_child_ids: childIDs,
      batch_primary_id: primaryID,
      ...(primary?.url ? canvasBatchPreview(primary) : {}),
    };
  });
}

function canvasBatchPreview(node: CanvasNode) {
  return {
    url: node.url,
    thumbnail_url: node.thumbnail_url || "",
    ...(node.natural_width && node.natural_height ? { natural_width: node.natural_width, natural_height: node.natural_height } : {}),
    ...(node.free_resize !== undefined ? { free_resize: node.free_resize } : {}),
  };
}

export function setCanvasBatchPrimary(nodes: readonly CanvasNode[], childID: string) {
  const child = nodes.find((node) => node.id === childID && node.batch_root_id && node.url);
  if (!child?.batch_root_id) return [...nodes];
  return nodes.map((node): CanvasNode => node.id === child.batch_root_id ? {
    ...node,
    url: child.url,
    thumbnail_url: child.thumbnail_url || "",
    width: child.width,
    height: child.height,
    ...(child.natural_width && child.natural_height ? { natural_width: child.natural_width, natural_height: child.natural_height } : {}),
    ...(child.free_resize !== undefined ? { free_resize: child.free_resize } : {}),
    batch_primary_id: child.id,
  } : node);
}

export function syncCanvasBatchRootAfterRetry(nodes: readonly CanvasNode[], childID: string) {
  const child = nodes.find((node) => node.id === childID && node.batch_root_id && node.url);
  if (!child?.batch_root_id) return [...nodes];
  const root = nodes.find((node) => node.id === child.batch_root_id);
  if (!root) return [...nodes];
  const currentPrimary = root.batch_primary_id ? nodes.find((node) => node.id === root.batch_primary_id) : null;
  if (root.batch_primary_id !== childID && currentPrimary?.url) return [...nodes];
  return setCanvasBatchPrimary(nodes, childID).map((node): CanvasNode => node.id === root.id ? {
    ...node,
    generation_status: "success",
    generation_error: "",
  } : node);
}

export function detachCanvasBatchRootForReplacement(
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
  rootID: string,
): CanvasBatchRootReplacement {
  const root = nodes.find((node) => node.id === rootID && node.batch_child_ids?.length);
  if (!root) return { nodes: [...nodes], connections: [...connections], removedNodeIDs: new Set() };
  const removedNodeIDs = new Set(canvasBatchChildIDs(root));
  return {
    nodes: nodes.filter((node) => !removedNodeIDs.has(node.id)),
    connections: connections.filter((connection) => !removedNodeIDs.has(connection.from_node_id) && !removedNodeIDs.has(connection.to_node_id)),
    removedNodeIDs,
  };
}
