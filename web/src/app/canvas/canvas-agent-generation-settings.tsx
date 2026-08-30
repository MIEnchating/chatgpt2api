import {
  buildImageSize,
  getImageSizeSelectionFromSize,
} from "@/app/image/image-options";
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
  videoAllowsCustomDimensions,
  videoAllowsCustomResolution,
  videoDefaultSeconds,
  videoWorkbenchResolutionForModelSize,
  videoWorkbenchSizeForModelResolution,
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
        ? { imageSize: buildImageSize(next, { preserveAspectRatio: true, snapToMultiple16: true }) }
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
    let nextSize = patch.size;
    let nextQuality = patch.resolution;
    if (patch.size !== undefined && patch.resolution === undefined && videoAllowsCustomDimensions(model)) {
      nextQuality = videoWorkbenchResolutionForModelSize(model, patch.size, quality);
    }
    if (patch.resolution !== undefined && patch.size === undefined && videoAllowsCustomResolution(model)) {
      nextSize = videoWorkbenchSizeForModelResolution(model, patch.resolution, size);
    }
    onChange({
      ...(nextQuality !== undefined ? { videoQuality: nextQuality } : {}),
      ...(nextSize !== undefined ? { videoSize: nextSize } : {}),
    });
  }

  return <VideoSettingsPanel model={model} value={value} onChange={update} showTaskCount={false} coreOnly />;
}
