import type { CreationTask } from "@/lib/api";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { httpRequestEventStream } from "@/lib/request";
import { isRetryableTaskPollError } from "@/lib/generation-task-contract";

type TaskEvent = {
  type: "snapshot" | "tasks";
  items: CreationTask[];
  deleted_ids: string[];
};
type TaskSnapshot = { items: CreationTask[]; deletedIDs: string[] };
type TaskObserver = {
  workflowBatchIDs: readonly string[];
  onUpdate: (snapshot: TaskSnapshot) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
};
type TaskListener = Pick<TaskObserver, "onError" | "signal"> & {
  taskID?: string;
  workflowBatchIDs?: readonly string[];
  onChange: (deletedIDs: ReadonlySet<string>) => void;
};
type TaskStreamScope = { task_ids: string[]; workflow_batch_ids: string[] };
type OpenTaskStream = (options: { scope: TaskStreamScope; signal: AbortSignal; onData: (data: string) => void }) => Promise<void>;

function workflowBatchID(task: CreationTask) {
  const context = task.workflow_context as { workflow_id?: unknown; batch_task_id?: unknown } | undefined;
  if (typeof context?.workflow_id !== "string" || !context.workflow_id) return undefined;
  return (typeof context.batch_task_id === "string" && context.batch_task_id.trim()) || task.id;
}

export class CreationTaskTimeoutError extends Error {}

function abortError() { return new DOMException("任务订阅已取消", "AbortError"); }

// One connection per browser session, shared by every task waiter and workspace.
// A reconnect receives the latest snapshot for the current task and batch IDs.
export function createCreationTaskEventClient(open: OpenTaskStream) {
  const observers = new Map<TaskListener, () => void>();
  const tasks = new Map<string, CreationTask>();
  const removedTaskIDs = new Set<string>();
  let connection: AbortController | undefined;
  let connectedTaskIDs = new Set<string>();
  let connectedBatchIDs = new Set<string>();
  let reconcileQueued = false;
  let ready = false;

  const stop = () => {
    connection?.abort();
    connection = undefined;
    ready = false;
    tasks.clear();
    removedTaskIDs.clear();
    connectedTaskIDs.clear();
    connectedBatchIDs.clear();
  };
  const failAll = (error: Error) => {
    const current = [...observers.keys()];
    for (const cleanup of observers.values()) cleanup();
    stop();
    current.forEach(observer => observer.onError(error));
  };
  const deliver = (observer: TaskListener, deletedIDs: ReadonlySet<string>) => {
    if (!observers.has(observer) || observer.signal?.aborted) return;
    try { observer.onChange(deletedIDs); }
    catch (error) {
      observers.get(observer)?.();
      observer.onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const receive = (data: string) => {
    const event = JSON.parse(data) as TaskEvent | { type: "error"; message: string; status?: number };
    if (event.type === "error") throw Object.assign(new Error(event.message), { status: event.status });
    if ((event.type !== "snapshot" && event.type !== "tasks") || !Array.isArray(event.items) || !Array.isArray(event.deleted_ids)) {
      throw new Error("任务事件格式无效");
    }
    const previousIDs = event.type === "snapshot" ? [...tasks.keys()] : [];
    const deletedIDs = new Set(event.deleted_ids);
    const snapshotIDs = new Set<string>();
    for (const task of event.items) {
      if (!task || typeof task.id !== "string") throw new Error("任务事件缺少 ID");
      snapshotIDs.add(task.id);
      removedTaskIDs.delete(task.id);
      const current = tasks.get(task.id);
      if (current && (Number(current.revision) || 0) > (Number(task.revision) || 0)) continue;
      tasks.set(task.id, task);
    }
    for (const id of previousIDs) if (!snapshotIDs.has(id)) deletedIDs.add(id);
    for (const id of deletedIDs) {
      tasks.delete(id);
      if (connectedTaskIDs.has(id)) removedTaskIDs.add(id);
    }
    ready = true;
    Array.from(observers.keys()).forEach(observer => deliver(observer, deletedIDs));
  };
  const reconnectDelay = (milliseconds: number, signal: AbortSignal) => new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
  const run = async (controller: AbortController) => {
    let failures = 0;
    while (!controller.signal.aborted && observers.size) {
      try {
        const scope = currentScope();
        connectedTaskIDs = new Set(scope.task_ids);
        connectedBatchIDs = new Set(scope.workflow_batch_ids);
        for (const [id, task] of tasks) {
          const batchID = workflowBatchID(task);
          if (!connectedTaskIDs.has(id) && !(batchID && connectedBatchIDs.has(batchID))) tasks.delete(id);
        }
        for (const id of removedTaskIDs) {
          if (!connectedTaskIDs.has(id)) removedTaskIDs.delete(id);
        }
        await open({ scope, signal: controller.signal, onData: data => {
          if (controller.signal.aborted || connection !== controller) return;
          receive(data);
          failures = 0;
        } });
        if (!controller.signal.aborted) throw new Error("任务事件连接已断开");
      } catch (error) {
        if (controller.signal.aborted || connection !== controller) return;
        ready = false;
        if (!isRetryableTaskPollError(error)) {
          failAll(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        await reconnectDelay(Math.min(10_000, 500 * 2 ** Math.min(failures++, 5)), controller.signal);
      }
    }
  };
  const currentScope = (): TaskStreamScope => {
    const taskIDs = new Set<string>();
    const batchIDs = new Set<string>();
    for (const observer of observers.keys()) {
      if (observer.taskID) taskIDs.add(observer.taskID);
      for (const id of observer.workflowBatchIDs || []) batchIDs.add(id);
    }
    return { task_ids: [...taskIDs], workflow_batch_ids: [...batchIDs] };
  };
  const reconcileConnection = () => {
    reconcileQueued = false;
    if (!observers.size) return;
    const scope = currentScope();
    if (connection && scope.task_ids.every(id => connectedTaskIDs.has(id)) &&
      scope.workflow_batch_ids.every(id => connectedBatchIDs.has(id))) return;
    connection?.abort();
    connection = new AbortController();
    ready = false;
    void run(connection);
  };
  const subscribe = (observer: TaskListener) => {
    if (observer.signal?.aborted) return () => {};
    const unsubscribe = () => {
      observers.delete(observer);
      observer.signal?.removeEventListener("abort", unsubscribe);
      if (!observers.size) stop();
    };
    observers.set(observer, unsubscribe);
    observer.signal?.addEventListener("abort", unsubscribe, { once: true });
    if (!reconcileQueued) {
      reconcileQueued = true;
      queueMicrotask(reconcileConnection);
    }
    if (ready) queueMicrotask(() => { if (ready) deliver(observer, new Set()); });
    return unsubscribe;
  };
  const watch = ({ onUpdate, ...observer }: TaskObserver) => {
    if (!observer.workflowBatchIDs.length) return () => {};
    const batches = new Set(observer.workflowBatchIDs);
    return subscribe({
      ...observer,
      onChange: (deletedIDs) => onUpdate({
        items: [...tasks.values()].filter(task => {
          const id = workflowBatchID(task);
          return id !== undefined && batches.has(id);
        }),
        deletedIDs: [...deletedIDs],
      }),
    });
  };
  const wait = (id: string, options: { signal?: AbortSignal; timeoutMs?: number | null; minRevision?: number; onProgress?: (task: CreationTask) => void } = {}) => new Promise<CreationTask>((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason || abortError()); return; }
    let unsubscribe = () => {};
    let settled = false;
    let previousTask: CreationTask | undefined;
    const finish = (task?: CreationTask, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (task) resolve(task); else reject(error);
    };
    const abort = () => finish(undefined, options.signal?.reason || abortError());
    // A null deadline follows the server task until completion or cancellation.
    const timer = options.timeoutMs === null ? undefined : setTimeout(() => finish(undefined, new CreationTaskTimeoutError("任务等待超时，请稍后在任务队列中查看结果")), options.timeoutMs ?? 8 * 60_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    unsubscribe = subscribe({
      taskID: id,
      signal: options.signal,
      onError: error => finish(undefined, error),
      onChange: (deletedIDs) => {
        const task = tasks.get(id);
        if (!task) {
          if (deletedIDs.has(id) || removedTaskIDs.has(id)) finish(undefined, new Error("任务记录已被删除"));
          return;
        }
        if (options.minRevision !== undefined && (Number(task.revision) || 0) < options.minRevision) return;
        if (previousTask !== task) options.onProgress?.(task);
        previousTask = task;
        if (["success", "error", "cancelled"].includes(task.status)) finish(task);
      },
    });
    if (settled) unsubscribe();
  });
  const reset = () => failAll(abortError());
  return { watch, wait, reset };
}

const client = createCreationTaskEventClient(({ scope, ...options }) => httpRequestEventStream("/api/creation-tasks/events", {
  ...options, method: "POST", body: scope, timeout: 0, idleTimeoutMs: 45_000, maxEventCharacters: 64 * 1024 * 1024,
}));

if (typeof window !== "undefined") window.addEventListener(AUTH_SESSION_CHANGE_EVENT, client.reset);

export const watchCreationTasks = client.watch;
export const waitForCreationTask = client.wait;
