import { formatImageSizeDisplay } from "@/app/image/image-options";
import { videoSizeLabel } from "@/lib/video-model-capabilities";

const IMAGE_QUALITY_LABELS: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export function canvasAgentImageSettingsSummary(quality: string, size: string) {
  const qualityLabel = IMAGE_QUALITY_LABELS[quality] || "自动";
  const sizeLabel = size ? formatImageSizeDisplay(size) : "自动";
  return `${qualityLabel} · ${sizeLabel}`;
}

export function canvasAgentVideoSettingsSummary(quality: string, size: string) {
  return `${quality || "自动"} · ${videoSizeLabel(size) || "自动"}`;
}
