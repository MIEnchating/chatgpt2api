import type { CanvasDocument } from "@/services/api/canvas";

export function canvasHistoryKey(document: CanvasDocument) {
  return JSON.stringify({
    title: document.title,
    background: document.background,
    show_image_info: document.show_image_info,
    nodes: document.nodes,
    connections: document.connections,
  });
}

export function restoreCanvasHistoryDocument(current: CanvasDocument, snapshot: CanvasDocument): CanvasDocument {
  const restored = { ...snapshot };
  delete restored.retained_storage_object_ids;
  delete restored.retained_storage_object_urls;
  delete restored.retained_storage_objects_until;
  return {
    ...restored,
    id: current.id || snapshot.id,
    revision: current.revision,
    updated_at: current.updated_at,
    viewport: current.viewport,
    ...(current.retained_storage_object_ids ? { retained_storage_object_ids: current.retained_storage_object_ids } : {}),
    ...(current.retained_storage_object_urls ? { retained_storage_object_urls: current.retained_storage_object_urls } : {}),
    ...(current.retained_storage_objects_until ? { retained_storage_objects_until: current.retained_storage_objects_until } : {}),
  };
}

export function appendCanvasHistorySnapshot(
  history: readonly CanvasDocument[],
  snapshot: CanvasDocument,
  maximum = 50,
) {
  const limit = Math.max(2, maximum);
  if (!history.length) return [snapshot];
  if (canvasHistoryKey(history.at(-1)!) === canvasHistoryKey(snapshot)) return history.slice(-limit);
  return [...history.slice(-(limit - 1)), snapshot];
}

export function commitCanvasGenerationHistory(
  baseHistory: readonly CanvasDocument[],
  snapshot: CanvasDocument,
  maximum = 50,
) {
  return appendCanvasHistorySnapshot(baseHistory, snapshot, maximum);
}

// History snapshots retain file references only while their browser lease lives.
export function canvasHistoryStorageObjectIDs(...histories: readonly (readonly CanvasDocument[])[]) {
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

export function canvasHistoryStorageObjectURLs(...histories: readonly (readonly CanvasDocument[])[]) {
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
