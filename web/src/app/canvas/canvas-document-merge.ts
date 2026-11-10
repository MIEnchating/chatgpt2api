import { mergeCanvasAgentMessageQueues } from "./agent/canvas-agent-message-queue";
import type { CanvasDocument } from "@/services/api/canvas";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function mergeFields<T extends object>(base: T, local: T, remote: T, excluded: readonly string[] = []): T {
  const result = { ...remote } as Record<string, unknown>;
  const before = base as Record<string, unknown>, edited = local as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(edited)])) {
    if (excluded.includes(key)) continue;
    if (equal(before[key], edited[key])) continue;
    if (key in edited) result[key] = edited[key];
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
  const running = remote.agent_run?.status === "running" || base.agent_run?.status === "running";
  const merged = mergeFields(base, local, remote, running ? ["nodes", "connections", "agent_sessions"] : ["nodes", "connections"]);
  merged.nodes = mergeEntities(base.nodes, local.nodes, remote.nodes);
  const ids = new Set(merged.nodes.map((node) => node.id));
  merged.connections = mergeEntities(base.connections, local.connections, remote.connections).filter((edge) => ids.has(edge.from_node_id) && ids.has(edge.to_node_id));
  merged.revision = remote.revision;
  merged.updated_at = remote.updated_at;
  merged.agent_run = remote.agent_run;
  if (running) {
    merged.agent_sessions = mergeCanvasAgentMessageQueues(base.agent_sessions, local.agent_sessions, remote.agent_sessions);
    merged.active_agent_session_id = remote.active_agent_session_id;
  }
  return merged;
}

export function mergeCanvasHistory(base: CanvasDocument, local: CanvasDocument, snapshot: CanvasDocument, remote: CanvasDocument, serverChanges = mergeCanvasDocuments(local, base, remote)): CanvasDocument {
  // Remove acknowledged browser edits before rebasing each undo snapshot.
  return mergeCanvasDocuments(base, snapshot, serverChanges);
}
