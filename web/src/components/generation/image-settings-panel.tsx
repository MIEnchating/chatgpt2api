import { Label } from "@/components/ui/label";
import { LabeledField } from "@/components/labeled-field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isGPTImage26 } from "@/lib/image-model-capabilities";
import type { ImageGenerationOptions } from "@/lib/image-generation-options";
import type { ImageOutputFormat } from "@/lib/api";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import {
  imageWorkbenchQualityOptions,
  buildImageSize,
  formatImageSizeDisplay,
  isHighResolutionImageSize,
  parseImageSizeDimensions,
  isImageAspectRatio,
  type ImageResolution,
  type ImageSizeSelection,
} from "@/lib/image-options";
import { ImageSizePresetControls } from "@/components/generation/image-size-preset-controls";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { imageOutputCountLimit, type ImageQuality } from "@/lib/api";
import { configuredImageModel } from "@/lib/image-model-definitions";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type ImageSettingsValue = ImageSizeSelection & {
  snapToMultiple16: boolean;
  quality: "" | ImageQuality;
  count: number;
  imageOptions?: ImageGenerationOptions;
  outputFormat?: ImageOutputFormat;
};

export function ImageSettingsPanel({
  model,
  value,
  onChange,
  disabled = false,
  showSize = true,
  showCount = true,
  showQuality = true,
  showSnapToMultiple16 = true,
}: {
  model: string;
  value: ImageSettingsValue;
  onChange: (patch: Partial<ImageSettingsValue>) => void;
  disabled?: boolean;
  showSize?: boolean;
  showCount?: boolean;
  showQuality?: boolean;
  showSnapToMultiple16?: boolean;
}) {
  const definition = configuredImageModel(model);
  const selectedRatio = value.aspectRatio === "custom" ? value.customRatio : value.aspectRatio;
  const qualityOptions = imageWorkbenchQualityOptions(model);
  useEffect(() => {
    if (!definition) return;
    const patch: Partial<ImageSettingsValue> = {};
    if (value.quality && !definition.quality_values.includes(value.quality)) patch.quality = "";
    if (value.resolution !== "auto" && !definition.resolutions.includes(value.resolution)) patch.resolution = "auto";
    if (value.mode === "custom" && !definition.exact_dimensions) patch.mode = "auto";
    if (value.mode === "ratio" && selectedRatio && !definition.aspect_ratios.includes(selectedRatio)) patch.aspectRatio = "";
    if (Object.keys(patch).length) onChange(patch);
  }, [definition, value.quality, value.resolution, value.mode, selectedRatio, onChange]);
  const computedSize = buildImageSize(value, { snapToMultiple16: value.snapToMultiple16 });
  const dimensions = parseImageSizeDimensions(computedSize) || { width: "1024", height: "1024" };
  const displayedWidth = value.mode === "custom" ? value.customWidth : dimensions.width;
  const displayedHeight = value.mode === "custom" ? value.customHeight : dimensions.height;
  const sizeLabel = computedSize ? formatImageSizeDisplay(computedSize) : value.mode === "auto" ? "自动" : "尺寸无效";
  const highResolution = Boolean(computedSize && isHighResolutionImageSize(computedSize, value));
  const countLimit = value.outputFormat === "svg" ? 1 : Math.max(1, Math.min(10, imageOutputCountLimit(model)));
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
    <div className="flex min-w-0 flex-col gap-4">
      {showSize || (showQuality && qualityOptions.length > 1) ? <Card size="sm" role="group" aria-label="画面设置">
        <CardHeader><CardTitle>画面设置</CardTitle></CardHeader>
        <CardContent className="grid min-w-0 gap-4">
          {showQuality && qualityOptions.length > 1 ? <section className="space-y-1.5">
            <ImageParameterLabel help="选择画面精细程度，更高质量通常需要更长生成时间。">画面质量</ImageParameterLabel>
            <ToggleGroup type="single" size="sm" variant="outline" spacing={1} value={value.quality || "auto"} onValueChange={(quality) => { if (quality) onChange({ quality: quality === "auto" ? "" : quality as ImageQuality }); }} disabled={disabled} aria-label="图片质量" className="grid w-full auto-cols-fr grid-flow-col">
              {qualityOptions.map((option) => (
                <ToggleGroupItem key={option.value || "auto"} value={option.value || "auto"} className="min-w-0 px-1">
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </section> : null}

          {showSize && definition ? <section className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <ImageParameterLabel>画幅比例</ImageParameterLabel>
              <Select disabled={disabled} value={value.mode === "auto" ? "auto" : selectedRatio || "auto"} onValueChange={(ratio) => onChange({ mode: "ratio", aspectRatio: ratio === "auto" ? "" : isImageAspectRatio(ratio) ? ratio : "custom", customRatio: ratio === "auto" ? "" : ratio })}>
                <SelectTrigger className="w-full" aria-label="图片画幅比例"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="auto">自动</SelectItem>{definition.aspect_ratios.map((ratio) => <SelectItem key={ratio} value={ratio}>{ratio}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <ImageParameterLabel>分辨率</ImageParameterLabel>
              <Select disabled={disabled} value={value.resolution} onValueChange={(resolution) => onChange({ mode: "ratio", resolution: resolution as ImageResolution })}>
                <SelectTrigger className="w-full" aria-label="图片分辨率"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="auto">自动</SelectItem>{definition.resolutions.map((resolution) => <SelectItem key={resolution} value={resolution}>{resolution.toUpperCase()}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </section> : showSize ? <ImageSizePresetControls
            value={value}
            previewLabel={sizeLabel}
            highResolution={highResolution}
            disabled={disabled}
            onChange={onChange}
          /> : null}

          {showSize && (!definition || definition.exact_dimensions) ? <section className="space-y-1.5">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <ImageParameterLabel help="手动输入图片宽高；输入完成后可自动向上补成 16 的倍数。">自定义尺寸</ImageParameterLabel>
              {showSnapToMultiple16 ? <Label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>对齐至 16 倍数</span>
                <Switch disabled={disabled} checked={value.snapToMultiple16} aria-label="16倍数对齐" onCheckedChange={(checked) => onChange({ snapToMultiple16: checked })} />
              </Label> : null}
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
              <DimensionInput
                disabled={disabled}
                prefix="W"
                value={displayedWidth}
                onFocus={beginCustomSize}
                onChange={(customWidth) => onChange({ mode: "custom", customWidth })}
                onBlur={(raw) => alignDimension("customWidth", raw)}
              />
              <X className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <DimensionInput
                disabled={disabled}
                prefix="H"
                value={displayedHeight}
                onFocus={beginCustomSize}
                onChange={(customHeight) => onChange({ mode: "custom", customHeight })}
                onBlur={(raw) => alignDimension("customHeight", raw)}
              />
            </div>
          </section> : null}
        </CardContent>
      </Card> : null}

      {showCount || isGPTImage26(model) ? <Card size="sm" role="group" aria-label="输出设置">
        <CardHeader><CardTitle>输出设置</CardTitle></CardHeader>
        <CardContent className="grid min-w-0 gap-4">
          {showCount ? <section className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <ImageParameterLabel help={`当前模型单次请求支持 1-${countLimit} 张图片。`}>生成数量</ImageParameterLabel>
            <NumberInput disabled={disabled} value={count} min={1} max={countLimit} controlsLayout="split" suffix="张" aria-label="生成数量" className="w-36" inputClassName="px-0 text-right text-xs font-semibold" onValueChange={(raw) => { const next = Number(raw); if (Number.isFinite(next)) onChange({ count: Math.max(1, Math.min(countLimit, Math.round(next))) }); }} />
          </section> : null}

          {isGPTImage26(model) ? <section className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <ImageParameterLabel help="控制生成前的规划程度；高复杂度适合密集文字和复杂构图，也可能增加耗时。">复杂度</ImageParameterLabel>
                <Select disabled={disabled} value={value.imageOptions?.complexity || "high"} onValueChange={(complexity) => onChange({ imageOptions: { ...value.imageOptions, complexity: complexity as ImageGenerationOptions["complexity"] } })}>
                  <SelectTrigger aria-label="图片复杂度" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="low">低</SelectItem><SelectItem value="medium">中</SelectItem><SelectItem value="high">高（默认）</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <ImageParameterLabel>输出格式</ImageParameterLabel>
                <Select disabled={disabled} value={value.outputFormat || "png"} onValueChange={(format) => onChange({ outputFormat: format as ImageOutputFormat, ...(format === "svg" ? { count: 1 } : {}), ...(format === "gif" ? { mode: "auto" as const, resolution: "auto" as const } : {}), imageOptions: { ...value.imageOptions, background: format === "png" || format === "webp" ? value.imageOptions?.background : "auto", markup: format === "gif" || format === "svg" ? undefined : value.imageOptions?.markup } })}>
                  <SelectTrigger aria-label="图片输出格式" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{["png", "jpeg", "webp", "svg", "gif"].map((format) => <SelectItem key={format} value={format}>{format.toUpperCase()}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <ImageParameterLabel>背景</ImageParameterLabel>
              <Select disabled={disabled || value.outputFormat === "gif" || value.outputFormat === "svg"} value={value.imageOptions?.background || "auto"} onValueChange={(background) => onChange({ imageOptions: { ...value.imageOptions, background: background as ImageGenerationOptions["background"] }, ...(background === "transparent" && value.outputFormat === "jpeg" ? { outputFormat: "png" as const } : {}) })}>
                <SelectTrigger aria-label="图片背景" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="auto">自动</SelectItem><SelectItem value="opaque">不透明</SelectItem><SelectItem value="transparent">透明</SelectItem></SelectContent>
              </Select>
            </div>
            {value.outputFormat === "gif" ? <div className="grid grid-cols-2 gap-3">
              <LabeledField label="动画帧数">{(fieldId) => <NumberInput id={fieldId} disabled={disabled} value={value.imageOptions?.frame_count ?? 9} min={2} max={16} aria-label="动画帧数" onValueChange={(raw) => onChange({ imageOptions: { ...value.imageOptions, frame_count: Math.max(2, Math.min(16, Math.round(Number(raw) || 9))) } })} />}</LabeledField>
              <LabeledField label="每帧时长（毫秒）">{(fieldId) => <NumberInput id={fieldId} disabled={disabled} value={value.imageOptions?.frame_duration_ms ?? 200} min={20} max={2000} aria-label="每帧时长" onValueChange={(raw) => onChange({ imageOptions: { ...value.imageOptions, frame_duration_ms: Math.max(20, Math.min(2000, Math.round(Number(raw) / 10) * 10 || 200)) } })} />}</LabeledField>
            </div> : null}
            {value.outputFormat === "gif" || value.outputFormat === "svg" ? <p className="text-xs text-muted-foreground">仅支持文生图，完成后一次返回。GIF 建议使用自动尺寸；帧数越多，可用的单帧尺寸越小。</p> : null}
          </section> : null}
        </CardContent>
      </Card> : null}
    </div>
  );
}

function DimensionInput({
  disabled,
  prefix,
  value,
  onFocus,
  onChange,
  onBlur,
}: {
  disabled: boolean;
  prefix: "W" | "H";
  value: string;
  onFocus: () => void;
  onChange: (value: string) => void;
  onBlur: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  return (
    <InputGroup
      className="min-w-0"
    >
      <InputGroupAddon align="inline-start">{prefix}</InputGroupAddon>
      <InputGroupInput
        type="number"
        inputMode="numeric"
        min="1"
        step="1"
        aria-label={prefix === "W" ? "图片宽度" : "图片高度"}
        disabled={disabled}
        value={draft}
        placeholder="自动"
        onFocus={() => {
          setEditing(true);
          onFocus();
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          onChange(next);
        }}
        onBlur={() => {
          setEditing(false);
          onBlur(draft);
        }}
        className="px-0 disabled:opacity-100"
      />
    </InputGroup>
  );
}
