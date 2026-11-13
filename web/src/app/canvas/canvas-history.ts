import type { CanvasDocument } from "@/services/api/canvas";

export type CanvasHistorySnapshot = Pick<CanvasDocument, "id" | "title" | "background" | "show_image_info" | "nodes" | "connections">;

export function createCanvasHistorySnapshot(document: CanvasHistorySnapshot): CanvasHistorySnapshot {
  const snapshot = {
    id: document.id,
    title: document.title,
    background: document.background,
    show_image_info: document.show_image_info,
    nodes: document.nodes,
    connections: document.connections,
  };
  return JSON.parse(JSON.stringify(snapshot)) as CanvasHistorySnapshot;
}

export function canvasHistoryKey(document: CanvasHistorySnapshot) {
  return JSON.stringify({
    title: document.title,
    background: document.background,
    show_image_info: document.show_image_info,
    nodes: document.nodes,
    connections: document.connections,
  });
}

export function restoreCanvasHistoryDocument(current: CanvasDocument, snapshot: CanvasHistorySnapshot): CanvasDocument {
  // Canvas undo restores only fields covered by canvasHistoryKey.
  const restored = {
    ...current,
    id: current.id || snapshot.id,
    title: snapshot.title,
    background: snapshot.background,
    show_image_info: snapshot.show_image_info,
    nodes: snapshot.nodes,
    connections: snapshot.connections,
  };
  if (restored.show_image_info === undefined) delete restored.show_image_info;
  return restored;
}

export function appendCanvasHistorySnapshot(
  history: readonly CanvasHistorySnapshot[],
  snapshot: CanvasHistorySnapshot,
  maximum = 50,
) {
  const limit = Math.max(2, maximum);
  if (!history.length) return [snapshot];
  if (canvasHistoryKey(history.at(-1)!) === canvasHistoryKey(snapshot)) return history.slice(-limit);
  return [...history.slice(-(limit - 1)), snapshot];
}

export function commitCanvasGenerationHistory(
  baseHistory: readonly CanvasHistorySnapshot[],
  snapshot: CanvasHistorySnapshot,
  maximum = 50,
) {
  return appendCanvasHistorySnapshot(baseHistory, snapshot, maximum);
}

// History snapshots retain file references only while their browser lease lives.
export function canvasHistoryStorageObjectIDs(...histories: readonly (readonly CanvasHistorySnapshot[])[]) {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\/api\/files\/([a-zA-Z0-9._~%-]+)\/content(?:[?#\s"'<>)]|$)/g)) {
        try { ids.add(decodeURIComponent(match[1])); } catch { /* Ignore malformed encoded IDs. */ }
      }
      for (const match of value.matchAll(/(?:^|[\s"'(:,])server:([a-zA-Z0-9._~-]+)(?:[\s"',})]|$)/g)) ids.add(match[1]);
      try {
        const parsed = new URL(value, "https://canvas.local");
        const match = /^\/api\/files\/([^/]+)\/content$/.exec(parsed.pathname);
        if (match) ids.add(decodeURIComponent(match[1]));
      } catch { /* Invalid URLs cannot reference a stored file. */ }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (!key.startsWith("retained_storage_object")) visit(item);
      }
    }
  };
  histories.forEach((history) => history.forEach(visit));
  return [...ids].sort();
}

export function canvasHistoryStorageObjectURLs(...histories: readonly (readonly CanvasHistorySnapshot[])[]) {
  const urls = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
        for (let candidate = match[0]; candidate; candidate = candidate.slice(0, -1)) {
          urls.add(candidate);
          if (!/[),.;\]}]$/.test(candidate)) break;
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (!key.startsWith("retained_storage_object")) visit(item);
      }
    }
  };
  histories.forEach((history) => history.forEach(visit));
  return [...urls].sort();
}

export function canvasHistoryLeaseExpired(document: CanvasDocument, now = Date.now()) {
  if (!document.retained_storage_objects_until) return false;
  const expiry = Date.parse(document.retained_storage_objects_until);
  return !Number.isFinite(expiry) || expiry <= now;
}
