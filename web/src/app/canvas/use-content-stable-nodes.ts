import { useRef } from "react";

// Position and size change on every frame while nodes are dragged or resized.
const GEOMETRY_KEYS = new Set(["x", "y", "width", "height"]);

function sameNodeContent(left: object, right: object) {
  if (left === right) return true;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  return leftKeys.every((key) => GEOMETRY_KEYS.has(key) || (key in rightRecord && Object.is(leftRecord[key], rightRecord[key])));
}

// Returns the previous array while only node geometry changed, so consumers that read node content
// (resource references, Markdown renderers) are not recomputed for every drag frame.
export function useContentStableNodes<T extends { id: string }>(nodes: T[]): T[] {
  const previousRef = useRef(nodes);
  const previous = previousRef.current;
  const stable = previous === nodes || (previous.length === nodes.length && nodes.every((node, index) => sameNodeContent(previous[index], node))) ? previous : nodes;
  previousRef.current = stable;
  return stable;
}
