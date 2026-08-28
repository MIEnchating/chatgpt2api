import { getImageSizeSelectionFromSize } from "@/app/image/image-options";
import { isImageOutputFormat, isImageQuality } from "@/lib/api";
import type { CanvasNode } from "@/services/api/canvas";

const STORAGE_KEYS = {
  size: "chatgpt2api:image_last_size",
  quality: "chatgpt2api:image_last_quality",
  outputFormat: "chatgpt2api:image_last_output_format",
  outputCompression: "chatgpt2api:image_last_output_compression",
  stream: "chatgpt2api:image_last_stream_v3",
  partialImages: "chatgpt2api:image_last_partial_images",
  responseFormatB64JSON: "chatgpt2api:image_generation_response_format_b64_json",
  codexCLICompatibility: "chatgpt2api:image_generation_codex_cli_compatibility",
  canvasImageCount: "chatgpt2api:canvas_default_image_count",
} as const;

export function defaultCanvasImageParameters(): Partial<CanvasNode> {
  if (typeof window === "undefined") return { generation_count: 1, generation_output_format: "png", generation_stream: false, generation_partial_images: 1, generation_response_format_b64_json: false, generation_codex_cli_compatibility: false, generation_snap_to_multiple_16: true };
  const size = window.localStorage.getItem(STORAGE_KEYS.size) || "";
  const quality = window.localStorage.getItem(STORAGE_KEYS.quality);
  const outputFormat = window.localStorage.getItem(STORAGE_KEYS.outputFormat);
  const compressionValue = window.localStorage.getItem(STORAGE_KEYS.outputCompression);
  const compression = compressionValue === null || compressionValue === "" ? Number.NaN : Number(compressionValue);
  const streamValue = window.localStorage.getItem(STORAGE_KEYS.stream);
  const partialImages = Number(window.localStorage.getItem(STORAGE_KEYS.partialImages));
  const canvasImageCount = Number(window.localStorage.getItem(STORAGE_KEYS.canvasImageCount));
  return {
    generation_size: size,
    generation_resolution: getImageSizeSelectionFromSize(size).resolution,
    generation_quality: isImageQuality(quality) ? quality : undefined,
    generation_count: Number.isFinite(canvasImageCount) ? Math.max(1, Math.min(15, Math.floor(canvasImageCount))) : 1,
    generation_output_format: isImageOutputFormat(outputFormat) ? outputFormat : "png",
    generation_output_compression: Number.isFinite(compression) && compression >= 0 && compression <= 100 ? compression : undefined,
    generation_stream: streamValue === "true",
    generation_partial_images: Number.isFinite(partialImages) ? Math.max(0, Math.min(3, partialImages)) : 1,
    generation_response_format_b64_json: window.localStorage.getItem(STORAGE_KEYS.responseFormatB64JSON) === "true",
    generation_codex_cli_compatibility: window.localStorage.getItem(STORAGE_KEYS.codexCLICompatibility) === "true",
  };
}
