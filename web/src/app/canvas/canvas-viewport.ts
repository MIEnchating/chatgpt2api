export type CanvasViewport = { zoom: number; x: number; y: number };

export const CANVAS_MIN_ZOOM = 0.05;
export const CANVAS_MAX_ZOOM = 5;

export function clampCanvasZoom(value: number) {
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, value));
}

export function resetCanvasViewport(canvasSize: { width: number; height: number }): CanvasViewport {
  return {
    zoom: 1,
    x: canvasSize.width / 2,
    y: canvasSize.height / 2,
  };
}

export function setCanvasViewportZoom(
  viewport: CanvasViewport,
  canvasSize: { width: number; height: number },
  value: number,
): CanvasViewport {
  const zoom = clampCanvasZoom(value);
  const centerX = canvasSize.width / 2;
  const centerY = canvasSize.height / 2;
  return {
    zoom,
    x: centerX - ((centerX - viewport.x) / viewport.zoom) * zoom,
    y: centerY - ((centerY - viewport.y) / viewport.zoom) * zoom,
  };
}

export function zoomCanvasViewport(viewport: CanvasViewport, localPoint: { x: number; y: number }, deltaY: number): CanvasViewport {
  const factor = Math.pow(1.1, -deltaY / 100);
  const zoom = clampCanvasZoom(viewport.zoom * factor);
  const worldX = (localPoint.x - viewport.x) / viewport.zoom;
  const worldY = (localPoint.y - viewport.y) / viewport.zoom;
  return {
    zoom,
    x: localPoint.x - worldX * zoom,
    y: localPoint.y - worldY * zoom,
  };
}

export function canvasGridMetrics(viewport: CanvasViewport) {
  const size = 48 * viewport.zoom;
  return {
    size,
    x: viewport.x % size,
    y: viewport.y % size,
    dotSize: viewport.zoom < 0.12 ? 0.8 : 1.15,
  };
}

export function canvasNodesInViewport<T extends { x: number; y: number; width: number; height: number }>(
  nodes: readonly T[],
  viewport: CanvasViewport,
  canvasSize: { width: number; height: number },
  padding = 280,
) {
  const zoom = Math.max(CANVAS_MIN_ZOOM, viewport.zoom);
  const viewLeft = -viewport.x / zoom - padding;
  const viewTop = -viewport.y / zoom - padding;
  const viewRight = viewLeft + canvasSize.width / zoom + padding * 2;
  const viewBottom = viewTop + canvasSize.height / zoom + padding * 2;
  return nodes.filter((node) => (
    node.x + node.width > viewLeft
    && node.x < viewRight
    && node.y + node.height > viewTop
    && node.y < viewBottom
  ));
}
