import { Camera, CircleHelp, Compass, Focus, FolderOpen, Hand, ImagePlus, LoaderCircle, Map, Minus, Music, Plus, Redo2, Settings2, Trash2, Type, Undo2, Upload, Video, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from "@/app/canvas/canvas-viewport";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/services/api/canvas";

export type CanvasCreatableNodeType = Exclude<CanvasNode["type"], "group">;

export const CANVAS_DOCK_BREAKPOINT = 1100;
export const CANVAS_DOCK_COMPACT_WIDTH = 268;
export const CANVAS_DOCK_WIDTH = 500;

const NODE_OPTIONS: Array<{ type: CanvasCreatableNodeType; label: string; description: string; icon: LucideIcon; tone: string }> = [
  { type: "text", label: "文字", description: "记录想法与提示词", icon: Type, tone: "bg-blue-500/10 text-blue-600 dark:text-blue-300" },
  { type: "image", label: "图片", description: "生成或导入图片", icon: ImagePlus, tone: "bg-sky-500/10 text-sky-600 dark:text-sky-300" },
  { type: "video", label: "视频", description: "从文字或素材生成视频", icon: Video, tone: "bg-orange-500/10 text-orange-600 dark:text-orange-300" },
  { type: "audio", label: "音频", description: "创作配音与声音", icon: Music, tone: "bg-violet-500/10 text-violet-600 dark:text-violet-300" },
  { type: "panorama", label: "全景图", description: "创建沉浸式全景场景", icon: Compass, tone: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-300" },
  { type: "director", label: "导演台", description: "编排镜头与场景", icon: Camera, tone: "bg-amber-500/10 text-amber-600 dark:text-amber-300" },
  { type: "config", label: "生成配置", description: "连接素材并设置生成参数", icon: Settings2, tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" },
];

function NodeOptions({ onCreate }: { onCreate: (type: CanvasCreatableNodeType) => void }) {
  return NODE_OPTIONS.map(({ type, label, description, icon: Icon, tone }) => (
    <button key={type} type="button" className="flex w-full items-center gap-3 rounded-lg p-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onCreate(type)}>
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", tone)}><Icon className="size-4" /></span>
      <span className="min-w-0"><span className="block text-xs font-medium">{label}</span><span className="block text-[11px] leading-5 text-muted-foreground">{description}</span></span>
    </button>
  ));
}

export function CanvasNodeCreatePalette({ point, viewport, connecting, onCreate }: {
  point: { x: number; y: number };
  viewport: { width: number; height: number };
  connecting?: boolean;
  onCreate: (type: CanvasCreatableNodeType) => void;
}) {
  const width = Math.min(272, Math.max(0, viewport.width - 24));
  const height = Math.min(438, Math.max(0, viewport.height - 24));
  return (
    <div data-connection-create-menu={connecting || undefined} data-node-create-menu={!connecting || undefined} data-canvas-no-pan className="absolute z-[60] flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-elevated)]" style={{ width, maxHeight: height, left: Math.max(12, Math.min(point.x, viewport.width - width - 12)), top: Math.max(12, Math.min(point.y, viewport.height - height - 12)) }}>
      <p className="shrink-0 border-b border-border/70 px-3 py-2.5 text-xs font-semibold">{connecting ? "创建节点并连接" : "添加到画布"}</p>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="p-1.5"><NodeOptions onCreate={onCreate} /></ScrollArea>
    </div>
  );
}

type CanvasWorkspaceControlsProps = {
  width: number;
  zoom: number;
  selectedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  uploading: boolean;
  miniMapOpen: boolean;
  hasNodes: boolean;
  assetsOpen: boolean;
  onCreate: (type: CanvasCreatableNodeType) => void;
  onUpload: () => void;
  onAssets: () => void;
  onSelect: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onZoom: (zoom: number) => void;
  onFit: () => void;
  onMiniMap: () => void;
  onShortcuts: () => void;
};

export function CanvasWorkspaceControls(props: CanvasWorkspaceControlsProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const compact = props.width < CANVAS_DOCK_BREAKPOINT;
  const create = (type: CanvasCreatableNodeType) => { setCreateOpen(false); props.onCreate(type); };
  return (
    <div data-canvas-controls className="pointer-events-none absolute inset-x-3 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-30 flex justify-center">
      <div data-canvas-workspace-dock style={{ width: compact ? CANVAS_DOCK_COMPACT_WIDTH : CANVAS_DOCK_WIDTH }} className={cn("pointer-events-auto flex max-w-full items-center justify-center rounded-lg border border-border/80 bg-card/95 shadow-[var(--shadow-elevated)] backdrop-blur-xl", compact ? "flex-col" : "flex-row")}>
      <div data-canvas-view-controls role="group" aria-label="画布视图" className="flex h-11 shrink-0 items-center gap-0.5 px-1.5">
        <ControlButton label="适应画布" disabled={!props.hasNodes} onClick={props.onFit}><Focus /></ControlButton>
        <ControlButton label="缩小画布" disabled={props.zoom <= CANVAS_MIN_ZOOM} onClick={() => props.onZoom(props.zoom / 1.2)}><Minus /></ControlButton>
        <Popover>
          <PopoverTrigger asChild><Button variant="ghost" className="h-9 w-12 px-0 text-xs tabular-nums" aria-label="缩放比例">{Math.round(props.zoom * 100)}%</Button></PopoverTrigger>
          <PopoverContent side="top" className="w-56 space-y-3" scrollable={false}>
            <p className="text-xs font-semibold">画布缩放</p>
            <Slider aria-label="画布缩放" min={CANVAS_MIN_ZOOM * 100} max={CANVAS_MAX_ZOOM * 100} value={Math.round(props.zoom * 100)} onChange={(event) => props.onZoom(Number(event.target.value) / 100)} />
            <div className="flex gap-1">{[0.5, 1, 2].map((zoom) => <Button key={zoom} variant="secondary" size="sm" className="h-7 flex-1 text-xs" onClick={() => props.onZoom(zoom)}>{zoom * 100}%</Button>)}</div>
          </PopoverContent>
        </Popover>
        <ControlButton label="放大画布" disabled={props.zoom >= CANVAS_MAX_ZOOM} onClick={() => props.onZoom(props.zoom * 1.2)}><Plus /></ControlButton>
        <ControlButton label="小地图" active={props.miniMapOpen} disabled={!props.hasNodes} onClick={props.onMiniMap}><Map /></ControlButton>
        <ControlButton label="快捷键" onClick={props.onShortcuts}><CircleHelp /></ControlButton>
      </div>
      <span aria-hidden="true" className={compact ? "h-px w-[calc(100%-1rem)] bg-border" : "h-6 w-px bg-border"} />
      <div data-canvas-toolbar role="group" aria-label="画布操作" className="flex h-11 shrink-0 items-center gap-0.5 px-1.5">
        <ControlButton label="移动/选择" active={!props.selectedCount} onClick={props.onSelect}><Hand /></ControlButton>
        <ControlButton label="撤销" disabled={!props.canUndo} onClick={props.onUndo}><Undo2 /></ControlButton>
        <ControlButton label="重做" disabled={!props.canRedo} onClick={props.onRedo}><Redo2 /></ControlButton>
        <span className="mx-1 h-5 w-px bg-border" />
        <Popover open={createOpen} onOpenChange={setCreateOpen}>
          <PopoverTrigger asChild><Button className="h-8 gap-1 rounded-md px-2.5 text-xs" aria-label="添加节点"><Plus className="size-4" />添加</Button></PopoverTrigger>
          <PopoverContent side="top" align="center" className="w-[272px] p-1.5">
            <p className="px-2 py-2 text-xs font-semibold">添加到画布</p>
            <NodeOptions onCreate={create} />
            <div className="mt-1 border-t border-border pt-1"><Button variant="ghost" className="h-10 w-full justify-start px-2 text-xs" disabled={props.uploading} onClick={() => { setCreateOpen(false); props.onUpload(); }}>{props.uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}上传素材</Button></div>
          </PopoverContent>
        </Popover>
        <ControlButton label="素材库" active={props.assetsOpen} onClick={props.onAssets}><FolderOpen /></ControlButton>
        <ControlButton label={props.selectedCount ? `删除所选（${props.selectedCount}）` : "删除所选"} disabled={!props.selectedCount} danger onClick={props.onDelete}><Trash2 /></ControlButton>
      </div>
      </div>
    </div>
  );
}

function ControlButton({ label, active, danger, children, ...props }: { label: string; active?: boolean; danger?: boolean; children: ReactNode } & React.ComponentProps<typeof Button>) {
  return <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={label} aria-pressed={active} className={cn("size-8 shrink-0 rounded-lg [&_svg]:size-4", active && "bg-brand-soft text-brand", danger && "text-destructive")} {...props}>{children}</Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}
