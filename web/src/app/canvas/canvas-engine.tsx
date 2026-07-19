import { Copy, Download, ImagePlus, Info, LoaderCircle, Maximize2, Pencil, Sparkles, Trash2, Upload, WandSparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";

import { AuthenticatedImage } from "@/components/authenticated-image";
import type { CanvasConnection, CanvasDocument, CanvasNode } from "@/lib/api";
import { cn } from "@/lib/utils";

type HandleType = "source" | "target";
type ConnectionOrigin = { nodeID: string; handleType: HandleType };
type Point = { x: number; y: number };
type SelectionBox = { start: Point; current: Point; initialIDs: string[]; additive: boolean };

type CanvasEngineProps = {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasDocument["viewport"];
  background: CanvasDocument["background"];
  tool: "select" | "pan";
  selectedNodeIDs: Set<string>;
  selectedConnectionID: string;
  panelNodeID: string;
  runningNodeID: string;
  onNodesChange: (nodes: CanvasNode[]) => void;
  onNodesCommit: () => void;
  onViewportChange: (viewport: CanvasDocument["viewport"], commit?: boolean) => void;
  onSelectionChange: (nodeIDs: Set<string>, connectionID?: string) => void;
  onConnect: (sourceID: string, targetID: string) => void;
  canConnect: (sourceID: string, targetID: string) => boolean;
  onConnectionDropEmpty: (origin: ConnectionOrigin, position: Point, menu: Point) => void;
  onPromptChange: (nodeID: string, prompt: string, commit?: boolean) => void;
  onTitleChange: (nodeID: string, title: string) => void;
  onNodePanelToggle: (nodeID: string) => void;
  onNodeUpload: (nodeID: string) => void;
  uploadingNodeID: string;
  onViewImage: (nodeID: string) => void;
  onCopyPrompt: (nodeID: string) => void;
  onDownloadImage: (nodeID: string) => void;
  onTextToImage: (nodeID: string) => void;
  onNodeInfo: (nodeID: string) => void;
  onNodeDelete: (nodeID: string) => void;
  onNodeContextMenu: (event: ReactMouseEvent, nodeID: string) => void;
  onConnectionContextMenu: (event: ReactMouseEvent<SVGPathElement>, connectionID: string) => void;
  onCanvasContextMenu: (event: ReactMouseEvent, position: Point) => void;
  onCanvasDoubleClick: (event: ReactMouseEvent, position: Point) => void;
  renderNodePanel: (node: CanvasNode) => ReactNode;
  onDrop?: (event: React.DragEvent<HTMLDivElement>, position: Point) => void;
};

export function CanvasEngine({
  nodes,
  connections,
  viewport,
  background,
  tool,
  selectedNodeIDs,
  selectedConnectionID,
  panelNodeID,
  runningNodeID,
  onNodesChange,
  onNodesCommit,
  onViewportChange,
  onSelectionChange,
  onConnect,
  canConnect,
  onConnectionDropEmpty,
  onPromptChange,
  onTitleChange,
  onNodePanelToggle,
  onNodeUpload,
  uploadingNodeID,
  onViewImage,
  onCopyPrompt,
  onDownloadImage,
  onTextToImage,
  onNodeInfo,
  onNodeDelete,
  onNodeContextMenu,
  onConnectionContextMenu,
  onCanvasContextMenu,
  onCanvasDoubleClick,
  renderNodePanel,
  onDrop,
}: CanvasEngineProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef(nodes);
  const viewportRef = useRef(viewport);
  const selectedRef = useRef(selectedNodeIDs);
  const frameRef = useRef<number | null>(null);
  const panRef = useRef({ active: false, startX: 0, startY: 0, initialX: 0, initialY: 0, moved: false });
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; initial: Array<{ id: string; x: number; y: number }> }>({ active: false, startX: 0, startY: 0, initial: [] });
  const resizeRef = useRef<{ active: boolean; nodeID: string; corner: ResizeCorner; startX: number; startY: number; node: CanvasNode | null }>({ active: false, nodeID: "", corner: "bottom-right", startX: 0, startY: 0, node: null });
  const connectionRef = useRef<ConnectionOrigin | null>(null);
  const selectionRef = useRef<SelectionBox | null>(null);
  const [connecting, setConnecting] = useState<ConnectionOrigin | null>(null);
  const [mouseWorld, setMouseWorld] = useState<Point>({ x: 0, y: 0 });
  const [connectionTargetID, setConnectionTargetID] = useState("");
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [textEditRequest, setTextEditRequest] = useState({ nodeID: "", nonce: 0 });

  nodesRef.current = nodes;
  viewportRef.current = viewport;
  selectedRef.current = selectedNodeIDs;

  const nodeByID = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  function screenToWorld(clientX: number, clientY: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    const current = viewportRef.current;
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - current.x) / current.zoom, y: (clientY - rect.top - current.y) / current.zoom };
  }

  function worldToScreen(point: Point) {
    const current = viewportRef.current;
    return { x: current.x + point.x * current.zoom, y: current.y + point.y * current.zoom };
  }

  function connectionFor(origin: ConnectionOrigin, otherID: string) {
    if (!otherID || otherID === origin.nodeID) return null;
    const sourceID = origin.handleType === "source" ? origin.nodeID : otherID;
    const targetID = origin.handleType === "source" ? otherID : origin.nodeID;
    return canConnect(sourceID, targetID) ? { sourceID, targetID } : null;
  }

  function connectionTargetAt(point: Point, origin: ConnectionOrigin) {
    const radius = 28 / viewportRef.current.zoom;
    let nearest = "";
    let nearestDistance = Number.POSITIVE_INFINITY;
    nodesRef.current.forEach((node) => {
      if (node.id === origin.nodeID || !connectionFor(origin, node.id)) return;
      const port = origin.handleType === "source"
        ? { x: node.x, y: node.y + node.height / 2 }
        : { x: node.x + node.width, y: node.y + node.height / 2 };
      const distance = Math.hypot(point.x - port.x, point.y - port.y);
      const inside = point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height;
      if ((inside || distance <= radius) && distance < nearestDistance) {
        nearest = node.id;
        nearestDistance = distance;
      }
    });
    return nearest;
  }

  function selectNode(event: ReactMouseEvent, nodeID: string) {
    const next = new Set(selectedRef.current);
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      if (next.has(nodeID)) next.delete(nodeID);
      else next.add(nodeID);
    } else if (!next.has(nodeID)) {
      next.clear();
      next.add(nodeID);
    }
    onSelectionChange(next, "");
    return next;
  }

  function startNodeDrag(event: ReactMouseEvent, nodeID: string) {
    if (event.button !== 0 || tool === "pan") return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-connection-handle],[data-resize-handle],[data-canvas-no-pan]")) return;
    event.stopPropagation();
    const selected = selectNode(event, nodeID);
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      initial: nodesRef.current.filter((node) => selected.has(node.id)).map((node) => ({ id: node.id, x: node.x, y: node.y })),
    };
  }

  function startResize(event: ReactMouseEvent, node: CanvasNode, corner: ResizeCorner) {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = { active: true, nodeID: node.id, corner, startX: event.clientX, startY: event.clientY, node: { ...node } };
  }

  function startConnection(event: ReactMouseEvent, nodeID: string, handleType: HandleType) {
    event.preventDefault();
    event.stopPropagation();
    const origin = { nodeID, handleType };
    connectionRef.current = origin;
    setConnecting(origin);
    setMouseWorld(screenToWorld(event.clientX, event.clientY));
    setConnectionTargetID("");
    onSelectionChange(new Set(), "");
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-canvas-node],[data-connection-id],[data-canvas-no-pan]")) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 0 && tool === "select" && (event.ctrlKey || event.metaKey)) {
      const point = screenToWorld(event.clientX, event.clientY);
      const selection = { start: point, current: point, additive: event.shiftKey, initialIDs: event.shiftKey ? Array.from(selectedRef.current) : [] };
      selectionRef.current = selection;
      setSelectionBox(selection);
      if (!event.shiftKey) onSelectionChange(new Set(), "");
      return;
    }
    if (event.button === 0) onSelectionChange(new Set(), "");
    event.preventDefault();
    panRef.current = { active: true, startX: event.clientX, startY: event.clientY, initialX: viewportRef.current.x, initialY: viewportRef.current.y, moved: false };
    document.body.style.cursor = "grabbing";
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = viewportRef.current;
    const factor = Math.pow(1.1, -event.deltaY / 100);
    const zoom = Math.min(4, Math.max(0.08, current.zoom * factor));
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const worldX = (mouseX - current.x) / current.zoom;
    const worldY = (mouseY - current.y) / current.zoom;
    onViewportChange({ zoom, x: mouseX - worldX * zoom, y: mouseY - worldY * zoom });
  }

  // oxlint-disable react-hooks/exhaustive-deps
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const preventWheel = (event: WheelEvent) => event.preventDefault();
    container.addEventListener("wheel", preventWheel, { passive: false });
    return () => container.removeEventListener("wheel", preventWheel);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      connectionRef.current = null;
      selectionRef.current = null;
      setConnecting(null);
      setConnectionTargetID("");
      setSelectionBox(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      if (panRef.current.active) {
        const dx = event.clientX - panRef.current.startX;
        const dy = event.clientY - panRef.current.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panRef.current.moved = true;
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
        frameRef.current = requestAnimationFrame(() => onViewportChange({ ...viewportRef.current, x: panRef.current.initialX + dx, y: panRef.current.initialY + dy }));
        return;
      }
      if (dragRef.current.active) {
        const dx = (event.clientX - dragRef.current.startX) / viewportRef.current.zoom;
        const dy = (event.clientY - dragRef.current.startY) / viewportRef.current.zoom;
        onNodesChange(nodesRef.current.map((node) => {
          const initial = dragRef.current.initial.find((item) => item.id === node.id);
          return initial ? { ...node, x: initial.x + dx, y: initial.y + dy } : node;
        }));
        return;
      }
      if (resizeRef.current.active && resizeRef.current.node) {
        const start = resizeRef.current.node;
        const dx = (event.clientX - resizeRef.current.startX) / viewportRef.current.zoom;
        const dy = (event.clientY - resizeRef.current.startY) / viewportRef.current.zoom;
        const left = resizeRef.current.corner.includes("left");
        const top = resizeRef.current.corner.includes("top");
        const width = Math.max(180, start.width + (left ? -dx : dx));
        const height = Math.max(120, start.height + (top ? -dy : dy));
        onNodesChange(nodesRef.current.map((node) => node.id === start.id ? { ...node, x: left ? start.x + start.width - width : start.x, y: top ? start.y + start.height - height : start.y, width, height } : node));
        return;
      }
      if (connectionRef.current) {
        const point = screenToWorld(event.clientX, event.clientY);
        const targetID = connectionTargetAt(point, connectionRef.current);
        setMouseWorld(point);
        setConnectionTargetID(targetID);
        return;
      }
      if (selectionRef.current) {
        const point = screenToWorld(event.clientX, event.clientY);
        const current = { ...selectionRef.current, current: point };
        selectionRef.current = current;
        setSelectionBox(current);
        const left = Math.min(current.start.x, point.x);
        const top = Math.min(current.start.y, point.y);
        const right = Math.max(current.start.x, point.x);
        const bottom = Math.max(current.start.y, point.y);
        const ids = new Set(current.additive ? current.initialIDs : []);
        nodesRef.current.forEach((node) => {
          if (left < node.x + node.width && right > node.x && top < node.y + node.height && bottom > node.y) ids.add(node.id);
        });
        onSelectionChange(ids, "");
      }
    };

    const handleUp = (event: PointerEvent) => {
      if (panRef.current.active) {
        panRef.current.active = false;
        document.body.style.cursor = "default";
        onViewportChange(viewportRef.current, true);
      }
      if (dragRef.current.active) {
        dragRef.current.active = false;
        onNodesCommit();
      }
      if (resizeRef.current.active) {
        resizeRef.current.active = false;
        resizeRef.current.node = null;
        onNodesCommit();
      }
      const origin = connectionRef.current;
      if (origin) {
        const point = screenToWorld(event.clientX, event.clientY);
        const targetID = connectionTargetAt(point, origin);
        connectionRef.current = null;
        setConnecting(null);
        setConnectionTargetID("");
        const connection = connectionFor(origin, targetID);
        if (connection) onConnect(connection.sourceID, connection.targetID);
        else {
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) onConnectionDropEmpty(origin, point, { x: event.clientX - rect.left, y: event.clientY - rect.top });
        }
      }
      if (selectionRef.current) {
        selectionRef.current = null;
        setSelectionBox(null);
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [canConnect, onConnect, onConnectionDropEmpty, onNodesChange, onNodesCommit, onSelectionChange, onViewportChange]);
  // oxlint-enable react-hooks/exhaustive-deps

  const preview = connectionPreview(connecting, connectionTargetID, mouseWorld, nodeByID);
  const toolbarNodeID = selectedNodeIDs.size === 1 ? Array.from(selectedNodeIDs)[0] : "";
  const toolbarNode = toolbarNodeID ? nodeByID.get(toolbarNodeID) || null : null;

  return (
    <div
      ref={containerRef}
      className={cn("canvas-grid absolute inset-0 touch-none overflow-hidden", background === "grid" && "canvas-background-grid", background === "plain" && "canvas-background-plain")}
      onPointerDown={handlePointerDown}
      onContextMenu={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-node],[data-connection-id],[data-canvas-no-pan]")) return;
        onCanvasContextMenu(event, screenToWorld(event.clientX, event.clientY));
      }}
      onDoubleClick={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-node],[data-connection-id],[data-canvas-no-pan]")) return;
        event.preventDefault();
        event.stopPropagation();
        onCanvasDoubleClick(event, screenToWorld(event.clientX, event.clientY));
      }}
      onWheel={handleWheel}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop?.(event, screenToWorld(event.clientX, event.clientY))}
    >
      <div className="absolute origin-top-left" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
        <svg className="pointer-events-none absolute top-0 left-0 h-[10000px] w-[10000px] overflow-visible">
          {connections.map((connection) => {
            const from = nodeByID.get(connection.from_node_id);
            const to = nodeByID.get(connection.to_node_id);
            if (!from || !to) return null;
            const start = { x: from.x + from.width, y: from.y + from.height / 2 };
            const end = { x: to.x, y: to.y + to.height / 2 };
            const path = connectionPath(start, end);
            const active = selectedConnectionID === connection.id || selectedNodeIDs.has(from.id) || selectedNodeIDs.has(to.id);
            return (
              <g key={connection.id}>
                <path
                  data-connection-id={connection.id}
                  d={path}
                  stroke="transparent"
                  strokeWidth="16"
                  fill="none"
                  className="pointer-events-auto cursor-pointer"
                  onClick={(event) => { event.stopPropagation(); onSelectionChange(new Set(), connection.id); }}
                  onContextMenu={(event) => onConnectionContextMenu(event, connection.id)}
                />
                <path d={path} stroke={active ? "#1456f0" : "#8793a5"} strokeWidth={active ? 3 : 2} opacity={active ? 1 : 0.86} fill="none" className="pointer-events-none" style={{ filter: selectedConnectionID === connection.id ? "drop-shadow(0 0 8px rgba(20,86,240,.4))" : undefined }} />
              </g>
            );
          })}
          {preview ? <path d={connectionPath(preview.start, preview.end)} stroke="#1456f0" strokeWidth="2" strokeDasharray="5 5" fill="none" /> : null}
        </svg>

        {nodes.map((node) => (
          <CanvasDOMNode
            key={node.id}
            node={node}
            selected={selectedNodeIDs.has(node.id)}
            showPanel={panelNodeID === node.id}
            running={runningNodeID === node.id}
            connecting={Boolean(connecting)}
            connectionTarget={connectionTargetID === node.id}
            onMouseDown={startNodeDrag}
            onResize={startResize}
            onConnect={startConnection}
            onPromptChange={onPromptChange}
            onTitleChange={onTitleChange}
            editRequestNonce={textEditRequest.nodeID === node.id ? textEditRequest.nonce : 0}
            onViewImage={onViewImage}
            onTextToImage={onTextToImage}
            onContextMenu={onNodeContextMenu}
            renderPanel={renderNodePanel}
          />
        ))}

        {selectionBox ? (
          <div className="pointer-events-none absolute border border-[#1456f0] bg-[#1456f0]/10" style={selectionBoxStyle(selectionBox)} />
        ) : null}
      </div>
      {toolbarNode ? (
        <CanvasNodeToolbar
          node={toolbarNode}
          viewport={viewport}
          showPanel={panelNodeID === toolbarNode.id}
          running={runningNodeID === toolbarNode.id}
          uploading={uploadingNodeID === toolbarNode.id}
          onInfo={() => onNodeInfo(toolbarNode.id)}
          onEditText={() => setTextEditRequest((current) => ({ nodeID: toolbarNode.id, nonce: current.nonce + 1 }))}
          onPanelToggle={() => onNodePanelToggle(toolbarNode.id)}
          onUpload={() => onNodeUpload(toolbarNode.id)}
          onViewImage={() => onViewImage(toolbarNode.id)}
          onCopyPrompt={() => onCopyPrompt(toolbarNode.id)}
          onDownloadImage={() => onDownloadImage(toolbarNode.id)}
          onTextToImage={() => onTextToImage(toolbarNode.id)}
          onDelete={() => onNodeDelete(toolbarNode.id)}
        />
      ) : null}
    </div>
  );
}

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

function CanvasDOMNode({ node, selected, showPanel, running, connecting, connectionTarget, onMouseDown, onResize, onConnect, onPromptChange, onTitleChange, editRequestNonce, onViewImage, onTextToImage, onContextMenu, renderPanel }: {
  node: CanvasNode;
  selected: boolean;
  showPanel: boolean;
  running: boolean;
  connecting: boolean;
  connectionTarget: boolean;
  onMouseDown: (event: ReactMouseEvent, nodeID: string) => void;
  onResize: (event: ReactMouseEvent, node: CanvasNode, corner: ResizeCorner) => void;
  onConnect: (event: ReactMouseEvent, nodeID: string, handleType: HandleType) => void;
  onPromptChange: (nodeID: string, prompt: string, commit?: boolean) => void;
  onTitleChange: (nodeID: string, title: string) => void;
  editRequestNonce: number;
  onViewImage: (nodeID: string) => void;
  onTextToImage: (nodeID: string) => void;
  onContextMenu: (event: ReactMouseEvent, nodeID: string) => void;
  renderPanel: (node: CanvasNode) => ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title || "");
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const active = selected || connectionTarget;

  useEffect(() => {
    if (!editingTitle) setTitleDraft(node.title || "");
  }, [editingTitle, node.title]);

  const finishTitleEditing = useCallback(() => {
    const title = titleDraft.trim() || (node.type === "image" ? "图片" : "想法");
    setTitleDraft(title);
    setEditingTitle(false);
    if (title !== node.title) onTitleChange(node.id, title);
  }, [node.id, node.title, node.type, onTitleChange, titleDraft]);

  const finishTextEditing = useCallback(() => {
    if (!editing) return;
    onPromptChange(node.id, node.prompt || "", true);
    setEditing(false);
  }, [editing, node.id, node.prompt, onPromptChange]);

  useEffect(() => {
    if (!editingTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && titleInputRef.current?.contains(target)) return;
      finishTitleEditing();
    };
    window.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [editingTitle, finishTitleEditing]);

  useEffect(() => {
    if (!editing) return;
    const textarea = textEditorRef.current;
    textarea?.focus();
    if (textarea) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && textarea?.contains(target)) return;
      finishTextEditing();
    };
    window.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [editing, finishTextEditing]);

  useEffect(() => {
    if (!editRequestNonce || node.type !== "text") return;
    setEditing(true);
  }, [editRequestNonce, node.type]);
  return (
    <div
      data-canvas-node
      data-node-id={node.id}
      className="group absolute overflow-visible"
      style={{ left: node.x, top: node.y, width: node.width, height: node.height, zIndex: selected || showPanel ? 50 : 10 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(event) => onContextMenu(event, node.id)}
    >
      <div data-canvas-no-pan className="absolute top-[-28px] left-3 z-30 max-w-[calc(100%-24px)]" onMouseDown={(event) => event.stopPropagation()}>
        {editingTitle ? (
          <input
            ref={titleInputRef}
            autoFocus
            value={titleDraft}
            maxLength={64}
            className="h-6 max-w-full border-0 border-b border-dashed border-foreground/50 bg-transparent px-0 py-0.5 text-left text-xs font-medium text-foreground outline-none"
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={finishTitleEditing}
            onKeyDown={(event) => {
              if (event.key === "Enter") finishTitleEditing();
              if (event.key === "Escape") {
                setTitleDraft(node.title || "");
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            title="双击修改节点名称"
            className="block max-w-full truncate border-b border-dashed border-transparent py-0.5 text-left text-xs font-medium text-foreground/75 transition hover:border-current hover:text-foreground"
            onDoubleClick={(event) => {
              event.stopPropagation();
              setEditingTitle(true);
            }}
          >
            {node.title || (node.type === "image" ? "图片" : "想法")}
          </button>
        )}
      </div>
      <div
        className={cn(
          "relative size-full overflow-hidden rounded-3xl border-2 transition-[border-color,box-shadow]",
          node.type === "image" && node.url ? "bg-transparent" : "bg-card",
          active ? "border-[#1456f0] shadow-[0_0_0_1px_rgba(20,86,240,.34)]" : node.type === "image" && node.url ? "border-transparent" : "border-border",
        )}
        onMouseDown={(event) => onMouseDown(event, node.id)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (node.type === "image" && node.url) onViewImage(node.id);
          else if (node.type === "text") setEditing(true);
        }}
      >
        {node.type === "image" ? node.url ? (
          <AuthenticatedImage src={node.url} alt={node.title || node.prompt || "画布图片"} draggable={false} className="pointer-events-none size-full rounded-[inherit] object-contain" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-3 bg-muted/35 text-muted-foreground">
            <span className="flex size-12 items-center justify-center rounded-xl bg-[#e7efff] text-[#1456f0]"><ImagePlus className="size-5" /></span>
            <span className="text-[11px] tracking-[0.16em] text-muted-foreground">空图片节点</span>
          </div>
        ) : editing ? (
          <textarea
            ref={textEditorRef}
            autoFocus
            data-canvas-no-pan
            value={node.prompt || ""}
            className="size-full resize-none border-0 bg-card px-4 py-4 pr-20 font-mono text-sm leading-6 outline-none"
            placeholder="输入你的想法"
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) => onPromptChange(node.id, event.target.value)}
            onBlur={(event) => { onPromptChange(node.id, event.target.value, true); setEditing(false); }}
            onKeyDown={(event) => { if (event.key === "Escape") finishTextEditing(); }}
          />
        ) : (
          <div className="size-full overflow-y-auto whitespace-pre-wrap break-words bg-card px-4 py-4 pr-20 font-mono text-sm leading-6">
            {node.prompt || <span className="text-muted-foreground">双击输入想法</span>}
          </div>
        )}
        {node.type === "text" ? <button data-canvas-no-pan type="button" className="absolute top-3 right-3 z-20 flex h-8 items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 text-xs font-medium shadow-sm backdrop-blur hover:bg-muted" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onTextToImage(node.id); }}><ImagePlus className="size-3.5" />生图</button> : null}
        {running ? <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[inherit] bg-black/25 backdrop-blur-[1px]"><span className="flex items-center gap-2 rounded-full bg-black/65 px-3 py-2 text-xs font-medium text-white"><LoaderCircle className="size-4 animate-spin" />生成中</span></div> : null}
      </div>
      <ConnectionHandle side="left" visible={hovered || selected || connecting} onMouseDown={(event) => onConnect(event, node.id, "target")} />
      <ConnectionHandle side="right" visible={hovered || selected || connecting} onMouseDown={(event) => onConnect(event, node.id, "source")} />
      {selected ? (["top-left", "top-right", "bottom-left", "bottom-right"] as ResizeCorner[]).map((corner) => <ResizeHandle key={corner} corner={corner} onMouseDown={(event) => onResize(event, node, corner)} />) : null}
      {showPanel ? <div data-canvas-no-pan className="absolute top-full left-1/2 z-[70] w-[500px] -translate-x-1/2 pt-4" onMouseDown={(event) => event.stopPropagation()}>{renderPanel(node)}</div> : null}
    </div>
  );
}

function CanvasNodeToolbar({ node, viewport, showPanel, running, uploading, onInfo, onEditText, onPanelToggle, onUpload, onViewImage, onCopyPrompt, onDownloadImage, onTextToImage, onDelete }: {
  node: CanvasNode;
  viewport: CanvasDocument["viewport"];
  showPanel: boolean;
  running: boolean;
  uploading: boolean;
  onInfo: () => void;
  onEditText: () => void;
  onPanelToggle: () => void;
  onUpload: () => void;
  onViewImage: () => void;
  onCopyPrompt: () => void;
  onDownloadImage: () => void;
  onTextToImage: () => void;
  onDelete: () => void;
}) {
  const left = viewport.x + (node.x + node.width / 2) * viewport.zoom;
  const top = viewport.y + node.y * viewport.zoom - 14;
  return (
    <div
      data-canvas-no-pan
      className="absolute z-[80] flex h-12 min-w-max -translate-x-1/2 -translate-y-full items-center overflow-hidden rounded-2xl border border-border bg-card/96 text-sm shadow-[0_12px_32px_rgba(15,23,42,.16)] backdrop-blur-xl"
      style={{ left, top }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <NodeAction label="信息" onClick={onInfo}><Info /></NodeAction>
      {running ? (
        <NodeAction label="生成中" disabled onClick={() => undefined}><LoaderCircle className="animate-spin" /></NodeAction>
      ) : node.type === "text" ? (
        <>
          <NodeAction label="编辑文字" onClick={onEditText}><Pencil /></NodeAction>
          <NodeAction label="生图" onClick={onTextToImage}><Sparkles /></NodeAction>
        </>
      ) : node.url ? (
        <>
          <NodeAction label="编辑" active={showPanel} onClick={onPanelToggle}><WandSparkles /></NodeAction>
          <NodeAction label="复制提示词" onClick={onCopyPrompt}><Copy /></NodeAction>
          <NodeAction label={uploading ? "上传中" : "替换"} disabled={uploading} onClick={onUpload}>{uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}</NodeAction>
          <NodeAction label="查看" onClick={onViewImage}><Maximize2 /></NodeAction>
          <NodeAction label="下载" onClick={onDownloadImage}><Download /></NodeAction>
        </>
      ) : (
        <NodeAction label={uploading ? "上传中" : "上传图片"} disabled={uploading} onClick={onUpload}>{uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}</NodeAction>
      )}
      <NodeAction label="删除" danger onClick={onDelete}><Trash2 /></NodeAction>
    </div>
  );
}

function NodeAction({ label, active = false, danger = false, disabled = false, onClick, children }: { label: string; active?: boolean; danger?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" title={label} disabled={disabled} className={cn("flex h-full shrink-0 items-center gap-2 whitespace-nowrap px-4 font-medium transition hover:bg-muted disabled:cursor-wait disabled:opacity-60", active && "bg-[#e7efff] text-[#1456f0]", danger && "border-l border-border text-rose-600")} onClick={onClick}><span className="[&>svg]:size-[17px]">{children}</span>{label}</button>;
}

function ConnectionHandle({ side, visible, onMouseDown }: { side: "left" | "right"; visible: boolean; onMouseDown: (event: ReactMouseEvent) => void }) {
  return <div data-connection-handle={side === "left" ? "target" : "source"} className={cn("absolute z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity", visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0 group-hover:opacity-100")} style={{ top: "50%", left: side === "left" ? -24 : undefined, right: side === "right" ? -24 : undefined }} onMouseDown={onMouseDown}><div className="size-3 rounded-full border-2 border-[#7f8da1] bg-card" /></div>;
}

function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: ReactMouseEvent) => void }) {
  const position = { "top-left": "-top-3 -left-3 cursor-nwse-resize", "top-right": "-top-3 -right-3 cursor-nesw-resize", "bottom-left": "-bottom-3 -left-3 cursor-nesw-resize", "bottom-right": "-right-3 -bottom-3 cursor-nwse-resize" }[corner];
  return <div data-resize-handle={corner} className={cn("absolute z-40 size-6", position)} onMouseDown={onMouseDown}><span className="absolute top-1/2 left-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#1456f0] bg-white" /></div>;
}

function connectionPreview(origin: ConnectionOrigin | null, targetID: string, mouse: Point, nodeByID: Map<string, CanvasNode>) {
  if (!origin) return null;
  const node = nodeByID.get(origin.nodeID);
  if (!node) return null;
  const target = targetID ? nodeByID.get(targetID) : null;
  if (origin.handleType === "source") return { start: { x: node.x + node.width, y: node.y + node.height / 2 }, end: target ? { x: target.x, y: target.y + target.height / 2 } : mouse };
  return { start: target ? { x: target.x + target.width, y: target.y + target.height / 2 } : mouse, end: { x: node.x, y: node.y + node.height / 2 } };
}

function connectionPath(start: Point, end: Point) {
  const curvature = Math.max(Math.abs(end.x - start.x) * 0.5, 50);
  return `M ${start.x} ${start.y} C ${start.x + curvature} ${start.y}, ${end.x - curvature} ${end.y}, ${end.x} ${end.y}`;
}

function selectionBoxStyle(box: SelectionBox) {
  const left = Math.min(box.start.x, box.current.x);
  const top = Math.min(box.start.y, box.current.y);
  return { left, top, width: Math.abs(box.current.x - box.start.x), height: Math.abs(box.current.y - box.start.y) };
}
