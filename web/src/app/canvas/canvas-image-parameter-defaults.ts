import { getImageSizeSelectionFromSize } from "@/app/image/image-options";
import { isImageOutputFormat, isImageQuality, type CanvasNode } from "@/lib/api";

const STORAGE_KEYS = {
  size: "chatgpt2api:image_last_size",
  quality: "chatgpt2api:image_last_quality",
  outputFormat: "chatgpt2api:image_last_output_format",
  outputCompression: "chatgpt2api:image_last_output_compression",
  stream: "chatgpt2api:image_last_stream_v2",
  partialImages: "chatgpt2api:image_last_partial_images",
} as const;

export function defaultCanvasImageParameters(): Partial<CanvasNode> {
  if (typeof window === "undefined") return { generation_count: 1, generation_output_format: "png", generation_stream: true };
  const size = window.localStorage.getItem(STORAGE_KEYS.size) || "";
  const quality = window.localStorage.getItem(STORAGE_KEYS.quality);
  const outputFormat = window.localStorage.getItem(STORAGE_KEYS.outputFormat);
  const compressionValue = window.localStorage.getItem(STORAGE_KEYS.outputCompression);
  const compression = compressionValue === null || compressionValue === "" ? Number.NaN : Number(compressionValue);
  const streamValue = window.localStorage.getItem(STORAGE_KEYS.stream);
  const partialImages = Number(window.localStorage.getItem(STORAGE_KEYS.partialImages));
  return {
    generation_size: size,
    generation_resolution: getImageSizeSelectionFromSize(size).resolution,
    generation_quality: isImageQuality(quality) ? quality : undefined,
    generation_count: 1,
    generation_output_format: isImageOutputFormat(outputFormat) ? outputFormat : "png",
    generation_output_compression: Number.isFinite(compression) && compression >= 0 && compression <= 100 ? compression : undefined,
    generation_stream: streamValue === null ? true : streamValue === "true",
    generation_partial_images: Number.isFinite(partialImages) ? Math.max(0, Math.min(3, partialImages)) : 0,
  };
}
