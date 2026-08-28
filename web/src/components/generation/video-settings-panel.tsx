import { ClipboardPaste, LockKeyhole, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ImageAspectRatioOptionButton, ImageParameterLabel } from "@/app/image/components/image-parameter-ui";
import { imageParameterChoiceClass } from "@/app/image/components/image-parameter-styles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { TooltipButton, TooltipHint } from "@/components/ui/tooltip";
import {
  VIDEO_WORKBENCH_RATIO_OPTIONS,
  isReferenceSeedanceVideoModel,
  supportsKlingMode,
  supportsKlingMultiShot,
  supportsKlingNegativePrompt,
  supportsKlingShotType,
  usesReferenceGenericVideoPanel,
  usesReferenceSpecialVideoPanel,
  videoAllowsCustomDimensions,
  videoAllowsCustomDuration,
  videoAllowsCustomResolution,
  videoAudioControl,
  videoAudioGenerationDisabled,
  videoComposerAspectRatio,
  videoComposerPixelLabel,
  videoComposerSizeDescription,
  videoComposerSizeLabel,
  videoComposerWatermarkSupported,
  videoModelProfile,
  videoResolutionIsValid,
  videoSecondsIsValid,
  videoSecondsOptions,
  videoSizeOptions,
  videoWorkbenchDisplayResolution,
  videoWorkbenchDisplaySeconds,
  videoWorkbenchDisplaySize,
  videoWorkbenchRatioForSize,
  videoWorkbenchResolutionInputValue,
  videoWorkbenchResolutionOptions,
  videoWorkbenchSecondsOptions,
} from "@/lib/video-model-capabilities";
import {
  normalizeVideoMultiPromptDuration,
  normalizeVideoMultiPrompts,
  type VideoMultiPromptItem,
} from "@/lib/video-kling-workbench";
import { cn } from "@/lib/utils";

export type VideoSettingsValue = {
  size: string;
  seconds: string;
  resolution: string;
  mode: string;
  negativePrompt: string;
  multiShot: boolean;
  shotType: "intelligence" | "customize";
  multiPrompt: VideoMultiPromptItem[];
  characterOrientation: "image" | "video";
  generateAudio: boolean;
  watermark: boolean;
  taskCount: number;
};

export function VideoSettingsPanel({
  model,
  value,
  onChange,
  referenceImageCount = 0,
  referenceVideoCount = 0,
  showTaskCount = true,
  coreOnly = false,
  advancedContent,
}: {
  model: string;
  value: VideoSettingsValue;
  onChange: (patch: Partial<VideoSettingsValue>) => void;
  referenceImageCount?: number;
  referenceVideoCount?: number;
  showTaskCount?: boolean;
  coreOnly?: boolean;
  advancedContent?: ReactNode;
}) {
  const sizeOptions = videoSizeOptions(model);
  const dimensionOptions = sizeOptions.filter((item) => /^\d+x\d+$/i.test(item));
  const allowsCustomDimensions = videoAllowsCustomDimensions(model);
  const usesDimensionInputs = allowsCustomDimensions || (dimensionOptions.length > 0 && dimensionOptions.length === sizeOptions.length);
  const allowsCustomResolution = videoAllowsCustomResolution(model);
  const secondsOptions = videoSecondsOptions(model);
  const positiveSeconds = secondsOptions.filter((item) => item > 0);
  const profile = videoModelProfile(model);
  const seedance = isReferenceSeedanceVideoModel(model);
  const genericPanel = usesReferenceGenericVideoPanel(model);
  const displaySize = videoWorkbenchDisplaySize(model, value.size);
  const displayRatio = videoWorkbenchRatioForSize(value.size);
  const displaySeconds = videoWorkbenchDisplaySeconds(model, value.seconds);
  const displayResolution = videoWorkbenchDisplayResolution(model, value.resolution);
  const allowsCustomDuration = videoAllowsCustomDuration(model);
  const minimumSeconds = genericPanel ? 1 : seedance ? -1 : positiveSeconds[0] || 1;
  const maximumSeconds = genericPanel ? 30 : seedance ? 15 : positiveSeconds.at(-1) || minimumSeconds;
  const secondsValid = videoSecondsIsValid(model, Number(displaySeconds));
  const resolutionValid = videoResolutionIsValid(model, displayResolution, Number(displaySeconds));
  const audioControl = videoAudioControl(model);
  const showAudio = audioControl !== "none";
  const showWatermark = videoComposerWatermarkSupported(model);
  const specialPanel = usesReferenceSpecialVideoPanel(model);
  const supportsMode = supportsKlingMode(model);
  const klingV3Panel = profile === "kling-3" || profile === "kling-kie-v3" || profile.startsWith("kling-omni");
  const supportsMultiShot = supportsKlingMultiShot(model);
  const supportsNegativePrompt = supportsKlingNegativePrompt(model);
  const supportsShotType = supportsKlingShotType(model);
  const secondsPresets = videoWorkbenchSecondsOptions(model);
  const resolutionOptions = videoWorkbenchResolutionOptions(model, Number(displaySeconds));
  const audioDisabled = audioControl === "always" || videoAudioGenerationDisabled(model, value.mode, referenceImageCount, referenceVideoCount);
  const taskCount = Math.max(1, Math.min(6, Math.floor(value.taskCount || 1)));

  function changeMode(mode: string) {
    const resolution = mode === "4k" ? "4k" : mode === "pro" ? "1080p" : supportsMode ? "720p" : value.resolution;
    onChange({ mode, resolution, ...(model.toLowerCase().replace(/[._/]+/g, "-") === "kling-v2-6" && mode !== "pro" ? { generateAudio: false } : {}) });
  }

  return (
    <div className="flex flex-col gap-3.5">
      {specialPanel && supportsMode ? <section className="order-10 space-y-1.5">
        <ImageParameterLabel help="可灵模式决定输出清晰度；旧版专业模式才能生成音频。">模式选择</ImageParameterLabel>
        <div className={cn("grid gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70", klingV3Panel ? "grid-cols-3" : "grid-cols-2")}>
          {(klingV3Panel
            ? [{ value: "std", label: "720P" }, { value: "pro", label: "1080P" }, { value: "4k", label: "4K" }]
            : [{ value: "std", label: "标准 720P" }, { value: "pro", label: "专业 1080P" }]
          ).map((option) => {
            const activeMode = value.mode === "pro" || value.mode === "4k" ? value.mode : "std";
            return <button key={option.value} type="button" aria-pressed={activeMode === option.value} className={imageParameterChoiceClass(activeMode === option.value, "h-8")} onClick={() => changeMode(option.value)}>{option.label}</button>;
          })}
        </div>
      </section> : !coreOnly && (profile === "grok-kie" || profile === "grok-i2v") ? <section className="order-60 space-y-1.5">
        <ImageParameterLabel help="KIE Grok 支持 normal、fun 和 spicy 三种生成模式。">模式选择</ImageParameterLabel>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70">
          {[{ value: "normal", label: "普通" }, { value: "fun", label: "趣味" }, { value: "spicy", label: "大胆" }].map((option) => {
            const activeMode = value.mode === "fun" || value.mode === "spicy" ? value.mode : "normal";
            return <button key={option.value} type="button" aria-pressed={activeMode === option.value} className={imageParameterChoiceClass(activeMode === option.value, "h-8")} onClick={() => changeMode(option.value)}>{option.label}</button>;
          })}
        </div>
      </section> : null}

      {(!specialPanel || !supportsMode) && (resolutionOptions.length > 0 || allowsCustomResolution) ? <section className="order-10 space-y-1.5">
        <ImageParameterLabel help="更高清晰度通常需要更长生成时间。">{seedance ? "分辨率" : "清晰度"}</ImageParameterLabel>
        <div className={cn("grid gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70", resolutionOptions.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
          {resolutionOptions.map((resolution) => {
            const disabled = profile.startsWith("seedance-") && resolution === "1080p" && /fast|mini/i.test(model);
            return <TooltipButton key={resolution} type="button" disabled={disabled} tooltip={disabled ? "当前 fast / mini 模型不支持 1080p" : resolution} aria-pressed={!disabled && displayResolution === resolution} className={cn(imageParameterChoiceClass(!disabled && displayResolution === resolution, "h-8 uppercase"), disabled && "cursor-not-allowed opacity-35 hover:bg-transparent hover:text-[#5f626a]")} onClick={() => onChange({ resolution })}>{resolution}</TooltipButton>;
          })}
        </div>
        {allowsCustomResolution ? <VideoResolutionInput value={videoWorkbenchResolutionInputValue(value.resolution)} onChange={(resolution) => onChange({ resolution })} /> : null}
        {!resolutionValid ? <p className="text-[11px] text-rose-600 dark:text-rose-400">当前模型不支持该清晰度</p> : null}
        {seedance && /fast|mini/i.test(model) ? <p className="text-[11px] leading-4 text-muted-foreground">fast / mini 模型不支持 1080p，会使用 720p。</p> : null}
      </section> : null}

      {!coreOnly && supportsNegativePrompt ? <section className={cn(specialPanel ? "order-5" : "order-70", "space-y-1.5")}>
        <ImageParameterLabel>负面提示词</ImageParameterLabel>
        <Textarea value={value.negativePrompt} onChange={(event) => onChange({ negativePrompt: event.target.value })} rows={2} className="min-h-16 resize-y text-xs" />
      </section> : null}

      {!coreOnly && supportsMultiShot ? <section className="order-70 space-y-2 border-b border-[#ececf0] pb-3 dark:border-border">
        <div className="flex items-center justify-between gap-3"><ImageParameterLabel>多镜头</ImageParameterLabel><Switch checked={value.multiShot} onCheckedChange={(multiShot) => onChange({ multiShot })} /></div>
        {value.multiShot ? <>
          {supportsShotType ? <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70"><button type="button" className={imageParameterChoiceClass(value.shotType === "intelligence", "h-8")} onClick={() => onChange({ shotType: "intelligence" })}>智能分镜</button><button type="button" className={imageParameterChoiceClass(value.shotType === "customize", "h-8")} onClick={() => onChange({ shotType: "customize" })}>自定义分镜</button></div> : null}
          {!supportsShotType || value.shotType === "customize" ? <KlingMultiPromptEditor value={value.multiPrompt} onChange={(multiPrompt) => onChange({ multiPrompt })} /> : null}
        </> : null}
        {advancedContent}
      </section> : !coreOnly && advancedContent ? <div className="order-70">{advancedContent}</div> : null}

      {!coreOnly && profile === "kling-motion" ? <section className="order-70 space-y-1.5">
        <ImageParameterLabel>角色朝向</ImageParameterLabel>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70"><button type="button" className={imageParameterChoiceClass(value.characterOrientation === "video", "h-8")} onClick={() => onChange({ characterOrientation: "video" })}>跟随视频</button><button type="button" className={imageParameterChoiceClass(value.characterOrientation === "image", "h-8")} onClick={() => onChange({ characterOrientation: "image" })}>跟随图片</button></div>
      </section> : null}

      {sizeOptions.length > 0 || usesDimensionInputs ? <section className="order-20 space-y-1.5">
        <ImageParameterLabel help={usesDimensionInputs ? "输入视频宽高，或从下方选择宽高比。" : "选择视频输出的尺寸比例。"}>{specialPanel && !usesDimensionInputs ? "比例" : seedance ? "比例" : "尺寸"}</ImageParameterLabel>
        {usesDimensionInputs ? <div className="space-y-2">
          <VideoDimensionInputs value={displaySize} options={dimensionOptions} allowCustom={allowsCustomDimensions} disabled={displaySize === "auto"} onChange={(size) => onChange({ size })} />
          {allowsCustomDimensions ? <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="视频宽高比">{VIDEO_WORKBENCH_RATIO_OPTIONS.map((ratio) => { const size = ratio === "adaptive" ? "auto" : videoComposerPixelLabel(value.resolution, ratio); return <ImageAspectRatioOptionButton key={ratio} active={displayRatio === ratio} label={videoComposerSizeLabel(ratio)} description={ratio === "adaptive" ? "adaptive" : size} ratio={videoComposerAspectRatio(ratio)} onClick={() => onChange({ size })} />; })}</div> : null}
        </div> : <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="视频尺寸">{sizeOptions.map((size) => <ImageAspectRatioOptionButton key={size} active={displaySize === size} label={videoComposerSizeLabel(size)} description={videoComposerSizeDescription(model, displayResolution, size)} ratio={videoComposerAspectRatio(size)} onClick={() => onChange({ size })} />)}</div>}
      </section> : null}

      {!coreOnly ? <section className="order-30 space-y-1.5">
        <ImageParameterLabel help="视频生成所需时间会随秒数增加。">秒数</ImageParameterLabel>
        <div className={cn("grid gap-2", allowsCustomDuration ? "grid-cols-[minmax(0,1fr)_6.5rem]" : "grid-cols-1")}>
          <Select value={secondsPresets.includes(Number(displaySeconds)) ? displaySeconds : undefined} onValueChange={(seconds) => onChange({ seconds })}><SelectTrigger className="h-8 min-w-0 rounded-lg border-[#dedfe3] bg-white px-2 text-xs font-medium text-[#3f4147] shadow-none dark:border-border dark:bg-background/70 dark:text-foreground" aria-label="选择视频秒数"><SelectValue placeholder="选择秒数" /></SelectTrigger><SelectContent>{(secondsPresets.length > 0 ? secondsPresets : secondsOptions).map((seconds) => <SelectItem key={seconds} value={String(seconds)}>{seconds < 0 ? "智能时长" : `${seconds} 秒`}</SelectItem>)}</SelectContent></Select>
          {allowsCustomDuration ? <div className={cn("grid h-8 grid-cols-[1fr_auto] items-center overflow-hidden rounded-lg border bg-white dark:bg-background/70", secondsValid ? "border-[#dedfe3] dark:border-border" : "border-rose-400 ring-2 ring-rose-500/10")}><Input type="number" inputMode="numeric" min={minimumSeconds} max={maximumSeconds} step="1" value={displaySeconds === "-1" ? "" : displaySeconds} placeholder={displaySeconds === "-1" ? "智能" : `${minimumSeconds}-${maximumSeconds}`} onChange={(event) => onChange({ seconds: event.target.value })} className="h-full min-w-0 border-0 bg-transparent px-2 text-center text-xs font-semibold shadow-none focus-visible:ring-0" aria-label="手动输入视频秒数" /><span className="pr-2 text-[11px] text-[#8e8e93] dark:text-muted-foreground">{displaySeconds === "-1" ? "" : "秒"}</span></div> : null}
        </div>
        {!secondsValid ? <p className="text-[11px] text-rose-600 dark:text-rose-400">请输入当前模型支持的时长</p> : null}
      </section> : null}

      {showTaskCount ? <section className="order-35 space-y-1.5">
        <ImageParameterLabel help="一次创建多个相同参数的独立视频任务。">任务</ImageParameterLabel>
        <NumberInput value={taskCount} min={1} max={6} controlsLayout="split" suffix="个" aria-label="视频任务数" className="h-8" inputClassName="px-0 text-right text-xs font-semibold" onValueChange={(raw) => { const next = Number(raw); if (Number.isFinite(next)) onChange({ taskCount: Math.max(1, Math.min(6, Math.round(next))) }); }} />
      </section> : null}

      {!coreOnly && showAudio ? <section className="order-40 flex items-center justify-between gap-3 border-t border-[#ececf0] pt-3 dark:border-border"><ImageParameterLabel help={model.toLowerCase().replace(/[._/]+/g, "-") === "kling-v2-6" ? "仅专业模式，且只能使用一张参考图。" : "为支持该能力的模型生成与视频同步的音频。"}>音频生成</ImageParameterLabel><Switch checked={audioControl === "always" || (value.generateAudio && !audioDisabled)} disabled={audioDisabled} onCheckedChange={(generateAudio) => onChange({ generateAudio })} /></section> : null}
      {!coreOnly && showWatermark ? <section className="order-50 flex items-center justify-between gap-3 border-t border-[#ececf0] pt-3 dark:border-border"><ImageParameterLabel help="在生成的视频中添加供应商水印。">添加水印</ImageParameterLabel><Switch checked={value.watermark} onCheckedChange={(watermark) => onChange({ watermark })} /></section> : null}
    </div>
  );
}

function KlingMultiPromptEditor({ value, onChange }: { value: VideoMultiPromptItem[]; onChange: (value: VideoMultiPromptItem[]) => void }) {
  const items = normalizeVideoMultiPrompts(value);
  const update = (index: number, patch: Partial<VideoMultiPromptItem>) => onChange(items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const paste = async (index: number) => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) throw new Error();
      update(index, { prompt: text });
      toast.success("已读取剪贴板文本");
    } catch {
      toast.error("剪贴板里没有可读取的文本");
    }
  };
  return <div className="space-y-2">{items.map((item, index) => <section key={index} className="space-y-2 rounded-lg border border-[#dedfe3] p-2 dark:border-border"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">分镜提示词 {index + 1}</span><TooltipButton type="button" tooltip="删除分镜" disabled={items.length <= 1} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-rose-600 disabled:opacity-35"><X className="size-3.5" /></TooltipButton></div><div className="flex gap-1"><Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void paste(index)}><ClipboardPaste className="size-3.5" />剪贴板</Button><Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => update(index, { prompt: "" })}><Trash2 className="size-3.5" />清空</Button></div><Textarea value={item.prompt} onChange={(event) => update(index, { prompt: event.target.value })} rows={2} className="min-h-14 resize-y text-xs" placeholder="描述这个分镜" /><label className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>时长</span><Input type="number" min="1" max="15" value={item.duration} onChange={(event) => update(index, { duration: normalizeVideoMultiPromptDuration(event.target.value) })} className="h-7 w-20 text-center text-xs" /></label></section>)}<Button type="button" variant="outline" size="sm" className="w-full" onClick={() => onChange([...items, { prompt: "", duration: "1" }])}><Plus className="size-3.5" />新增分镜</Button></div>;
}

function VideoDimensionInputs({ value, options, allowCustom, disabled, onChange }: { value: string; options: string[]; allowCustom: boolean; disabled: boolean; onChange: (value: string) => void }) {
  const readDimensions = (size: string) => { const match = size.match(/^(\d+)x(\d+)$/i); return { width: match?.[1] || "", height: match?.[2] || "" }; };
  const [dimensions, setDimensions] = useState(() => readDimensions(value || options[0] || ""));
  useEffect(() => setDimensions(readDimensions(value || options[0] || "")), [options, value]);
  const commit = () => {
    if (disabled || !/^\d+$/.test(dimensions.width) || !/^\d+$/.test(dimensions.height) || Number(dimensions.width) < 1 || Number(dimensions.height) < 1) return setDimensions(readDimensions(value || options[0] || ""));
    const next = `${dimensions.width}x${dimensions.height}`;
    if (allowCustom || options.includes(next)) onChange(next); else setDimensions(readDimensions(value || options[0] || ""));
  };
  return <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(); }}>{(["width", "height"] as const).map((key, index) => <div key={key} className={cn("grid h-9 min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] items-center overflow-hidden rounded-lg border border-[#dedfe3] bg-white transition-colors dark:border-border dark:bg-background/70", disabled && "cursor-not-allowed border-border/60 bg-muted/50 text-muted-foreground dark:bg-muted/40", index === 1 && "col-start-3")}><span className={cn("pl-2 text-[11px] font-semibold text-[#8e8e93]", disabled && "text-muted-foreground")}>{key === "width" ? "W" : "H"}</span>{disabled ? <TooltipHint content="自动尺寸下不可手动输入"><span tabIndex={0} role="img" aria-label={`${key === "width" ? "宽度" : "高度"}已锁定`} className="flex h-full min-w-0 cursor-not-allowed items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"><LockKeyhole className="size-3.5" aria-hidden="true" /></span></TooltipHint> : <Input type="number" min="1" value={dimensions[key]} onChange={(event) => setDimensions((current) => ({ ...current, [key]: event.target.value.replace(/\D/g, "") }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); } }} className="h-full min-w-0 border-0 bg-transparent px-1.5 text-center text-xs font-semibold shadow-none focus-visible:ring-0" aria-label={key === "width" ? "视频宽度" : "视频高度"} />}</div>)}<span className={cn("col-start-2 row-start-1 text-sm text-[#a0a3aa]", disabled && "text-muted-foreground/70")}>x</span></div>;
}

function VideoResolutionInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const showPixelSuffix = /^\d{3,}$/.test(value.trim());
  return <div className="grid h-8 grid-cols-[minmax(0,1fr)_1.75rem] items-center overflow-hidden rounded-lg border border-[#dedfe3] bg-white dark:border-border dark:bg-background/70"><Input value={value} onChange={(event) => onChange(event.target.value)} placeholder="自定义" className="h-full min-w-0 border-0 bg-transparent px-2 text-center text-xs font-semibold shadow-none focus-visible:ring-0" aria-label="自定义清晰度" /><span className="pr-2 text-[11px] text-[#8e8e93]">{showPixelSuffix ? "p" : ""}</span></div>;
}
