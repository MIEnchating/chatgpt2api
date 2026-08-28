import type { CanvasNode } from "@/services/api/canvas";

export type CanvasTaskQueueStatus = "generating" | "success" | "error" | "cancelled";

export type CanvasTaskQueueItem = {
  id: string;
  serverTaskID: string;
  canvasID: string;
  canvasTitle: string;
  nodeIDs: string[];
  type: "image" | "video" | "audio" | "panorama" | "text";
  title: string;
  prompt: string;
  model: string;
  status: CanvasTaskQueueStatus;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  progress: number;
  error: string;
  startedAt: number;
  completedAt?: number;
};

const TERMINAL_TASK_RETENTION_MS = 5000;
const listeners = new Set<() => void>();
let snapshot: CanvasTaskQueueItem[] = [];
let pruneTimer: ReturnType<typeof setTimeout> | null = null;

function emit(next: CanvasTaskQueueItem[]) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function scheduleTerminalPrune() {
  if (pruneTimer) clearTimeout(pruneTimer);
  const terminalTimes = snapshot.flatMap((item) => item.completedAt ? [item.completedAt] : []);
  if (!terminalTimes.length) return;
  const delay = Math.max(0, Math.min(...terminalTimes) + TERMINAL_TASK_RETENTION_MS - Date.now());
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    const cutoff = Date.now() - TERMINAL_TASK_RETENTION_MS;
    const next = snapshot.filter((item) => !item.completedAt || item.completedAt > cutoff);
    if (next.length !== snapshot.length) emit(next);
    scheduleTerminalPrune();
  }, delay + 10);
}

function nodeTaskID(node: CanvasNode) {
  return node.task_id || (node.type === "audio" ? node.audio_task_id : "") || "";
}

function outputNodes(nodes: CanvasNode[]) {
  const mediaNodes = nodes.filter((node) => node.type !== "config");
  const batchChildIDs = new Set(mediaNodes.flatMap((node) => node.batch_child_ids || []));
  const batchChildren = mediaNodes.filter((node) => batchChildIDs.has(node.id));
  return batchChildren.length ? batchChildren : mediaNodes.length ? mediaNodes : nodes;
}

function taskType(nodes: CanvasNode[]): CanvasTaskQueueItem["type"] {
  const node = nodes.find((item) => item.type !== "config") || nodes[0];
  const type = node?.type === "config" ? node.generation_mode : node?.type;
  return type === "video" || type === "audio" || type === "panorama" || type === "text" ? type : "image";
}

function taskModel(node: CanvasNode | undefined, type: CanvasTaskQueueItem["type"]) {
  if (!node) return "";
  if (type === "video") return node.generation_video_model || node.generation_model || "";
  if (type === "audio") return node.generation_audio_model || node.generation_model || "";
  if (type === "text") return node.generation_text_model || node.generation_model || "";
  return node.generation_model || "";
}

function overlaps(left: string[], right: Set<string>) {
  return left.some((nodeID) => right.has(nodeID));
}

function terminalStatus(nodes: CanvasNode[]): CanvasTaskQueueStatus {
  if (nodes.some((node) => node.generation_status === "loading")) return "generating";
  if (nodes.some((node) => node.generation_status === "error")) return "error";
  if (nodes.some((node) => node.generation_status === "success")) return "success";
  return "cancelled";
}

/** Mirrors canvas node generation state into the global task queue. */
export function syncCanvasTaskQueue(canvasID: string, canvasTitle: string, nodes: CanvasNode[]) {
  if (!canvasID) return;
  const groups = new Map<string, CanvasNode[]>();
  nodes.forEach((node) => {
    const taskID = nodeTaskID(node);
    if (!taskID || !node.generation_started_at) return;
    const group = groups.get(taskID) || [];
    group.push(node);
    groups.set(taskID, group);
  });

  const now = Date.now();
  const current = snapshot.filter((item) => !item.completedAt || item.completedAt > now - TERMINAL_TASK_RETENTION_MS);
  const matchedIDs = new Set<string>();

  groups.forEach((groupNodes, serverTaskID) => {
    const nodeIDs = new Set(groupNodes.map((node) => node.id));
    const existing = current.find((item) => item.canvasID === canvasID && (!item.completedAt || matchedIDs.has(item.id)) && (
      item.serverTaskID === serverTaskID || overlaps(item.nodeIDs, nodeIDs)
    ));
    const status = terminalStatus(groupNodes);
    if (!existing && status !== "generating") return;

    const outputs = outputNodes(groupNodes);
    const primary = outputs[0] || groupNodes[0];
    const totalCount = Math.max(1, outputs.length);
    const completedCount = outputs.filter((node) => node.generation_status === "success").length;
    const failedCount = outputs.filter((node) => node.generation_status === "error").length;
    const progressValues = outputs.map((node) => node.generation_progress).filter((value): value is number => typeof value === "number");
    const settledProgress = Math.round(((completedCount + failedCount) / totalCount) * 100);
    const progress = status === "success" ? 100 : Math.max(settledProgress, progressValues.length ? Math.round(progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length) : status === "generating" ? 8 : 0);
    const type = taskType(groupNodes);
    const error = groupNodes.find((node) => node.generation_error)?.generation_error || "";
    const item: CanvasTaskQueueItem = {
      id: existing?.id || `${canvasID}:${serverTaskID}`,
      serverTaskID,
      canvasID,
      canvasTitle,
      nodeIDs: [...new Set([...(existing?.nodeIDs || []), ...nodeIDs])],
      type,
      title: primary?.title || `${type}任务`,
      prompt: primary?.composer_content || primary?.prompt || "",
      model: taskModel(primary, type),
      status,
      totalCount,
      completedCount,
      failedCount,
      progress: Math.min(100, progress),
      error,
      startedAt: Math.min(...groupNodes.map((node) => node.generation_started_at || now)),
      ...(status === "generating" ? {} : { completedAt: existing?.completedAt || now }),
    };
    if (existing) current[current.indexOf(existing)] = item;
    else current.push(item);
    matchedIDs.add(item.id);
  });

  current.forEach((item, index) => {
    if (item.canvasID !== canvasID || item.completedAt || matchedIDs.has(item.id)) return;
    current[index] = { ...item, status: "cancelled", completedAt: now, progress: 0 };
  });

  current.sort((left, right) => right.startedAt - left.startedAt);
  emit(current);
  scheduleTerminalPrune();
}

export function subscribeCanvasTaskQueue(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCanvasTaskQueueSnapshot() {
  return snapshot;
}

export function resetCanvasTaskQueueForTests() {
  if (pruneTimer) clearTimeout(pruneTimer);
  pruneTimer = null;
  snapshot = [];
}
