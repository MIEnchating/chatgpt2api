import type { CanvasDocument } from "@/services/api/canvas";
import { canvasAgentHistoryChanges, canvasAgentHistoryReceipt } from "./agent/canvas-agent-history";
import { isCanvasAgentSession } from "./agent/canvas-agent-sessions";
import { mergeCanvasDocuments } from "./canvas-document-merge";

type SubmitCanvasSaveOptions = {
  base: CanvasDocument;
  payload: CanvasDocument;
  remote: CanvasDocument;
  save: (document: CanvasDocument) => Promise<{ document: CanvasDocument }>;
  loadRemote: (projectID: string, sessionIDs: string[]) => Promise<CanvasDocument>;
};

export async function submitCanvasSave({ base, payload, remote, save, loadRemote }: SubmitCanvasSaveOptions) {
  for (let attempt = 0; ; attempt++) {
    const submitted = mergeCanvasDocuments(base, payload, remote);
    const changes = canvasAgentHistoryChanges(submitted, remote);
    let document: CanvasDocument;
    try {
      ({ document } = await save(changes));
    } catch (error) {
      if ((error as { status?: number }).status !== 409 || attempt >= 3) throw error;
      const sessionIDs = (payload.agent_sessions || []).filter(isCanvasAgentSession).map((session) => session.id);
      remote = await loadRemote(payload.id, sessionIDs);
      continue;
    }
    return {
      submitted,
      document: canvasAgentHistoryReceipt(document, { ...submitted, agent_session_updates: changes.agent_session_updates }),
    };
  }
}

export type CanvasSaveFlushOptions = {
  save: () => Promise<boolean>;
  getChangeVersion: () => number;
  getProjectID: () => string;
  maxPasses?: number;
};

export function canvasSaveRequired(persistedVersion: number, changeVersion: number) {
  return persistedVersion !== changeVersion;
}

/** Wait until the save operation has observed the latest edit for one project. */
export async function flushCanvasSaves({ save, getChangeVersion, getProjectID, maxPasses = 8 }: CanvasSaveFlushOptions) {
  const projectID = getProjectID();
  for (let pass = 0; pass < Math.max(1, maxPasses); pass += 1) {
    const version = getChangeVersion();
    if (!(await save())) return false;
    if (getProjectID() !== projectID) return false;
    if (getChangeVersion() === version) return true;
  }
  return false;
}
