import { Minus, Plus, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ImageAspectRatioOptionButton, ImageParameterLabel } from "@/app/image/components/image-parameter-ui";
import { imageParameterChoiceClass } from "@/app/image/components/image-parameter-styles";
import { defaultCanvasImageParameters } from "@/app/canvas/canvas-image-parameter-defaults";
import { canvasFloatingPanelPlacement } from "@/app/canvas/canvas-floating-panel";
import {
  GEMINI_IMAGE_RESOLUTION_OPTIONS,
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  IMAGE_RESOLUTION_OPTIONS,
  XAI_IMAGE_RESOLUTION_OPTIONS,
  buildImageSize,
  formatImageSizeDisplay,
  getImageSizeSelectionFromSize,
} from "@/app/image/image-options";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  IMAGE_OUTPUT_FORMAT_OPTIONS,
  imageModelRoute,
  imageOutputCountLimit,
  supportsImageAspectRatio,
  supportsImageExactDimensions,
  supportsImageOutputControls,
  supportsImageOutputCompression,
  supportsImageQuality,
  supportsImageQualityValue,
  supportsImageResolution,
  supportsImageSize,
  supportsImageStreaming,
  supportsStructuredImageParameters,
  type CanvasNode,
  type ImageOutputFormat,
  type ImageQuality,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type CanvasImageParameterPatch = Partial<Pick<CanvasNode,
  | "generation_size"
  | "generation_resolution"
  | "generation_quality"
  | "generation_count"
  | "generation_output_format"
  | "generation_output_compression"
  | "generation_stream"
  | "generation_partial_images"
>>;

export function CanvasImageParameterPopover({ node, imageModel, onChange }: { node: CanvasNode; imageModel: string; onChange: (patch: CanvasImageParameterPatch) => void }) {
  const buttonRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const defaults = defaultCanvasImageParameters();
  const size = node.generation_size ?? defaults.generation_size ?? "";
  const selection = getImageSizeSelectionFromSize(
    size,
    node.generation_resolution ?? defaults.generation_resolution,
  );
  const quality = node.generation_quality ?? defaults.generation_quality ?? "";
  const countLimit = imageOutputCountLimit(imageModel);
  const count = Math.max(1, Math.min(countLimit, node.generation_count ?? defaults.generation_count ?? 1));
  const outputFormat = node.generation_output_format ?? defaults.generation_output_format ?? "png";
  const outputCompression = node.generation_output_compression ?? defaults.generation_output_compression;
  const stream = node.generation_stream ?? defaults.generation_stream ?? false;
  const partialImages = Math.max(0, Math.min(3, node.generation_partial_images ?? defaults.generation_partial_images ?? 0));
  const imageRoute = imageModelRoute(imageModel);
  const googleGeminiImageParameters = imageRoute === "google-gemini-image";
  const xaiImageParameters = imageRoute === "xai-image";
  const sizeSupported = supportsImageSize(imageModel);
  const structuredParameters = supportsStructuredImageParameters(imageModel);
  const exactDimensionsSupported = supportsImageExactDimensions(imageModel);
  const qualitySupported = supportsImageQuality(imageModel);
  const streamingSupported = supportsImageStreaming(imageModel);
  const outputControlsSupported = supportsImageOutputControls(imageModel);
  const aspectRatioOptions = IMAGE_ASPECT_RATIO_OPTIONS.filter(
    (option) => option.value !== "custom" && supportsImageAspectRatio(imageModel, option.value),
  );
  const resolutionOptions = (googleGeminiImageParameters
    ? GEMINI_IMAGE_RESOLUTION_OPTIONS
    : xaiImageParameters
      ? XAI_IMAGE_RESOLUTION_OPTIONS
      : IMAGE_RESOLUTION_OPTIONS
  ).filter((option) => supportsImageResolution(imageModel, option.value));
  const qualityOptions = [{ value: "", label: "自动" }, ...IMAGE_QUALITY_OPTIONS]
    .filter((option) => supportsImageQualityValue(imageModel, option.value));
  const selectedResolution = supportsImageResolution(imageModel, selection.resolution)
    ? selection.resolution
    : "auto";
  const selectedAspectRatio = supportsImageAspectRatio(imageModel, selection.aspectRatio)
    ? selection.aspectRatio
    : "";
  const selectedSizeMode = (selection.mode === "ratio" && !selectedAspectRatio) || (selection.mode === "custom" && !exactDimensionsSupported)
    ? "auto"
    : selection.mode;
  const sizeLabel = sizeSupported && selectedSizeMode !== "auto" && size ? formatImageSizeDisplay(size) : "自动";
  const panelPlacement = buttonRect ? canvasFloatingPanelPlacement({
    anchor: buttonRect,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }) : null;

  useEffect(() => {
    if (!open) return;
    const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    syncPosition();
    window.addEventListener("resize", syncPosition);
    window.addEventListener("scroll", syncPosition, true);
    window.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => {
      window.removeEventListener("resize", syncPosition);
      window.removeEventListener("scroll", syncPosition, true);
      window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    };
  }, [open]);

  function updateSize(aspectRatio: typeof selection.aspectRatio, resolution: typeof selection.resolution) {
    if (!aspectRatio) {
      onChange({ generation_size: "", generation_resolution: "auto" });
      return;
    }
    const nextSelection = { ...selection, mode: "ratio" as const, aspectRatio, resolution };
    onChange({
      generation_size: buildImageSize(nextSelection, { preserveAspectRatio: googleGeminiImageParameters || xaiImageParameters }),
      generation_resolution: resolution,
    });
  }

  return (
    <>
      <span ref={buttonRef} className="inline-flex">
        <button type="button" aria-expanded={open} aria-label="打开图片参数" title="图片参数" className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border/70 bg-background/75 px-2.5 text-xs font-medium text-foreground shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-border hover:bg-background", open && "border-[#bfd1ff] bg-[#eaf1ff] text-[#1456f0]")} onClick={() => setOpen((value) => !value)}>
          <SlidersHorizontal className="size-3.5 text-[#1456f0]" />
          <span className="font-semibold">{sizeLabel}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{count} 张</span>
        </button>
      </span>
      {open && buttonRect && panelPlacement ? createPortal(
        <ScrollArea
          ref={panelRef}
          data-canvas-parameter-panel
          className="fixed z-[1200] rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_18px_54px_rgba(15,23,42,.18)]"
          style={{
            left: panelPlacement.left,
            width: panelPlacement.width,
            maxHeight: panelPlacement.maxHeight,
            ...(panelPlacement.direction === "above"
              ? { bottom: window.innerHeight - buttonRect.top + 8 }
              : { top: buttonRect.bottom + 8 }),
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
        <div className="space-y-3.5 p-3 pr-4">
          {sizeSupported ? <section className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <ImageParameterLabel help="选择画幅比例，系统会自动换算为合法像素尺寸。">画幅比例</ImageParameterLabel>
              <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{sizeLabel}</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="图片画幅比例">
              {aspectRatioOptions.map((option) => {
                const active = option.value ? selectedSizeMode === "ratio" && selectedAspectRatio === option.value : selectedSizeMode === "auto";
                return <ImageAspectRatioOptionButton key={option.value || "auto"} active={active} label={option.value || "自动"} ratio={option.value || undefined} onClick={() => updateSize(option.value, option.value ? selectedResolution : "auto")} />;
              })}
            </div>
          </section> : null}

          {qualitySupported ? <section className="space-y-1.5">
            <ImageParameterLabel help="质量越高，生成时间和费用通常越高。">质量</ImageParameterLabel>
            <div className={cn("grid gap-1 rounded-lg bg-muted p-1", qualityOptions.length === 3 ? "grid-cols-3" : "grid-cols-4")}>
              {qualityOptions.map((option) => <button key={option.value || "auto"} type="button" className={imageParameterChoiceClass(quality === option.value, "h-7")} onClick={() => onChange({ generation_quality: (option.value || undefined) as ImageQuality | undefined })}>{option.label}</button>)}
            </div>
          </section> : null}

          {structuredParameters && resolutionOptions.length > 1 ? <section className="space-y-1.5">
            <ImageParameterLabel help={googleGeminiImageParameters ? "Gemini 使用官方 512、1K、2K、4K 档位。" : xaiImageParameters ? "Grok 官方支持 1K、2K 分辨率。" : "1080P、2K、4K 会结合画幅比例计算实际像素。"}>分辨率</ImageParameterLabel>
            <div className={cn("grid gap-1 rounded-lg bg-muted p-1", resolutionOptions.length === 5 ? "grid-cols-5" : resolutionOptions.length === 3 ? "grid-cols-3" : "grid-cols-4")}>
              {resolutionOptions.map((option) => {
                const active = selectedResolution === option.value;
                return <button key={option.value} type="button" className={imageParameterChoiceClass(active, "h-7")} onClick={() => updateSize(selectedAspectRatio || "1:1", option.value)}>{option.label}</button>;
              })}
            </div>
          </section> : null}

          <section className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <ImageParameterLabel help={`当前模型单次请求支持 1-${countLimit} 张图片。`}>生成数量</ImageParameterLabel>
            <div className="grid h-8 grid-cols-[2rem_3.25rem_2rem] overflow-hidden rounded-lg border border-border bg-background">
              <button type="button" disabled={count <= 1} className="grid place-items-center hover:bg-muted disabled:opacity-35" onClick={() => onChange({ generation_count: count - 1 })}><Minus className="size-3.5" /></button>
              <span className="grid place-items-center border-x border-border text-xs font-semibold">{count} 张</span>
              <button type="button" disabled={count >= countLimit} className="grid place-items-center hover:bg-muted disabled:opacity-35" onClick={() => onChange({ generation_count: count + 1 })}><Plus className="size-3.5" /></button>
            </div>
          </section>

          {streamingSupported || outputControlsSupported ? <div className="border-t border-border pt-2.5">
            <div className="space-y-3">
              {streamingSupported ? <div className="flex h-9 items-center justify-between rounded-lg bg-muted px-2.5">
                <ImageParameterLabel help="开启后使用流式图片响应。">流式返回</ImageParameterLabel>
                <Switch checked={stream} aria-label="启用流式生成" onCheckedChange={(enabled) => onChange({ generation_stream: enabled, ...(!enabled ? { generation_partial_images: 0 } : {}) })} />
              </div> : null}
              {streamingSupported && stream ? <section className="space-y-1.5"><ImageParameterLabel help="返回 0-3 张生成过程中的中间图。">中间图数量</ImageParameterLabel><div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">{[0, 1, 2, 3].map((value) => <button key={value} type="button" className={imageParameterChoiceClass(partialImages === value, "h-7")} onClick={() => onChange({ generation_partial_images: value })}>{value} 张</button>)}</div></section> : null}
              {outputControlsSupported ? <section className="space-y-1.5">
                <ImageParameterLabel help="支持 PNG、JPEG 和 WebP。">输出格式</ImageParameterLabel>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">{IMAGE_OUTPUT_FORMAT_OPTIONS.map((option) => <button key={option.value} type="button" className={imageParameterChoiceClass(outputFormat === option.value, "h-7 uppercase")} onClick={() => onChange({ generation_output_format: option.value, ...(!supportsImageOutputCompression(option.value) ? { generation_output_compression: undefined } : {}) })}>{option.label}</button>)}</div>
              </section> : null}
              {outputControlsSupported && supportsImageOutputCompression(outputFormat) ? <section className="space-y-1.5"><div className="flex items-center justify-between"><ImageParameterLabel help="JPEG 和 WebP 的压缩范围为 0-100。">压缩率</ImageParameterLabel><span className="text-xs text-muted-foreground">{outputCompression ?? "默认"}</span></div><div className="grid grid-cols-[1fr_4rem] items-center gap-2"><Slider min="0" max="100" value={outputCompression ?? 100} onChange={(event) => onChange({ generation_output_compression: Number(event.target.value) })} /><Input type="number" min="0" max="100" value={outputCompression ?? ""} placeholder="默认" className="h-8 text-center text-xs" onChange={(event) => onChange({ generation_output_compression: event.target.value === "" ? undefined : Math.max(0, Math.min(100, Number(event.target.value))) })} /></div></section> : null}
            </div>
          </div> : null}
        </div>
        </ScrollArea>,
        document.body,
      ) : null}
    </>
  );
}
