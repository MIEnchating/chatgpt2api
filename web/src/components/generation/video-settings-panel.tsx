import { LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";

import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import { imageParameterChoiceClass } from "@/components/generation/image-parameter-styles";
import { AspectRatioOptionButton } from "@/components/generation/aspect-ratio-option";
import { GenerationSizeBadge } from "@/components/generation/generation-size-badge";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TooltipHint } from "@/components/ui/tooltip";
import {
  videoAllowsCustomDuration,
  videoAudioControl,
  videoComposerAspectRatio,
  videoComposerPixelLabel,
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
  videoWorkbenchSecondsOptions,
} from "@/lib/video-model-capabilities";
import {
  videoContractUIState,
  videoModelContract,
  type VideoModelContractRuleValues,
} from "@/lib/video-model-contracts";
import { cn } from "@/lib/utils";

export type VideoSettingsValue = {
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
}: {
  model: string;
  value: VideoSettingsValue;
  onChange: (patch: Partial<VideoSettingsValue>) => void;
  showTaskCount?: boolean;
  coreOnly?: boolean;
  ruleValues?: VideoModelContractRuleValues;
}) {
  const sizeOptions = videoSizeOptions(model);
  const dimensionOptions = sizeOptions.filter((item) => /^\d+x\d+$/i.test(item));
  const usesDimensionInputs = dimensionOptions.length > 0 && dimensionOptions.length === sizeOptions.length;
  const secondsOptions = videoSecondsOptions(model);
  const positiveSeconds = secondsOptions.filter((item) => item > 0);
  const displaySize = videoWorkbenchDisplaySize(model, value.size);
  const displayRatio = videoWorkbenchRatioForSize(value.size);
  const displaySeconds = videoWorkbenchDisplaySeconds(model, value.seconds);
  const displayResolution = videoWorkbenchDisplayResolution(model, value.resolution);
  const videoSizePreview = displayRatio === "adaptive"
    ? "自动"
    : (/^\d+x\d+$/i.test(displaySize) ? displaySize : videoComposerPixelLabel(displayResolution, displayRatio)).replace(/x/gi, "×");
  const allowsCustomDuration = videoAllowsCustomDuration(model);
  const minimumSeconds = positiveSeconds[0] || 1;
  const maximumSeconds = positiveSeconds.at(-1) || minimumSeconds;
  const secondsValid = videoSecondsIsValid(model, Number(displaySeconds));
  const resolutionValid = videoResolutionIsValid(model, displayResolution);
  const audioControl = videoAudioControl(model);
  const showAudio = audioControl !== "none";
  const showWatermark = videoComposerWatermarkSupported(model);
  const secondsPresets = videoWorkbenchSecondsOptions(model);
  const resolutionOptions = videoWorkbenchResolutionOptions(model);
  const audioDisabled = audioControl === "always";
  const taskCount = Math.max(1, Math.min(6, Math.floor(value.taskCount || 1)));
  const contractUI = videoContractUIState(videoModelContract(model), {
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
    <div className="flex flex-col gap-3.5">
      {!hidden("resolution") && resolutionOptions.length > 0 ? <section className="order-10 space-y-1.5">
        <ImageParameterLabel help="更高清晰度通常需要更长生成时间。">清晰度</ImageParameterLabel>
        <div className={cn("grid gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70", resolutionOptions.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
          {resolutionOptions.map((resolution) => <button key={resolution} type="button" disabled={disabled("resolution")} aria-pressed={displayResolution === resolution} className={imageParameterChoiceClass(displayResolution === resolution, "h-8 uppercase")} onClick={() => onChange({ resolution })}>{resolution}</button>)}
        </div>
        {!resolutionValid ? <p className="text-[11px] text-rose-600 dark:text-rose-400">当前模型不支持该清晰度</p> : null}
      </section> : null}

      {!hidden("size") && (sizeOptions.length > 0 || usesDimensionInputs) ? <section className="order-20 space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <ImageParameterLabel help={usesDimensionInputs ? "输入视频宽高，或从下方选择画幅比例。" : "选择视频输出的画幅比例。"}>画幅比例</ImageParameterLabel>
          <GenerationSizeBadge>{videoSizePreview}</GenerationSizeBadge>
        </div>
        {usesDimensionInputs ? <div className="space-y-2">
          <VideoDimensionInputs value={displaySize} options={dimensionOptions} disabled={displaySize === "auto" || disabled("size")} onChange={(size) => onChange({ size })} />
        </div> : <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="视频画幅比例">{sizeOptions.map((size) => { const ratio = videoWorkbenchRatioForSize(size); return <AspectRatioOptionButton key={size} active={displaySize === size} disabled={disabled("size")} label={videoComposerSizeLabel(size)} description={ratio === "adaptive" ? "自动匹配" : ratio} ratio={videoComposerAspectRatio(size)} onClick={() => onChange({ size })} />; })}</div>}
      </section> : null}

      {!coreOnly && !hidden("duration") ? <section className="order-30 space-y-1.5">
        <ImageParameterLabel help="视频生成所需时间会随秒数增加。">秒数</ImageParameterLabel>
        <div className={cn("grid gap-2", allowsCustomDuration ? "grid-cols-[minmax(0,1fr)_6.5rem]" : "grid-cols-1")}>
          <Select value={secondsPresets.includes(Number(displaySeconds)) ? displaySeconds : undefined} disabled={disabled("duration")} onValueChange={(seconds) => onChange({ seconds })}><SelectTrigger className="h-8 min-w-0 rounded-lg border-[#dedfe3] bg-white px-2 text-xs font-medium text-[#3f4147] shadow-none dark:border-border dark:bg-background/70 dark:text-foreground" aria-label="选择视频秒数"><SelectValue placeholder="选择秒数" /></SelectTrigger><SelectContent>{(secondsPresets.length > 0 ? secondsPresets : secondsOptions).map((seconds) => <SelectItem key={seconds} value={String(seconds)}>{seconds < 0 ? "智能时长" : `${seconds} 秒`}</SelectItem>)}</SelectContent></Select>
          {allowsCustomDuration ? <VideoDurationInput value={displaySeconds === "-1" ? "" : displaySeconds} min={minimumSeconds} max={maximumSeconds} disabled={disabled("duration")} placeholder={displaySeconds === "-1" ? "智能" : `${minimumSeconds}-${maximumSeconds}`} onChange={(seconds) => onChange({ seconds })} /> : null}
        </div>
        {!secondsValid ? <p className="text-[11px] text-rose-600 dark:text-rose-400">请输入当前模型支持的时长</p> : null}
      </section> : null}

      {showTaskCount ? <section className="order-35 space-y-1.5">
        <ImageParameterLabel help="一次创建多个相同参数的独立视频任务。">任务</ImageParameterLabel>
        <NumberInput value={taskCount} min={1} max={6} controlsLayout="split" suffix="个" aria-label="视频任务数" className="h-8" inputClassName="px-0 text-right text-xs font-semibold" onValueChange={(raw) => { const next = Number(raw); if (Number.isFinite(next)) onChange({ taskCount: Math.max(1, Math.min(6, Math.round(next))) }); }} />
      </section> : null}

      {!coreOnly && showAudio && !hidden("generate_audio") ? <section className="order-40 flex items-center justify-between gap-3 border-t border-[#ececf0] pt-3 dark:border-border"><ImageParameterLabel help="为支持该能力的模型生成与视频同步的音频。">音频生成</ImageParameterLabel><Switch checked={audioControl === "always" || (value.generateAudio && !audioDisabled)} disabled={audioDisabled || disabled("generate_audio")} onCheckedChange={(generateAudio) => onChange({ generateAudio })} /></section> : null}
      {!coreOnly && showWatermark && !hidden("watermark") ? <section className="order-50 flex items-center justify-between gap-3 border-t border-[#ececf0] pt-3 dark:border-border"><ImageParameterLabel help="在生成的视频中添加供应商水印。">添加水印</ImageParameterLabel><Switch checked={value.watermark} disabled={disabled("watermark")} onCheckedChange={(watermark) => onChange({ watermark })} /></section> : null}
    </div>
  );
}

function VideoDurationInput({ value, min, max, disabled, placeholder, onChange }: { value: string; min: number; max: number; disabled: boolean; placeholder: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const parsed = Number(draft);
  const valid = draft === "" || (Number.isInteger(parsed) && parsed >= min && parsed <= max);
  const commit = () => {
    if (draft === "") {
      setDraft(value);
      return;
    }
    const next = String(Math.max(min, Math.min(max, Math.round(parsed))));
    setDraft(next);
    if (next !== value) onChange(next);
  };

  return (
    <div className={cn("grid h-8 grid-cols-[1fr_auto] items-center overflow-hidden rounded-lg border bg-white dark:bg-background/70", valid ? "border-[#dedfe3] dark:border-border" : "border-rose-400 ring-2 ring-rose-500/10")}>
      <Input
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="手动输入视频秒数"
        aria-invalid={!valid}
        className="h-full min-w-0 border-0 bg-transparent px-2 text-center text-xs font-semibold shadow-none focus-visible:ring-0"
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
      <span className="pr-2 text-[11px] text-[#8e8e93] dark:text-muted-foreground">{draft ? "秒" : ""}</span>
    </div>
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
  return <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(); }}>{(["width", "height"] as const).map((key, index) => <div key={key} className={cn("grid h-9 min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] items-center overflow-hidden rounded-lg border border-[#dedfe3] bg-white transition-colors dark:border-border dark:bg-background/70", disabled && "cursor-not-allowed border-border/60 bg-muted/50 text-muted-foreground dark:bg-muted/40", index === 1 && "col-start-3")}><span className={cn("pl-2 text-[11px] font-semibold text-[#8e8e93]", disabled && "text-muted-foreground")}>{key === "width" ? "W" : "H"}</span>{disabled ? <TooltipHint content="自动尺寸下不可手动输入"><span tabIndex={0} role="img" aria-label={`${key === "width" ? "宽度" : "高度"}已锁定`} className="flex h-full min-w-0 cursor-not-allowed items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"><LockKeyhole className="size-3.5" aria-hidden="true" /></span></TooltipHint> : <Input type="number" min="1" value={dimensions[key]} onChange={(event) => setDimensions((current) => ({ ...current, [key]: event.target.value.replace(/\D/g, "") }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); } }} className="h-full min-w-0 border-0 bg-transparent px-1.5 text-center text-xs font-semibold shadow-none focus-visible:ring-0" aria-label={key === "width" ? "视频宽度" : "视频高度"} />}</div>)}<span className={cn("col-start-2 row-start-1 text-sm text-[#a0a3aa]", disabled && "text-muted-foreground/70")}>x</span></div>;
}
