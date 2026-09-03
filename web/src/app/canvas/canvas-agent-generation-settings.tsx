import {
  buildImageSize,
  getImageSizeSelectionFromSize,
} from "@/lib/image-options";
import {
  ImageSettingsPanel,
  type ImageSettingsValue,
} from "@/components/generation/image-settings-panel";
import {
  VideoSettingsPanel,
  type VideoSettingsValue,
} from "@/components/generation/video-settings-panel";
import type { ImageQuality } from "@/lib/api";
import {
  videoDefaultSeconds,
} from "@/lib/video-model-capabilities";

export function CanvasAgentImageSettings({
  model,
  quality,
  size,
  onChange,
}: {
  model: string;
  quality: string;
  size: string;
  onChange: (patch: { imageQuality?: string; imageSize?: string }) => void;
}) {
  const value: ImageSettingsValue = {
    ...getImageSizeSelectionFromSize(size),
    snapToMultiple16: true,
    quality: quality as "" | ImageQuality,
    count: 1,
  };

  function update(patch: Partial<ImageSettingsValue>) {
    const next = { ...value, ...patch };
    onChange({
      ...(patch.quality !== undefined ? { imageQuality: patch.quality } : {}),
      ...(["mode", "aspectRatio", "resolution", "customRatio", "customWidth", "customHeight"].some((key) => key in patch)
        ? {
            imageSize: buildImageSize(next, {
              preserveAspectRatio: true,
              // Keep the input stable while typing; DimensionInput applies
              // alignment on blur, matching the creation workbench behavior.
              snapToMultiple16: !("customWidth" in patch || "customHeight" in patch),
            }),
          }
        : {}),
    });
  }

  return <ImageSettingsPanel model={model} value={value} onChange={update} showCount={false} showSnapToMultiple16={false} />;
}

export function CanvasAgentVideoSettings({
  model,
  quality,
  size,
  onChange,
}: {
  model: string;
  quality: string;
  size: string;
  onChange: (patch: { videoQuality?: string; videoSize?: string }) => void;
}) {
  const value: VideoSettingsValue = {
    size,
    seconds: String(videoDefaultSeconds(model)),
    resolution: quality,
    generateAudio: false,
    watermark: false,
    taskCount: 1,
  };

  function update(patch: Partial<VideoSettingsValue>) {
    onChange({
      ...(patch.resolution !== undefined ? { videoQuality: patch.resolution } : {}),
      ...(patch.size !== undefined ? { videoSize: patch.size } : {}),
    });
  }

  return <VideoSettingsPanel model={model} value={value} onChange={update} showTaskCount={false} coreOnly />;
}
