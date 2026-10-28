import { Bot, Camera, ChevronDown, CircleHelp, Compass, FolderOpen, Grid2X2, Hand, History, ImagePlus, LoaderCircle, Magnet, Map, MousePointer2, Music, PanelLeft, Plus, Redo2, Settings2, Trash2, Type, Undo2, Upload, Video, Waypoints, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { canvasWorkspaceControlsStacked, type CanvasTool } from "./canvas-workspace-layout";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from "@/app/canvas/canvas-viewport";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/services/api/canvas";

export type CanvasCreatableNodeType = Exclude<CanvasNode["type"], "group">;

export const CANVAS_DOCK_BREAKPOINT = 560;
export const CANVAS_DOCK_MIN_WIDTH = 268;
export const CANVAS_DOCK_COMPACT_WIDTH = 316;
export const CANVAS_DOCK_WIDTH = 400;

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
  viewInset: number;
  zoom: number;
  selectedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  uploading: boolean;
  miniMapOpen: boolean;
  hasNodes: boolean;
  assetsOpen: boolean;
  agentOpen: boolean;
  onAgent: () => void;
  sidePanelOpen: boolean;
  historyOpen: boolean;
  showConnections: boolean;
  snapToGrid: boolean;
  onCreate: (type: CanvasCreatableNodeType) => void;
  onUpload: () => void;
  onAssets: () => void;
  onManagement: () => void;
  onHistory: () => void;
  onArrange: () => void;
  onToggleConnections: () => void;
  onToggleSnap: () => void;
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
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
  const stacked = canvasWorkspaceControlsStacked(props.width, props.sidePanelOpen, props.agentOpen, props.viewInset);
  const create = (type: CanvasCreatableNodeType) => { setCreateOpen(false); props.onCreate(type); };
  const surface = "pointer-events-auto flex h-12 max-w-full items-center justify-center gap-0.5 rounded-2xl border border-border/80 bg-card/95 px-1.5 shadow-[var(--shadow-elevated)] backdrop-blur-xl";
  return (
    <div data-canvas-controls className={cn("pointer-events-none absolute inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex items-center", stacked ? "flex-col gap-2" : "h-12 justify-center")}>
      <div data-canvas-view-controls role="group" aria-label="画布视图" style={stacked ? { marginLeft: compact ? 0 : props.viewInset } : { left: props.viewInset }} className={cn(surface, !stacked && "absolute left-0", stacked && !compact && "self-start")}>
        {!props.sidePanelOpen ? <Tooltip><TooltipTrigger asChild><Button variant="ghost" className={cn("h-8 gap-2 rounded-lg px-2 text-xs", compact && "size-8 p-0 has-[>svg]:px-0")} aria-label="资产管理" aria-expanded={props.sidePanelOpen} onClick={props.onManagement}><PanelLeft className="size-4" />{!compact && "资产管理"}</Button></TooltipTrigger><TooltipContent>资产管理</TooltipContent></Tooltip> : null}
        <ControlButton label="整理画布" disabled={!props.hasNodes} onClick={props.onArrange}><Grid2X2 /></ControlButton>
        <ControlButton label="画布小地图" active={props.miniMapOpen} disabled={!props.hasNodes} onClick={props.onMiniMap}><Map /></ControlButton>
        <ControlButton label={props.showConnections ? "隐藏节点连线" : "显示节点连线"} active={props.showConnections} onClick={props.onToggleConnections}><Waypoints /></ControlButton>
        <ControlButton label="网格吸附" active={props.snapToGrid} onClick={props.onToggleSnap}><Magnet /></ControlButton>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <CanvasZoomOptions zoom={props.zoom} onZoom={props.onZoom} onFit={props.onFit} />
      </div>
      <div data-canvas-workspace-dock className="flex w-max max-w-full items-center gap-1.5 sm:gap-2">
        <div className={cn(surface, "min-w-0", compact && "[&_button]:size-7 [&_button]:p-0", props.width < 360 && "[&_button]:size-6")}>
          <div data-canvas-toolbar role="group" aria-label="画布操作" className={cn("flex items-center", compact ? "gap-0" : "gap-0.5")}>
            <Popover open={createOpen} onOpenChange={setCreateOpen}>
              <PopoverTrigger asChild><Button size="icon" className="size-8 rounded-lg" title="添加节点" aria-label="添加节点"><Plus className="size-4" /></Button></PopoverTrigger>
              <PopoverContent side="top" align="center" className="w-[272px] p-1.5">
                <p className="px-2 py-2 text-xs font-semibold">添加到画布</p>
                <NodeOptions onCreate={create} />
                <div className="mt-1 border-t border-border pt-1"><Button variant="ghost" className="h-10 w-full justify-start px-2 text-xs" disabled={props.uploading} onClick={() => { setCreateOpen(false); props.onUpload(); }}>{props.uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}上传素材</Button></div>
              </PopoverContent>
            </Popover>
            <CanvasToolPicker tool={props.tool} onChange={props.onToolChange} />
            <ControlButton label="素材库" active={props.assetsOpen} onClick={props.onAssets}><FolderOpen /></ControlButton>
            <ControlButton label="生成历史" active={props.historyOpen} onClick={props.onHistory}><History /></ControlButton>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
            <ControlButton label="撤销" disabled={!props.canUndo} onClick={props.onUndo}><Undo2 /></ControlButton>
            <ControlButton label="重做" disabled={!props.canRedo} onClick={props.onRedo}><Redo2 /></ControlButton>
            <ControlButton label={props.selectedCount ? `删除所选（${props.selectedCount}）` : "删除所选"} disabled={!props.selectedCount} danger onClick={props.onDelete}><Trash2 /></ControlButton>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
            <ControlButton label="快捷键" onClick={props.onShortcuts}><CircleHelp /></ControlButton>
          </div>
        </div>
        {!props.agentOpen ? <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" data-canvas-agent-trigger aria-label="打开 Agent" aria-expanded={props.agentOpen} onClick={props.onAgent} className={cn("pointer-events-auto size-12 shrink-0 rounded-full border border-border/80 bg-card/95 p-1.5 shadow-[var(--shadow-elevated)] backdrop-blur-xl transition-transform hover:scale-105", compact && "size-10 p-1", props.agentOpen && "border-brand/60 ring-2 ring-brand/20")}>
              <span className="grid size-full place-items-center rounded-full bg-gradient-to-br from-cyan-200 via-sky-400 to-indigo-500 shadow-[inset_0_1px_4px_rgba(255,255,255,0.6)]"><Bot className="size-5 text-white" /></span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Agent</TooltipContent>
        </Tooltip> : null}
      </div>
    </div>
  );
}

function CanvasToolPicker({ tool, onChange }: { tool: CanvasTool; onChange: (tool: CanvasTool) => void }) {
  const [open, setOpen] = useState(false);
  const label = tool === "select" ? "选择工具（V）" : "抓手工具（H）";
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="secondary" size="icon" aria-label={label} title={label} className="size-8 rounded-lg">{tool === "select" ? <MousePointer2 className="size-4" /> : <Hand className="size-4" />}</Button></PopoverTrigger>
    <PopoverContent side="top" align="start" className="w-48 p-1.5" aria-label="画布工具">
      <div role="group" aria-label="选择画布工具" className="flex flex-col gap-1">
        {([{ value: "select", label: "选择 / 移动", description: "选中、框选和拖动节点", key: "V", icon: MousePointer2 }, { value: "pan", label: "抓手", description: "平移画布，不移动节点", key: "H", icon: Hand }] as const).map(({ value, label, description, key, icon: Icon }) => <button key={value} type="button" aria-pressed={tool === value} aria-description={description} onClick={() => { onChange(value); setOpen(false); }} className={cn("flex h-9 w-full shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", tool === value ? "bg-brand-soft text-brand" : "hover:bg-muted")}>
          <Icon className="size-4 shrink-0" /><span className="min-w-0 flex-1 whitespace-nowrap text-xs font-medium">{label}</span><kbd className="text-[11px] text-muted-foreground">{key}</kbd>
        </button>)}
      </div>
    </PopoverContent>
  </Popover>;
}

function CanvasZoomOptions({ zoom, onZoom, onFit }: Pick<CanvasWorkspaceControlsProps, "zoom" | "onZoom" | "onFit">) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const percentage = Math.round(zoom * 100);
  const apply = (value: number) => { onZoom(value); setOpen(false); };
  const commit = () => {
    const value = Number(draft.trim());
    if (!draft.trim() || !Number.isFinite(value)) { setDraft(String(percentage)); return; }
    apply(Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, value / 100)));
  };
  const shortcut = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setDraft(String(percentage)); }}>
      <PopoverTrigger asChild><Button variant="ghost" className="h-8 gap-1 rounded-lg px-2 text-xs tabular-nums" aria-label="缩放比例">{percentage}%<ChevronDown className="size-3" /></Button></PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-56 p-2">
        <form className="relative mb-2" onSubmit={(event) => { event.preventDefault(); commit(); }}>
          <Input type="number" min={CANVAS_MIN_ZOOM * 100} max={CANVAS_MAX_ZOOM * 100} step="any" aria-label="缩放百分比" className="h-10 border-0 bg-muted pr-8 tabular-nums" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <span className="pointer-events-none absolute right-3 top-2.5 text-sm text-muted-foreground">%</span>
        </form>
        <Button variant="ghost" className="h-10 w-full justify-between px-3 text-sm" disabled={zoom >= CANVAS_MAX_ZOOM} onClick={() => apply(zoom * 1.2)}>放大<kbd className="text-xs text-muted-foreground">{shortcut} +</kbd></Button>
        <Button variant="ghost" className="h-10 w-full justify-between px-3 text-sm" disabled={zoom <= CANVAS_MIN_ZOOM} onClick={() => apply(zoom / 1.2)}>缩小<kbd className="text-xs text-muted-foreground">{shortcut} −</kbd></Button>
        <Button variant="ghost" className="h-10 w-full justify-between px-3 text-sm" onClick={() => { onFit(); setOpen(false); }}>适合屏幕<kbd className="text-xs text-muted-foreground">{shortcut} 0</kbd></Button>
        <div className="my-1 border-t border-border" />
        {[0.5, 1, CANVAS_MAX_ZOOM].map((value) => <Button key={value} variant="ghost" className="h-10 w-full justify-start px-3 text-sm" onClick={() => apply(value)}>缩放至{value * 100}%</Button>)}
      </PopoverContent>
    </Popover>
  );
}

function ControlButton({ label, active, danger, children, ...props }: { label: string; active?: boolean; danger?: boolean; children: ReactNode } & React.ComponentProps<typeof Button>) {
  return <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={label} aria-pressed={active} className={cn("size-8 shrink-0 rounded-lg [&_svg]:size-4", active && "bg-brand-soft text-brand", danger && "text-destructive")} {...props}>{children}</Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}
