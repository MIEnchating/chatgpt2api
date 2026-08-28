import { nanoid } from "nanoid";

import { CANVAS_NODE_DEFAULT_SIZE } from "@/app/canvas/canvas-node-specs";
import type {
  CanvasAgentConfig,
  CanvasInsertAssetPayload,
  CanvasPendingAgentAsset,
} from "@/app/canvas/agent/canvas-agent-types";
import type { MyAsset } from "@/lib/my-assets";
import { DEFAULT_VIDEO_MODEL, videoDefaultResolution, videoDefaultSeconds, videoDefaultSize, videoSizeOptions } from "@/lib/video-model-capabilities";
import type { CanvasNode } from "@/services/api/canvas";

const STARTER_NODE_GAP = 360;

export function defaultCanvasAgentStarterConfig() {
  const videoModel = defaultCanvasAgentStarterVideoModel();
  const seconds = videoDefaultSeconds(videoModel);
  return {
    imageQuality: "",
    imageSize: "1:1",
    videoQuality: videoDefaultResolution(videoModel, seconds),
    videoSize: preferredCanvasAgentVideoSize(
      videoSizeOptions(videoModel),
      videoDefaultSize(videoModel),
    ),
  };
}

export function defaultCanvasAgentStarterVideoModel() {
  return DEFAULT_VIDEO_MODEL;
}

export function preferredCanvasAgentVideoSize(options: readonly string[], fallback: string) {
  const landscape = options.filter((value) => {
    const dimensions = value.match(/^(\d+)(?::|x)(\d+)$/i);
    return dimensions ? Number(dimensions[1]) > Number(dimensions[2]) : false;
  });
  return landscape.find((value) => value === "16:9")
    || (landscape.includes(fallback) ? fallback : landscape[0])
    || (options.includes(fallback) ? fallback : options[0])
    || fallback
    || "16:9";
}

export function normalizeCanvasAgentConfig(
  value: Partial<CanvasAgentConfig> | null | undefined,
  defaults: CanvasAgentConfig,
  options: Record<keyof CanvasAgentConfig, readonly string[]>,
): CanvasAgentConfig {
  const select = (key: keyof CanvasAgentConfig) => {
    const available = options[key];
    const current = typeof value?.[key] === "string" ? value[key].trim() : "";
    if (available.includes(current)) return current;
    const fallback = defaults[key].trim();
    if (available.includes(fallback)) return fallback;
    return available[0] || "";
  };
  return {
    imageQuality: select("imageQuality"),
    imageSize: select("imageSize"),
    videoQuality: select("videoQuality"),
    videoSize: select("videoSize"),
  };
}

export function canvasAgentStarterLabel(
  kind: CanvasInsertAssetPayload["kind"],
  assets: readonly CanvasPendingAgentAsset[],
) {
  const count = assets.filter((asset) => asset.payload.kind === kind).length + 1;
  return `${{ text: "文本", image: "图片", video: "视频", audio: "音频" }[kind]}${count}`;
}

export function createCanvasPendingAgentAsset(
  payload: CanvasInsertAssetPayload,
  label: string,
): CanvasPendingAgentAsset {
  const nodeId = nanoid();
  return {
    nodeId,
    payload,
    reference: {
      id: nodeId,
      type: payload.kind,
      title: payload.title,
      label,
      ...(payload.kind === "text" ? { text: payload.content } : {}),
      ...(payload.kind === "image" ? { dataUrl: payload.dataUrl } : {}),
      ...(payload.kind === "video" || payload.kind === "audio" ? { url: payload.url } : {}),
      ...(payload.kind !== "text" ? { storageKey: payload.storageKey, mimeType: payload.mimeType } : {}),
    },
  };
}

export function canvasInsertPayloadFromMyAsset(asset: MyAsset): CanvasInsertAssetPayload {
  if (asset.kind === "text") {
    return { kind: "text", content: asset.content || "", title: asset.title, assetId: asset.id, source: "asset" };
  }
  const common = {
    title: asset.title,
    storageKey: asset.storageKey,
    assetId: asset.id,
    bytes: asset.bytes,
    mimeType: asset.mimeType,
    source: "asset" as const,
  };
  if (asset.kind === "image") {
    return { kind: "image", dataUrl: asset.url || asset.coverUrl || "", width: asset.width, height: asset.height, ...common };
  }
  if (asset.kind === "video") {
    return { kind: "video", url: asset.url || "", width: asset.width, height: asset.height, durationMs: asset.durationMs, ...common };
  }
  return { kind: "audio", url: asset.url || "", durationMs: asset.durationMs, ...common };
}

export function canvasPendingAgentAssetNode(
  asset: CanvasPendingAgentAsset,
  index: number,
  total: number,
  center: { x: number; y: number },
  createdAt = new Date().toISOString(),
): CanvasNode {
  const payload = asset.payload;
  const fallback = CANVAS_NODE_DEFAULT_SIZE[payload.kind];
  const sourceWidth = payload.kind === "image" || payload.kind === "video" ? payload.width : undefined;
  const sourceHeight = payload.kind === "image" || payload.kind === "video" ? payload.height : undefined;
  const fitted = fitStarterMediaSize(payload.kind, sourceWidth, sourceHeight, fallback);
  const nodeCenter = {
    x: center.x + (index - (total - 1) / 2) * STARTER_NODE_GAP,
    y: center.y,
  };
  const url = payload.kind === "image"
    ? payload.dataUrl
    : payload.kind === "video" || payload.kind === "audio"
      ? payload.url
      : undefined;
  const title = payload.kind === "text"
    ? payload.content.slice(0, 32) || "Assistant Text"
    : payload.kind === "image"
      ? payload.title.slice(0, 32) || "Generated Image"
      : payload.title;

  return {
    id: asset.nodeId,
    type: payload.kind,
    x: nodeCenter.x - fitted.width / 2,
    y: nodeCenter.y - fitted.height / 2,
    width: fitted.width,
    height: fitted.height,
    ...(payload.kind === "text" ? { font_size: 14 } : {}),
    scale_x: 1,
    scale_y: 1,
    title,
    prompt: payload.kind === "text" ? payload.content : payload.kind === "image" ? payload.title : "",
    url,
    ...(payload.kind !== "text" ? {
      storage_key: payload.storageKey,
      bytes: payload.bytes,
      mime_type: payload.mimeType,
      generation_status: "success" as const,
    } : {}),
    ...(payload.kind === "image" || payload.kind === "video" ? {
      natural_width: payload.width,
      natural_height: payload.height,
    } : {}),
    ...(payload.kind === "audio" || payload.kind === "video" ? { duration_ms: payload.durationMs } : {}),
    created_at: createdAt,
  };
}

function fitStarterMediaSize(
  kind: CanvasInsertAssetPayload["kind"],
  width: number | undefined,
  height: number | undefined,
  fallback: { width: number; height: number },
) {
  if (kind !== "image" && kind !== "video") return fallback;
  const sourceWidth = Math.max(1, Number(width) || fallback.width);
  const sourceHeight = Math.max(1, Number(height) || fallback.height);
  const maximum = kind === "video" ? 420 : 640;
  const scale = Math.min(1, maximum / sourceWidth, maximum / sourceHeight);
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}
