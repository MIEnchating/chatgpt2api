import { httpRequest } from "@/lib/request";
import type { CanvasDocument } from "@/services/api/canvas";
import type { CanvasAgentGenerationConfig } from "./canvas-agent-context";
import type { CanvasAssistantReference } from "./canvas-agent-types";
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

async function observeCanvasAgentRun(projectID: string, runID: string, initial: { document: CanvasDocument }, onDocument: (document: CanvasDocument) => void, signal: AbortSignal, alreadyStopped = false, onObservationError?: (error: CanvasAgentObservationError) => void) {
  // A detached browser only stops observing; explicit Stop cancels the server run.
  let response = initial;
  let snapshotPending = true;
  let stopRequest: Promise<{ document: CanvasDocument } | { error: unknown }> | undefined;
  let stopIssued = alreadyStopped;
  let failures = 0;
  const stop = () => {
    if (signal.reason === "canvas-detached" || stopIssued) return;
    stopIssued = true;
    stopRequest = stopCanvasAgentRun(projectID, runID).catch(error => ({ error }));
  };
  signal.addEventListener("abort", stop);
  try {
    while (true) {
      if (signal.aborted && signal.reason === "canvas-detached") return;
      if (signal.aborted) stop();
      let applied = false;
      if (snapshotPending) {
        snapshotPending = false;
        try {
          onDocument(response.document);
          applied = true;
        } catch (error) {
          if (!onObservationError) throw error;
          onObservationError(new CanvasAgentObservationError(error));
        }
      }
      if (applied && (response.document.agent_run?.id !== runID || response.document.agent_run.status !== "running")) return response.document;
      if (signal.aborted && signal.reason === "canvas-detached") return;
      if (stopRequest) {
        const stopped = await stopRequest;
        stopRequest = undefined;
        if ("error" in stopped) throw new CanvasAgentStopError(stopped.error);
        response = stopped;
        snapshotPending = true;
        continue;
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) { setTimeout(resolve, 200); return; }
        const timer = setTimeout(done, 500);
        function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
        signal.addEventListener("abort", done, { once: true });
      });
      if (stopRequest || signal.aborted && signal.reason === "canvas-detached") continue;
      try { response = await fetchCanvasAgentRun(projectID, signal.aborted ? undefined : signal); snapshotPending = true; failures = 0; } catch (error) {
        if (signal.aborted) continue;
        if (onObservationError) onObservationError(new CanvasAgentObservationError(error));
        else if (++failures > 5) throw error;
      }
    }
  } catch (error) {
    if (error instanceof CanvasAgentStopError) throw error;
    throw new CanvasAgentObservationError(error);
  } finally { signal.removeEventListener("abort", stop); }
}

// Persisted nodes and attachments are authoritative; requests carry handles only.
function canvasAgentRequestReferences(request: CanvasBackendAgentRequest) {
  return { ...request, references: request.references.map(({ id, source }) => ({ id, source })) };
}
