import { ChevronDown, Minus, Plus, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ImageAspectRatioGlyph, ImageParameterLabel } from "@/app/image/components/image-parameter-ui";
import { imageParameterChoiceClass } from "@/app/image/components/image-parameter-styles";
import { defaultCanvasImageParameters } from "@/app/canvas/canvas-image-parameter-defaults";
import { canvasFloatingPanelPlacement } from "@/app/canvas/canvas-floating-panel";
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  IMAGE_RESOLUTION_OPTIONS,
  buildImageSize,
  formatImageSizeDisplay,
  getImageSizeSelectionFromSize,
} from "@/app/image/image-options";
import { Input } from "@/components/ui/input";
import {
  IMAGE_OUTPUT_FORMAT_OPTIONS,
  supportsImageOutputCompression,
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

export function CanvasImageParameterPopover({ node, onChange }: { node: CanvasNode; onChange: (patch: CanvasImageParameterPatch) => void }) {
  const buttonRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const defaults = defaultCanvasImageParameters();
  const size = node.generation_size ?? defaults.generation_size ?? "";
  const selection = getImageSizeSelectionFromSize(size);
  const quality = node.generation_quality ?? defaults.generation_quality ?? "";
  const count = Math.max(1, Math.min(10, node.generation_count ?? defaults.generation_count ?? 1));
  const outputFormat = node.generation_output_format ?? defaults.generation_output_format ?? "png";
  const outputCompression = node.generation_output_compression ?? defaults.generation_output_compression;
  const stream = node.generation_stream ?? defaults.generation_stream ?? true;
  const partialImages = Math.max(0, Math.min(3, node.generation_partial_images ?? defaults.generation_partial_images ?? 0));
  const sizeLabel = size ? formatImageSizeDisplay(size) : "自动";
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
    onChange({ generation_size: buildImageSize(nextSelection), generation_resolution: resolution });
  }

  return (
    <>
      <span ref={buttonRef} className="inline-flex">
        <button type="button" className={cn("inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground", open && "border-[#bfd1ff] bg-[#eef4ff] text-[#1456f0]")} onClick={() => setOpen((value) => !value)}>
          <SlidersHorizontal className="size-3.5" />
          <span>{sizeLabel}</span>
          <span className="text-border">·</span>
          <span>{count} 张</span>
        </button>
      </span>
      {open && buttonRect && panelPlacement ? createPortal(
        <div
          ref={panelRef}
          data-canvas-parameter-panel
          className="fixed z-[1200] overflow-y-auto rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-[0_18px_54px_rgba(15,23,42,.18)]"
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
        <div className="space-y-3.5">
          <section className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <ImageParameterLabel help="选择画幅比例，系统会自动换算为合法像素尺寸。">画幅比例</ImageParameterLabel>
              <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{sizeLabel}</span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {IMAGE_ASPECT_RATIO_OPTIONS.filter((option) => option.value !== "custom").map((option) => {
                const active = option.value ? selection.mode === "ratio" && selection.aspectRatio === option.value : selection.mode === "auto";
                return <button key={option.value || "auto"} type="button" className={cn("flex h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-border bg-muted/45 px-1 text-[10px] font-medium text-muted-foreground transition hover:bg-background hover:text-foreground", active && "border-[#bfd1ff] bg-[#eef4ff] text-[#1456f0]")} onClick={() => updateSize(option.value, option.value ? selection.resolution : "auto")}>{option.value ? <ImageAspectRatioGlyph ratio={option.value} /> : <SlidersHorizontal className="size-3.5" />}<span>{option.value || "自动"}</span></button>;
              })}
            </div>
          </section>

          <section className="space-y-1.5">
            <ImageParameterLabel help="质量越高，生成时间和费用通常越高。">质量</ImageParameterLabel>
            <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
              {[{ value: "", label: "自动" }, ...IMAGE_QUALITY_OPTIONS].map((option) => <button key={option.value || "auto"} type="button" className={imageParameterChoiceClass(quality === option.value, "h-7")} onClick={() => onChange({ generation_quality: (option.value || undefined) as ImageQuality | undefined })}>{option.label}</button>)}
            </div>
          </section>

          <section className="space-y-1.5">
            <ImageParameterLabel help="1080P、2K、4K 会结合画幅比例计算实际像素。">分辨率</ImageParameterLabel>
            <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
              {IMAGE_RESOLUTION_OPTIONS.map((option) => {
                const active = selection.resolution === option.value;
                return <button key={option.value} type="button" className={imageParameterChoiceClass(active, "h-7")} onClick={() => updateSize(selection.aspectRatio || "1:1", option.value)}>{option.label}</button>;
              })}
            </div>
          </section>

          <section className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <ImageParameterLabel help="单次请求可生成 1-10 张图片。">生成数量</ImageParameterLabel>
            <div className="grid h-8 grid-cols-[2rem_3.25rem_2rem] overflow-hidden rounded-lg border border-border bg-background">
              <button type="button" disabled={count <= 1} className="grid place-items-center hover:bg-muted disabled:opacity-35" onClick={() => onChange({ generation_count: count - 1 })}><Minus className="size-3.5" /></button>
              <span className="grid place-items-center border-x border-border text-xs font-semibold">{count} 张</span>
              <button type="button" disabled={count >= 10} className="grid place-items-center hover:bg-muted disabled:opacity-35" onClick={() => onChange({ generation_count: count + 1 })}><Plus className="size-3.5" /></button>
            </div>
          </section>

          <details className="group border-t border-border pt-2.5">
            <summary className="flex h-8 cursor-pointer list-none items-center justify-between rounded-lg px-2 text-xs font-semibold hover:bg-muted [&::-webkit-details-marker]:hidden"><span>高级设置</span><ChevronDown className="size-3.5 transition group-open:rotate-180" /></summary>
            <div className="mt-2 space-y-3">
              <div className="flex h-9 items-center justify-between rounded-lg bg-muted px-2.5">
                <ImageParameterLabel help="开启后使用流式图片响应。">流式返回</ImageParameterLabel>
                <button type="button" role="switch" aria-checked={stream} className={cn("relative inline-flex h-5 w-9 rounded-full transition", stream ? "bg-[#1456f0]" : "bg-muted-foreground/35")} onClick={() => onChange({ generation_stream: !stream, ...(!stream ? {} : { generation_partial_images: 0 }) })}><span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform", stream ? "translate-x-[18px]" : "translate-x-0.5")} /></button>
              </div>
              {stream ? <section className="space-y-1.5"><ImageParameterLabel help="返回 0-3 张生成过程中的中间图。">中间图数量</ImageParameterLabel><div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">{[0, 1, 2, 3].map((value) => <button key={value} type="button" className={imageParameterChoiceClass(partialImages === value, "h-7")} onClick={() => onChange({ generation_partial_images: value })}>{value} 张</button>)}</div></section> : null}
              <section className="space-y-1.5">
                <ImageParameterLabel help="支持 PNG、JPEG 和 WebP。">输出格式</ImageParameterLabel>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">{IMAGE_OUTPUT_FORMAT_OPTIONS.map((option) => <button key={option.value} type="button" className={imageParameterChoiceClass(outputFormat === option.value, "h-7 uppercase")} onClick={() => onChange({ generation_output_format: option.value, ...(!supportsImageOutputCompression(option.value) ? { generation_output_compression: undefined } : {}) })}>{option.label}</button>)}</div>
              </section>
              {supportsImageOutputCompression(outputFormat) ? <section className="space-y-1.5"><div className="flex items-center justify-between"><ImageParameterLabel help="JPEG 和 WebP 的压缩范围为 0-100。">压缩率</ImageParameterLabel><span className="text-xs text-muted-foreground">{outputCompression ?? "默认"}</span></div><div className="grid grid-cols-[1fr_4rem] gap-2"><input type="range" min="0" max="100" value={outputCompression ?? 100} className="accent-[#1456f0]" onChange={(event) => onChange({ generation_output_compression: Number(event.target.value) })} /><Input type="number" min="0" max="100" value={outputCompression ?? ""} placeholder="默认" className="h-8 text-center text-xs" onChange={(event) => onChange({ generation_output_compression: event.target.value === "" ? undefined : Math.max(0, Math.min(100, Number(event.target.value))) })} /></div></section> : null}
            </div>
          </details>
        </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
