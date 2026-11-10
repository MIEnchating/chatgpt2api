import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
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
import { useRef } from "react";

import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/services/api/canvas";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
    <Card data-canvas-node-quick-actions aria-label="节点快捷操作" className="flex max-w-full items-center gap-1 p-1.5 flex-row">
      <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden flex-1" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0 flex w-max min-w-full items-center gap-1">
        {visibleGroups.map((actions, index) => <div key={actions[0].key} className={cn("flex shrink-0 items-center gap-0.5", index > 0 && "border-l border-border/70 pl-1")}>
          {actions.map(({ key, label, icon: Icon, disabled, onClick }) => <Tooltip key={key}>
            <TooltipTrigger asChild><Button variant="ghost" type="button" aria-label={label} disabled={disabled} className="flex shrink-0 items-center justify-center whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-35" onClick={onClick}><Icon  />{key !== "save-asset" && label}</Button></TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>)}
        </div>)}
      </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
      {moreActions.length ? <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" type="button" aria-label="更多节点操作" className="grid shrink-0 place-items-center"><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent data-canvas-no-pan side="bottom" align="end" aria-label="节点操作" collisionPadding={8} className="w-48" onCloseAutoFocus={(event) => {
          if (!actionClosedRef.current) return;
          event.preventDefault();
          actionClosedRef.current = false;
        }}>
          {moreActions.map(({ key, label, icon: Icon, disabled, onClick }) => <DropdownMenuItem key={key} disabled={disabled} onSelect={() => {
            actionClosedRef.current = true;
            onClick();
          }}><Icon />{label}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu> : null}
      {(imageLike || node.type === "video" || node.type === "audio" ? hasMedia : node.type === "text") ? <div className="flex shrink-0 items-center gap-0.5 border-l border-border/70 pl-1.5">
        {(imageLike || node.type === "video") && hasMedia ? <Tooltip>
          <TooltipTrigger asChild><Button variant="ghost" size="icon-sm" type="button" aria-label="预览" onClick={onPreview} className="grid place-items-center"><Eye  /></Button></TooltipTrigger>
          <TooltipContent side="bottom">预览</TooltipContent>
        </Tooltip> : null}
        <Tooltip>
          <TooltipTrigger asChild><Button variant="ghost" size="icon-sm" type="button" aria-label="下载" disabled={node.type === "text" && !hasPrompt} onClick={onDownload} className="grid place-items-center disabled:cursor-not-allowed disabled:opacity-35"><Download  /></Button></TooltipTrigger>
          <TooltipContent side="bottom">{node.type === "text" ? "下载文字" : "下载"}</TooltipContent>
        </Tooltip>
      </div> : null}
    </Card>
  );
}
