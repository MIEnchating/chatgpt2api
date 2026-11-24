import { httpRequest, httpRequestEventStream } from "@/lib/request";
import { isRetryableTaskPollError } from "@/lib/generation-task-contract";
import type { CanvasDocument } from "@/services/api/canvas";
import type { CanvasAgentGenerationConfig } from "./canvas-agent-context";
import type { CanvasAgentQueuedMessage, CanvasAssistantReference } from "./canvas-agent-types";
import type { CanvasAgentAction } from "./canvas-agent-tools";
import { CANVAS_AGENT_RESULT_UNKNOWN_PREFIX } from "./canvas-agent-run-state";

export type CanvasBackendAgentRequest = {
  id: string;
  sessionId: string;
  assistantId: string;
  userMessageId: string;
  userText: string;
  model: string;
  relayTokenName: string;
  apiMode: "chat" | "responses";
  stream: boolean;
  reasoningEnabled: boolean;
  configuredSystemPrompt?: string;
  generation: CanvasAgentGenerationConfig;
  relayTokens: Record<string, string>;
  videoRelayTokens: Record<string, string>;
  references: CanvasAssistantReference[];
  selectedNodeIds: string[];
  skillIds: string[];
  resume: boolean;
  editPreviousRequest: boolean;
  readOnly?: boolean;
  modelRequestLimit?: number;
  goalContinuation?: number;
  mediaGenerationChoice?: "generate" | "defer";
};
const path = (projectID: string) => `/api/canvas/agent-runs?history=active&project_id=${encodeURIComponent(projectID)}`;
export class CanvasAgentStopError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? `停止失败：${cause.message}` : "停止失败，请重试", { cause });
  }
}
export class CanvasAgentObservationError extends Error {
  constructor(cause: unknown) {
    super(`后台执行进度暂未同步：${cause instanceof Error ? cause.message : "暂时无法读取进度"}。已保留原任务和最近记录，请核对原任务状态。`, { cause });
  }
}
export function fetchCanvasAgentRun(projectID: string, signal?: AbortSignal) {
  return httpRequest<{ document: CanvasDocument }>(path(projectID), { signal });
}
export function compactCanvasAgentContext(projectID: string, body: Pick<CanvasBackendAgentRequest, "sessionId" | "model" | "relayTokenName" | "apiMode" | "modelRequestLimit">) {
  return httpRequest<{ kind: "unchanged" | "pruned" | "summarized"; savedTokens: number }>(
    `/api/canvas/agent-context?project_id=${encodeURIComponent(projectID)}`,
    { method: "POST", body, timeout: 0 },
  );
}
export type CanvasAgentQueueUpdate = {
  sessionId: string;
  action: "append" | "steer" | "remove" | "pause" | "resume" | "unpause";
  messageId?: string;
  message?: CanvasAgentQueuedMessage;
  afterRunId?: string;
  settings?: Omit<CanvasBackendAgentRequest, "id" | "sessionId" | "assistantId" | "userMessageId" | "userText" | "references" | "resume" | "editPreviousRequest">;
};
export function updateBackendCanvasAgentQueue(projectID: string, body: CanvasAgentQueueUpdate) {
  return httpRequest<{ document: CanvasDocument }>(path(projectID), { method: "PATCH", body });
}
export function stopCanvasAgentRun(projectID: string, runID: string) {
  return httpRequest<{ document: CanvasDocument }>(`${path(projectID)}&run_id=${encodeURIComponent(runID)}`, { method: "DELETE" });
}
export async function runBackendCanvasAgent(projectID: string, request: CanvasBackendAgentRequest, onDocument: (document: CanvasDocument) => void, signal: AbortSignal, onObservationError?: (error: CanvasAgentObservationError) => void) {
  return submitAndObserve(projectID, request.id, path(projectID), canvasAgentRequestReferences(request), onDocument, signal, onObservationError);
}
export async function runBackendCanvasTool(projectID: string, context: CanvasBackendAgentRequest, call: CanvasAgentAction, onDocument: (document: CanvasDocument) => void, signal: AbortSignal, onObservationError?: (error: CanvasAgentObservationError) => void) {
  const document = await submitAndObserve(projectID, context.id, `/api/canvas/agent-tools?history=active&project_id=${encodeURIComponent(projectID)}`, { context: canvasAgentRequestReferences(context), call }, onDocument, signal, onObservationError);
  if (!document || document.agent_run?.id !== context.id) throw new Error(`${CANVAS_AGENT_RESULT_UNKNOWN_PREFIX}未找到本次工具任务记录，请先核对画布和任务状态。`);
  if (!document.agent_run.toolResult) {
    if (document.agent_run.status === "error" && document.agent_run.error) throw new Error(document.agent_run.error);
    throw new Error(`${CANVAS_AGENT_RESULT_UNKNOWN_PREFIX}工具任务已结束，但未返回执行结果。请先核对画布和已有任务状态，不要直接重复提交。`);
  }
  return { result: document.agent_run.toolResult, document };
}

async function submitAndObserve(projectID: string, runID: string, endpoint: string, body: unknown, onDocument: (document: CanvasDocument) => void, signal: AbortSignal, onObservationError?: (error: CanvasAgentObservationError) => void) {
  if (signal.aborted) return;
  let stopRequest: Promise<{ document: CanvasDocument } | undefined> | undefined;
  const stop = () => {
    if (signal.reason !== "canvas-detached" && !stopRequest) stopRequest = stopCanvasAgentRun(projectID, runID).catch(() => undefined);
  };
  signal.addEventListener("abort", stop);
  if (signal.aborted) stop();
  try {
    const submitted = submitCanvasAgentRun(projectID, runID, endpoint, body);
    const aborted = new Promise<{ document: CanvasDocument } | undefined>((resolve) => {
      const resolveStop = () => { stop(); void (stopRequest || Promise.resolve(undefined)).then(resolve); };
      if (signal.aborted) resolveStop();
      else signal.addEventListener("abort", resolveStop, { once: true });
      void submitted.finally(() => signal.removeEventListener("abort", resolveStop)).catch(() => {});
    });
    const first = await Promise.race([submitted, aborted]);
    if (signal.aborted && signal.reason === "canvas-detached") return;
    const stopped = first && signal.aborted && stopRequest && first.document.agent_run?.id === runID ? await stopRequest : undefined;
    const response = stopped?.document.agent_run?.id === runID ? stopped : first || await submitted;
    signal.removeEventListener("abort", stop);
    return observeCanvasAgentRun(projectID, runID, response, onDocument, signal, Boolean(stopped), onObservationError);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
export function answerBackendWorkflowReview(projectID: string, sessionId: string, prompts: Record<string, string>, answer: string) {
  return httpRequest<{ document: CanvasDocument }>(`/api/canvas/agent-tools/review-answers?history=active&project_id=${encodeURIComponent(projectID)}`, { method: "POST", body: { sessionId, prompts, answer } });
}

async function submitCanvasAgentRun(projectID: string, runID: string, endpoint: string, body: unknown) {
  try {
    return await httpRequest<{ document: CanvasDocument }>(endpoint, { method: "POST", body });
  } catch (error) {
    // A lost acknowledgement does not mean the server rejected the run. Read
    // the same execution ID before reporting failure; never submit it twice.
    try {
      const response = await fetchCanvasAgentRun(projectID);
      if (response.document.agent_run?.id === runID) return response;
    } catch { /* Keep the original submission error when recovery is unavailable. */ }
    throw error;
  }
}

type CanvasProgressDelta = {
  type: "delta";
  base_revision: number;
  revision: number;
  operations: { path: (string | number)[]; value: unknown; remove?: boolean; append?: boolean }[];
};

function appendCanvasProgressText(previous: unknown, value: unknown) {
  if (typeof previous !== "string" || typeof value !== "string") throw new SyntaxError("画布增量文本无效");
  return previous + value;
}

function applyCanvasProgressDelta(document: CanvasDocument, delta: CanvasProgressDelta): CanvasDocument {
  if (!Array.isArray(delta.operations) || !Number.isSafeInteger(delta.revision) || delta.revision < document.revision) {
    throw new SyntaxError("画布增量格式无效");
  }
  const next = { ...document };
  // Published snapshots are immutable. Copy only ancestors of changed fields.
  const writable = new WeakSet<object>([next]);
  for (const operation of delta.operations) {
    const { path, value, remove, append } = operation;
    if (!Array.isArray(path) || !path.length) throw new SyntaxError("画布增量路径无效");
    let target: object = next;
    for (const [index, key] of path.entries()) {
      if (Array.isArray(target)) {
        if (typeof key !== "number" || !Number.isInteger(key) || key < 0 || key > target.length) throw new SyntaxError("画布增量索引无效");
      } else if (typeof key !== "string") {
        throw new SyntaxError("画布增量字段无效");
      }
      const previous: unknown = Object.hasOwn(target, key) ? Reflect.get(target, key) : undefined;
      if (index === path.length - 1) {
        if (!remove) {
          writeCanvasProgressField(target, key, append ? appendCanvasProgressText(previous, value) : value);
        } else if (Array.isArray(target)) {
          if (Number(key) >= target.length) throw new SyntaxError("画布增量删除索引无效");
          target.splice(Number(key), 1);
        } else {
          Reflect.deleteProperty(target, key);
        }
        break;
      }
      if (!previous || typeof previous !== "object") throw new SyntaxError("画布增量路径无效");
      if (writable.has(previous)) {
        target = previous;
        continue;
      }
      const child = Array.isArray(previous) ? previous.slice() : { ...previous };
      writeCanvasProgressField(target, key, child);
      writable.add(child);
      target = child;
    }
  }
  if (next.revision !== delta.revision || next.id !== document.id) throw new SyntaxError("画布增量版本无效");
  return next;
}

function writeCanvasProgressField(target: object, key: string | number, value: unknown) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

export async function watchCanvasAgentProgress(projectID: string, runID: string, signal: AbortSignal, onDocument: (document: CanvasDocument) => void, onError?: (error: CanvasAgentObservationError) => void, initial?: CanvasDocument) {
  let latest: CanvasDocument | undefined;
  let applied: CanvasDocument | undefined;
  let terminal = false;
  let failures = 0;
  const accept = (document: CanvasDocument) => {
    signal.throwIfAborted();
    if (document?.id !== projectID || !Number.isSafeInteger(document.revision)) throw new SyntaxError("画布进度格式无效");
    if (applied && document.revision < applied.revision) return;
    if (applied !== document && (!applied || applied.revision !== document.revision || applied.agent_run?.id !== document.agent_run?.id || applied.agent_run?.status !== document.agent_run?.status)) {
      try {
        onDocument(document);
      } catch (cause) {
        const error = new CanvasAgentObservationError(cause);
        if (!onError) throw error;
        onError(error);
        return;
      }
      applied = document;
      failures = 0;
    }
    latest = document;
    terminal = document.agent_run?.id !== runID || document.agent_run.status !== "running";
  };
  if (initial) {
    try { accept(initial); }
    catch (cause) { throw cause instanceof CanvasAgentObservationError ? cause : new CanvasAgentObservationError(cause); }
  }
  while (!terminal) {
    signal.throwIfAborted();
    let baseline: CanvasDocument | undefined;
    try {
      await httpRequestEventStream(`${path(projectID)}&run_id=${encodeURIComponent(runID)}`, {
        signal, timeout: 0, idleTimeoutMs: 45_000, onData(data) {
          const event = JSON.parse(data) as { type: "snapshot"; document: CanvasDocument } | CanvasProgressDelta | { type: "error"; status: number; message: string };
          if (event?.type === "error") throw Object.assign(new Error(event.message), { status: event.status });
          if (event?.type === "snapshot") baseline = event.document;
          else if (event?.type === "delta") {
            if (!baseline || baseline.revision !== event.base_revision) throw new Error("画布进度版本不同步，正在重新连接");
            baseline = applyCanvasProgressDelta(baseline, event);
          } else throw new SyntaxError("画布进度格式无效");
          accept(baseline);
        },
      });
      if (!terminal) throw new Error("画布进度连接已断开");
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof CanvasAgentObservationError) throw cause;
      if (terminal) return latest;
      const error = new CanvasAgentObservationError(cause);
      if (cause instanceof SyntaxError || !isRetryableTaskPollError(cause) || failures >= 5) throw error;
      onError?.(error);
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, Math.min(4000, 500 * 2 ** failures++));
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  return latest;
}

async function observeCanvasAgentRun(projectID: string, runID: string, initial: { document: CanvasDocument }, onDocument: (document: CanvasDocument) => void, signal: AbortSignal, alreadyStopped = false, onObservationError?: (error: CanvasAgentObservationError) => void) {
  const observation = new AbortController();
  const abort = () => observation.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    if (!signal.aborted) return await watchCanvasAgentProgress(projectID, runID, observation.signal, onDocument, onObservationError, initial.document);
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (signal.reason === "canvas-detached") return;
  let stopped = initial;
  if (!alreadyStopped) {
    try {
      stopped = await stopCanvasAgentRun(projectID, runID);
    } catch (error) {
      throw new CanvasAgentStopError(error);
    }
  }
  return watchCanvasAgentProgress(projectID, runID, new AbortController().signal, onDocument, onObservationError, stopped.document);
}

// Persisted nodes and attachments are authoritative; requests carry handles only.
function canvasAgentRequestReferences(request: CanvasBackendAgentRequest) {
  return { ...request, references: request.references.map(({ id, source }) => ({ id, source })) };
}
