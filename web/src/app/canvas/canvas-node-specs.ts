import type { CanvasNode } from "@/services/api/canvas";

export const CANVAS_NODE_DEFAULT_SIZE = {
  image: { width: 340, height: 240 },
  panorama: { width: 340, height: 170 },
  text: { width: 340, height: 240 },
  config: { width: 440, height: 240 },
  video: { width: 420, height: 236 },
  audio: { width: 340, height: 160 },
  director: { width: 360, height: 320 },
  group: { width: 760, height: 480 },
} satisfies Record<CanvasNode["type"], { width: number; height: number }>;
