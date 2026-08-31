import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import {
  IMAGE_ASPECT_RATIO_PRESET_OPTIONS,
  type ImageAspectRatio,
  type ImageResolution,
  type ImageSizeMode,
} from "@/lib/image-options";
import { AspectRatioOptionButton } from "@/components/generation/aspect-ratio-option";
import { GenerationSizeBadge } from "@/components/generation/generation-size-badge";
import { cn } from "@/lib/utils";

type ImageSizePresetValue = {
  mode: ImageSizeMode;
  aspectRatio: ImageAspectRatio;
  resolution: ImageResolution;
};

export function ImageSizePresetControls({
  value,
  previewLabel,
  highResolution = false,
  disabled = false,
  ariaLabelPrefix = "图片",
  className,
  onChange,
}: {
  value: ImageSizePresetValue;
  previewLabel?: string;
  highResolution?: boolean;
  disabled?: boolean;
  ariaLabelPrefix?: string;
  className?: string;
  onChange: (patch: Partial<ImageSizePresetValue>) => void;
}) {
  return (
    <section className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <ImageParameterLabel help="选择图片宽高比和尺寸档位，图形会直观展示宽高关系。">宽高比</ImageParameterLabel>
        {previewLabel ? <GenerationSizeBadge highResolution={highResolution}>{previewLabel}</GenerationSizeBadge> : null}
      </div>
      <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={`${ariaLabelPrefix}宽高比`}>
          {IMAGE_ASPECT_RATIO_PRESET_OPTIONS.map((option) => {
            const automatic = option.aspectRatio === "";
            const active = automatic
              ? value.mode === "auto"
              : value.mode === "ratio" && value.aspectRatio === option.aspectRatio && value.resolution === option.resolution;
            return (
              <AspectRatioOptionButton
                key={option.value}
                active={active}
                disabled={disabled}
                label={automatic ? "自动" : option.label}
                ratio={automatic ? undefined : option.aspectRatio}
                layout="visual"
                onClick={() => onChange({
                  mode: automatic ? "auto" : "ratio",
                  aspectRatio: option.aspectRatio,
                  resolution: option.resolution,
                })}
              />
            );
          })}
      </div>
    </section>
  );
}
