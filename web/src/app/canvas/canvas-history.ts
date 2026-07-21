import type { CanvasDocument } from "@/lib/api";

export function canvasHistoryKey(document: CanvasDocument) {
  return JSON.stringify({
    title: document.title,
    background: document.background,
    nodes: document.nodes,
    connections: document.connections,
  });
}

export function restoreCanvasHistoryDocument(current: CanvasDocument, snapshot: CanvasDocument): CanvasDocument {
  return {
    ...snapshot,
    id: current.id || snapshot.id,
    revision: current.revision,
    updated_at: current.updated_at,
    viewport: current.viewport,
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
