import type { CanvasAgentSessionSummary, CanvasAgentSessionUpdate, CanvasDocument } from "@/services/api/canvas";
import type { CanvasAssistantSession } from "./canvas-agent-types";
import { isCanvasAgentSession } from "./canvas-agent-sessions";
import { canvasDocumentValuesEqual } from "../canvas-document-equality";

export function canvasAgentHistorySummaries(document: Pick<CanvasDocument, "agent_session_summaries" | "deleted_agent_session_ids"> & { agent_sessions: readonly CanvasAssistantSession[] }): CanvasAgentSessionSummary[] {
  const removed = new Set(document.deleted_agent_session_ids || []);
  const summaries = new Map((document.agent_session_summaries || []).map(item => [item.id, item]));
  for (const session of document.agent_sessions) {
    summaries.set(session.id, { id: session.id, title: session.title, created_at: session.createdAt, updated_at: session.updatedAt, message_count: session.messages.length, content_hash: summaries.get(session.id)?.content_hash || "" });
  }
  return [...summaries.values()].filter(item => !removed.has(item.id));
}

// Save metadata separately and send bodies only when their content changes.
export function canvasAgentHistoryChanges(document: CanvasDocument, baseline: CanvasDocument): CanvasDocument {
  if (!document.agent_history_partial) return document;
  const before = new Map((baseline.agent_sessions || []).filter(isCanvasAgentSession).map(session => [session.id, session]));
  const versions = new Map((baseline.agent_session_summaries || []).map(summary => [summary.id, summary.content_hash]));
  const bodies: unknown[] = [], updates: CanvasAgentSessionUpdate[] = [];
  for (const session of document.agent_sessions || []) {
    if (!isCanvasAgentSession(session)) { bodies.push(session); continue; }
    const previous = before.get(session.id);
    if (!previous) { bodies.push(session); continue; }
    const current = session as unknown as Record<string, unknown>, original = previous as unknown as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(original), ...Object.keys(current)])].filter(key => !canvasDocumentValuesEqual(current[key], original[key]));
    if (!keys.length) continue;
    if (!versions.get(session.id) || !keys.every(key => ["title", "engine", "updatedAt"].includes(key) && typeof current[key] === "string")) {
      bodies.push(session);
      continue;
    }
    const changes: CanvasAgentSessionUpdate["changes"] = {};
    if (keys.includes("title")) changes.title = session.title;
    if (keys.includes("engine")) changes.engine = session.engine;
    if (keys.includes("updatedAt")) changes.updatedAt = session.updatedAt;
    updates.push({ id: session.id, changes });
  }
  return { ...document, agent_sessions: bodies, ...(updates.length ? { agent_session_updates: updates } : {}) };
}

// Accepted metadata updates acknowledge the submitted body without downloading it again.
export function canvasAgentHistoryReceipt(document: CanvasDocument, submitted: CanvasDocument): CanvasDocument {
  const updates = document.agent_session_updates || [], expected = submitted.agent_session_updates || [];
  if (!Array.isArray(updates) || updates.length !== expected.length || updates.some(update => !update || typeof update.id !== "string" || !update.changes || !canvasDocumentValuesEqual(update.changes, expected.find(item => item.id === update.id)?.changes))) {
    throw new Error("会话保存回执无效，原记录未被替换");
  }
  if (!updates.length) return document;
  const sent = new Map((submitted.agent_sessions || []).filter(isCanvasAgentSession).map(session => [session.id, session]));
  const summaries = new Map((document.agent_session_summaries || []).map(summary => [summary.id, summary.content_hash]));
  const bodies = [...(document.agent_sessions || [])];
  const received = new Set(bodies.filter(isCanvasAgentSession).map(session => session.id));
  const accepted = new Set<string>();
  for (const update of updates) {
    const session = sent.get(update.id);
    if (!session || accepted.has(update.id) || !summaries.get(update.id) || !Object.keys(update.changes).length || !Object.entries(update.changes).every(([key, value]) => ["title", "engine", "updatedAt"].includes(key) && typeof value === "string" && (key !== "engine" || value === "native" || value === "codex"))) {
      throw new Error("会话保存回执无效，原记录未被替换");
    }
    accepted.add(update.id);
    if (!received.has(update.id)) bodies.push({ ...session, ...update.changes });
  }
  const receipt = { ...document, agent_sessions: bodies };
  delete receipt.agent_session_updates;
  return receipt;
}
