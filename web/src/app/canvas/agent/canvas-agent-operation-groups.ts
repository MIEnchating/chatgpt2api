import type { CanvasAgentTraceEntry } from "./canvas-agent-types";

export type CanvasAgentOperation = Extract<CanvasAgentTraceEntry, { type: "operation" }>;
export type CanvasAgentOperationCategory = "nodes" | "tools" | "plan" | "workflow" | "files";
export const canvasAgentOperationCategoryLabels: Record<CanvasAgentOperationCategory, string> = {
  nodes: "画布节点", tools: "查询与工具", plan: "计划管理", workflow: "工作流", files: "文件与命令",
};

export function canvasAgentOperationCategory(entry: CanvasAgentOperation): CanvasAgentOperationCategory {
  if (entry.kind === "plan" || entry.kind === "workflow") return entry.kind;
  if (entry.kind === "file" || entry.kind === "command") return "files";
  if (entry.kind === "create" || entry.kind === "generate" || entry.kind === "edit") return "nodes";
  return "tools";
}

type OperationGroup = { type: "operations"; id: string; category: CanvasAgentOperationCategory; entries: CanvasAgentOperation[] };
export function canvasAgentOperationGroups(entries: readonly CanvasAgentTraceEntry[]) {
  const groups: (OperationGroup | Exclude<CanvasAgentTraceEntry, CanvasAgentOperation>)[] = [];
  for (const entry of entries) {
    if (entry.type !== "operation") { groups.push(entry); continue; }
    const category = canvasAgentOperationCategory(entry);
    const previous = groups.at(-1);
    // Preserve chronology: model replies, questions and category changes end a batch.
    if (previous?.type === "operations" && previous.category === category) previous.entries.push(entry);
    else groups.push({ type: "operations", id: entry.id, category, entries: [entry] });
  }
  return groups;
}
