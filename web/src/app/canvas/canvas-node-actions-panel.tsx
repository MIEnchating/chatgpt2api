import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Brush,
  Camera,
  MoreHorizontal,
  Download,
  Eye,
  FileText,
  FolderPlus,
  Grid2X2,
  ImagePlus,
  Lock,
  LockOpen,
  Music,
  Scissors,
  Upload,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/services/api/canvas";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type CanvasImageOperation = "mask" | "crop" | "split" | "upscale" | "angle";
export type CanvasMediaOperation = "frame-first" | "frame-last" | "frame-current" | "extract-audio" | "trim-audio";

export function CanvasNodeQuickActions({
  node,
  busy,
  uploading,
  onUpload,
  imageEditingSupported,
  onImageOperation,
  onDownload,
  onPreview,
  onReversePrompt,
  onSaveAsset,
  onToggleFreeResize,
  onTextToImage,
  onOpenDirector,
  onMediaOperation,
}: {
  node: CanvasNode;
  busy: boolean;
  uploading: boolean;
  onUpload: () => void;
  imageEditingSupported: boolean;
  onImageOperation: (operation: CanvasImageOperation) => void;
  onDownload: () => void;
  onPreview: () => void;
  onReversePrompt: () => void;
  onSaveAsset: () => void;
  onToggleFreeResize: () => void;
  onTextToImage: () => void;
  onOpenDirector: () => void;
  onMediaOperation: (operation: CanvasMediaOperation) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const actionClosedRef = useRef(false);
  type QuickAction = { key: string; label: string; icon: LucideIcon; disabled?: boolean; onClick: () => void };
  const hasMedia = Boolean(node.url);
  const hasPrompt = Boolean((node.type === "panorama" ? node.panorama_source_prompt || node.prompt : node.prompt)?.trim());
  const imageLike = node.type === "image" || node.type === "panorama";
  const groups: QuickAction[][] = [];
  const moreActions: QuickAction[] = [];

  if (imageLike && hasMedia) {
    moreActions.push({ key: "split", label: "切图", icon: Grid2X2, disabled: busy, onClick: () => onImageOperation("split") });
    moreActions.push({ key: "resize", label: node.free_resize ? "锁定比例" : "自由缩放", icon: node.free_resize ? Lock : LockOpen, onClick: onToggleFreeResize });
    moreActions.push({ key: "reverse-prompt", label: "反推提示词", icon: FileText, onClick: onReversePrompt });
    groups.push([
      { key: "mask", label: "局部编辑", icon: Brush, disabled: busy || !imageEditingSupported, onClick: () => onImageOperation("mask") },
      { key: "crop", label: "裁剪", icon: Scissors, disabled: busy, onClick: () => onImageOperation("crop") },
      { key: "upscale", label: "放大", icon: ZoomIn, disabled: busy, onClick: () => onImageOperation("upscale") },
      { key: "angle", label: "多角度", icon: Camera, disabled: busy || !imageEditingSupported, onClick: () => onImageOperation("angle") },
    ]);
    groups.push([
      { key: "save-asset", label: "存入我的素材", icon: FolderPlus, onClick: onSaveAsset },
    ]);
  } else if (node.type === "video" && hasMedia) {
    moreActions.push({ key: "first-frame", label: "截取首帧", icon: Camera, disabled: busy, onClick: () => onMediaOperation("frame-first") });
    moreActions.push({ key: "last-frame", label: "截取尾帧", icon: Camera, disabled: busy, onClick: () => onMediaOperation("frame-last") });
    groups.push([
      { key: "current-frame", label: "截取当前帧", icon: Camera, disabled: busy, onClick: () => onMediaOperation("frame-current") },
      { key: "extract-audio", label: "分离音频", icon: Music, disabled: busy, onClick: () => onMediaOperation("extract-audio") },
    ]);
    groups.push([
      { key: "save-asset", label: "存入我的素材", icon: FolderPlus, onClick: onSaveAsset },
    ]);
  } else if (node.type === "audio" && hasMedia) {
    groups.push([
      { key: "trim-audio", label: "截取音频", icon: Scissors, disabled: busy, onClick: () => onMediaOperation("trim-audio") },
      { key: "save-asset", label: "存入我的素材", icon: FolderPlus, onClick: onSaveAsset },
    ]);
  } else if (node.type === "text") {
    groups.push([
      { key: "text-to-image", label: "生成图片", icon: ImagePlus, disabled: !hasPrompt, onClick: onTextToImage },
      { key: "save-asset", label: "存入我的素材", icon: FolderPlus, disabled: !hasPrompt, onClick: onSaveAsset },
    ]);
  } else if (node.type === "director") {
    groups.push([
      { key: "open-director", label: "打开导演台", icon: Camera, onClick: onOpenDirector },
    ]);
  }

  if (node.type === "image" || node.type === "video") {
    const upload: QuickAction = { key: "upload", label: uploading ? "上传中" : hasMedia ? (node.type === "video" ? "替换视频" : "替换图片") : (node.type === "video" ? "上传视频" : "上传图片"), icon: Upload, disabled: busy || uploading, onClick: onUpload };
    if (hasMedia) moreActions.push(upload);
    else groups.push([upload]);
  }
  const visibleGroups = groups.filter((group) => group.length > 0);
  if (!visibleGroups.length) return null;
  return (
    <div data-canvas-node-quick-actions aria-label="节点快捷操作" className="flex max-w-full items-center gap-1 rounded-xl border border-border bg-card/96 p-1.5 shadow-[var(--shadow-elevated)] backdrop-blur-xl">
      <ScrollArea className="min-w-0 flex-1" viewClass="flex w-max min-w-full items-center gap-1" viewportClassName="overscroll-contain">
        {visibleGroups.map((actions, index) => <div key={actions[0].key} className={cn("flex shrink-0 items-center gap-0.5", index > 0 && "border-l border-border/70 pl-1")}>
          {actions.map(({ key, label, icon: Icon, disabled, onClick }) => <Tooltip key={key}>
            <TooltipTrigger asChild><button type="button" aria-label={label} disabled={disabled} className="flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35" onClick={onClick}><Icon className="size-4" />{key !== "save-asset" && label}</button></TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>)}
        </div>)}
      </ScrollArea>
      {moreActions.length ? <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <PopoverTrigger asChild><button type="button" aria-label="更多节点操作" title="更多操作" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><MoreHorizontal className="size-4" /></button></PopoverTrigger>
        <PopoverContent data-canvas-no-pan side="bottom" align="end" aria-label="节点操作" className="w-48 p-1" onCloseAutoFocus={(event) => {
          if (!actionClosedRef.current) return;
          event.preventDefault();
          actionClosedRef.current = false;
        }} onClick={(event) => {
          if (!(event.target instanceof Element) || !event.target.closest("button:not(:disabled)")) return;
          actionClosedRef.current = true;
          setMoreOpen(false);
        }}>{moreActions.map(({ key, label, icon: Icon, disabled, onClick }) => <button key={key} type="button" aria-label={label} disabled={disabled} onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-35"><Icon className="size-4 shrink-0 text-muted-foreground" />{label}</button>)}</PopoverContent>
      </Popover> : null}
      {(imageLike || node.type === "video" || node.type === "audio" ? hasMedia : node.type === "text") ? <div className="flex shrink-0 items-center gap-0.5 border-l border-border/70 pl-1.5">
        {(imageLike || node.type === "video") && hasMedia ? <Tooltip>
          <TooltipTrigger asChild><button type="button" aria-label="预览" onClick={onPreview} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Eye className="size-4" /></button></TooltipTrigger>
          <TooltipContent side="bottom">预览</TooltipContent>
        </Tooltip> : null}
        <Tooltip>
          <TooltipTrigger asChild><button type="button" aria-label="下载" disabled={node.type === "text" && !hasPrompt} onClick={onDownload} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35"><Download className="size-4" /></button></TooltipTrigger>
          <TooltipContent side="bottom">{node.type === "text" ? "下载文字" : "下载"}</TooltipContent>
        </Tooltip>
      </div> : null}
    </div>
  );
}
