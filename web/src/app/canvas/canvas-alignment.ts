import type { CanvasNode } from "@/services/api/canvas";

export type CanvasAlignmentGuides = { vertical?: number; horizontal?: number };
export type CanvasAlignmentContext = {
  x: number[]; y: number[];
  targets: { x: number[]; y: number[] }[];
};

export function createCanvasAlignmentContext(nodes: readonly CanvasNode[], movingIDs: ReadonlySet<string>): CanvasAlignmentContext | null {
  const moving = nodes.filter(node => movingIDs.has(node.id));
  if (!moving.length) return null;
  const left = Math.min(...moving.map(node => node.x));
  const right = Math.max(...moving.map(node => node.x + node.width));
  const top = Math.min(...moving.map(node => node.y));
  const bottom = Math.max(...moving.map(node => node.y + node.height));
  return {
    x: [left, (left + right) / 2, right], y: [top, (top + bottom) / 2, bottom],
    targets: nodes.filter(node => !movingIDs.has(node.id) && node.type !== "group").map(node => ({
      x: [node.x, node.x + node.width / 2, node.x + node.width],
      y: [node.y, node.y + node.height / 2, node.y + node.height],
    })),
  };
}

export function calculateCanvasAlignment(context: CanvasAlignmentContext | null, offset: { x: number; y: number }, threshold: number) {
  const adjusted = { ...offset };
  const guides: CanvasAlignmentGuides = {};
  if (!context) return { offset: adjusted, guides };
  for (const axis of ["x", "y"] as const) {
    let delta: number | undefined;
    let guide: number | undefined;
    for (const target of context.targets) {
      context[axis].forEach((value, index) => {
        const difference = target[axis][index] - value - offset[axis];
        if (Math.abs(difference) <= threshold && (delta === undefined || Math.abs(difference) < Math.abs(delta))) {
          delta = difference;
          guide = target[axis][index];
        }
      });
    }
    adjusted[axis] += delta ?? 0;
    guides[axis === "x" ? "vertical" : "horizontal"] = guide;
  }
  return { offset: adjusted, guides };
}
