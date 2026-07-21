import type { CanvasNode } from "@/lib/api";

export function canvasGenerationActiveNodeID(
  sourceNodeID: string,
  resultNodeID: string,
  createsResultNode: boolean,
  selectResultNode = false,
) {
  return createsResultNode && selectResultNode ? resultNodeID : sourceNodeID;
}

export function placeCanvasGenerationResultNodes(
  nodes: readonly CanvasNode[],
  sourceNodeID: string,
  resultNodes: readonly CanvasNode[],
  removedNodeIDs: ReadonlySet<string> = new Set(),
) {
  const [root, ...children] = resultNodes;
  if (!root) return nodes.filter((node) => !removedNodeIDs.has(node.id));
  if (root.id !== sourceNodeID) {
    return [...nodes.filter((node) => !removedNodeIDs.has(node.id)), ...resultNodes];
  }

  let replaced = false;
  const next = nodes.flatMap((node): CanvasNode[] => {
    if (removedNodeIDs.has(node.id)) return [];
    if (node.id !== sourceNodeID) return [node];
    replaced = true;
    return [root];
  });
  if (!replaced) next.push(root);
  return [...next, ...children];
}

export function setCanvasConfigGenerationStatus(
  nodes: readonly CanvasNode[],
  nodeID: string,
  status: NonNullable<CanvasNode["generation_status"]>,
  error = "",
  taskID = "",
) {
  return nodes.map((node): CanvasNode => node.id === nodeID && node.type === "config" ? {
    ...node,
    generation_status: status,
    generation_error: error,
    task_id: taskID,
  } : node);
}
