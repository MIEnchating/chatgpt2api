import { useMemo, useRef, useState, type PointerEvent } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { CanvasDocument, CanvasNode } from "@/services/api/canvas";
import { canvasNodeBounds } from "./canvas-groups";

export function CanvasMiniMap({ nodes, viewport, viewportSize, onViewportChange, onClose }: { onClose: () => void; nodes: CanvasNode[]; viewport: CanvasDocument["viewport"]; viewportSize: { width: number; height: number }; onViewportChange: (viewport: CanvasDocument["viewport"]) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const width = Math.min(240, Math.max(80, viewportSize.width - 24));
  const height = Math.min(160, Math.max(60, viewportSize.height - 244));
  const map = useMemo(() => {
    const bounds = canvasNodeBounds(nodes);
    const minX = bounds.left - 500;
    const minY = bounds.top - 500;
    const maxX = bounds.right + 500;
    const maxY = bounds.bottom + 500;
    const worldWidth = Math.max(1, maxX - minX);
    const worldHeight = Math.max(1, maxY - minY);
    const scale = Math.min(width / worldWidth, height / worldHeight);
    return { minX, minY, scale, offsetX: (width - worldWidth * scale) / 2, offsetY: (height - worldHeight * scale) / 2 };
  }, [height, nodes, width]);

  const markers = useMemo(() => nodes.map((node) => (
    <span key={node.id} data-canvas-minimap-node={node.id}
      className={cn("pointer-events-none absolute rounded-sm", node.type === "image" ? "bg-primary" : node.type === "video" ? "bg-orange-500" : node.type === "config" ? "bg-emerald-500" : "bg-amber-500")}
      style={{
        left: (node.x - map.minX) * map.scale + map.offsetX,
        top: (node.y - map.minY) * map.scale + map.offsetY,
        width: Math.max(2, node.width * map.scale),
        height: Math.max(2, node.height * map.scale),
      }}
    />
  )), [map, nodes]);
  const viewScale = map.scale / viewport.zoom;
  const viewportBox = {
    left: map.offsetX - map.minX * map.scale - viewport.x * viewScale,
    top: map.offsetY - map.minY * map.scale - viewport.y * viewScale,
    width: Math.max(4, viewportSize.width * viewScale),
    height: Math.max(4, viewportSize.height * viewScale),
  };

  function navigate(event: PointerEvent<HTMLDivElement>) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const worldX = (event.clientX - rect.left - map.offsetX) / map.scale + map.minX;
    const worldY = (event.clientY - rect.top - map.offsetY) / map.scale + map.minY;
    onViewportChange({ zoom: viewport.zoom, x: viewportSize.width / 2 - worldX * viewport.zoom, y: viewportSize.height / 2 - worldY * viewport.zoom });
  }

  return (
    <Card data-canvas-minimap data-canvas-no-pan className="absolute left-3 z-30 overflow-hidden gap-0 p-0" style={{ width, bottom: "var(--canvas-dock-clearance)" }}>
      <div className="flex h-8 items-center justify-between border-b border-border/70 px-2.5 text-[11px] font-medium">画布导航<Button variant="ghost" size="icon-sm" type="button" className="grid place-items-center" aria-label="关闭小地图" onClick={onClose}><X  /></Button></div>
      <div ref={containerRef} role="group" tabIndex={0} aria-label="小地图，使用方向键移动画布"
        className={cn("relative touch-none", dragging ? "cursor-grabbing" : "cursor-grab")} style={{ height }}
        onKeyDown={(event) => {
          const delta = { ArrowLeft: [64, 0], ArrowRight: [-64, 0], ArrowUp: [0, 64], ArrowDown: [0, -64] }[event.key];
          if (!delta) return;
          event.preventDefault();
          event.stopPropagation();
          onViewportChange({ ...viewport, x: viewport.x + delta[0], y: viewport.y + delta[1] });
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          navigate(event);
        }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) navigate(event); }}
        onLostPointerCapture={() => setDragging(false)}
      >
        {markers}
        <span data-canvas-minimap-viewport className="pointer-events-none absolute border border-primary bg-primary/10" style={viewportBox} />
      </div>
    </Card>
  );
}
