import type { CanvasConnection, CanvasNode } from "@/services/api/canvas";

const DIRECTOR_VIDEO_MAX_WIDTH = 420;
const DIRECTOR_VIDEO_MAX_HEIGHT = 420;

export function getNextDirectorOutputY(
  director: CanvasNode,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
) {
  return connections.reduce((y, connection) => {
    if (connection.from_node_id !== director.id) return y;
    const output = nodes.find((node) => node.id === connection.to_node_id);
    return output?.type === "image" || output?.type === "video"
      ? Math.max(y, output.y + output.height + 36)
      : y;
  }, director.y);
}

export function fitDirectorVideoNodeSize(width: number, height: number) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(
    1,
    DIRECTOR_VIDEO_MAX_WIDTH / safeWidth,
    DIRECTOR_VIDEO_MAX_HEIGHT / safeHeight,
  );
  return { width: safeWidth * scale, height: safeHeight * scale };
}
