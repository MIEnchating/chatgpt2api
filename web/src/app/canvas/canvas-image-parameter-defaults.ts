import { getImageSizeSelectionFromSize } from "@/app/image/image-options";
import { isImageOutputFormat, isImageQuality, type ImageGenerationPreferences } from "@/lib/api";
import type { CanvasNode } from "@/services/api/canvas";

export function defaultCanvasImageParameters(
  preferences?: ImageGenerationPreferences,
): Partial<CanvasNode> {
  const workbench = preferences?.workbench;
  const size = workbench?.image_size || "";
  const quality = workbench?.image_quality;
  const outputFormat = workbench?.image_output_format;
  const compressionValue = workbench?.image_output_compression;
  const compression = compressionValue === null || compressionValue === "" ? Number.NaN : Number(compressionValue);
  const canvasImageCount = preferences?.canvas_default_image_count ?? 1;
  return {
    generation_size: size,
    generation_resolution: getImageSizeSelectionFromSize(size).resolution,
    generation_quality: isImageQuality(quality) ? quality : undefined,
    generation_count: Number.isFinite(canvasImageCount) ? Math.max(1, Math.min(15, Math.floor(canvasImageCount))) : 1,
    generation_output_format: isImageOutputFormat(outputFormat) ? outputFormat : "png",
    generation_output_compression: Number.isFinite(compression) && compression >= 0 && compression <= 100 ? compression : undefined,
    generation_stream: preferences?.stream === true,
    generation_partial_images: Math.max(0, Math.min(3, preferences?.partial_images ?? 1)),
    generation_response_format_b64_json: preferences?.response_format_b64_json === true,
    generation_codex_cli_compatibility: preferences?.codex_cli_compatibility === true,
    generation_snap_to_multiple_16: workbench?.image_snap_to_multiple_16 !== false,
  };
}
