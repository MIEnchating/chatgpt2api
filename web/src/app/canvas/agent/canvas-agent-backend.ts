import { httpRequest } from "@/lib/request";
import type { CanvasDocument } from "@/services/api/canvas";
import type { CanvasAgentGenerationConfig } from "./canvas-agent-context";
import type { CanvasAssistantReference } from "./canvas-agent-types";
import type { CanvasAgentAction } from "./canvas-agent-tools";

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
  references: CanvasAssistantReference[];
  selectedNodeIds: string[];
  skillIds: string[];
  resume: boolean;
  editPreviousRequest: boolean;
  mediaGenerationChoice?: "generate" | "defer";
};
const path = (projectID: string) => `/api/canvas/agent-runs?project_id=${encodeURIComponent(projectID)}`;
export function fetchCanvasAgentRun(projectID: string, signal?: AbortSignal) {
  return httpRequest<{ document: CanvasDocument }>(path(projectID), { signal });
}
export function stopCanvasAgentRun(projectID: string, runID: string) {
  return httpRequest<{ document: CanvasDocument }>(`${path(projectID)}&run_id=${encodeURIComponent(runID)}`, { method: "DELETE" });
}
export async function runBackendCanvasAgent(projectID: string, request: CanvasBackendAgentRequest, onDocument: (document: CanvasDocument) => void, signal: AbortSignal) {
  const response = await httpRequest<{ document: CanvasDocument }>(path(projectID), { method: "POST", body: canvasAgentRequestReferences(request) });
  return observeCanvasAgentRun(projectID, request.id, response, onDocument, signal);
}
export async function runBackendCanvasTool(projectID: string, context: CanvasBackendAgentRequest, call: CanvasAgentAction, onDocument: (document: CanvasDocument) => void, signal: AbortSignal) {
  const response = await httpRequest<{ document: CanvasDocument }>(`/api/canvas/agent-tools?project_id=${encodeURIComponent(projectID)}`, { method: "POST", body: { context: canvasAgentRequestReferences(context), call } });
  const document = await observeCanvasAgentRun(projectID, context.id, response, onDocument, signal);
  if (!document || document.agent_run?.id !== context.id || !document.agent_run.toolResult) throw new Error("工具执行未返回结果，请先核对画布状态");
  return { result: document.agent_run.toolResult, document };
}
export function answerBackendWorkflowReview(projectID: string, sessionId: string, prompts: Record<string, string>, answer: string) {
  return httpRequest<{ document: CanvasDocument }>(`/api/canvas/agent-tools/review-answers?project_id=${encodeURIComponent(projectID)}`, { method: "POST", body: { sessionId, prompts, answer } });
}
async function observeCanvasAgentRun(projectID: string, runID: string, initial: { document: CanvasDocument }, onDocument: (document: CanvasDocument) => void, signal: AbortSignal) {
  // A detached browser only stops observing; explicit Stop cancels the server run.
  let response = initial;
  let stopped = false;
  let failures = 0;
  const stop = () => {
    if (signal.reason === "canvas-detached" || stopped) return;
    stopped = true;
    void stopCanvasAgentRun(projectID, runID).catch(() => { stopped = false; });
  };
  signal.addEventListener("abort", stop);
  try {
    while (true) {
      if (signal.aborted && signal.reason === "canvas-detached") return;
      if (signal.aborted) stop();
      onDocument(response.document);
      if (response.document.agent_run?.id !== runID || response.document.agent_run.status !== "running") return response.document;
      await new Promise((resolve) => setTimeout(resolve, 500));
      try { response = await fetchCanvasAgentRun(projectID); failures = 0; } catch (error) { if (signal.aborted || ++failures > 5) throw error; }
    }
  } finally { signal.removeEventListener("abort", stop); }
}

// Persisted nodes and attachments are authoritative; requests carry handles only.
function canvasAgentRequestReferences(request: CanvasBackendAgentRequest) {
  return { ...request, references: request.references.map(({ id, source }) => ({ id, source })) };
}
