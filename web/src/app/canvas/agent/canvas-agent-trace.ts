import { canvasAgentActionLabel, isCanvasAgentMediaAction, type CanvasAgentAction, type CanvasAgentToolResult } from "./canvas-agent-tools";
import type { CanvasAgentTraceEntry } from "./canvas-agent-types";

export type CanvasAgentTraceSection =
  | { type: "question"; entry: Extract<CanvasAgentTraceEntry, { type: "question" }> }
  | { type: "execution"; entries: Exclude<CanvasAgentTraceEntry, { type: "question" }>[] };

export function canvasAgentTraceSections(entries: readonly CanvasAgentTraceEntry[] = []): CanvasAgentTraceSection[] {
  const sections: CanvasAgentTraceSection[] = [];
  let execution: Exclude<CanvasAgentTraceEntry, { type: "question" }>[] = [];
  const flush = () => {
    if (!execution.length) return;
    sections.push({ type: "execution", entries: execution });
    execution = [];
  };
  for (const entry of entries) {
    if (entry.type === "question") {
      flush();
      sections.push({ type: "question", entry });
    } else execution.push(entry);
  }
  flush();
  return sections;
}

export function canvasAgentTraceProgress(entries: readonly CanvasAgentTraceEntry[] = [], running = false) {
  const latest = entries.findLast((entry) => entry.type === "operation") || entries.at(-1);
  if (!latest) return running ? "正在处理" : "查看详情";
  if (latest.type === "operation" && latest.kind === "command" && latest.detail) {
    const command = latest.detail.split("\n")[0];
    return (latest.status === "running" && running ? "正在运行 " : "已运行 ") + command;
  }
  if (latest.type === "operation" && latest.status === "error") return "执行失败 · " + latest.label;
  if (latest.type === "operation" && latest.status === "running" && running) return latest.label;
  if (latest.type === "operation") return latest.label;
  return running ? "正在整理思路" : "查看思考过程";
}

export function upsertCanvasAgentTrace(entries: readonly CanvasAgentTraceEntry[] = [], entry: CanvasAgentTraceEntry): CanvasAgentTraceEntry[] {
  const existing = entries.find((item) => item.id === entry.id);
  if (!existing) return [...entries, entry].slice(-256);
  return entries.map((item) => item.id === entry.id ? entry : item);
}

export function upsertCanvasAgentOperationTrace(entries: readonly CanvasAgentTraceEntry[] = [], entry: Extract<CanvasAgentTraceEntry, { type: "operation" }>): CanvasAgentTraceEntry[] {
  const taskID = entry.kind === "generate" ? entry.detail.match(/^任务：([^\n]+)/m)?.[1] : undefined;
  const previous = taskID ? entries.find((item) => item.type === "operation" && item.kind === "generate" && item.detail.match(/^任务：([^\n]+)/m)?.[1] === taskID) : undefined;
  return upsertCanvasAgentTrace(entries, previous?.type === "operation" ? { ...entry, id: previous.id } : entry);
}

export function updateCanvasAgentQuestionTrace(entries: readonly CanvasAgentTraceEntry[] = [], questionID: string, update: { answer?: string; cancelled?: boolean }): CanvasAgentTraceEntry[] {
  return entries.map((entry) => entry.type === "question" && entry.id === questionID ? { ...entry, ...update } : entry);
}

export function canvasAgentActionTrace(action: CanvasAgentAction, result: CanvasAgentToolResult): CanvasAgentTraceEntry {
  const media = isCanvasAgentMediaAction(action);
  const pending = result.code === "execution_unknown" || result.code === "execution_not_started";
  const waiting = result.submitted === false && result.status === "idle" || result.code === "execution_not_started" || result.code === "awaiting_user" || result.code === "media_generation_deferred" || result.code === "user_cancelled" || result.code === "delete_cancelled";
  const status = waiting ? "waiting" : pending || media && ["loading", "running", "queued"].includes(String(result.status)) ? "running" : !result.ok || ["error", "failed"].includes(String(result.status)) ? "error" : "success";
  const title = (canvasAgentActionLabel(action) || "执行画布操作").replace(/^正在/, "");
  const createdNodeLabels: Record<string, string> = { generate_image: "图片节点已创建", edit_image: "图片编辑节点已创建", generate_video: "视频节点已创建", generate_audio: "音频节点已创建" };
  const label = media && action.name === "generate_node" ? status === "success" ? "生成任务已完成" : status === "waiting" ? "等待继续生成" : status === "error" ? "继续生成失败" : "正在继续生成任务"
    : media && result.nodeId && createdNodeLabels[action.name] ? createdNodeLabels[action.name]
      : media && result.taskId ? status === "success" ? "完成了生成任务" : "提交了生成任务"
        : media && result.nodeId ? "已创建生成节点"
    : status === "success" ? title.replace(/^(读取|查找|创建|更新|删除|整理|保存|查看|提交)/, "$1了") : title;
  const details: string[] = [];
  const resultNodes = [result.nodes, result.upstream, result.downstream].flatMap((value) => Array.isArray(value) ? value : []).filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object");
  if (result.project && typeof result.project === "object" && typeof (result.project as Record<string, unknown>).title === "string") details.push(`画布：${String((result.project as Record<string, unknown>).title)}`);
  if (Array.isArray(result.nodes)) {
    details.push(`找到 ${resultNodes.length} 个节点${resultNodes.slice(0, 12).length ? `：${resultNodes.slice(0, 12).map((node) => typeof node.title === "string" ? node.title : typeof node.type === "string" ? node.type : "未命名节点").join("、")}` : ""}`);
  }
  if (result.node && typeof result.node === "object") {
    const node = result.node as Record<string, unknown>;
    if (typeof node.title === "string") details.push(`节点：${node.title}${typeof node.type === "string" ? `（${node.type}）` : ""}`);
  }
  for (const [key, name] of [["title", "名称"], ["path", "文件"], ["prompt", "提示词"], ["query", "查询"], ["sourceNodeId", "来源节点"], ["targetNodeId", "目标节点"]]) {
    const value = action.arguments[key];
    if (typeof value === "string" && value) details.push(`${name}：${value.slice(0, 2000)}`);
  }
  if (typeof result.taskId === "string") details.push(`任务：${result.taskId}`);
  if (!pending && typeof result.message === "string") details.push(result.message.slice(0, 2000));
  return {
    id: `tool:${action.id}`, type: "operation", label, status,
    kind: media ? "generate" : action.name === "read_skill_file" ? "file" : /^(get_|query_)/.test(action.name) ? "read" : action.name.startsWith("create_") ? "create" : /^(update_|delete_|arrange_)/.test(action.name) ? "edit" : "tool",
    detail: clipTraceDetail(uniqueTraceDetails(details).join("\n")),
    ...(typeof result.nodeId === "string" ? { nodeId: result.nodeId } : typeof action.arguments.nodeId === "string" ? { nodeId: action.arguments.nodeId } : {}),
  };
}

export function canvasAgentTraceDetailLines(detail: string, node?: { id: string; title?: string }) {
  return detail.split("\n").filter((line) => {
    if (!node || !/^(节点|名称)[:：]/.test(line)) return true;
    const value = line.replace(/^[^:：]+[:：]\s*/, "").replace(/（[^（）]*）$/, "").trim();
    return value !== node.id && value !== node.title;
  });
}

function uniqueTraceDetails(details: string[]) {
  const seen = new Set<string>();
  return details.filter((line) => {
    const key = line.replace(/^[^:：]+[:：]\s*/, "").replace(/（[^（）]*）$/, "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function canvasCodexItemTrace(item: Record<string, unknown>, completed: boolean): CanvasAgentTraceEntry | undefined {
  if (typeof item.id !== "string") return;
  const status = item.status === "failed" || item.status === "declined" || Boolean(item.error) || typeof item.exitCode === "number" && item.exitCode !== 0 ? "error" : completed ? "success" : "running";
  const base = { id: `codex:${item.id}`, type: "operation", status } as const;
  const detail = (...values: unknown[]) => clipTraceDetail(values.filter((value): value is string => typeof value === "string" && Boolean(value)).join("\n"));
  if (item.type === "commandExecution") return { ...base, kind: "command", label: completed ? "运行了命令" : "正在运行命令", detail: detail(item.command, item.cwd, typeof item.exitCode === "number" ? `退出码：${item.exitCode}` : undefined, item.aggregatedOutput) };
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes as Array<{ path?: string; diff?: string }> : [];
    return { ...base, kind: "edit", label: completed ? "编辑了文件" : "正在编辑文件", detail: detail(...changes.map((change) => detail(change.path, change.diff))) };
  }
  if (item.type === "imageView") return { ...base, kind: "image", label: completed ? "查看了图片" : "正在查看图片", detail: detail(item.path) };
  if (item.type === "webSearch") return { ...base, kind: "read", label: completed ? "搜索了资料" : "正在搜索资料", detail: detail(item.query) };
  if (item.type === "mcpToolCall") return { ...base, kind: "tool", label: completed ? "调用了工具" : "正在调用工具", detail: detail(item.server, item.tool) };
}

function clipTraceDetail(text: string) {
  return text.length > 1200 ? `${text.slice(0, 1180)}\n…（详情已截断）` : text;
}
