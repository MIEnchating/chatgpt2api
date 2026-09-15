import type { CanvasNode } from "@/services/api/canvas";
import { summarizeCanvasAgentNode } from "./canvas-agent-context";

export function queryCanvasAgentNodes(nodes: CanvasNode[], query: Record<string, unknown>) {
  const keyword = typeof query.keyword === "string" ? query.keyword.trim().toLocaleLowerCase() : "";
  const page = typeof query.page === "number" ? query.page : 1;
  const pageSize = typeof query.pageSize === "number" ? query.pageSize : 30;
  const matched = nodes.filter((node) => (!query.nodeId || query.nodeId === node.id)
    && (!query.type || query.type === node.type)
    && (!keyword || [node.id, node.title, node.prompt].some((value) => value?.toLocaleLowerCase().includes(keyword))));
  return {
    ok: true,
    total: matched.length,
    page,
    pageSize,
    hasMore: page * pageSize < matched.length,
    nodes: matched.slice((page - 1) * pageSize, page * pageSize).map(summarizeCanvasAgentNode),
  };
}
