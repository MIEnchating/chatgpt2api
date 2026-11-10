import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import {
  IMAGE_ASPECT_RATIO_PRESET_OPTIONS,
  type ImageAspectRatio,
  type ImageResolution,
  type ImageSizeMode,
} from "@/lib/image-options";
import { AspectRatioOptionButton } from "@/components/generation/aspect-ratio-option";
import { GenerationSizeBadge } from "@/components/generation/generation-size-badge";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

const IMAGE_PRESET_GROUPS = [
  { resolution: "auto", label: "常用比例" },
  { resolution: "2k", label: "2K 预设" },
  { resolution: "4k", label: "4K 预设" },
] as const;

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
    <section className={cn("@container min-w-0 space-y-2", className)}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <ImageParameterLabel help="常用比例由模型决定像素尺寸；2K、4K 预设指定尺寸档位，也可以在下方手动输入宽高。">宽高比</ImageParameterLabel>
        <div className="flex min-w-0 items-center gap-2">
          {previewLabel && value.mode !== "auto" ? <GenerationSizeBadge highResolution={highResolution}>{previewLabel}</GenerationSizeBadge> : null}
          <Toggle size="sm" variant="outline" pressed={value.mode === "auto"} disabled={disabled} aria-label={`${ariaLabelPrefix}自动尺寸`} onClick={() => onChange({ mode: "auto", aspectRatio: "", resolution: "auto" })}>自动</Toggle>
        </div>
      </div>
      {IMAGE_PRESET_GROUPS.map((group) => (
        <div key={group.resolution} className="grid min-w-0 gap-1.5" role="group" aria-label={`${ariaLabelPrefix}${group.label}`}>
          {group.resolution !== "auto" ? <p className="text-xs text-muted-foreground">{group.label}</p> : null}
          <div className="grid grid-cols-4 gap-1.5">
            {IMAGE_ASPECT_RATIO_PRESET_OPTIONS.filter((option) => option.aspectRatio && option.resolution === group.resolution).map((option) => {
              const active = value.mode === "ratio" && value.aspectRatio === option.aspectRatio && value.resolution === option.resolution;
              return (
                <AspectRatioOptionButton
                  key={option.value}
                  active={active}
                  disabled={disabled}
                  label={option.aspectRatio}
                  aria-label={`${ariaLabelPrefix} ${option.label}`}
                  ratio={option.aspectRatio}
                  layout="inline"
                  onClick={() => onChange({
                    mode: "ratio",
                    aspectRatio: option.aspectRatio,
                    resolution: option.resolution,
                  })}
                />
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
