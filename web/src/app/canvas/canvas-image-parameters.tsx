import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import { defaultCanvasImageParameters } from "@/app/canvas/canvas-image-parameter-defaults";
import { canvasFloatingPanelPlacement } from "@/app/canvas/canvas-floating-panel";
import {
  buildImageSize,
  formatImageSizeDisplay,
  getImageSizeSelectionFromSize,
} from "@/lib/image-options";
import {
  ImageSettingsPanel,
  type ImageSettingsValue,
} from "@/components/generation/image-settings-panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { imageOutputCountLimit } from "@/lib/api";
import type { CanvasNode } from "@/services/api/canvas";
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
  | "generation_snap_to_multiple_16"
  | "generation_model"
>>;

export function CanvasImageParameterPopover({ node, imageModel, imageModels = [], onChange, expanded = false, showModel = true, showSize = true }: { node: CanvasNode; imageModel: string; imageModels?: string[]; onChange: (patch: CanvasImageParameterPatch) => void; expanded?: boolean; showModel?: boolean; showSize?: boolean }) {
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
  const selectedModel = node.generation_model?.trim() || imageModel;
  const modelOptions = Array.from(new Set([selectedModel, ...imageModels, imageModel].filter(Boolean)));
	const countLimit = imageOutputCountLimit(selectedModel);
  const count = Math.max(1, Math.min(countLimit, node.generation_count ?? defaults.generation_count ?? 1));
  const snapToMultiple16 = node.generation_snap_to_multiple_16 ?? defaults.generation_snap_to_multiple_16 ?? true;
  const calculatedSize = buildImageSize(selection, { snapToMultiple16 });
  const sizeLabel = selection.mode !== "auto" && calculatedSize ? formatImageSizeDisplay(calculatedSize) : "自动";
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

  const settingsValue: ImageSettingsValue = {
    ...selection,
    snapToMultiple16,
    quality,
    count,
  };

  function updateSettings(patch: Partial<ImageSettingsValue>) {
    const next = { ...settingsValue, ...patch };
    const nextSize = buildImageSize(next, { snapToMultiple16: next.snapToMultiple16 });
    onChange({
      generation_size: next.mode === "auto" ? "" : nextSize,
      generation_resolution: next.resolution,
      generation_quality: next.quality || undefined,
      generation_count: next.count,
      generation_snap_to_multiple_16: next.snapToMultiple16,
    });
  }

  const parameterFields = (
    <div className="flex flex-col gap-3.5">
      {showModel ? <section className="order-0 space-y-1.5">
        <ImageParameterLabel help="选择当前图片节点使用的生成模型。">模型</ImageParameterLabel>
        <Select value={selectedModel || undefined} onValueChange={(value) => onChange({ generation_model: value })}>
          <SelectTrigger className="h-9 rounded-lg px-2.5 text-xs shadow-none"><SelectValue placeholder="选择模型" /></SelectTrigger>
          <SelectContent>{modelOptions.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
        </Select>
      </section> : null}
      <ImageSettingsPanel model={selectedModel} value={settingsValue} onChange={updateSettings} showSize={showSize} />
    </div>
  );

  if (expanded) {
    return (
      <section className="space-y-3 border-t border-border/80 pt-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-foreground">生成参数</h3>
          <span className="text-[11px] text-muted-foreground">{showSize ? `${sizeLabel} · ` : ""}{count} 张</span>
        </div>
        {parameterFields}
      </section>
    );
  }

  return (
    <>
      <span ref={buttonRef} className="inline-flex">
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-expanded={open} aria-label="打开图片参数" className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border/70 bg-background/75 px-2.5 text-xs font-medium text-foreground shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-border hover:bg-background", open && "border-[#bfd1ff] bg-[#eaf1ff] text-[#1456f0]")} onClick={() => setOpen((value) => !value)}>
              <SlidersHorizontal className="size-3.5 text-[#1456f0]" />
              <span className="font-semibold">{sizeLabel}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{count} 张</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>图片参数</TooltipContent>
        </Tooltip>
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
        <div className="p-3 pr-4">{parameterFields}</div>
        </ScrollArea>,
        document.body,
      ) : null}
    </>
  );
}
