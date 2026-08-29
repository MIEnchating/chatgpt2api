import { AlertCircle, ChevronRight, ImagePlus, LoaderCircle, RefreshCw, Settings2, Star, Trash2, Video, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";

import { AuthenticatedImage } from "@/components/authenticated-image";
import { OverflowMarqueeText } from "@/components/overflow-marquee-text";
import {
  activeCanvasConnectionPath,
  canvasConnectionPath,
  canvasConnectionRelations,
  findCanvasConnectionDropTarget,
  resolveCanvasConnection,
  type CanvasConnectionHandleType as HandleType,
  type CanvasConnectionOrigin as ConnectionOrigin,
  type CanvasPoint as Point,
} from "@/app/canvas/canvas-connections";
import { canvasGridMetrics, canvasNodesInViewport, zoomCanvasViewport } from "@/app/canvas/canvas-viewport";
import { canvasExportTransform, type CanvasExportBounds } from "@/app/canvas/canvas-export";
import { canvasNodeAspectRatio } from "@/app/canvas/canvas-node-geometry";
import { expandCanvasGroupNodeIDs, findCanvasGroupDropTarget, findContainingCanvasGroupID, snapCanvasNodesIntoGroup } from "@/app/canvas/canvas-groups";
import { buildCanvasInputIndex } from "@/app/canvas/canvas-config-inputs";
import { canvasBatchMotion, expandCanvasBatchNodeIDs, visibleCanvasNodes } from "@/app/canvas/canvas-batches";
import { CanvasDirectorNodePanel } from "@/app/canvas/canvas-director-node-panel";
import { CanvasSpecialNodeContent, SpecialNodeLoading } from "@/app/canvas/canvas-special-nodes";
import { CanvasVideoNodePlayer } from "@/app/canvas/canvas-video-player";
import { Tooltip, TooltipButton, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getCachedAuthenticatedImageByteSize } from "@/lib/authenticated-image";
import type { CanvasConnection, CanvasDocument, CanvasNode } from "@/services/api/canvas";
import { cn } from "@/lib/utils";

type SelectionBox = { start: Point; current: Point; initialIDs: string[]; additive: boolean };

function formatImageBytes(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatGenerationElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

type CanvasEngineProps = {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasDocument["viewport"];
  background: CanvasDocument["background"];
  showImageInfo: boolean;
  canvasSize: { width: number; height: number };
  exporting?: boolean;
  exportBounds?: CanvasExportBounds;
  selectedNodeIDs: Set<string>;
  selectedConnectionID: string;
  panelNodeID: string;
  loadingNodeID: string;
  pendingConnectionActive: boolean;
  collapsingBatchRootIDs: Set<string>;
  openingBatchRootIDs: Set<string>;
  onNodesChange: (nodes: CanvasNode[]) => void;
  onNodesCommit: () => void;
  onViewportChange: (viewport: CanvasDocument["viewport"], commit?: boolean) => void;
  onSelectionChange: (nodeIDs: Set<string>, connectionID?: string) => void;
  onConnect: (sourceID: string, targetID: string) => void;
  canConnect: (sourceID: string, targetID: string) => boolean;
  onConnectionDropEmpty: (origin: ConnectionOrigin, position: Point, menu: Point) => void;
  onTitleChange: (nodeID: string, title: string) => void;
  onNodePanelToggle: (nodeID: string) => void;
  onNodeMediaLoad: (nodeID: string, width: number, height: number, bytes?: number) => void;
  onViewImage: (nodeID: string) => void;
  onDirectorOpen: (nodeID: string) => void;
  onTextToImage: (nodeID: string) => void;
  onNodeRetry: (nodeID: string) => void;
  onNodeActivate: (nodeID: string) => void;
  onToggleBatch: (nodeID: string) => void;
  onSetBatchPrimary: (nodeID: string) => void;
  onNodeDelete: (nodeID: string) => void;
  onNodeContextMenu: (event: ReactMouseEvent, nodeID: string) => void;
  onConnectionContextMenu: (event: ReactMouseEvent<SVGPathElement>, connectionID: string) => void;
  onCanvasContextMenu: (event: ReactMouseEvent, position: Point) => void;
  onCanvasDoubleClick: (event: ReactMouseEvent, position: Point) => void;
  renderNodePanel: (node: CanvasNode) => ReactNode;
  renderNodeActions: (node: CanvasNode) => ReactNode;
  renderNodeQuickActions?: (node: CanvasNode) => ReactNode;
  renderNodeInfo: (node: CanvasNode) => ReactNode;
  onDrop?: (event: React.DragEvent<HTMLDivElement>, position: Point) => void;
};

export function CanvasEngine({
  nodes,
  connections,
  viewport,
  background,
  showImageInfo,
  canvasSize,
  exporting = false,
  exportBounds,
  selectedNodeIDs,
  selectedConnectionID,
  panelNodeID,
  loadingNodeID,
  pendingConnectionActive,
  collapsingBatchRootIDs,
  openingBatchRootIDs,
  onNodesChange,
  onNodesCommit,
  onViewportChange,
  onSelectionChange,
  onConnect,
  canConnect,
  onConnectionDropEmpty,
  onTitleChange,
  onNodePanelToggle,
  onNodeMediaLoad,
  onViewImage,
  onDirectorOpen,
  onTextToImage,
  onNodeRetry,
  onNodeActivate,
  onToggleBatch,
  onSetBatchPrimary,
  onNodeDelete,
  onNodeContextMenu,
  onConnectionContextMenu,
  onCanvasContextMenu,
  onCanvasDoubleClick,
  renderNodePanel,
  renderNodeActions,
  renderNodeQuickActions,
  renderNodeInfo,
  onDrop,
}: CanvasEngineProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef(nodes);
  const viewportRef = useRef(viewport);
  const selectedRef = useRef(selectedNodeIDs);
  const frameRef = useRef<number | null>(null);
  const panRef = useRef({ active: false, startX: 0, startY: 0, initialX: 0, initialY: 0, moved: false, preserveSelection: false });
  const dragRef = useRef<{ active: boolean; moved: boolean; clickedNodeID: string; startX: number; startY: number; initial: Array<{ id: string; x: number; y: number }> }>({ active: false, moved: false, clickedNodeID: "", startX: 0, startY: 0, initial: [] });
  const resizeRef = useRef<{ active: boolean; pointerID: number; nodeID: string; corner: ResizeCorner; node: CanvasNode | null }>({ active: false, pointerID: -1, nodeID: "", corner: "bottom-right", node: null });
  const connectionRef = useRef<ConnectionOrigin | null>(null);
  const pendingConnectionWasActiveRef = useRef(false);
  const selectionRef = useRef<SelectionBox | null>(null);
  const pendingSelectionRef = useRef<Set<string> | null>(null);
  const spacePressedRef = useRef(false);
  const [connecting, setConnecting] = useState<ConnectionOrigin | null>(null);
  const [mouseWorld, setMouseWorld] = useState<Point>({ x: 0, y: 0 });
  const [connectionTargetID, setConnectionTargetID] = useState("");
  const [dropTargetGroupID, setDropTargetGroupID] = useState("");
  const [hoveredNodeID, setHoveredNodeID] = useState("");
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [drawerView, setDrawerView] = useState<"parameters" | "actions" | "info">("parameters");
  const [generationNow, setGenerationNow] = useState(Date.now());

  nodesRef.current = nodes;
  viewportRef.current = viewport;
  selectedRef.current = selectedNodeIDs;

  const canvasInputIndex = useMemo(() => buildCanvasInputIndex(nodes, connections), [connections, nodes]);
  const nodeByID = canvasInputIndex.nodeByID;
  const batchVisibleNodes = useMemo(() => visibleCanvasNodes(nodes, collapsingBatchRootIDs), [collapsingBatchRootIDs, nodes]);
  const renderedNodes = useMemo(() => exporting ? batchVisibleNodes : canvasNodesInViewport(batchVisibleNodes, viewport, canvasSize), [batchVisibleNodes, canvasSize, exporting, viewport]);
  const connectionNodeIDs = useMemo(() => new Set(batchVisibleNodes.map((node) => node.id)), [batchVisibleNodes]);
  const renderedNodeIDs = useMemo(() => new Set(renderedNodes.map((node) => node.id)), [renderedNodes]);
  const configInputSummaries = useMemo(() => {
    const summaries = new Map<string, { text: number; image: number; video: number; audio: number }>();
    nodes.forEach((node) => {
      if (node.type !== "config") return;
      const inputs = canvasInputIndex.configInputsByNodeID.get(node.id) || [];
      summaries.set(node.id, {
        text: inputs.filter((input) => input.type === "text").length,
        image: inputs.filter((input) => input.type === "image").length,
        video: inputs.filter((input) => input.type === "video").length,
        audio: inputs.filter((input) => input.type === "audio").length,
      });
    });
    return summaries;
  }, [canvasInputIndex, nodes]);
  const groupChildCounts = useMemo(() => {
    const counts = new Map<string, number>();
    nodes.forEach((node) => {
      if (node.group_id) counts.set(node.group_id, (counts.get(node.group_id) || 0) + 1);
    });
    return counts;
  }, [nodes]);
  const hasTimedLoadingNode = nodes.some((node) => node.generation_status === "loading" && (node.type === "text" || node.type === "image" || node.type === "video"));

  useEffect(() => {
    if (!hasTimedLoadingNode) return;
    setGenerationNow(Date.now());
    const timer = window.setInterval(() => setGenerationNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasTimedLoadingNode]);

  useEffect(() => {
    if (hoveredNodeID && !renderedNodeIDs.has(hoveredNodeID)) setHoveredNodeID("");
  }, [hoveredNodeID, renderedNodeIDs]);

  function screenToWorld(clientX: number, clientY: number) {
    const rect = containerRef.current?.getBoundingClientRect();
    const current = viewportRef.current;
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - current.x) / current.zoom, y: (clientY - rect.top - current.y) / current.zoom };
  }

  function connectionFor(origin: ConnectionOrigin, otherID: string) {
    const connection = resolveCanvasConnection(origin, otherID, nodesRef.current);
    return connection && canConnect(connection.sourceID, connection.targetID) ? connection : null;
  }

  function connectionTargetAt(point: Point, origin: ConnectionOrigin) {
    return findCanvasConnectionDropTarget({
      nodes: visibleCanvasNodes(nodesRef.current),
      point,
      zoom: viewportRef.current.zoom,
      origin,
      canConnect: (current, otherNodeID) => Boolean(connectionFor(current, otherNodeID)),
    });
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

  function captureNodeSelection(event: ReactMouseEvent, nodeID: string) {
    if (event.button !== 0) return;
    if (spacePressedRef.current) {
      pendingSelectionRef.current = null;
      return;
    }
    pendingSelectionRef.current = selectNode(event, nodeID);
  }

  function startNodeDrag(event: ReactMouseEvent, nodeID: string) {
    if (event.button !== 0) return;
    if (spacePressedRef.current) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-connection-handle],[data-resize-handle],[data-canvas-no-pan]")) return;
    event.stopPropagation();
    const selected = pendingSelectionRef.current ?? selectNode(event, nodeID);
    const draggedIDs = expandCanvasGroupNodeIDs(expandCanvasBatchNodeIDs(selected, nodesRef.current), nodesRef.current);
    pendingSelectionRef.current = null;
    dragRef.current = {
      active: true,
      moved: false,
      clickedNodeID: nodeID,
      startX: event.clientX,
      startY: event.clientY,
      initial: nodesRef.current.filter((node) => draggedIDs.has(node.id)).map((node) => ({ id: node.id, x: node.x, y: node.y })),
    };
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode, corner: ResizeCorner) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { active: true, pointerID: event.pointerId, nodeID: node.id, corner, node: { ...node } };
  }

  function startConnection(event: ReactMouseEvent, nodeID: string, handleType: HandleType) {
    event.preventDefault();
    event.stopPropagation();
    const origin = { nodeID, handleType };
    connectionRef.current = origin;
    setConnecting(origin);
    setMouseWorld(screenToWorld(event.clientX, event.clientY));
    setConnectionTargetID("");
    onSelectionChange(pendingSelectionRef.current ?? selectedRef.current, "");
    pendingSelectionRef.current = null;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    const overCanvasControl = Boolean(target?.closest("[data-canvas-no-pan]"));
    const overNodeOrConnection = Boolean(target?.closest("[data-canvas-node],[data-connection-id]"));
    if (event.button === 0 && !overNodeOrConnection && document.activeElement instanceof HTMLElement && (document.activeElement.isContentEditable || document.activeElement instanceof HTMLMediaElement)) {
      document.activeElement.blur();
    }
    if (overCanvasControl || (overNodeOrConnection && !spacePressedRef.current)) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 0 && (event.ctrlKey || event.metaKey) && !spacePressedRef.current) {
      event.preventDefault();
      const point = screenToWorld(event.clientX, event.clientY);
      const selection = { start: point, current: point, additive: event.shiftKey, initialIDs: event.shiftKey ? Array.from(selectedRef.current) : [] };
      selectionRef.current = selection;
      setSelectionBox(selection);
      if (!event.shiftKey) onSelectionChange(new Set(), "");
      return;
    }
    event.preventDefault();
    panRef.current = { active: true, startX: event.clientX, startY: event.clientY, initialX: viewportRef.current.x, initialY: viewportRef.current.y, moved: false, preserveSelection: spacePressedRef.current };
    document.body.style.cursor = "grabbing";
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    // ScrollArea owns wheel scrolling. Let the browser keep its native
    // momentum instead of treating the event as canvas zoom input.
    if (target?.closest(".scroll-area-viewport,[data-scrollable],[data-canvas-no-zoom],[data-canvas-no-pan],[role='dialog'],[role='listbox']")) return;
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = viewportRef.current;
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const next = zoomCanvasViewport(current, { x: mouseX, y: mouseY }, event.deltaY);
    viewportRef.current = next;
    onViewportChange(next, true);
  }

  // oxlint-disable react-hooks/exhaustive-deps
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const preventWheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".scroll-area-viewport,[data-scrollable],[data-canvas-no-zoom],[data-canvas-no-pan],[role='dialog'],[role='listbox']")) return;
      event.preventDefault();
    };
    container.addEventListener("wheel", preventWheel, { passive: false });
    return () => container.removeEventListener("wheel", preventWheel);
  }, []);

  useEffect(() => {
    if (pendingConnectionActive) {
      pendingConnectionWasActiveRef.current = true;
      return;
    }
    if (!pendingConnectionWasActiveRef.current) return;
    pendingConnectionWasActiveRef.current = false;
    connectionRef.current = null;
    setConnecting(null);
    setConnectionTargetID("");
  }, [pendingConnectionActive]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest("input,textarea,select,[contenteditable='true'],[data-canvas-no-pan],[role='dialog'],[role='listbox']")) {
          event.preventDefault();
          spacePressedRef.current = true;
          if (!panRef.current.active) document.body.style.cursor = "grab";
        }
        return;
      }
      if (event.key !== "Escape") return;
      connectionRef.current = null;
      selectionRef.current = null;
      setConnecting(null);
      setConnectionTargetID("");
      setSelectionBox(null);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spacePressedRef.current = false;
      if (!panRef.current.active) document.body.style.cursor = "default";
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      spacePressedRef.current = false;
      if (!panRef.current.active) document.body.style.cursor = "default";
    };
  }, []);

  useEffect(() => {
    const cancelPendingFrame = () => {
      if (frameRef.current === null) return;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
    const scheduleFrame = (callback: () => void) => {
      cancelPendingFrame();
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        callback();
      });
    };
    const draggedNodesAt = (clientX: number, clientY: number) => {
      const drag = dragRef.current;
      const dx = (clientX - drag.startX) / viewportRef.current.zoom;
      const dy = (clientY - drag.startY) / viewportRef.current.zoom;
      const initialByID = new Map(drag.initial.map((item) => [item.id, item]));
      return nodesRef.current.map((node) => {
        const initial = initialByID.get(node.id);
        return initial ? { ...node, x: initial.x + dx, y: initial.y + dy } : node;
      });
    };
    const applyNodeDrag = (clientX: number, clientY: number) => {
      if (!dragRef.current.active) return;
      const next = draggedNodesAt(clientX, clientY);
      setDropTargetGroupID(findCanvasGroupDropTarget(new Set(dragRef.current.initial.map((item) => item.id)), next)?.id || "");
      onNodesChange(next);
    };
    const applyNodeResize = (clientX: number, clientY: number) => {
      const resize = resizeRef.current;
      const start = resize.node;
      if (!resize.active || !start) return;
      const left = resize.corner.includes("left");
      const top = resize.corner.includes("top");
      // Use the opposite corner as a fixed anchor and resolve the pointer in
      // world coordinates. This avoids drift when the canvas is zoomed.
      const pointer = screenToWorld(clientX, clientY);
      const anchorX = left ? start.x + start.width : start.x;
      const anchorY = top ? start.y + start.height : start.y;
      const rawWidth = Math.max(0, left ? anchorX - pointer.x : pointer.x - anchorX);
      const rawHeight = Math.max(0, top ? anchorY - pointer.y : pointer.y - anchorY);
      let width = Math.max(220, rawWidth);
      let height = Math.max(160, rawHeight);
      if ((start.type === "image" && !start.free_resize) || start.type === "video") {
        const ratio = canvasNodeAspectRatio(start);
        if (rawWidth / ratio >= rawHeight) height = width / ratio;
        else width = height * ratio;
        if (height < 160) { height = 160; width = height * ratio; }
        if (width < 220) { width = 220; height = width / ratio; }
      }
      onNodesChange(nodesRef.current.map((node) => node.id === start.id ? { ...node, x: left ? anchorX - width : start.x, y: top ? anchorY - height : start.y, width, height } : node));
    };
    const handleMove = (event: PointerEvent) => {
      if (panRef.current.active) {
        const dx = event.clientX - panRef.current.startX;
        const dy = event.clientY - panRef.current.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panRef.current.moved = true;
        scheduleFrame(() => {
          const next = { ...viewportRef.current, x: panRef.current.initialX + dx, y: panRef.current.initialY + dy };
          viewportRef.current = next;
          onViewportChange(next);
        });
        return;
      }
      if (dragRef.current.active) {
        if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) dragRef.current.moved = true;
        const { clientX, clientY } = event;
        scheduleFrame(() => applyNodeDrag(clientX, clientY));
        return;
      }
      if (resizeRef.current.active && resizeRef.current.node && resizeRef.current.pointerID === event.pointerId) {
        const { clientX, clientY } = event;
        scheduleFrame(() => applyNodeResize(clientX, clientY));
        return;
      }
      if (connectionRef.current) {
        const point = screenToWorld(event.clientX, event.clientY);
        const targetID = connectionTargetAt(point, connectionRef.current).nodeID;
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
        visibleCanvasNodes(nodesRef.current).forEach((node) => {
          if (left < node.x + node.width && right > node.x && top < node.y + node.height && bottom > node.y) ids.add(node.id);
        });
        onSelectionChange(ids, "");
      }
    };

    const handleUp = (event: PointerEvent) => {
      if (panRef.current.active) {
        const wasMoved = panRef.current.moved;
        const wasCancelled = event.type === "pointercancel";
        const dx = event.clientX - panRef.current.startX;
        const dy = event.clientY - panRef.current.startY;
        panRef.current.active = false;
        document.body.style.cursor = spacePressedRef.current ? "grab" : "default";
        cancelPendingFrame();
        if (!wasCancelled && wasMoved) {
          const next = { ...viewportRef.current, x: panRef.current.initialX + dx, y: panRef.current.initialY + dy };
          viewportRef.current = next;
          onViewportChange(next, true);
        } else if (!wasCancelled && !panRef.current.preserveSelection) {
          onSelectionChange(new Set(), "");
        }
      }
      if (dragRef.current.active) {
        const wasClick = event.type !== "pointercancel" && !dragRef.current.moved;
        const clickedNodeID = dragRef.current.clickedNodeID;
        const moved = dragRef.current.moved;
        cancelPendingFrame();
        if (event.type !== "pointercancel" && moved) {
          const movedIDs = new Set(dragRef.current.initial.map((item) => item.id));
          const movedNodes = draggedNodesAt(event.clientX, event.clientY);
          const targetGroup = findCanvasGroupDropTarget(movedIDs, movedNodes);
          onNodesChange(targetGroup
            ? snapCanvasNodesIntoGroup(movedIDs, movedNodes, targetGroup)
            : movedNodes.map((node) => {
              if (!movedIDs.has(node.id) || node.type === "group") return node;
              const groupID = findContainingCanvasGroupID(node, movedNodes);
              return node.group_id === groupID ? node : { ...node, group_id: groupID };
            }));
        }
        dragRef.current.active = false;
        dragRef.current.moved = false;
        dragRef.current.clickedNodeID = "";
        dragRef.current.initial = [];
        setDropTargetGroupID("");
        if (moved) onNodesCommit();
        else if (wasClick && clickedNodeID) onNodeActivate(clickedNodeID);
      }
      if (resizeRef.current.active && resizeRef.current.pointerID === event.pointerId) {
        cancelPendingFrame();
        if (event.type !== "pointercancel") applyNodeResize(event.clientX, event.clientY);
        resizeRef.current.active = false;
        resizeRef.current.pointerID = -1;
        resizeRef.current.node = null;
        onNodesCommit();
      }
      const origin = connectionRef.current;
      if (origin) {
        const point = screenToWorld(event.clientX, event.clientY);
        const dropTarget = connectionTargetAt(point, origin);
        connectionRef.current = null;
        setConnectionTargetID("");
        const connection = connectionFor(origin, dropTarget.nodeID);
        if (connection) {
          setConnecting(null);
          onConnect(connection.sourceID, connection.targetID);
        } else if (dropTarget.isNearNode || event.type === "pointercancel") {
          setConnecting(null);
        } else {
          setMouseWorld(point);
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) onConnectionDropEmpty(origin, point, { x: event.clientX - rect.left, y: event.clientY - rect.top });
        }
      }
      if (selectionRef.current) {
        selectionRef.current = null;
        setSelectionBox(null);
      }
    };

    const handleBlur = () => {
      cancelPendingFrame();
      if (panRef.current.active && panRef.current.moved) onViewportChange(viewportRef.current, true);
      if (dragRef.current.active && dragRef.current.moved) onNodesCommit();
      if (resizeRef.current.active) onNodesCommit();
      panRef.current.active = false;
      dragRef.current.active = false;
      dragRef.current.moved = false;
      dragRef.current.clickedNodeID = "";
      dragRef.current.initial = [];
      setDropTargetGroupID("");
      resizeRef.current.active = false;
      resizeRef.current.pointerID = -1;
      resizeRef.current.node = null;
      connectionRef.current = null;
      selectionRef.current = null;
      spacePressedRef.current = false;
      document.body.style.cursor = "default";
      setConnecting(null);
      setConnectionTargetID("");
      setSelectionBox(null);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [canConnect, onConnect, onConnectionDropEmpty, onNodeActivate, onNodesChange, onNodesCommit, onSelectionChange, onViewportChange]);
  // oxlint-enable react-hooks/exhaustive-deps

  const preview = connectionPreview(connecting, connectionTargetID, mouseWorld, nodeByID);
  const activeNodeID = exporting ? "" : selectedNodeIDs.size > 1
    ? ""
    : hoveredNodeID || (selectedNodeIDs.size === 1 ? Array.from(selectedNodeIDs)[0] : "");
  const related = useMemo(() => canvasConnectionRelations(activeNodeID, connections), [activeNodeID, connections]);
  const exportViewport = exporting && exportBounds ? { zoom: 1, x: -exportBounds.minX, y: -exportBounds.minY } : viewport;
  const grid = canvasGridMetrics(exportViewport);
  const canvasBackgroundStyle = {
    backgroundImage: background === "plain"
      ? "none"
      : background === "grid"
        ? "linear-gradient(var(--canvas-grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--canvas-grid-line) 1px, transparent 1px)"
        : `radial-gradient(circle, var(--canvas-grid-dot) ${grid.dotSize}px, transparent ${grid.dotSize + 0.2}px)`,
    backgroundSize: background === "plain" ? undefined : `${grid.size}px ${grid.size}px`,
    backgroundPosition: background === "plain" ? undefined : `${grid.x}px ${grid.y}px`,
  } satisfies CSSProperties;
  const panelNode = panelNodeID ? nodeByID.get(panelNodeID) || null : null;

  useEffect(() => {
    setDrawerView(panelNode?.type === "director" ? "actions" : "parameters");
  }, [panelNode?.type, panelNodeID]);

  return (
    <div
      ref={containerRef}
      data-canvas-export-root
      className="canvas-grid absolute inset-0 touch-none select-none overflow-hidden"
      style={{
        ...canvasBackgroundStyle,
        ...(exporting && exportBounds ? { width: exportBounds.width, height: exportBounds.height, right: "auto", bottom: "auto" } : {}),
      }}
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
      <div className="absolute origin-top-left" style={{
        transform: exporting && exportBounds ? canvasExportTransform(exportBounds) : `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      }}>
        <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" style={{ width: exporting && exportBounds ? exportBounds.width : 10000, height: exporting && exportBounds ? exportBounds.height : 10000 }}>
          {connections.map((connection) => {
            const from = nodeByID.get(connection.from_node_id);
            const to = nodeByID.get(connection.to_node_id);
            if (!from || !to || !connectionNodeIDs.has(from.id) || !connectionNodeIDs.has(to.id)) return null;
            const start = { x: from.x + from.width, y: from.y + from.height / 2 };
            const end = { x: to.x, y: to.y + to.height / 2 };
            const path = canvasConnectionPath(start, end);
            const active = !exporting && (selectedConnectionID === connection.id || related.connectionIDs.has(connection.id));
            return (
              <g key={connection.id}>
                <path
                  data-connection-id={connection.id}
                  d={path}
                  stroke="transparent"
                  strokeWidth="16"
                  fill="none"
                  style={{ cursor: "pointer", pointerEvents: "stroke" }}
                  onClick={(event) => { event.stopPropagation(); if (!spacePressedRef.current) onSelectionChange(new Set(), connection.id); }}
                  onContextMenu={(event) => onConnectionContextMenu(event, connection.id)}
                />
                <path
                  d={path}
                  stroke={active ? "var(--canvas-connection-active)" : "var(--canvas-connection-muted)"}
                  strokeWidth={active ? 3 : 2}
                  opacity={active ? 1 : 0.82}
                  fill="none"
                  className="pointer-events-none"
                  style={{ filter: active ? "drop-shadow(0 0 8px var(--canvas-connection-shadow))" : undefined }}
                />
              </g>
            );
          })}
          {preview ? <path d={activeCanvasConnectionPath(preview.start, preview.end)} stroke="var(--canvas-connection-active)" strokeWidth="2" strokeDasharray="5,5" fill="none" /> : null}
        </svg>

        {renderedNodes.map((node) => (
          <CanvasDOMNode
            key={node.id}
            node={node}
            showImageInfo={showImageInfo}
            selected={!exporting && selectedNodeIDs.has(node.id)}
            related={!exporting && related.nodeIDs.has(node.id)}
            focusRelated={!exporting && activeNodeID === node.id}
            showPanel={!exporting && panelNodeID === node.id}
            loading={!exporting && (loadingNodeID === node.id || node.generation_status === "loading")}
            now={generationNow}
            connecting={!exporting && Boolean(connecting)}
            connectionTarget={!exporting && connectionTargetID === node.id}
            configInputSummary={configInputSummaries.get(node.id) || { text: 0, image: 0, video: 0, audio: 0 }}
            groupChildCount={groupChildCounts.get(node.id) || 0}
            groupDropTarget={dropTargetGroupID === node.id}
            batchClosing={Boolean(node.batch_root_id && collapsingBatchRootIDs.has(node.batch_root_id))}
            batchOpening={openingBatchRootIDs.has(node.id)}
            batchRecovering={collapsingBatchRootIDs.has(node.id)}
            batchMotion={canvasBatchMotion(node, nodeByID)}
            onMouseDown={startNodeDrag}
            onSelectCapture={captureNodeSelection}
            onResize={startResize}
            onConnect={startConnection}
            onTitleChange={onTitleChange}
            onActivate={onNodeActivate}
            onViewImage={onViewImage}
            onDirectorOpen={onDirectorOpen}
            onTextToImage={onTextToImage}
            onRetry={onNodeRetry}
            onToggleBatch={onToggleBatch}
            onSetBatchPrimary={onSetBatchPrimary}
            onContextMenu={onNodeContextMenu}
            onMediaLoad={onNodeMediaLoad}
            onHoverStart={setHoveredNodeID}
            onHoverEnd={(nodeID) => setHoveredNodeID((current) => current === nodeID ? "" : current)}
          />
        ))}

        {!exporting && selectionBox ? (
          <div className="pointer-events-none absolute border border-[#1456f0] bg-[#1456f0]/10" style={selectionBoxStyle(selectionBox)} />
        ) : null}
      </div>
      {!exporting && panelNode ? (
        <div className="pointer-events-none absolute inset-y-3 right-3 z-50 flex max-w-[calc(100%-1.5rem)] items-start gap-2 sm:inset-y-4 sm:right-4 sm:max-w-[calc(100%-2rem)]">
          {renderNodeQuickActions ? <div data-canvas-no-pan className="pointer-events-auto mt-16 hidden shrink-0 sm:block" onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>{renderNodeQuickActions(panelNode)}</div> : null}
        <div
          data-canvas-no-pan
          data-canvas-node-drawer
          className="pointer-events-auto flex h-full w-[min(420px,calc(100vw-1.5rem))] min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card/95 shadow-[0_18px_60px_rgba(15,23,42,.2)] backdrop-blur-xl sm:w-[min(420px,calc(100vw-2rem))]"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border/70 px-3.5 py-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="flex shrink-0 items-center gap-1 rounded-lg bg-muted p-1">
                {panelNode.type !== "director" ? <button type="button" className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition", drawerView === "parameters" ? "bg-card text-[#1456f0] shadow-sm" : "text-muted-foreground hover:text-foreground")} onClick={() => setDrawerView("parameters")}>参数</button> : null}
                <button type="button" className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition", drawerView === "actions" ? "bg-card text-[#1456f0] shadow-sm" : "text-muted-foreground hover:text-foreground")} onClick={() => setDrawerView("actions")}>操作</button>
                <button type="button" className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition", drawerView === "info" ? "bg-card text-[#1456f0] shadow-sm" : "text-muted-foreground hover:text-foreground")} onClick={() => setDrawerView("info")}>详情</button>
              </div>
              <OverflowMarqueeText className="min-w-0 flex-1 text-xs font-medium text-muted-foreground" text={panelNode.title || (panelNode.type === "video" ? "视频" : panelNode.type === "audio" ? "音频" : panelNode.type === "panorama" ? "全景图" : panelNode.type === "director" ? "导演台" : panelNode.type === "config" ? "生成配置" : panelNode.type === "image" ? "图片" : "文字")} />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex size-8 items-center justify-center rounded-lg text-rose-600 transition hover:bg-rose-50 dark:hover:bg-rose-950/30" onClick={() => onNodeDelete(panelNode.id)} aria-label="删除节点"><Trash2 className="size-4" /></button></TooltipTrigger><TooltipContent>删除节点</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><button type="button" className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={() => onNodePanelToggle(panelNode.id)} aria-label="关闭节点抽屉"><X className="size-4" /></button></TooltipTrigger><TooltipContent>关闭节点抽屉</TooltipContent></Tooltip>
            </div>
          </div>
          {drawerView === "parameters" ? (
            <div className="min-h-0 flex-1 overflow-hidden p-3 sm:p-4">{renderNodePanel(panelNode)}</div>
          ) : (
            <ScrollArea className="min-h-0 flex-1" viewportClassName="p-3 sm:p-4">
              {drawerView === "actions" ? renderNodeActions(panelNode) : renderNodeInfo(panelNode)}
            </ScrollArea>
          )}
        </div>
        </div>
      ) : null}
    </div>
  );
}

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

function CanvasDOMNode({ node, showImageInfo, selected, related, focusRelated, showPanel, loading, now, connecting, connectionTarget, configInputSummary, groupChildCount, groupDropTarget, batchClosing, batchOpening, batchRecovering, batchMotion, onMouseDown, onSelectCapture, onResize, onConnect, onTitleChange, onActivate, onViewImage, onDirectorOpen, onTextToImage, onRetry, onToggleBatch, onSetBatchPrimary, onContextMenu, onMediaLoad, onHoverStart, onHoverEnd }: {
  node: CanvasNode;
  showImageInfo: boolean;
  selected: boolean;
  related: boolean;
  focusRelated: boolean;
  showPanel: boolean;
  loading: boolean;
  now: number;
  connecting: boolean;
  connectionTarget: boolean;
  configInputSummary: { text: number; image: number; video: number; audio: number };
  groupChildCount: number;
  groupDropTarget: boolean;
  batchClosing: boolean;
  batchOpening: boolean;
  batchRecovering: boolean;
  batchMotion?: { x: number; y: number; index: number };
  onMouseDown: (event: ReactMouseEvent, nodeID: string) => void;
  onSelectCapture: (event: ReactMouseEvent, nodeID: string) => void;
  onResize: (event: ReactPointerEvent<HTMLDivElement>, node: CanvasNode, corner: ResizeCorner) => void;
  onConnect: (event: ReactMouseEvent, nodeID: string, handleType: HandleType) => void;
  onTitleChange: (nodeID: string, title: string) => void;
  onActivate: (nodeID: string) => void;
  onViewImage: (nodeID: string) => void;
  onDirectorOpen: (nodeID: string) => void;
  onTextToImage: (nodeID: string) => void;
  onRetry: (nodeID: string) => void;
  onToggleBatch: (nodeID: string) => void;
  onSetBatchPrimary: (nodeID: string) => void;
  onContextMenu: (event: ReactMouseEvent, nodeID: string) => void;
  onMediaLoad: (nodeID: string, width: number, height: number, bytes?: number) => void;
  onHoverStart: (nodeID: string) => void;
  onHoverEnd: (nodeID: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title || "");
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const titleActivationTimerRef = useRef<number | null>(null);
  const active = selected || connectionTarget || focusRelated;
  const batchCount = node.batch_child_ids?.length || 0;
  const isBatchRoot = (node.type === "image" || node.type === "panorama") && batchCount > 1;
  const isBatchChild = Boolean(node.batch_root_id);
  const isGroup = node.type === "group";

  useEffect(() => {
    if (!editingTitle) setTitleDraft(node.title || "");
  }, [editingTitle, node.title]);

  useEffect(() => () => {
    if (titleActivationTimerRef.current !== null) window.clearTimeout(titleActivationTimerRef.current);
  }, []);

  const finishTitleEditing = useCallback(() => {
    const title = titleDraft.trim() || (node.type === "image" ? "图片" : node.type === "video" ? "视频" : node.type === "config" ? "生成配置" : node.type === "group" ? "组" : "文字");
    setTitleDraft(title);
    setEditingTitle(false);
    if (title !== node.title) onTitleChange(node.id, title);
  }, [node.id, node.title, node.type, onTitleChange, titleDraft]);

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

  const mediaNode = node.type === "image" || node.type === "video" || node.type === "audio" || node.type === "panorama" || node.type === "director";

  return (
    <div
      data-canvas-node
      data-node-id={node.id}
      className="group absolute overflow-visible"
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        zIndex: isGroup ? 5 : selected || showPanel ? 50 : 10,
        ...(isBatchChild ? {
          "--batch-from-x": `${batchMotion?.x || 0}px`,
          "--batch-from-y": `${batchMotion?.y || 0}px`,
          "--batch-from-rotate": `${6 + (batchMotion?.index || 0) * 4}deg`,
          animation: batchClosing ? "canvas-batch-child-out 260ms cubic-bezier(.4,0,.2,1) both" : "canvas-batch-child-in 340ms cubic-bezier(.2,.85,.18,1) both",
          animationDelay: batchClosing ? "0ms" : `${45 + (batchMotion?.index || 0) * 24}ms`,
        } as CSSProperties : {}),
      }}
      onMouseEnter={() => { setHovered(true); onHoverStart(node.id); }}
      onMouseLeave={() => { setHovered(false); onHoverEnd(node.id); }}
      onMouseDownCapture={(event) => onSelectCapture(event, node.id)}
      onContextMenu={(event) => onContextMenu(event, node.id)}
    >
      <div
        data-canvas-no-pan
        className="absolute top-[-30px] left-1/2 z-30 flex max-w-[calc(100%-16px)] -translate-x-1/2 justify-center"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {editingTitle ? (
          <input
            ref={titleInputRef}
            autoFocus
            value={titleDraft}
            maxLength={64}
            className="h-7 max-w-full rounded-md border border-border bg-card/92 px-2 text-center text-xs font-medium text-foreground shadow-sm outline-none backdrop-blur"
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
          <TooltipButton
            type="button"
            tooltip="双击修改节点名称"
            className="block h-7 max-w-full overflow-hidden rounded-md border border-transparent bg-card/78 px-2 text-center text-xs font-medium leading-7 text-foreground/70 shadow-sm backdrop-blur transition hover:border-border hover:bg-card hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              if (titleActivationTimerRef.current !== null) {
                window.clearTimeout(titleActivationTimerRef.current);
                titleActivationTimerRef.current = null;
              }
              if (event.detail > 1) return;
              titleActivationTimerRef.current = window.setTimeout(() => {
                titleActivationTimerRef.current = null;
                onActivate(node.id);
              }, 220);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (titleActivationTimerRef.current !== null) {
                window.clearTimeout(titleActivationTimerRef.current);
                titleActivationTimerRef.current = null;
              }
              setEditingTitle(true);
            }}
          >
            <OverflowMarqueeText text={node.title || (node.type === "image" ? "图片" : node.type === "video" ? "视频" : node.type === "audio" ? "音频" : node.type === "panorama" ? "全景图" : node.type === "director" ? "导演台" : node.type === "group" ? "组" : node.type === "config" ? "生成配置" : "文字")} />
          </TooltipButton>
        )}
      </div>
      {isGroup ? <div className="pointer-events-none absolute right-3 top-[-26px] z-30 text-xs text-muted-foreground">{groupChildCount} 个节点</div> : null}
      <div
        className={cn(
          "relative size-full transition-[border-color,box-shadow]",
          isGroup ? "rounded-xl border bg-card/35" : "rounded-2xl border-2",
          isBatchRoot ? "overflow-visible" : "overflow-hidden",
          mediaNode && node.url ? "bg-transparent" : "bg-card",
          groupDropTarget
            ? "border-[#1456f0] shadow-[0_0_0_2px_rgba(20,86,240,.4)]"
            : active
            ? "border-[#1456f0] shadow-[0_0_0_1px_rgba(20,86,240,.34)]"
            : related
              ? "border-[var(--canvas-connection-muted)] shadow-[0_0_0_1px_var(--canvas-connection-shadow)]"
              : mediaNode && node.url ? "border-transparent" : "border-border",
        )}
        onMouseDown={(event) => onMouseDown(event, node.id)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (isBatchRoot) onToggleBatch(node.id);
          else if ((node.type === "image" || node.type === "video" || node.type === "panorama") && node.url) onViewImage(node.id);
        }}
      >
        {isBatchRoot ? <CanvasBatchStack count={batchCount} expanded={Boolean(node.batch_expanded)} opening={batchOpening} recovering={batchRecovering} /> : null}
        {isGroup ? null : node.type === "config" ? (
          <div className="flex size-full flex-col bg-card px-4 py-4">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600"><Settings2 className="size-5" /></span>
              <div className="min-w-0"><div className="text-sm font-semibold">生成配置</div><div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground"><span className="rounded-md bg-muted px-2 py-1">提示词 {configInputSummary.text} 个</span><span className="rounded-md bg-muted px-2 py-1">参考图 {configInputSummary.image} 张</span><span className="rounded-md bg-muted px-2 py-1">视频 {configInputSummary.video} 个</span><span className="rounded-md bg-muted px-2 py-1">音频 {configInputSummary.audio} 个</span></div></div>
            </div>
          </div>
        ) : node.type === "director" ? <CanvasDirectorNodePanel onOpen={() => onDirectorOpen(node.id)} /> : node.type === "audio" || node.type === "panorama" ? <CanvasSpecialNodeContent node={node} onPanoramaOpen={node.type === "panorama" && node.url ? () => onViewImage(node.id) : undefined} onPanoramaMoveStart={node.type === "panorama" ? (event) => onMouseDown(event, node.id) : undefined} /> : (node.type === "image" || node.type === "video" || node.type === "text") && node.generation_status === "error" ? (
          <div className="flex size-full flex-col items-center justify-center gap-3 bg-card px-6 text-center">
            <span className="grid size-9 place-items-center rounded-full bg-rose-500/10 text-rose-600"><AlertCircle className="size-4.5" /></span>
            <ScrollArea
              data-canvas-no-pan
              data-canvas-no-zoom
              className="max-h-[calc(100%-88px)] max-w-[260px] text-muted-foreground"
              viewportClassName="px-1"
              viewClass="whitespace-pre-wrap break-words text-xs leading-5"
              onWheel={(event) => event.stopPropagation()}
            >
              {node.generation_error || "生成失败"}
            </ScrollArea>
            <button data-canvas-no-pan type="button" className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground shadow-sm transition hover:bg-muted" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRetry(node.id); }}><RefreshCw className="size-3.5" />重试</button>
          </div>
        ) : node.type === "image" || node.type === "video" ? node.url ? (
          node.type === "video" ? (
            <CanvasVideoNodePlayer
              src={node.url}
              title={node.title || node.prompt || "画布视频"}
              selected={selected}
              onOpen={() => onViewImage(node.id)}
              onMediaLoad={(width, height) => onMediaLoad(node.id, width, height)}
            />
          ) : <AuthenticatedImage src={node.url} alt={node.title || node.prompt || "画布图片"} draggable={false} className="pointer-events-none size-full rounded-[inherit] object-contain" onLoad={(event) => onMediaLoad(node.id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight, getCachedAuthenticatedImageByteSize(node.url))} />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-3 bg-muted/35 text-muted-foreground">
            <span className="flex size-12 items-center justify-center rounded-xl bg-[#e7efff] text-[#1456f0] dark:bg-blue-950/50 dark:text-blue-300">
              {node.type === "video" ? <Video className="size-5" /> : <ImagePlus className="size-5" />}
            </span>
            <span className="text-[11px] tracking-[0.16em] text-muted-foreground">
              {node.type === "video" ? "空视频节点" : "空图片节点"}
            </span>
          </div>
        ) : (
          <ScrollArea data-canvas-no-zoom className="size-full" viewportClassName="bg-card px-4 py-4 pr-20" viewClass="whitespace-pre-wrap break-words font-mono" style={{ fontSize: node.font_size || 14, lineHeight: 1.6 }} onWheel={(event) => event.stopPropagation()}>
            {node.prompt || <span className="text-muted-foreground">暂无文字内容</span>}
          </ScrollArea>
        )}
        {showImageInfo && node.type === "image" && node.url ? <div data-canvas-image-info className="pointer-events-none absolute bottom-2 right-2 z-20 flex max-w-[calc(100%-16px)] items-center justify-end gap-1.5 text-[10px] leading-none text-white drop-shadow-[0_1px_3px_rgba(0,0,0,.9)]"><span className="shrink-0 tabular-nums">{node.natural_width && node.natural_height ? `${node.natural_width} × ${node.natural_height}` : `${Math.round(node.width)} × ${Math.round(node.height)}`}</span>{formatImageBytes(node.bytes) ? <span className="shrink-0 tabular-nums">{formatImageBytes(node.bytes)}</span> : null}</div> : null}
        {node.type === "text" && node.generation_status !== "loading" && node.generation_status !== "error" ? <button data-canvas-no-pan type="button" className="absolute top-3 right-3 z-20 flex h-8 items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 text-xs font-medium shadow-sm backdrop-blur hover:bg-muted" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onTextToImage(node.id); }}><ImagePlus className="size-3.5" />生图</button> : null}
        {loading && node.type !== "config" ? (node.type === "audio" || node.type === "panorama") ? <SpecialNodeLoading /> : !isBatchRoot || !node.url ? <CanvasGenerationLoading node={node} now={now} /> : null : null}
        {isBatchRoot ? <button data-canvas-no-pan type="button" aria-label={node.batch_expanded ? "收起图片组" : "展开图片组"} className="absolute top-2.5 right-2.5 z-40 flex h-8 items-center gap-1 rounded-full border border-border bg-card/90 px-2.5 text-xs font-semibold shadow-sm backdrop-blur" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onToggleBatch(node.id); }}><span className="text-[#1456f0]">{batchCount}</span><ChevronRight className={cn("size-3.5 transition-transform", node.batch_expanded && "rotate-90")} /></button> : null}
        {isBatchChild && node.url ? <button data-canvas-no-pan type="button" className="absolute top-2.5 right-2.5 z-40 flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card/90 px-2.5 text-xs font-medium opacity-100 shadow-sm backdrop-blur transition-opacity sm:opacity-0 sm:group-hover:opacity-100" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSetBatchPrimary(node.id); }}><Star className="size-3.5 text-[#1456f0]" />设为主图</button> : null}
      </div>
      {!isGroup ? <ConnectionHandle side="left" visible={hovered || selected || connecting} onMouseDown={(event) => onConnect(event, node.id, "target")} /> : null}
      {!isGroup ? <ConnectionHandle side="right" visible={node.type !== "config" && (hovered || selected || connecting)} onMouseDown={(event) => onConnect(event, node.id, "source")} /> : null}
      {(["top-left", "top-right", "bottom-left", "bottom-right"] as ResizeCorner[]).map((corner) => <ResizeHandle key={corner} corner={corner} visible={selected || hovered} onPointerDown={(event) => onResize(event, node, corner)} />)}
    </div>
  );
}

function CanvasGenerationLoading({ node, now }: { node: CanvasNode; now: number }) {
  const fallbackStartedAt = useRef(Date.now());
  const startedAt = node.generation_started_at || fallbackStartedAt.current;
  const progress = Math.max(0, Math.min(100, Math.round(node.generation_progress || 0)));
  const elapsed = formatGenerationElapsed(now - startedAt);

  if (node.type === "video") {
    return (
      <div className="pointer-events-none absolute inset-0 z-30 flex flex-col justify-between rounded-[inherit] bg-card p-4 text-foreground">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
          <LoaderCircle className="size-9 animate-spin text-[#1456f0]" />
          <span className="text-sm font-semibold text-[#1456f0]">正在创作 {progress}%</span>
          <span className="rounded-full bg-muted px-2 py-1 text-xs tabular-nums">{elapsed}</span>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>当前创作进度</span><span>{progress}%</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-[#1456f0] transition-[width]" style={{ width: `${progress}%` }} /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 rounded-[inherit] bg-card text-[#1456f0]">
      <LoaderCircle className="size-8 animate-spin" />
      <span className="text-[10px] font-medium tracking-[0.16em]">{progress > 0 ? `生成中 ${progress}%` : "生成中"}</span>
      <span className="rounded-full border border-border px-2 py-1 text-xs tabular-nums text-foreground">{elapsed}</span>
      {progress > 0 ? <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-[#1456f0] transition-[width]" style={{ width: `${progress}%` }} /></div> : null}
    </div>
  );
}

function CanvasBatchStack({ count, expanded, opening, recovering }: { count: number; expanded: boolean; opening: boolean; recovering: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-visible">
      {Array.from({ length: Math.min(Math.max(0, count - 1), 5) }, (_, index) => (
        <span
          key={index}
          className="absolute inset-0 rounded-2xl border border-border bg-card shadow-[0_12px_28px_rgba(15,23,42,.11)] transition-transform duration-300"
          style={{
            opacity: expanded && !opening ? 0.34 : 1,
            transform: opening || recovering
              ? `translate(${54 + index * 22}px, ${20 + index * 12}px) rotate(${8 + index * 5}deg) scale(.98)`
              : `translate(${34 + index * 18}px, ${14 + index * 10}px) rotate(${6 + index * 4}deg)`,
          }}
        />
      ))}
    </div>
  );
}

function ConnectionHandle({ side, visible, onMouseDown }: { side: "left" | "right"; visible: boolean; onMouseDown: (event: ReactMouseEvent) => void }) {
  return <div data-connection-handle={side === "left" ? "target" : "source"} className={cn("absolute z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150", visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0")} style={{ top: "50%", left: side === "left" ? -24 : undefined, right: side === "right" ? -24 : undefined }} onMouseDown={onMouseDown}><div className="size-3 rounded-full border-2 border-[var(--canvas-connection-muted)] bg-card transition-transform hover:scale-125" /></div>;
}

function ResizeHandle({ corner, visible, onPointerDown }: { corner: ResizeCorner; visible: boolean; onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void }) {
  const position = { "top-left": "-top-[14px] -left-[14px] cursor-nwse-resize", "top-right": "-top-[14px] -right-[14px] cursor-nesw-resize", "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize", "bottom-right": "-right-[14px] -bottom-[14px] cursor-nwse-resize" }[corner];
  return <div data-resize-handle={corner} className={cn("absolute z-40 flex size-7 touch-none items-center justify-center transition-opacity", position, visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0")} onPointerDown={onPointerDown}><span className="size-2.5 rounded-full border-2 border-[#1456f0] bg-card shadow-sm" /></div>;
}

function connectionPreview(origin: ConnectionOrigin | null, targetID: string, mouse: Point, nodeByID: Map<string, CanvasNode>) {
  if (!origin) return null;
  const node = nodeByID.get(origin.nodeID);
  if (!node) return null;
  const target = targetID ? nodeByID.get(targetID) : null;
  if (origin.handleType === "source") return { start: { x: node.x + node.width, y: node.y + node.height / 2 }, end: target ? { x: target.x, y: target.y + target.height / 2 } : mouse };
  return { start: target ? { x: target.x + target.width, y: target.y + target.height / 2 } : mouse, end: { x: node.x, y: node.y + node.height / 2 } };
}

function selectionBoxStyle(box: SelectionBox) {
  const left = Math.min(box.start.x, box.current.x);
  const top = Math.min(box.start.y, box.current.y);
  return { left, top, width: Math.abs(box.current.x - box.start.x), height: Math.abs(box.current.y - box.start.y) };
}
