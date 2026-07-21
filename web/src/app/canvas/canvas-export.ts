export type CanvasExportNode = { x: number; y: number; width: number; height: number };

export type CanvasExportBounds = {
  minX: number;
  minY: number;
  width: number;
  height: number;
};

export function canvasExportBounds(nodes: readonly CanvasExportNode[], padding = 128): CanvasExportBounds {
  if (!nodes.length) return { minX: 0, minY: 0, width: padding * 2, height: padding * 2 };
  const minX = Math.min(...nodes.map((node) => node.x)) - padding;
  const minY = Math.min(...nodes.map((node) => node.y)) - padding;
  const maxX = Math.max(...nodes.map((node) => node.x + node.width)) + padding;
  const maxY = Math.max(...nodes.map((node) => node.y + node.height)) + padding;
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export function canvasExportTransform(bounds: CanvasExportBounds) {
  return `translate(${-bounds.minX}px, ${-bounds.minY}px) scale(1)`;
}
