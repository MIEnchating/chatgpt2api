import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { CanvasDocument, CanvasNode } from "@/services/api/canvas";

type CanvasOverlaySpace = { top: number; bottom: number };

function canvasOverlayVerticalSpaces(top: number, bottom: number, blocked: CanvasOverlaySpace[]) {
  let spaces = [{ top, bottom }];
  for (const obstacle of blocked) {
    spaces = spaces.flatMap((space) => {
      if (obstacle.bottom <= space.top || obstacle.top >= space.bottom) return [space];
      return [
        { top: space.top, bottom: Math.min(space.bottom, obstacle.top) },
        { top: Math.max(space.top, obstacle.bottom), bottom: space.bottom },
      ].filter((part) => part.bottom > part.top);
    });
  }
  return spaces;
}

export function CanvasNodeToolbar({ node, viewport, expanded, editor, children }: {
  node: CanvasNode;
  viewport: CanvasDocument["viewport"];
  expanded: boolean;
  editor: ReactNode;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, toolbarWidth: 0, toolbarHeight: 0 });

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const toolbar = toolbarRef.current;
    if (!layer || !toolbar) return;
    const measure = () => setSize((previous) => {
      const next = { width: layer.clientWidth, height: layer.clientHeight, toolbarWidth: toolbar.offsetWidth, toolbarHeight: toolbar.offsetHeight };
      return Object.keys(next).every((key) => next[key as keyof typeof next] === previous[key as keyof typeof next]) ? previous : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

  const nodeLeft = node.x * viewport.zoom + viewport.x;
  const nodeTop = node.y * viewport.zoom + viewport.y;
  const nodeWidth = node.width * viewport.zoom;
  const nodeBottom = nodeTop + node.height * viewport.zoom;
  // Reserve the project navigation and the workspace dock while following the node.
  const visible = size.width > 0;
  const safeTop = Math.min(72, Math.max(8, size.height - size.toolbarHeight - 24));
  const bottom = Math.max(safeTop, size.height - 8);
  const left = Math.max(8, Math.min(nodeLeft + nodeWidth / 2 - size.toolbarWidth / 2, size.width - size.toolbarWidth - 8));
  const titleTop = nodeTop - 36 * viewport.zoom;
  const titleBottom = nodeTop - 8 * viewport.zoom;
  const wantedTop = nodeTop - 36 * viewport.zoom - size.toolbarHeight - 12;
  const toolbarSpaces = canvasOverlayVerticalSpaces(safeTop, bottom,
    left < nodeLeft + nodeWidth && left + size.toolbarWidth > nodeLeft ? [{ top: titleTop - 12, bottom: titleBottom + 12 }] : []);
  let top = safeTop;
  let distance = Infinity;
  for (const space of toolbarSpaces) {
    if (space.bottom - space.top < size.toolbarHeight) continue;
    const candidate = Math.max(space.top, Math.min(wantedTop, space.bottom - size.toolbarHeight));
    if (Math.abs(candidate - wantedTop) < distance) {
      top = candidate;
      distance = Math.abs(candidate - wantedTop);
    }
  }
  return <div ref={layerRef} data-canvas-node-overlays className="pointer-events-none absolute inset-x-0 top-0 bottom-[var(--canvas-dock-clearance)] z-20" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <div ref={toolbarRef} data-canvas-node-toolbar data-canvas-no-pan data-toolbar-node-id={node.id} role="group" aria-label="选中节点操作" className="pointer-events-auto absolute w-max max-w-[min(600px,calc(100%-1rem))]" style={{ left, top, visibility: visible ? "visible" : "hidden" }}>
      {children}
    </div>
    <div data-canvas-node-input-anchor data-canvas-no-pan className="pointer-events-auto absolute w-[640px] -translate-x-1/2" style={{ left: nodeLeft + nodeWidth / 2, top: nodeBottom + 12, visibility: expanded ? "visible" : "hidden" }}>
      {editor}
    </div>
  </div>;
}
