import { X } from "lucide-react";

import {
  ImageAspectRatioOptionButton,
  ImageParameterLabel,
} from "@/app/image/components/image-parameter-ui";
import { imageParameterChoiceClass } from "@/app/image/components/image-parameter-styles";
import {
  IMAGE_ASPECT_RATIO_PRESET_OPTIONS,
  IMAGE_WORKBENCH_QUALITY_OPTIONS,
  buildImageSize,
  formatImageSizeDisplay,
  isHighResolutionImageSize,
  parseImageSizeDimensions,
  type ImageSizeSelection,
} from "@/app/image/image-options";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { imageOutputCountLimit, type ImageQuality } from "@/lib/api";
import { cn } from "@/lib/utils";

export type ImageSettingsValue = ImageSizeSelection & {
  snapToMultiple16: boolean;
  quality: "" | ImageQuality;
  count: number;
};

export function ImageSettingsPanel({
  model,
  value,
  onChange,
  showSize = true,
  showCount = true,
  showQuality = true,
  showSnapToMultiple16 = true,
}: {
  model: string;
  value: ImageSettingsValue;
  onChange: (patch: Partial<ImageSettingsValue>) => void;
  showSize?: boolean;
  showCount?: boolean;
  showQuality?: boolean;
  showSnapToMultiple16?: boolean;
}) {
  const computedSize = buildImageSize(value, { snapToMultiple16: value.snapToMultiple16 });
  const dimensions = parseImageSizeDimensions(computedSize) || { width: "1024", height: "1024" };
  const displayedWidth = value.mode === "custom" ? value.customWidth : dimensions.width;
  const displayedHeight = value.mode === "custom" ? value.customHeight : dimensions.height;
  const sizeLabel = computedSize ? formatImageSizeDisplay(computedSize) : value.mode === "auto" ? "自动" : "尺寸无效";
  const highResolution = Boolean(computedSize && isHighResolutionImageSize(computedSize, value));
  const countLimit = Math.max(1, Math.min(10, imageOutputCountLimit(model)));
  const count = Math.max(1, Math.min(countLimit, Math.floor(Number(value.count) || 1)));

  function beginCustomSize() {
    if (value.mode === "custom") return;
    onChange({
      mode: "custom",
      customWidth: dimensions.width || value.customWidth || "1024",
      customHeight: dimensions.height || value.customHeight || "1024",
    });
  }

  function alignDimension(key: "customWidth" | "customHeight", raw: string) {
    if (!value.snapToMultiple16) return;
    const dimension = Number(raw);
    if (!Number.isFinite(dimension) || dimension <= 0) return;
    onChange({ [key]: String(Math.max(16, Math.ceil(dimension / 16) * 16)) });
  }

  return (
    <div className="flex flex-col gap-3.5">
      {showQuality ? <section className="order-1 space-y-1.5">
        <ImageParameterLabel help="质量档位同时参与目标尺寸换算；厂商不支持的 quality 字段不会透传。">质量</ImageParameterLabel>
        <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70" role="group" aria-label="图片质量">
          {IMAGE_WORKBENCH_QUALITY_OPTIONS.map((option) => (
            <button
              key={option.value || "auto"}
              type="button"
              aria-pressed={value.quality === option.value}
              className={imageParameterChoiceClass(value.quality === option.value, "h-7")}
              onClick={() => onChange({ quality: option.value as "" | ImageQuality })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section> : null}

      {showSize ? <section className="order-2 space-y-1.5 border-t border-[#ececef] pt-2.5 dark:border-border">
        <div className="flex items-center justify-between gap-3">
          <ImageParameterLabel help="手动输入图片宽高；输入完成后可自动向上补成 16 的倍数。">尺寸</ImageParameterLabel>
          {showSnapToMultiple16 ? <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>16倍数对齐</span>
            <Switch checked={value.snapToMultiple16} aria-label="16倍数对齐" onCheckedChange={(checked) => onChange({ snapToMultiple16: checked })} />
          </label> : null}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
          <DimensionInput
            prefix="W"
            value={displayedWidth}
            onFocus={beginCustomSize}
            onChange={(customWidth) => onChange({ mode: "custom", customWidth })}
            onBlur={(raw) => alignDimension("customWidth", raw)}
          />
          <X className="size-3.5 text-[#9a9ca2]" aria-hidden="true" />
          <DimensionInput
            prefix="H"
            value={displayedHeight}
            onFocus={beginCustomSize}
            onChange={(customHeight) => onChange({ mode: "custom", customHeight })}
            onBlur={(raw) => alignDimension("customHeight", raw)}
          />
        </div>
      </section> : null}

      {showSize ? <section className="order-3 space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <ImageParameterLabel help="选择图片宽高比，系统会自动换算实际尺寸。">宽高比</ImageParameterLabel>
          <span className={cn("rounded-md bg-[#f3f4f6] px-2 py-0.5 font-mono text-[11px] text-[#686b73] dark:bg-muted dark:text-muted-foreground", highResolution && "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300")}>{sizeLabel}</span>
        </div>
        <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="图片宽高比">
          {IMAGE_ASPECT_RATIO_PRESET_OPTIONS.map((option) => {
            const automatic = option.aspectRatio === "";
            const active = automatic
              ? value.mode === "auto"
              : value.mode === "ratio" && value.aspectRatio === option.aspectRatio && value.resolution === option.resolution;
            return (
              <ImageAspectRatioOptionButton
                key={option.value}
                active={active}
                label={option.label}
                ratio={automatic ? undefined : option.aspectRatio}
                onClick={() => onChange({
                  mode: automatic ? "auto" : "ratio",
                  aspectRatio: option.aspectRatio,
                  resolution: option.resolution,
                })}
              />
            );
          })}
        </div>
      </section> : null}

      {showCount ? <section className="order-4 flex items-center justify-between gap-3 border-t border-[#ececef] pt-3 dark:border-border">
        <ImageParameterLabel help={`当前模型单次请求支持 1-${countLimit} 张图片。`}>生成数量</ImageParameterLabel>
        <NumberInput value={count} min={1} max={countLimit} controlsLayout="split" suffix="张" aria-label="生成数量" className="h-8 w-32" inputClassName="px-0 text-right text-xs font-semibold" onValueChange={(raw) => { const next = Number(raw); if (Number.isFinite(next)) onChange({ count: Math.max(1, Math.min(countLimit, Math.round(next))) }); }} />
      </section> : null}
    </div>
  );
}

function DimensionInput({
  prefix,
  value,
  onFocus,
  onChange,
  onBlur,
}: {
  prefix: "W" | "H";
  value: string;
  onFocus: () => void;
  onChange: (value: string) => void;
  onBlur: (value: string) => void;
}) {
  return (
    <label className="grid h-8 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-[#e3e4e7] bg-white px-2.5 dark:border-border dark:bg-background/70">
      <span className="text-[11px] text-[#777a82] dark:text-muted-foreground">{prefix}</span>
      <Input
        type="number"
        inputMode="numeric"
        min="1"
        step="1"
        value={value}
        placeholder="自动"
        onFocus={onFocus}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onBlur(event.target.value)}
        className="h-7 rounded-none border-0 bg-transparent px-0 text-xs font-medium shadow-none focus-visible:ring-0"
      />
    </label>
  );
}
