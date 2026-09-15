import type { CanvasNode } from "@/services/api/canvas";

export type CanvasNodeTreeRow = { node: CanvasNode; depth: number; hasChildren: boolean };

export function canvasNodeTreeRows(nodes: readonly CanvasNode[], filtered: readonly CanvasNode[], collapsed: ReadonlySet<string>): CanvasNodeTreeRow[] {
  const matching = new Set(filtered.map((node) => node.id));
  const groups = new Set(nodes.filter((node) => node.type === "group").map((node) => node.id));
  const children = new Map<string, CanvasNode[]>();
  for (const node of nodes) {
    if (node.group_id && groups.has(node.group_id)) children.set(node.group_id, [...children.get(node.group_id) || [], node]);
  }
  const visited = new Set<string>();
  const visit = (node: CanvasNode, depth: number): CanvasNodeTreeRow[] => {
    if (visited.has(node.id)) return [];
    visited.add(node.id);
    const descendants = (children.get(node.id) || []).flatMap((child) => visit(child, depth + 1));
    if (!matching.has(node.id) && !descendants.length) return [];
    return [{ node, depth, hasChildren: descendants.length > 0 }, ...collapsed.has(node.id) ? [] : descendants];
  };
  return nodes.filter((node) => !node.group_id || !groups.has(node.group_id)).flatMap((node) => visit(node, 0));
}
