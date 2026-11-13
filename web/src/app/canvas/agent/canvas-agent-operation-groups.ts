import type { CanvasAgentTraceEntry } from "./canvas-agent-types";

export type CanvasAgentOperation = Extract<CanvasAgentTraceEntry, { type: "operation" }>;
export type CanvasAgentOperationCategory = "nodes" | "tools" | "plan" | "workflow" | "files" | "agents";
export const canvasAgentOperationCategoryLabels: Record<CanvasAgentOperationCategory, string> = {
  nodes: "画布节点", tools: "查询与工具", plan: "计划管理", workflow: "工作流", files: "文件与命令", agents: "子代理",
};

export function canvasAgentOperationCategory(entry: CanvasAgentOperation): CanvasAgentOperationCategory {
  if (entry.kind === "subagent") return "agents";
  if (entry.kind === "plan" || entry.kind === "workflow") return entry.kind;
  if (entry.kind === "file" || entry.kind === "command") return "files";
  if (entry.kind === "create" || entry.kind === "generate" || entry.kind === "edit") return "nodes";
  return "tools";
}

type OperationGroup = { type: "operations"; id: string; entries: CanvasAgentOperation[] };

export function canvasAgentOperationGroups(entries: readonly CanvasAgentTraceEntry[]) {
  const groups: (OperationGroup | Exclude<CanvasAgentTraceEntry, CanvasAgentOperation>)[] = [];
  for (const entry of entries) {
    if (entry.type !== "operation") { groups.push(entry); continue; }
    const previous = groups.at(-1);
    if (previous?.type === "operations") previous.entries.push(entry);
    else groups.push({ type: "operations", id: entry.id, entries: [entry] });
  }
  return groups;
}
