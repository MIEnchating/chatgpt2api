import type { CanvasConnection, CanvasNode } from "@/lib/api";

export type CanvasClipboard = {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
};

export function remapCanvasNodeReferences(node: CanvasNode, idMap: ReadonlyMap<string, string>): CanvasNode {
  const current = { ...node } as CanvasNode & { parent_id?: unknown };
  delete current.parent_id;
  return {
    ...current,
    composer_content: current.composer_content?.replace(/@\[node:([^\]]+)\]/g, (token, nodeID: string) => {
      const mapped = idMap.get(nodeID);
      return mapped ? `@[node:${mapped}]` : token;
    }),
    batch_child_ids: node.batch_child_ids?.flatMap((childID) => idMap.get(childID) || []),
    batch_root_id: node.batch_root_id ? idMap.get(node.batch_root_id) : undefined,
    batch_primary_id: node.batch_primary_id ? idMap.get(node.batch_primary_id) : undefined,
  };
}

export function normalizeCanvasClipboard(value: unknown): CanvasClipboard | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { nodes?: unknown; connections?: unknown };
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length === 0 || candidate.nodes.length > 500) return null;

  const ids = new Set<string>();
  const nodes: CanvasNode[] = [];
  for (const raw of candidate.nodes) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Partial<CanvasNode>;
    const id = String(source.id || "").trim();
    const type = source.type;
    if (!id || id.length > 128 || ids.has(id) || (type !== "image" && type !== "text" && type !== "config")) return null;
    if (!isFiniteNumber(source.x) || !isFiniteNumber(source.y) || Math.abs(source.x) > 1e7 || Math.abs(source.y) > 1e7) return null;
    if (!isFiniteNumber(source.width) || !isFiniteNumber(source.height) || source.width <= 0 || source.height <= 0 || source.width > 20000 || source.height > 20000) return null;
    if (source.font_size !== undefined && (!isFiniteNumber(source.font_size) || source.font_size < 10 || source.font_size > 32)) return null;
    if (!isFiniteNumber(source.scale_x) || !isFiniteNumber(source.scale_y) || source.scale_x <= 0 || source.scale_y <= 0) return null;
    if (source.composer_content !== undefined && (typeof source.composer_content !== "string" || source.composer_content.length > 12000)) return null;
    if (source.batch_child_ids !== undefined && (!Array.isArray(source.batch_child_ids) || source.batch_child_ids.some((childID) => typeof childID !== "string"))) return null;
    if (source.generation_reference_urls !== undefined && (!Array.isArray(source.generation_reference_urls) || source.generation_reference_urls.some((url) => typeof url !== "string"))) return null;
    ids.add(id);
    const normalizedSource = { ...source } as Partial<CanvasNode> & { parent_id?: unknown };
    delete normalizedSource.parent_id;
    nodes.push({ ...normalizedSource, id, type, x: source.x, y: source.y, width: source.width, height: source.height, scale_x: source.scale_x, scale_y: source.scale_y } as CanvasNode);
  }

  if (candidate.connections !== undefined && !Array.isArray(candidate.connections)) return null;
  const connections = (candidate.connections || []) as unknown[];
  if (connections.length > 2000) return null;
  const connectionIDs = new Set<string>();
  const connectionPairs = new Set<string>();
  const normalizedConnections: CanvasConnection[] = [];
  for (const raw of connections) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Partial<CanvasConnection>;
    const id = String(source.id || "").trim();
    const fromNodeID = String(source.from_node_id || "").trim();
    const toNodeID = String(source.to_node_id || "").trim();
    const pair = `${fromNodeID}\u0000${toNodeID}`;
    if (!id || id.length > 128 || connectionIDs.has(id) || !ids.has(fromNodeID) || !ids.has(toNodeID) || fromNodeID === toNodeID || connectionPairs.has(pair)) return null;
    connectionIDs.add(id);
    connectionPairs.add(pair);
    normalizedConnections.push({ ...source, id, from_node_id: fromNodeID, to_node_id: toNodeID } as CanvasConnection);
  }

  return { nodes, connections: normalizedConnections };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
