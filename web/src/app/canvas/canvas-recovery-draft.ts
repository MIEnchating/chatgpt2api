import type { CanvasDocument } from "@/services/api/canvas";
import type { CanvasAssistantSession } from "./agent/canvas-agent-types";
import { isCanvasAgentSession, parseCanvasAgentSessions } from "./agent/canvas-agent-sessions";
import { canvasDocumentValuesEqual } from "./canvas-document-equality";

type CanvasDraftChanges = {
  canvas: Pick<CanvasDocument, "title" | "nodes" | "connections" | "background" | "show_image_info" | "viewport" | "agent_panel" | "agent_config" | "agent_auto_title_pending" | "active_agent_session_id">;
  sessions: CanvasAssistantSession[];
  deletedSessionIDs: string[];
};

export type CanvasRecoveryDraftSummary = {
  scope: string;
  id: string;
  revision: number;
  version: number;
  updatedAt: number;
};

export function canvasRecoveryDraftScope(accountID: string, projectID: string) {
  return JSON.stringify([accountID, projectID]);
}

export function captureCanvasDraftChanges(base: CanvasDocument, current: CanvasDocument): CanvasDraftChanges {
  const { title, nodes, connections, background, show_image_info, viewport, agent_panel, agent_config, agent_auto_title_pending, active_agent_session_id } = current;
  const before = new Map((base.agent_sessions || []).filter(isCanvasAgentSession).map(session => [session.id, session]));
  return {
    canvas: { title, nodes, connections, background, show_image_info, viewport, agent_panel, agent_config, agent_auto_title_pending, active_agent_session_id },
    sessions: (current.agent_sessions || []).filter(isCanvasAgentSession).filter(session => !canvasDocumentValuesEqual(before.get(session.id), session)),
    deletedSessionIDs: current.deleted_agent_session_ids || [],
  };
}

export function recoverCanvasDraftDocument(remote: CanvasDocument, changes: CanvasDraftChanges, asCopy: boolean): CanvasDocument {
  const sessions = new Map(parseCanvasAgentSessions(remote.agent_sessions).map(session => [session.id, session]));
  for (const session of changes.sessions) sessions.set(session.id, session);
  for (const id of changes.deletedSessionIDs) sessions.delete(id);
  const document = { ...remote, ...changes.canvas, agent_sessions: [...sessions.values()] };
  if (!asCopy) return document;
  const encoder = new TextEncoder();
  const suffix = "（恢复草稿）";
  let title = "", bytes = encoder.encode(suffix).length;
  for (const character of document.title) {
    bytes += encoder.encode(character).length;
    if (bytes > 200) break;
    title += character;
  }
  return {
    ...document,
    title: title + suffix,
    agent_run: undefined,
    pending_agent_request: undefined,
    agent_sessions: [...sessions.values()].map(session => ({
      ...session,
      codexThreadId: undefined,
      codexServiceId: undefined,
      ...(session.messageQueue ? { messageQueue: { ...session.messageQueue, paused: true, steeringId: undefined } } : {}),
    })),
  };
}

const DRAFTS = "drafts";
const CHANGES = "changes";
let opening: Promise<IDBDatabase> | undefined;

function openDraftDatabase() {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("chatgpt2api-canvas-recovery", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore(DRAFTS, { keyPath: ["scope", "id"] }).createIndex("scope", "scope");
      database.createObjectStore(CHANGES);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); opening = undefined; };
      database.onclose = () => { opening = undefined; };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => { opening = undefined; throw error; });
  return opening;
}

async function draftTransaction<T>(mode: IDBTransactionMode, run: (transaction: IDBTransaction, result: (value: T) => void) => void) {
  const database = await openDraftDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction([DRAFTS, CHANGES], mode, { durability: mode === "readwrite" ? "strict" : "default" });
    let value: T;
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = () => reject(transaction.error || new Error("本地草稿读写中断"));
    run(transaction, (result) => { value = result; });
  });
}

export async function listCanvasRecoveryDrafts(scope: string) {
  return draftTransaction<CanvasRecoveryDraftSummary[]>("readonly", (transaction, result) => {
    const request = transaction.objectStore(DRAFTS).index("scope").getAll(scope);
    request.onsuccess = () => result((request.result as CanvasRecoveryDraftSummary[]).sort((a, b) => b.updatedAt - a.updatedAt));
  });
}

export async function writeCanvasRecoveryDraft(summary: CanvasRecoveryDraftSummary, changes: CanvasDraftChanges) {
  return draftTransaction<void>("readwrite", (transaction) => {
    const drafts = transaction.objectStore(DRAFTS);
    const key = [summary.scope, summary.id];
    const request = drafts.get(key);
    request.onsuccess = () => {
      if (request.result && request.result.version >= summary.version) return;
      drafts.put(summary);
      transaction.objectStore(CHANGES).put(changes, key);
    };
  });
}

export async function readCanvasRecoveryDraft(summary: CanvasRecoveryDraftSummary) {
  return draftTransaction<CanvasDraftChanges | undefined>("readonly", (transaction, result) => {
    const key = [summary.scope, summary.id];
    const request = transaction.objectStore(DRAFTS).get(key);
    request.onsuccess = () => {
      if (request.result?.version !== summary.version) return;
      const changes = transaction.objectStore(CHANGES).get(key);
      changes.onsuccess = () => result(changes.result);
    };
  });
}

export async function clearCanvasRecoveryDraft(scope: string, id: string, throughVersion: number) {
  return draftTransaction<boolean>("readwrite", (transaction, result) => {
    const key = [scope, id];
    const drafts = transaction.objectStore(DRAFTS);
    const request = drafts.get(key);
    request.onsuccess = () => {
      const removed = Boolean(request.result && request.result.version <= throughVersion);
      if (removed) {
        drafts.delete(key);
        transaction.objectStore(CHANGES).delete(key);
      }
      result(removed);
    };
  });
}
