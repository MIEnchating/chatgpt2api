import { mergeCanvasAgentMessageQueues } from "./agent/canvas-agent-message-queue";
import { reconcileScriptProject } from "./canvas-script";
import type { CanvasDocument, CanvasScriptProject } from "@/services/api/canvas";
import { parseCanvasAgentSessions } from "./agent/canvas-agent-sessions";
import { createCanvasHistorySnapshot, type CanvasHistorySnapshot } from "./canvas-history";
import { canvasDocumentValuesEqual as equal } from "./canvas-document-equality";

const sessionRecord = (value: unknown): value is Record<string, unknown> & { id: string } =>
  value !== null && typeof value === "object" && "id" in value && typeof value.id === "string";

const SESSION_CONTENT_FIELDS = ["messages", "protocolMessages", "agentState", "contextCheckpoint", "contextUsage", "engine", "resumeAssistantMessageId", "codexThreadId", "codexServiceId", "activeSkillIds"] as const;

export class CanvasAgentSessionConflictError extends Error {
  constructor(readonly sessionIDs: string[], readonly remote: CanvasDocument) {
    super("同一对话在两处发生修改，尚未覆盖任何记录。请保留两份对话后继续。");
    this.name = "CanvasAgentSessionConflictError";
  }
}

function sessionContent(session: Record<string, unknown>) {
  return SESSION_CONTENT_FIELDS.map(key => session[key]);
}

function extendsSessionContent(earlier: Record<string, unknown>, later: Record<string, unknown>) {
  return SESSION_CONTENT_FIELDS.every(key => {
    const before = earlier[key], after = later[key];
    if ((key === "messages" || key === "protocolMessages") && Array.isArray(before) && Array.isArray(after)) {
      return before.length <= after.length && before.every((item, index) => equal(item, after[index]));
    }
    return equal(before, after);
  });
}

function mergeSession(base: Record<string, unknown>, local: Record<string, unknown>, remote: Record<string, unknown>, conflicts: string[]) {
  // An unchanged server snapshot cannot conflict with staged local edits.
  if (remote === base || remote === local) return local;
  const before = sessionContent(base), edited = sessionContent(local), received = sessionContent(remote);
  // Equal acknowledged content keeps the editor's stable transcript references.
  let content = equal(edited, received) ? local : remote;
  if (!equal(before, edited)) {
    if (equal(before, received) || equal(edited, received) || extendsSessionContent(remote, local)) content = local;
    else if (!extendsSessionContent(local, remote)) conflicts.push(String(local.id));
  }
  const result = mergeFields(base, local, remote, SESSION_CONTENT_FIELDS);
  for (const key of SESSION_CONTENT_FIELDS) {
    if (key in content) result[key] = content[key];
    else delete result[key];
  }
  return result;
}

// Preserve a divergent local conversation as a separate, independently resumable branch.
export function forkCanvasAgentSessionConflicts(local: CanvasDocument, sessionIDs: readonly string[], newID: () => string): CanvasDocument {
  const conflicts = new Set(sessionIDs), replacements = new Map<string, string>();
  const sessions = parseCanvasAgentSessions(local.agent_sessions).map(session => {
    if (!conflicts.has(session.id)) return session;
    const id = newID();
    replacements.set(session.id, id);
    return { ...session, id, title: `${session.title}（本页分支）`, codexThreadId: undefined, codexServiceId: undefined,
      ...(session.messageQueue ? { messageQueue: { ...session.messageQueue, paused: true, steeringId: undefined } } : {}) };
  });
  parseCanvasAgentSessions(sessions);
  return { ...local, agent_sessions: sessions, active_agent_session_id: replacements.get(local.active_agent_session_id || "") || local.active_agent_session_id };
}

function mergeFields<T extends object>(base: T, local: T, remote: T, excluded: readonly string[] = []): T {
  const result = { ...remote } as Record<string, unknown>;
  const before = base as Record<string, unknown>, edited = local as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(edited)])) {
    if (excluded.includes(key)) continue;
    if (equal(before[key], edited[key])) continue;
    if (key === "script_project" && before[key] && edited[key] && result[key]) {
      const b = before[key] as CanvasScriptProject, l = edited[key] as CanvasScriptProject, r = result[key] as CanvasScriptProject;
      const project = mergeFields(b, l, r, ["shots", "assets"]);
      project.shots = mergeEntities(b.shots, l.shots, r.shots);
      project.assets = mergeEntities(b.assets, l.assets, r.assets);
      if (!equal(b.shots.map(shot => shot.id), l.shots.map(shot => shot.id))) {
        const order = new Map(l.shots.map((shot, index) => [shot.id, index]));
        project.shots.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
      }
      result[key] = reconcileScriptProject(project, r);
    } else if (key in edited) result[key] = edited[key];
    else delete result[key];
  }
  return result as T;
}

function mergeEntities<T extends { id: string }>(base: T[], local: T[], remote: T[]): T[] {
  const before = new Map(base.map((item) => [item.id, item]));
  const edited = new Map(local.map((item) => [item.id, item]));
  const received = new Set(remote.map((item) => item.id));
  return [
    ...remote.flatMap((item) => {
      const original = before.get(item.id), changed = edited.get(item.id);
      if (original && !changed) return [];
      return [original && changed ? mergeFields(original, changed, item) : item];
    }),
    ...local.filter((item) => !before.has(item.id) && !received.has(item.id)),
  ];
}

// Rebase unsaved browser edits onto a server snapshot without replacing other nodes.
export function mergeCanvasDocuments(base: CanvasDocument, local: CanvasDocument, remote: CanvasDocument): CanvasDocument {
  const conflicts: string[] = [];
  const running = remote.agent_run?.status === "running" || base.agent_run?.status === "running";
  if (remote.agent_run?.status === "running" && base.agent_run?.status !== "running") {
    const before = new Map((base.agent_sessions || []).filter(sessionRecord).map(item => [item.id, item]));
    const edited = new Map((local.agent_sessions || []).filter(sessionRecord).map(item => [item.id, item]));
    const conflicts = (remote.agent_sessions || []).filter(sessionRecord).filter(item => {
      const original = before.get(item.id), changed = edited.get(item.id);
      return original && changed && !equal(sessionContent(original), sessionContent(changed)) && !equal(sessionContent(changed), sessionContent(item));
    });
    if (conflicts.length) throw new CanvasAgentSessionConflictError(conflicts.map(item => item.id), remote);
  }
  const merged = mergeFields(base, local, remote, ["nodes", "connections", "agent_sessions", "agent_session_summaries", "deleted_agent_session_ids"]);
  if (!equal(base.agent_config, local.agent_config)) {
    merged.agent_config = mergeFields(base.agent_config || {}, local.agent_config || {}, remote.agent_config || {});
  }
  merged.nodes = mergeEntities(base.nodes, local.nodes, remote.nodes);
  const ids = new Set(merged.nodes.map((node) => node.id));
  merged.connections = mergeEntities(base.connections, local.connections, remote.connections).filter((edge) => ids.has(edge.from_node_id) && ids.has(edge.to_node_id));
  merged.revision = remote.revision;
  merged.updated_at = remote.updated_at;
  merged.agent_run = remote.agent_run;
  if (remote.agent_history_partial) {
    const removed = new Set(local.deleted_agent_session_ids || []);
    const summaries = new Map((remote.agent_session_summaries || []).map(item => [item.id, item]));
    const beforeSummaries = new Map((base.agent_session_summaries || []).map(item => [item.id, item]));
    const before = new Map((base.agent_sessions || []).filter(sessionRecord).map(item => [item.id, item]));
    const edited = new Map((local.agent_sessions || []).filter(sessionRecord).map(item => [item.id, item]));
    const received = new Set((remote.agent_sessions || []).filter(sessionRecord).map(item => item.id));
    merged.agent_sessions = (remote.agent_sessions || []).flatMap(item => {
      if (!sessionRecord(item) || removed.has(item.id)) return [];
      const original = before.get(item.id), changed = edited.get(item.id);
      if (running && original && changed) return mergeCanvasAgentMessageQueues([original], [changed], [item]);
      return [original && changed ? mergeSession(original, changed, item, conflicts) : item];
    });
    for (const [id, item] of edited) {
      if (received.has(id) || removed.has(id)) continue;
      const original = before.get(id), summary = summaries.get(id), previous = beforeSummaries.get(id);
      if (!summary && previous) continue;
      if (summary && original && equal(original, item) && summary.content_hash !== previous?.content_hash) continue;
      merged.agent_sessions.push(item);
      // Preserve the version of a dirty body absent from this server response.
      // A changed server version then forces a fresh read before it can save.
      if (summary && previous && original && !equal(original, item)) summaries.set(id, { ...summary, content_hash: previous.content_hash });
    }
    merged.agent_session_summaries = [...summaries.values()];
    merged.deleted_agent_session_ids = [...removed].filter(id => summaries.has(id));
    merged.agent_history_partial = true;
    if (running) merged.active_agent_session_id = remote.active_agent_session_id || remote.agent_run?.sessionId;
  } else if (running) {
    merged.agent_sessions = mergeCanvasAgentMessageQueues(base.agent_sessions, local.agent_sessions, remote.agent_sessions);
    const existing = new Set([...(base.agent_sessions || []), ...(remote.agent_sessions || [])].filter(sessionRecord).map(item => item.id));
    merged.agent_sessions.push(...(local.agent_sessions || []).filter(item => sessionRecord(item) && !existing.has(item.id)));
    const runSessionID = remote.agent_run?.sessionId || base.agent_run?.sessionId;
    if (runSessionID && !merged.agent_sessions.some((session) => sessionRecord(session) && session.id === runSessionID)) {
      const retained = [
        ...(local.agent_sessions || []),
        ...(base.agent_sessions || []),
      ].find((session) => sessionRecord(session) && session.id === runSessionID);
      if (retained) merged.agent_sessions = [...merged.agent_sessions, retained];
    }
    merged.active_agent_session_id = remote.active_agent_session_id || runSessionID;
  } else {
    const before = new Map((base.agent_sessions || []).filter(sessionRecord).map((session) => [session.id, session]));
    const edited = new Map((local.agent_sessions || []).filter(sessionRecord).map((session) => [session.id, session]));
    const received = new Set((remote.agent_sessions || []).filter(sessionRecord).map((session) => session.id));
    merged.agent_sessions = [
      ...(remote.agent_sessions || []).flatMap((session) => {
        if (!sessionRecord(session)) return [session];
        const original = before.get(session.id), changed = edited.get(session.id);
        if (original && !changed && equal(original, session)) return [];
        return [original && changed ? mergeSession(original, changed, session, conflicts) : session];
      }),
      ...(local.agent_sessions || []).filter((session) => sessionRecord(session) && !before.has(session.id) && !received.has(session.id)),
    ];
  }
  if (conflicts.length) throw new CanvasAgentSessionConflictError(conflicts, remote);
  return merged;
}

export function mergeCanvasHistory(base: CanvasDocument, local: CanvasDocument, snapshot: CanvasHistorySnapshot, remote: CanvasDocument, serverChanges = mergeCanvasDocuments(local, base, remote)): CanvasHistorySnapshot {
  // Remove acknowledged browser edits before rebasing each undo snapshot.
  return createCanvasHistorySnapshot(mergeCanvasDocuments(base, { ...base, ...snapshot }, serverChanges));
}
