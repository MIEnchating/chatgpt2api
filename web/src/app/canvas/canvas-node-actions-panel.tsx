import {
  Brush,
  Camera,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileText,
  FolderPlus,
  Grid2X2,
  ImagePlus,
  Lock,
  LockOpen,
  Maximize2,
  Music,
  Scissors,
  Upload,
  Video,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/services/api/canvas";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type CanvasImageOperation = "mask" | "crop" | "split" | "upscale" | "angle";

type CanvasNodeActionsPanelProps = {
  node: CanvasNode;
  running: boolean;
  busy: boolean;
  uploading: boolean;
  imageEditingSupported: boolean;
  onUpload: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onCopyPrompt: () => void;
  onReversePrompt: () => void;
  onSaveAsset: () => void;
  onDuplicate: () => void;
  onToggleFreeResize: () => void;
  onImageOperation: (operation: CanvasImageOperation) => void;
  onTextToImage: () => void;
  onOpenDirector: () => void;
};

export function CanvasNodeActionsPanel({
  node,
  running,
  busy,
  uploading,
  imageEditingSupported,
  onUpload,
  onPreview,
  onDownload,
  onCopyPrompt,
  onReversePrompt,
  onSaveAsset,
  onDuplicate,
  onToggleFreeResize,
  onImageOperation,
  onTextToImage,
  onOpenDirector,
}: CanvasNodeActionsPanelProps) {
  const hasMedia = Boolean(node.url);
  const hasPrompt = Boolean((node.type === "panorama" ? node.panorama_source_prompt || node.prompt : node.prompt)?.trim());
  const imageLike = node.type === "image" || node.type === "panorama";
  const downloadable = hasMedia && (imageLike || node.type === "video" || node.type === "audio");
  const saveable = node.type === "text" ? hasPrompt : downloadable;
  const replaceLabel = node.type === "video"
    ? hasMedia ? "替换视频" : "上传视频"
    : node.type === "audio"
      ? hasMedia ? "替换音频" : "上传音频"
      : node.type === "panorama"
        ? hasMedia ? "替换全景图" : "上传全景图"
        : hasMedia ? "替换图片" : "上传图片";

  return (
    <div className="space-y-5 pb-2">
      {node.type === "director" ? (
        <ActionSection title="导演台">
          <ActionButton icon={Camera} label="打开导演台" description="进入场景搭建、截图与视频录制" primary onClick={onOpenDirector} />
        </ActionSection>
      ) : null}

      {node.type === "text" ? (
        <ActionSection title="文字操作">
          <ActionButton icon={ImagePlus} label="生成图片" description="用当前文字创建并连接生成配置" disabled={!hasPrompt} primary onClick={onTextToImage} />
          <ActionButton icon={Copy} label="复制文字" description="复制当前文字内容" disabled={!hasPrompt} onClick={onCopyPrompt} />
        </ActionSection>
      ) : null}

      {imageLike && hasMedia ? (
        <ActionSection title="图片编辑">
          <ActionButton icon={Brush} label="局部编辑" description={imageEditingSupported ? "涂抹区域并用 AI 定向修改" : "当前图片模型不支持参考图编辑"} disabled={!imageEditingSupported || busy} onClick={() => onImageOperation("mask")} />
          <ActionButton icon={Scissors} label="裁剪" description="裁剪后生成独立图片节点" disabled={busy} onClick={() => onImageOperation("crop")} />
          <ActionButton icon={Grid2X2} label="切图" description="按行列切分并连接子节点" disabled={busy} onClick={() => onImageOperation("split")} />
          <ActionButton icon={ZoomIn} label="放大" description="提升分辨率并保留原节点" disabled={busy} onClick={() => onImageOperation("upscale")} />
          <ActionButton icon={Camera} label="多角度" description="基于原图生成同一主体新视角" disabled={!imageEditingSupported || busy} onClick={() => onImageOperation("angle")} />
          <ActionButton icon={node.free_resize ? Lock : LockOpen} label={node.free_resize ? "锁定比例" : "自由缩放"} description={node.free_resize ? "恢复等比例缩放" : "允许自由调整宽高"} onClick={onToggleFreeResize} />
        </ActionSection>
      ) : null}

      {imageLike && hasMedia ? (
        <ActionSection title="提示词">
          <ActionButton icon={Copy} label="复制提示词" description="复制生成该图片的提示词" disabled={!hasPrompt} onClick={onCopyPrompt} />
          <ActionButton icon={FileText} label="反推提示词" description="创建文字和文本生成配置节点" onClick={onReversePrompt} />
        </ActionSection>
      ) : null}

      {(imageLike || node.type === "video" || node.type === "audio") ? (
        <ActionSection title="素材">
          <ActionButton icon={node.type === "video" ? Video : node.type === "audio" ? Music : Upload} label={uploading ? "上传中" : replaceLabel} description="从本地选择文件并写入当前节点" disabled={uploading || running} onClick={onUpload} />
          {hasMedia && node.type !== "audio" ? <ActionButton icon={Maximize2} label={node.type === "panorama" ? "沉浸查看" : node.type === "video" ? "预览视频" : "查看大图"} description="打开全屏预览" onClick={onPreview} /> : null}
          {downloadable ? <ActionButton icon={Download} label="下载" description="下载当前节点文件" onClick={onDownload} /> : null}
          {saveable ? <ActionButton icon={FolderPlus} label="存入我的素材" description="保存并同步到当前账号" onClick={onSaveAsset} /> : null}
        </ActionSection>
      ) : node.type === "text" && saveable ? (
        <ActionSection title="素材">
          <ActionButton icon={FolderPlus} label="存入我的素材" description="保存并同步到当前账号" onClick={onSaveAsset} />
        </ActionSection>
      ) : null}

      <ActionSection title="节点">
        <ActionButton icon={Copy} label="复制节点" description="复制节点内容和参数" onClick={onDuplicate} />
      </ActionSection>
    </div>
  );
}

export function CanvasNodeQuickActions({
  node,
  busy,
  imageEditingSupported,
  onImageOperation,
  onPreview,
  onDownload,
  onCopyPrompt,
  onReversePrompt,
  onSaveAsset,
  onDuplicate,
  onToggleFreeResize,
  onTextToImage,
  onOpenDirector,
}: {
  node: CanvasNode;
  busy: boolean;
  imageEditingSupported: boolean;
  onImageOperation: (operation: CanvasImageOperation) => void;
  onPreview: () => void;
  onDownload: () => void;
  onCopyPrompt: () => void;
  onReversePrompt: () => void;
  onSaveAsset: () => void;
  onDuplicate: () => void;
  onToggleFreeResize: () => void;
  onTextToImage: () => void;
  onOpenDirector: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  type QuickAction = { key: string; label: string; icon: LucideIcon; disabled?: boolean; onClick: () => void };
  const hasMedia = Boolean(node.url);
  const hasPrompt = Boolean((node.type === "panorama" ? node.panorama_source_prompt || node.prompt : node.prompt)?.trim());
  const imageLike = node.type === "image" || node.type === "panorama";
  const groups: QuickAction[][] = [];

  if (imageLike && hasMedia) {
    groups.push([
      { key: "preview", label: node.type === "panorama" ? "沉浸查看" : "查看大图", icon: Maximize2, onClick: onPreview },
    ]);
    groups.push([
      { key: "mask", label: "局部编辑", icon: Brush, disabled: busy || !imageEditingSupported, onClick: () => onImageOperation("mask") },
      { key: "crop", label: "裁剪", icon: Scissors, disabled: busy, onClick: () => onImageOperation("crop") },
      { key: "split", label: "切图", icon: Grid2X2, disabled: busy, onClick: () => onImageOperation("split") },
      { key: "upscale", label: "放大", icon: ZoomIn, disabled: busy, onClick: () => onImageOperation("upscale") },
      { key: "angle", label: "多角度", icon: Camera, disabled: busy || !imageEditingSupported, onClick: () => onImageOperation("angle") },
      { key: "resize", label: node.free_resize ? "锁定比例" : "自由缩放", icon: node.free_resize ? Lock : LockOpen, onClick: onToggleFreeResize },
    ]);
    groups.push([
      { key: "copy-prompt", label: "复制提示词", icon: Copy, disabled: !hasPrompt, onClick: onCopyPrompt },
      { key: "reverse-prompt", label: "反推提示词", icon: FileText, onClick: onReversePrompt },
    ]);
    groups.push([
      { key: "download", label: "下载", icon: Download, onClick: onDownload },
      { key: "save-asset", label: "存入我的素材", icon: FolderPlus, onClick: onSaveAsset },
    ]);
  } else if (node.type === "video" && hasMedia) {
    groups.push([
      { key: "preview", label: "预览视频", icon: Maximize2, onClick: onPreview },
      { key: "download", label: "下载", icon: Download, onClick: onDownload },
      { key: "save-asset", label: "存入我的素材", icon: FolderPlus, onClick: onSaveAsset },
    ]);
  } else if (node.type === "audio" && hasMedia) {
    groups.push([
      { key: "download", label: "下载", icon: Download, onClick: onDownload },
      { key: "save-asset", label: "存入我的素材", icon: FolderPlus, onClick: onSaveAsset },
    ]);
  } else if (node.type === "text") {
    groups.push([
      { key: "text-to-image", label: "生成图片", icon: ImagePlus, disabled: !hasPrompt, onClick: onTextToImage },
      { key: "copy-text", label: "复制文字", icon: Copy, disabled: !hasPrompt, onClick: onCopyPrompt },
      { key: "save-asset", label: "存入我的素材", icon: FolderPlus, disabled: !hasPrompt, onClick: onSaveAsset },
    ]);
  } else if (node.type === "director") {
    groups.push([
      { key: "open-director", label: "打开导演台", icon: Camera, onClick: onOpenDirector },
    ]);
  }

  if (node.type !== "group") {
    groups.push([{ key: "duplicate", label: "复制节点", icon: Copy, onClick: onDuplicate }]);
  }
  const visibleGroups = groups.filter((group) => group.length > 0);
  if (!visibleGroups.length) return null;
  const quickActionIndexByKey = new Map(
    visibleGroups.flat().map((action, index) => [action.key, index]),
  );
  const quickActionCount = quickActionIndexByKey.size;

  return (
    <div data-canvas-node-quick-actions data-collapsed={collapsed || undefined} className="flex max-h-[calc(100vh-9rem)] flex-col overflow-y-auto rounded-xl border border-border bg-card/96 p-1.5 shadow-[0_12px_32px_rgba(15,23,42,.18)] backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={collapsed ? "展开工具栏" : "收起工具栏"}
            aria-expanded={!collapsed}
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-[color,background-color,box-shadow,transform] duration-200 ease-in-out hover:scale-105 hover:bg-muted hover:text-foreground active:scale-90",
              collapsed && "bg-muted/70 text-foreground shadow-inner",
            )}
            onClick={() => setCollapsed((value) => !value)}
          >
            <span className="relative size-4">
              <ChevronUp className={cn("absolute inset-0 size-4 transition-[opacity,transform] duration-200 ease-in-out", collapsed ? "-translate-y-1 scale-75 opacity-0" : "translate-y-0 scale-100 opacity-100")} />
              <ChevronDown className={cn("absolute inset-0 size-4 transition-[opacity,transform] duration-200 ease-in-out", collapsed ? "translate-y-0 scale-100 opacity-100" : "translate-y-1 scale-75 opacity-0")} />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{collapsed ? "展开工具栏" : "收起工具栏"}</TooltipContent>
      </Tooltip>
      <div inert={collapsed} aria-hidden={collapsed} className={cn("grid transition-[grid-template-rows,transform] duration-300 ease-in-out", collapsed ? "pointer-events-none grid-rows-[0fr] -translate-y-1" : "grid-rows-[1fr] translate-y-0")}>
        <div className="min-h-0 overflow-hidden">
          {visibleGroups.map((actions) => (
            <div key={actions[0].key} className="mt-1 flex flex-col gap-1 border-t border-border/70 pt-1">
              {actions.map(({ key, label, icon: Icon, disabled, onClick }) => {
                const actionIndex = quickActionIndexByKey.get(key) || 0;
                return (
                  <div
                    key={key}
                    className={cn(
                      "size-9 transition-[opacity,transform] duration-150 ease-in-out",
                      collapsed ? "translate-y-1 scale-90 opacity-0" : "translate-y-0 scale-100 opacity-100",
                    )}
                    style={{
                      transitionDelay: collapsed
                        ? `${Math.max(0, quickActionCount - 1 - actionIndex) * 14}ms`
                        : `${40 + actionIndex * 18}ms`,
                    }}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" aria-label={label} disabled={disabled} className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35" onClick={onClick}><Icon className="size-4" /></button>
                      </TooltipTrigger>
                      <TooltipContent side="left">{label}</TooltipContent>
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActionSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function ActionButton({ icon: Icon, label, description, primary = false, disabled = false, onClick }: {
  icon: LucideIcon;
  label: string;
  description: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "group flex min-h-16 min-w-0 items-start gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left transition hover:border-[#9bb8f8] hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-45",
        primary && "border-[#bfd1ff] bg-[#edf3ff] dark:border-blue-900 dark:bg-blue-950/35",
      )}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground", primary && "bg-[#1456f0] text-white")}><Icon className="size-4" /></span>
      <span className="min-w-0">
        <strong className="block text-xs font-semibold text-foreground">{label}</strong>
        <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
