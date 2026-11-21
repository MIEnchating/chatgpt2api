import type { ImageSettingsValue } from "@/components/generation/image-settings-panel";
import { isImageQuality } from "@/lib/api";
import { getImageSizeSelectionFromSize } from "@/lib/image-options";
import type { WorkflowGenerationConfig } from "@/services/api/workflows";

export function workflowImageSettings(config: WorkflowGenerationConfig): ImageSettingsValue {
  return {
    ...getImageSizeSelectionFromSize(config.size || "auto"),
    quality: isImageQuality(config.quality) ? config.quality : "",
    count: Math.max(1, Math.min(10, Math.round(Number(config.count) || 1))),
    snapToMultiple16: true,
  };
}

export function generationQualityLabel(value: string) {
  if (value === "low") return "低";
  if (value === "medium") return "中";
  if (value === "high") return "高";
  return "自动";
}
