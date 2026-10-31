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
  onUpdate: (snapshot: TaskSnapshot) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
};
type OpenTaskStream = (options: { signal: AbortSignal; onData: (data: string) => void }) => Promise<void>;

export class CreationTaskTimeoutError extends Error {}

function abortError() { return new DOMException("任务订阅已取消", "AbortError"); }

// One connection per browser session, shared by every task waiter and workspace.
// A reconnect receives a full snapshot; normal events carry changed tasks only.
export function createCreationTaskEventClient(open: OpenTaskStream) {
  const observers = new Set<TaskObserver>();
  const cleanups = new Map<TaskObserver, () => void>();
  const tasks = new Map<string, CreationTask>();
  let connection: AbortController | undefined;
  let ready = false;

  const stop = () => {
    connection?.abort();
    connection = undefined;
    ready = false;
    tasks.clear();
  };
  const failAll = (error: Error) => {
    const current = [...observers];
    current.forEach(observer => cleanups.get(observer)?.());
    stop();
    current.forEach(observer => observer.onError(error));
  };
  const deliver = (observer: TaskObserver, deletedIDs: string[] = []) => {
    if (!observers.has(observer) || observer.signal?.aborted) return;
    try { observer.onUpdate({ items: [...tasks.values()], deletedIDs }); }
    catch (error) {
      cleanups.get(observer)?.();
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
    if (event.type === "snapshot") tasks.clear();
    for (const task of event.items) {
      if (!task || typeof task.id !== "string") throw new Error("任务事件缺少 ID");
      const current = tasks.get(task.id);
      if (current && (Number(current.revision) || 0) > (Number(task.revision) || 0)) continue;
      tasks.set(task.id, task);
    }
    for (const id of previousIDs) if (!tasks.has(id)) deletedIDs.add(id);
    for (const id of deletedIDs) tasks.delete(id);
    ready = true;
    [...observers].forEach(observer => deliver(observer, [...deletedIDs]));
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
        await open({ signal: controller.signal, onData: data => {
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
  const watch = (observer: TaskObserver) => {
    if (observer.signal?.aborted) return () => {};
    observers.add(observer);
    const unsubscribe = () => {
      observers.delete(observer);
      cleanups.delete(observer);
      observer.signal?.removeEventListener("abort", unsubscribe);
      if (!observers.size) stop();
    };
    cleanups.set(observer, unsubscribe);
    observer.signal?.addEventListener("abort", unsubscribe, { once: true });
    if (ready) queueMicrotask(() => deliver(observer));
    if (!connection) {
      connection = new AbortController();
      void run(connection);
    }
    return unsubscribe;
  };
  const wait = (id: string, options: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (task: CreationTask) => void } = {}) => new Promise<CreationTask>((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason || abortError()); return; }
    let unsubscribe = () => {};
    let settled = false;
    let previousTask: CreationTask | undefined;
    const finish = (task?: CreationTask, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (task) resolve(task); else reject(error);
    };
    const abort = () => finish(undefined, options.signal?.reason || abortError());
    const timer = setTimeout(() => finish(undefined, new CreationTaskTimeoutError("任务等待超时，请稍后在任务队列中查看结果")), options.timeoutMs ?? 8 * 60_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    unsubscribe = watch({
      signal: options.signal,
      onError: error => finish(undefined, error),
      onUpdate: ({ items, deletedIDs }) => {
        const task = items.find(item => item.id === id);
        if (!task) {
          if (deletedIDs.includes(id)) finish(undefined, new Error("任务记录已被删除"));
          return;
        }
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

const client = createCreationTaskEventClient(options => httpRequestEventStream("/api/creation-tasks/events", {
  ...options, timeout: 0, idleTimeoutMs: 45_000, maxEventCharacters: 64 * 1024 * 1024,
}));

if (typeof window !== "undefined") window.addEventListener(AUTH_SESSION_CHANGE_EVENT, client.reset);

export const watchCreationTasks = client.watch;
export const waitForCreationTask = client.wait;
