import type { CanvasNode } from "@/services/api/canvas";

export type CanvasAlignmentGuides = { vertical?: number; horizontal?: number };
export type CanvasAlignmentContext = {
  x: number[]; y: number[];
  targets: { x: number[]; y: number[] };
};

function nearest(values: readonly number[], target: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  const before = values[low - 1];
  const after = values[low];
  if (before === undefined) return after;
  if (after === undefined) return before;
  return target - before <= after - target ? before : after;
}

export function createCanvasAlignmentContext(nodes: readonly CanvasNode[], movingIDs: ReadonlySet<string>): CanvasAlignmentContext | null {
  const moving = nodes.filter(node => movingIDs.has(node.id));
  if (!moving.length) return null;
  const left = Math.min(...moving.map(node => node.x));
  const right = Math.max(...moving.map(node => node.x + node.width));
  const top = Math.min(...moving.map(node => node.y));
  const bottom = Math.max(...moving.map(node => node.y + node.height));
  const targets = nodes.filter(node => !movingIDs.has(node.id) && node.type !== "group").reduce((values, node) => {
    values.x.push(node.x, node.x + node.width / 2, node.x + node.width);
    values.y.push(node.y, node.y + node.height / 2, node.y + node.height);
    return values;
  }, { x: [] as number[], y: [] as number[] });
  targets.x.sort((a, b) => a - b);
  targets.y.sort((a, b) => a - b);
  return {
    x: [left, (left + right) / 2, right], y: [top, (top + bottom) / 2, bottom],
    targets,
  };
}

export function calculateCanvasAlignment(context: CanvasAlignmentContext | null, offset: { x: number; y: number }, threshold: number) {
  const adjusted = { ...offset };
  const guides: CanvasAlignmentGuides = {};
  if (!context) return { offset: adjusted, guides };
  for (const axis of ["x", "y"] as const) {
    let delta: number | undefined;
    let guide: number | undefined;
    const targets = context.targets[axis];
    for (const value of context[axis]) {
      const candidate = nearest(targets, value + offset[axis]);
      if (candidate === undefined) continue;
      const difference = candidate - value - offset[axis];
      if (Math.abs(difference) <= threshold && (delta === undefined || Math.abs(difference) < Math.abs(delta))) {
        delta = difference;
        guide = candidate;
      }
    }
    adjusted[axis] += delta ?? 0;
    guides[axis === "x" ? "vertical" : "horizontal"] = guide;
  }
  return { offset: adjusted, guides };
}
