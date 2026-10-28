import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CanvasDocument, CanvasNode } from "@/services/api/canvas";

export function CanvasNodeToolbar({ node, viewport, expanded, editor, children }: {
  node: CanvasNode;
  viewport: CanvasDocument["viewport"];
  expanded: boolean;
  editor: ReactNode;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, toolbarWidth: 0, toolbarHeight: 0, editorWidth: 0 });

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const toolbar = toolbarRef.current;
    const input = editorRef.current;
    if (!layer || !toolbar || !input) return;
    const measure = () => setSize((previous) => {
      const next = { width: layer.clientWidth, height: layer.clientHeight, toolbarWidth: toolbar.offsetWidth, toolbarHeight: toolbar.offsetHeight, editorWidth: input.offsetWidth };
      return Object.keys(next).every((key) => next[key as keyof typeof next] === previous[key as keyof typeof next]) ? previous : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    observer.observe(toolbar);
    observer.observe(input);
    return () => observer.disconnect();
  }, []);

  const nodeLeft = node.x * viewport.zoom + viewport.x;
  const nodeTop = node.y * viewport.zoom + viewport.y;
  const nodeWidth = node.width * viewport.zoom;
  const nodeBottom = nodeTop + node.height * viewport.zoom;
  // Keep controls anchored in canvas space, even when they extend beyond the viewport.
  const visible = size.width > 0;
  const left = nodeLeft + nodeWidth / 2 - size.toolbarWidth / 2;
  const top = nodeTop - 36 * viewport.zoom - size.toolbarHeight - 12;
  const editorHeight = node.type === "text" ? 220 : node.type === "image" ? 264 : 360;
  const editorLeft = nodeLeft + nodeWidth / 2 - size.editorWidth / 2;
  const editorTop = nodeBottom + 12;

  return <div ref={layerRef} data-canvas-node-overlays className="pointer-events-none absolute inset-x-0 top-0 bottom-[var(--canvas-dock-clearance)] z-20" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <div ref={toolbarRef} data-canvas-node-toolbar data-canvas-no-pan data-toolbar-node-id={node.id} role="group" aria-label="选中节点操作" className="pointer-events-auto absolute w-max max-w-[min(600px,calc(100%-1rem))]" style={{ left, top, visibility: visible ? "visible" : "hidden" }}>
      {children}
    </div>
    <div ref={editorRef} data-canvas-node-input-anchor data-canvas-no-pan className="pointer-events-auto absolute w-[520px] max-w-[calc(100%-1rem)]" style={{ left: editorLeft, top: editorTop, "--canvas-node-editor-height": `${editorHeight}px`, visibility: visible && expanded ? "visible" : "hidden" } as CSSProperties}>
      {editor}
    </div>
  </div>;
}
