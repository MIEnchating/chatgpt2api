import { Card } from "@/components/ui/card";
import { Eye, Maximize, Minus, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { visibleCanvasNodes } from "@/app/canvas/canvas-batches";
import { canvasConnectionPath } from "@/app/canvas/canvas-connections";
import { canvasNodeBounds } from "@/app/canvas/canvas-groups";
import { canvasGridMetrics, clampCanvasZoom, setCanvasViewportZoom, zoomCanvasViewport } from "@/app/canvas/canvas-viewport";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { fetchSharedCanvas, type CanvasDocument, type CanvasNode } from "@/services/api/canvas";

export default function SharedCanvasPage() {
  const { token = "" } = useParams();
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [preview, setPreview] = useState<CanvasNode | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const fit = useCallback((canvas: CanvasDocument) => {
    const host = hostRef.current;
    if (!host) return;
    const nodes = visibleCanvasNodes(canvas.nodes);
    if (!nodes.length) { setViewport({ x: host.clientWidth / 2, y: host.clientHeight / 2, zoom: 1 }); return; }
    const bounds = canvasNodeBounds(nodes);
    const zoom = clampCanvasZoom(Math.min((host.clientWidth - 64) / Math.max(1, bounds.right - bounds.left), (host.clientHeight - 160) / Math.max(1, bounds.bottom - bounds.top), 1));
    setViewport({ zoom, x: host.clientWidth / 2 - (bounds.left + bounds.right) / 2 * zoom, y: host.clientHeight / 2 - (bounds.top + bounds.bottom) / 2 * zoom });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let initial = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const result = await fetchSharedCanvas(token, controller.signal);
        if (controller.signal.aborted) return;
        setDocument(result.document);
        setError("");
        if (initial) { fit(result.document); initial = false; }
      } catch (error) {
        if (controller.signal.aborted) return;
        setDocument(null);
        setPreviewOpen(false);
        setPreview(null);
        setError(error instanceof Error ? error.message : "分享不存在或已取消");
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void load(), 15000);
      }
    };
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [token, retry, fit]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest("[data-share-interactive]")) return;
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      setViewport((current) => zoomCanvasViewport(current, { x: event.clientX - rect.left, y: event.clientY - rect.top }, event.deltaY));
    };
    host.addEventListener("wheel", wheel, { passive: false });
    return () => host.removeEventListener("wheel", wheel);
  }, []);

  function zoom(factor: number) {
    const host = hostRef.current;
    if (host) setViewport((current) => setCanvasViewportZoom(current, { width: host.clientWidth, height: host.clientHeight }, current.zoom * factor));
  }

  const nodes = document ? visibleCanvasNodes(document.nodes) : [];
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  const grid = canvasGridMetrics(viewport);
  return <div ref={hostRef} tabIndex={0} aria-label="只读分享画布" className="relative h-full w-full overflow-hidden bg-background outline-none"
    onKeyDown={(event) => {
      if ((event.target as HTMLElement).closest("[data-share-interactive]")) return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.2); }
      if (event.key === "-") { event.preventDefault(); zoom(1 / 1.2); }
      if (event.key === "0" && document) fit(document);
      const direction = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }[event.key];
      if (direction) { event.preventDefault(); setViewport((current) => ({ ...current, x: current.x + direction[0], y: current.y + direction[1] })); }
    }}>
    {!document ? error ? <EmptyState role="alert" headingLevel={1} className="h-full" title="无法查看分享" description={error} action={<Button variant="outline" onClick={() => setRetry((value) => value + 1)}><RefreshCw />重试</Button>} /> : <LoadingState label="正在加载分享画布" /> : <>
      <div className="absolute inset-0 touch-none cursor-grab active:cursor-grabbing"
        style={document.background === "plain" ? undefined : { backgroundImage: document.background === "grid" ? "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)" : "radial-gradient(circle, var(--border) 1px, transparent 1px)", backgroundSize: `${grid.size}px ${grid.size}px`, backgroundPosition: `${grid.x}px ${grid.y}px` }}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest("[data-share-interactive]")) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
          if (other) {
            const before = Math.hypot(previous.x - other.x, previous.y - other.y);
            const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
            const rect = event.currentTarget.getBoundingClientRect();
            const point = { x: (previous.x + other.x) / 2 - rect.left, y: (previous.y + other.y) / 2 - rect.top };
            setViewport((current) => {
              const next = zoomCanvasViewport(current, point, -100 * Math.log(after / Math.max(1, before)) / Math.log(1.1));
              return { ...next, x: next.x + (event.clientX - previous.x) / 2, y: next.y + (event.clientY - previous.y) / 2 };
            });
          } else {
            setViewport((current) => ({ ...current, x: current.x + event.clientX - previous.x, y: current.y + event.clientY - previous.y }));
          }
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerUp={(event) => pointers.current.delete(event.pointerId)}
        onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
        onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}>
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
          <svg className="pointer-events-none absolute overflow-visible" width="1" height="1" aria-hidden="true">{document.connections.map((connection) => {
            const from = nodeByID.get(connection.from_node_id), to = nodeByID.get(connection.to_node_id);
            return from && to ? <path key={connection.id} d={canvasConnectionPath({ x: from.x + from.width, y: from.y + from.height / 2 }, { x: to.x, y: to.y + to.height / 2 })} fill="none" stroke="var(--primary)" strokeOpacity={0.5} strokeWidth={2} /> : null;
          })}</svg>
          {nodes.map((node) => <Card role="article" key={node.id} data-shared-node={node.id} className={cn("absolute gap-0 overflow-visible p-0", node.type === "group" && "bg-muted/30")} style={{ left: node.x, top: node.y, width: node.width, height: node.height, zIndex: node.type === "group" ? 0 : 1 }}>
            <h2 className="absolute -top-8 left-0 max-w-full truncate text-sm font-medium">{node.title || ({ text: "文字", image: "图片", video: "视频", audio: "音频", panorama: "全景图", config: "生成配置", director: "导演台", script: "脚本", group: "分组" }[node.type])}</h2>
            {node.type === "group" ? null : node.type === "image" || node.type === "panorama" ? node.url ? <Button variant="ghost" type="button" data-share-interactive className="h-full w-full cursor-zoom-in overflow-hidden" aria-label={`查看${node.title || "图片"}`} onClick={() => { setPreview(node); setPreviewOpen(true); }}><img draggable={false} src={node.url} alt={node.title || "画布图片"} className="h-full w-full object-contain" /></Button> : <MediaPlaceholder /> : node.type === "video" ? node.url ? <video data-share-interactive controls preload="metadata" src={node.url} className="h-full w-full rounded-xl object-contain" /> : <MediaPlaceholder /> : node.type === "audio" ? node.url ? <div className="flex h-full items-center px-3"><audio data-share-interactive controls preload="metadata" src={node.url} className="w-full" /></div> : <MediaPlaceholder /> : <ScrollAreaRoot data-share-interactive style={{ fontSize: node.font_size || 14 }} data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden h-full cursor-text select-text" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0 whitespace-pre-wrap break-words p-4">{node.prompt || (node.type === "director" ? "导演台" : node.type === "config" ? "生成配置" : "")}</div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>}
          </Card>)}
        </div>
      </div>
      <header className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3"><Card className="min-w-0 max-w-full px-4 py-3 gap-0"><h1 className="truncate text-sm font-semibold">{document.title}</h1><p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Eye className="size-3.5" />只读分享</p></Card></header>
      {!nodes.length ? <EmptyState compact title="画布暂无内容" className="pointer-events-none absolute inset-0" /> : null}
      <Card data-share-interactive className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1 p-1.5 flex-row"><Button size="icon" variant="ghost" aria-label="缩小" onClick={() => zoom(1 / 1.2)}><Minus /></Button><span className="min-w-12 text-center text-xs tabular-nums">{Math.round(viewport.zoom * 100)}%</span><Button size="icon" variant="ghost" aria-label="放大" onClick={() => zoom(1.2)}><Plus /></Button><Button variant="ghost" onClick={() => fit(document)}><Maximize  />适合屏幕</Button></Card>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}><DialogContent className="sm:max-w-5xl"><DialogHeader><DialogTitle>{preview?.title || "图片预览"}</DialogTitle><DialogDescription>只读查看画布素材</DialogDescription></DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">{preview ? <img src={preview.url} alt={preview.title || "画布图片"} className="max-h-[75dvh] w-full object-contain" /> : null}</ScrollArea></DialogContent></Dialog>
    </>}
  </div>;
}

function MediaPlaceholder() {
  return <EmptyState compact title="暂无素材" className="h-full min-h-0 p-3" />;
}
