import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/components/ui/input-group";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { VideoParameterInputs } from "./video-parameter-inputs";
import type { VideoParameterValues } from "@/lib/video-model-contracts";
import { LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";

import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import { AspectRatioOptionButton } from "@/components/generation/aspect-ratio-option";
import { GenerationSizeBadge } from "@/components/generation/generation-size-badge";

import { NumberInput } from "@/components/ui/number-input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { TooltipHint } from "@/components/ui/tooltip";
import {
  videoAllowsCustomDuration,
  videoAudioControl,
  videoComposerAspectRatio,
  videoComposerSizeLabel,
  videoComposerWatermarkSupported,
  videoResolutionIsValid,
  videoSecondsIsValid,
  videoSecondsOptions,
  videoSizeOptions,
  videoWorkbenchDisplayResolution,
  videoWorkbenchDisplaySeconds,
  videoWorkbenchDisplaySize,
  videoWorkbenchRatioForSize,
  videoWorkbenchResolutionOptions,
  type VideoModelCapabilitySource,
} from "@/lib/video-model-capabilities";
import {
  videoContractUIState,
  videoModelContract,
  type VideoModelContract,
  type VideoModelContractRuleValues,
} from "@/lib/video-model-contracts";
import { cn } from "@/lib/utils";

export type VideoSettingsValue = {
  parameters?: VideoParameterValues;
  size: string;
  seconds: string;
  resolution: string;
  generateAudio: boolean;
  watermark: boolean;
  taskCount: number;
};

export function VideoSettingsPanel({
  model,
  value,
  onChange,
  showTaskCount = true,
  coreOnly = false,
  ruleValues,
  contract,
}: {
  model: string;
  value: VideoSettingsValue;
  onChange: (patch: Partial<VideoSettingsValue>) => void;
  showTaskCount?: boolean;
  coreOnly?: boolean;
  ruleValues?: VideoModelContractRuleValues;
  contract?: VideoModelContract;
}) {
  const capabilitySource: VideoModelCapabilitySource = contract ?? model;
  const sizeOptions = videoSizeOptions(capabilitySource);
  const dimensionOptions = sizeOptions.filter((item) => /^\d+x\d+$/i.test(item));
  const usesDimensionInputs = dimensionOptions.length > 0 && dimensionOptions.length === sizeOptions.length;
  const secondsOptions = videoSecondsOptions(capabilitySource);
  const positiveSeconds = secondsOptions.filter((item) => item > 0);
  const displaySize = videoWorkbenchDisplaySize(capabilitySource, value.size);
  const displayRatio = videoWorkbenchRatioForSize(displaySize);
  const displaySeconds = videoWorkbenchDisplaySeconds(capabilitySource, value.seconds);
  const displayResolution = videoWorkbenchDisplayResolution(capabilitySource, value.resolution);
  const videoSizePreview = displayRatio === "adaptive"
    ? "自动"
    : (/^\d+x\d+$/i.test(displaySize) ? displaySize : [displayResolution, displayRatio].filter(Boolean).join(" · ")).replace(/x/gi, "×");
  const allowsCustomDuration = videoAllowsCustomDuration(capabilitySource);
  const activeContract = contract ?? videoModelContract(model);
  const range = activeContract?.capability.seconds_range;
  const minimumSeconds = range?.min ?? positiveSeconds[0] ?? 1;
  const maximumSeconds = range ? range.max ?? undefined : positiveSeconds.at(-1) || minimumSeconds;
  const secondsValid = videoSecondsIsValid(capabilitySource, Number(displaySeconds));
  const resolutionValid = videoResolutionIsValid(capabilitySource, displayResolution);
  const audioControl = videoAudioControl(capabilitySource);
  const showAudio = audioControl !== "none";
  const showWatermark = videoComposerWatermarkSupported(capabilitySource);
  const durationSteps = [...new Set(positiveSeconds)].sort((a, b) => a - b);
  const sliderIndex = Math.max(0, durationSteps.indexOf(Number(displaySeconds)));
  const resolutionOptions = videoWorkbenchResolutionOptions(capabilitySource);
  const audioDisabled = audioControl === "always";
  const taskCount = Math.max(1, Math.min(6, Math.floor(value.taskCount || 1)));
  const contractUI = videoContractUIState(contract ?? videoModelContract(model), {
    ...ruleValues,
    size: displaySize,
    resolution: displayResolution,
    duration: Number(displaySeconds),
    generate_audio: audioControl === "always" || value.generateAudio,
    watermark: value.watermark,
  });
  const hidden = (field: "size" | "resolution" | "duration" | "generate_audio" | "watermark") => contractUI.hidden.has(field);
  const disabled = (field: "size" | "resolution" | "duration" | "generate_audio" | "watermark") => contractUI.disabled.has(field);

  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      {(!hidden("resolution") && resolutionOptions.length > 0) || (!hidden("size") && sizeOptions.length > 0) || (!coreOnly && !hidden("duration")) ? <Card size="sm" role="group" aria-label="画面设置">
        <CardHeader><CardTitle>画面设置</CardTitle></CardHeader>
        <CardContent className="grid min-w-0 gap-4">
          {!hidden("resolution") && resolutionOptions.length > 0 ? <section className={resolutionOptions.length === 1 && resolutionValid ? "flex items-center justify-between gap-3" : "space-y-2.5"}>
            <ImageParameterLabel help="更高清晰度通常需要更长生成时间。">清晰度</ImageParameterLabel>
            <ToggleGroup type="single" value={displayResolution} onValueChange={(resolution) => { if (resolution) onChange({ resolution }); }} disabled={disabled("resolution")} aria-label="视频清晰度" className={cn("w-full grid", resolutionOptions.length === 1 ? "w-24 grid-cols-1" : resolutionOptions.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
              {resolutionOptions.map((resolution) => <ToggleGroupItem key={resolution} value={resolution} className="min-w-0 uppercase">{resolution}</ToggleGroupItem>)}
            </ToggleGroup>
            {!resolutionValid ? <p className="text-[11px] text-destructive">当前模型不支持该清晰度</p> : null}
          </section> : null}

          {!hidden("size") && (sizeOptions.length > 0 || usesDimensionInputs) ? <section className="space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <ImageParameterLabel help={usesDimensionInputs ? "输入视频宽高，或从下方选择画幅比例。" : "选择视频输出的画幅比例。"}>画幅比例</ImageParameterLabel>
              <GenerationSizeBadge>{videoSizePreview}</GenerationSizeBadge>
            </div>
            {usesDimensionInputs ? <div className="space-y-2">
              <VideoDimensionInputs value={displaySize} options={dimensionOptions} disabled={displaySize === "auto" || disabled("size")} onChange={(size) => onChange({ size })} />
            </div> : <div className="grid grid-cols-3 gap-1.5 @min-[24rem]:grid-cols-4" role="group" aria-label="视频画幅比例">{sizeOptions.map((size) => { const ratio = videoWorkbenchRatioForSize(size); return <AspectRatioOptionButton key={size} active={displaySize === size} disabled={disabled("size")} label={videoComposerSizeLabel(size)} description={ratio === "adaptive" ? "自动匹配" : ratio} ratio={videoComposerAspectRatio(size)} onClick={() => onChange({ size })} />; })}</div>}
          </section> : null}

          {!coreOnly && !hidden("duration") ? <section className="space-y-2.5">
            <ImageParameterLabel help="时长越长，通常需要更久的生成时间。">视频时长</ImageParameterLabel>
            {!allowsCustomDuration || secondsOptions.includes(-1) ? <div className="flex items-center justify-between gap-3 text-xs">
              {!allowsCustomDuration || displaySeconds === "-1" ? <span className="font-medium tabular-nums">{displaySeconds === "-1" ? "智能时长" : `${displaySeconds} 秒`}</span> : null}
              {secondsOptions.includes(-1) ? <Label className="flex items-center gap-2"><span>智能时长</span><Switch aria-label="智能时长" disabled={disabled("duration")} checked={displaySeconds === "-1"} onCheckedChange={(checked) => onChange({ seconds: checked ? "-1" : String(minimumSeconds) })} /></Label> : null}
            </div> : null}
            {displaySeconds !== "-1" ? <div className="flex items-center gap-3">
              {maximumSeconds != null && (range ? maximumSeconds > minimumSeconds : durationSteps.length > 1) ? <Slider aria-label="视频时长" aria-valuetext={`${displaySeconds} 秒`} min={range ? minimumSeconds : 0} max={range ? maximumSeconds : durationSteps.length - 1} step={range?.step || 1} value={[range ? Number(displaySeconds) : sliderIndex]} disabled={disabled("duration")} onValueChange={([nextValue]) => onChange({ seconds: String(range ? Number(String(nextValue)) : durationSteps[Number(String(nextValue))]) })} /> : null}
              {allowsCustomDuration ? <VideoDurationInput value={displaySeconds} min={minimumSeconds} max={maximumSeconds} disabled={disabled("duration")} placeholder={maximumSeconds == null ? `${minimumSeconds} 秒起` : `${minimumSeconds}-${maximumSeconds}`} onChange={(seconds) => onChange({ seconds })} /> : null}
            </div> : null}
            {!secondsValid ? <p className="text-[11px] text-destructive">请输入当前模型支持的时长</p> : null}
          </section> : null}
        </CardContent>
      </Card> : null}

      {showTaskCount || (!coreOnly && ((showAudio && !hidden("generate_audio")) || (showWatermark && !hidden("watermark")))) ? <Card size="sm" role="group" aria-label="生成设置">
        <CardHeader><CardTitle>生成设置</CardTitle></CardHeader>
        <CardContent className="grid min-w-0 gap-4">
          {showTaskCount ? <section className="flex items-center justify-between gap-3">
            <div className="min-w-0"><ImageParameterLabel help="一次创建多个相同参数的独立视频任务。">生成数量</ImageParameterLabel><p className="mt-1 text-[11px] leading-5 text-muted-foreground">每个视频独立生成</p></div>
            <NumberInput value={taskCount} min={1} max={6} controlsLayout="split" suffix="个" aria-label="视频任务数" className="w-32 shrink-0" inputClassName="px-0 text-right text-xs font-semibold" onValueChange={(raw) => { const next = Number(raw); if (Number.isFinite(next)) onChange({ taskCount: Math.max(1, Math.min(6, Math.round(next))) }); }} />
          </section> : null}

          {!coreOnly && showAudio && !hidden("generate_audio") ? <section className="flex items-center justify-between gap-3"><div><ImageParameterLabel>同步生成声音</ImageParameterLabel><p className="mt-1 text-[11px] leading-5 text-muted-foreground">{audioDisabled ? "当前模型默认生成声音" : "为画面添加同步音频"}</p></div><Switch aria-label="同步生成声音" checked={audioControl === "always" || (value.generateAudio && !audioDisabled)} disabled={audioDisabled || disabled("generate_audio")} onCheckedChange={(generateAudio) => onChange({ generateAudio })} /></section> : null}
          {!coreOnly && showWatermark && !hidden("watermark") ? <section className="flex items-center justify-between gap-3"><div><ImageParameterLabel>添加水印</ImageParameterLabel><p className="mt-1 text-[11px] leading-5 text-muted-foreground">在视频中保留供应商水印</p></div><Switch aria-label="添加水印" checked={value.watermark} disabled={disabled("watermark")} onCheckedChange={(watermark) => onChange({ watermark })} /></section> : null}
        </CardContent>
      </Card> : null}

      {!coreOnly && activeContract?.capability.parameters?.length ? <Card size="sm" role="group" aria-label="附加参数"><CardHeader><CardTitle>附加参数</CardTitle></CardHeader><CardContent><VideoParameterInputs parameters={activeContract.capability.parameters.filter(parameter => !parameter.modes?.length || parameter.modes.includes(Number(ruleValues?.reference_image || 0) + Number(ruleValues?.reference_video || 0) + Number(ruleValues?.reference_audio || 0) > 0 ? "reference" : Number(ruleValues?.first_frame || 0) + Number(ruleValues?.last_frame || 0) > 0 ? "image" : "text"))} value={value.parameters || {}} onChange={parameters => onChange({parameters})} /></CardContent></Card> : null}
    </div>
  );
}

function VideoDurationInput({ value, min, max, disabled, placeholder, onChange }: { value: string; min: number; max?: number; disabled: boolean; placeholder: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const parsed = Number(draft);
  const valid = draft === "" || (Number.isInteger(parsed) && parsed >= min && (max == null || parsed <= max));
  const commit = () => {
    if (draft === "") {
      setDraft(value);
      return;
    }
    const next = String(Math.max(min, Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.round(parsed))));
    setDraft(next);
    if (next !== value) onChange(next);
  };

  return (
    <InputGroup className="w-24 shrink-0">
      <InputGroupInput
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="手动输入视频秒数"
        aria-invalid={!valid}
        className="h-full min-w-0 px-2 text-center"
        onFocus={() => setEditing(true)}
        onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
        onBlur={() => { commit(); setEditing(false); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
          }
        }}
      />
      <InputGroupAddon align="inline-end">{draft ? "秒" : ""}</InputGroupAddon>
    </InputGroup>
  );
}

function VideoDimensionInputs({ value, options, disabled, onChange }: { value: string; options: string[]; disabled: boolean; onChange: (value: string) => void }) {
  const readDimensions = (size: string) => { const match = size.match(/^(\d+)x(\d+)$/i); return { width: match?.[1] || "", height: match?.[2] || "" }; };
  const defaultSize = options[0] || "";
  const [dimensions, setDimensions] = useState(() => readDimensions(value || defaultSize));
  useEffect(() => setDimensions(readDimensions(value || defaultSize)), [defaultSize, value]);
  const commit = () => {
    if (disabled || !/^\d+$/.test(dimensions.width) || !/^\d+$/.test(dimensions.height) || Number(dimensions.width) < 1 || Number(dimensions.height) < 1) return setDimensions(readDimensions(value || options[0] || ""));
    const next = `${dimensions.width}x${dimensions.height}`;
    if (options.includes(next)) onChange(next); else setDimensions(readDimensions(value || options[0] || ""));
  };
  return <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(); }}>{(["width", "height"] as const).map((key, index) => <InputGroup key={key} className={cn("min-w-0", index === 1 && "col-start-3")}><InputGroupAddon align="inline-start">{key === "width" ? "W" : "H"}</InputGroupAddon>{disabled ? <TooltipHint content="自动尺寸下不可手动输入"><span tabIndex={0} role="img" aria-label={`${key === "width" ? "宽度" : "高度"}已锁定`} className="flex h-full min-w-0 cursor-not-allowed items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"><LockKeyhole className="size-3.5" aria-hidden="true" /></span></TooltipHint> : <InputGroupInput type="number" min="1" value={dimensions[key]} onChange={(event) => setDimensions((current) => ({ ...current, [key]: event.target.value.replace(/\D/g, "") }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); } }} className="h-full min-w-0 px-1.5 text-center" aria-label={key === "width" ? "视频宽度" : "视频高度"} />}</InputGroup>)}<span className={cn("col-start-2 row-start-1 text-sm text-muted-foreground", disabled && "text-muted-foreground/70")}>x</span></div>;
}
