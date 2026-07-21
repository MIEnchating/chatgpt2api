import { AlertCircle, Brush, Camera, ChevronRight, Copy, Download, Grid2X2, ImagePlus, Info, LoaderCircle, Lock, LockOpen, Maximize2, Minus, MoreHorizontal, Pencil, Play, Plus, RefreshCw, Scissors, Settings2, Sparkles, Star, Trash2, Upload, WandSparkles, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";

import { AuthenticatedImage } from "@/components/authenticated-image";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { canvasNodeToolbarPlacement } from "@/app/canvas/canvas-floating-panel";
import { canvasNodeAspectRatio } from "@/app/canvas/canvas-node-geometry";
import { canGenerateCanvasConfig, canvasConfigInputs } from "@/app/canvas/canvas-config-inputs";
import { CanvasImageParameterPopover } from "@/app/canvas/canvas-image-parameters";
import { canvasBatchMotion, expandCanvasBatchNodeIDs, visibleCanvasNodes } from "@/app/canvas/canvas-batches";
import { CanvasResourceMentionTextarea } from "@/app/canvas/canvas-resource-mention-textarea";
import { canvasNodeMentionReferences, canvasResourceLabels, type CanvasResourceLabel, type CanvasResourceReference } from "@/app/canvas/canvas-resources";
import type { CanvasConnection, CanvasDocument, CanvasNode } from "@/lib/api";
import { cn } from "@/lib/utils";

type SelectionBox = { start: Point; current: Point; initialIDs: string[]; additive: boolean };

type CanvasEngineProps = {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasDocument["viewport"];
  background: CanvasDocument["background"];
  canvasSize: { width: number; height: number };
  exporting?: boolean;
  exportBounds?: CanvasExportBounds;
  selectedNodeIDs: Set<string>;
  selectedConnectionID: string;
  panelNodeID: string;
  runningNodeID: string;
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
  onPromptChange: (nodeID: string, prompt: string, commit?: boolean) => void;
  onTextFontSizeChange: (nodeID: string, fontSize: number) => void;
  onTitleChange: (nodeID: string, title: string) => void;
  onNodePanelToggle: (nodeID: string) => void;
  onNodeGenerate: (nodeID: string) => void;
  onNodeStop: () => void;
  onNodeParametersChange: (nodeID: string, patch: Partial<CanvasNode>) => void;
  onNodeUpload: (nodeID: string) => void;
  onToggleFreeResize: (nodeID: string) => void;
  onCropImage: (nodeID: string) => void;
  onSplitImage: (nodeID: string) => void;
  onUpscaleImage: (nodeID: string) => void;
  onMaskEdit: (nodeID: string) => void;
  onAngleImage: (nodeID: string) => void;
  uploadingNodeID: string;
  onViewImage: (nodeID: string) => void;
  onCopyPrompt: (nodeID: string) => void;
  onDownloadImage: (nodeID: string) => void;
  onTextToImage: (nodeID: string) => void;
  onNodeRetry: (nodeID: string) => void;
  onNodeActivate: (nodeID: string) => void;
  onToggleBatch: (nodeID: string) => void;
  onSetBatchPrimary: (nodeID: string) => void;
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
  canvasSize,
  exporting = false,
  exportBounds,
  selectedNodeIDs,
  selectedConnectionID,
  panelNodeID,
  runningNodeID,
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
  onPromptChange,
  onTextFontSizeChange,
  onTitleChange,
  onNodePanelToggle,
  onNodeGenerate,
  onNodeStop,
  onNodeParametersChange,
  onNodeUpload,
  onToggleFreeResize,
  onCropImage,
  onSplitImage,
  onUpscaleImage,
  onMaskEdit,
  onAngleImage,
  uploadingNodeID,
  onViewImage,
  onCopyPrompt,
  onDownloadImage,
  onTextToImage,
  onNodeRetry,
  onNodeActivate,
  onToggleBatch,
  onSetBatchPrimary,
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
  const panRef = useRef({ active: false, startX: 0, startY: 0, initialX: 0, initialY: 0, moved: false, preserveSelection: false });
  const dragRef = useRef<{ active: boolean; moved: boolean; startX: number; startY: number; initial: Array<{ id: string; x: number; y: number }> }>({ active: false, moved: false, startX: 0, startY: 0, initial: [] });
  const resizeRef = useRef<{ active: boolean; nodeID: string; corner: ResizeCorner; startX: number; startY: number; node: CanvasNode | null }>({ active: false, nodeID: "", corner: "bottom-right", startX: 0, startY: 0, node: null });
  const connectionRef = useRef<ConnectionOrigin | null>(null);
  const pendingConnectionWasActiveRef = useRef(false);
  const selectionRef = useRef<SelectionBox | null>(null);
  const pendingSelectionRef = useRef<Set<string> | null>(null);
  const spacePressedRef = useRef(false);
  const [connecting, setConnecting] = useState<ConnectionOrigin | null>(null);
  const [mouseWorld, setMouseWorld] = useState<Point>({ x: 0, y: 0 });
  const [connectionTargetID, setConnectionTargetID] = useState("");
  const [hoveredNodeID, setHoveredNodeID] = useState("");
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [textEditRequest, setTextEditRequest] = useState({ nodeID: "", nonce: 0 });
  const [nodeDragging, setNodeDragging] = useState(false);

  nodesRef.current = nodes;
  viewportRef.current = viewport;
  selectedRef.current = selectedNodeIDs;

  const nodeByID = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const batchVisibleNodes = useMemo(() => visibleCanvasNodes(nodes, collapsingBatchRootIDs), [collapsingBatchRootIDs, nodes]);
  const renderedNodes = useMemo(() => exporting ? batchVisibleNodes : canvasNodesInViewport(batchVisibleNodes, viewport, canvasSize), [batchVisibleNodes, canvasSize, exporting, viewport]);
  const connectionNodeIDs = useMemo(() => new Set(batchVisibleNodes.map((node) => node.id)), [batchVisibleNodes]);
  const renderedNodeIDs = useMemo(() => new Set(renderedNodes.map((node) => node.id)), [renderedNodes]);
  const configInputSummaries = useMemo(() => {
    const summaries = new Map<string, { text: number; image: number; canGenerate: boolean }>();
    nodes.forEach((node) => {
      if (node.type !== "config") return;
      const inputs = canvasConfigInputs(node.id, nodes, connections);
      summaries.set(node.id, {
        text: inputs.filter((input) => input.type === "text").length,
        image: inputs.filter((input) => input.type === "image").length,
        canGenerate: canGenerateCanvasConfig(node, inputs),
      });
    });
    return summaries;
  }, [connections, nodes]);

  useEffect(() => {
    if (hoveredNodeID && !renderedNodeIDs.has(hoveredNodeID)) setHoveredNodeID("");
  }, [hoveredNodeID, renderedNodeIDs]);

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
    const draggedIDs = expandCanvasBatchNodeIDs(selected, nodesRef.current);
    pendingSelectionRef.current = null;
    dragRef.current = {
      active: true,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
      initial: nodesRef.current.filter((node) => draggedIDs.has(node.id)).map((node) => ({ id: node.id, x: node.x, y: node.y })),
    };
    setNodeDragging(true);
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
    onSelectionChange(pendingSelectionRef.current ?? selectedRef.current, "");
    pendingSelectionRef.current = null;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    const overCanvasControl = Boolean(target?.closest("[data-canvas-no-pan]"));
    const overNodeOrConnection = Boolean(target?.closest("[data-canvas-node],[data-connection-id]"));
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
    if (target?.closest("[data-canvas-no-zoom],[role='dialog'],[role='listbox']")) return;
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
    const preventWheel = (event: WheelEvent) => event.preventDefault();
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
    const handleMove = (event: PointerEvent) => {
      if (panRef.current.active) {
        const dx = event.clientX - panRef.current.startX;
        const dy = event.clientY - panRef.current.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panRef.current.moved = true;
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          const next = { ...viewportRef.current, x: panRef.current.initialX + dx, y: panRef.current.initialY + dy };
          viewportRef.current = next;
          onViewportChange(next);
        });
        return;
      }
      if (dragRef.current.active) {
        const dx = (event.clientX - dragRef.current.startX) / viewportRef.current.zoom;
        const dy = (event.clientY - dragRef.current.startY) / viewportRef.current.zoom;
        if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) dragRef.current.moved = true;
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
        let width = Math.max(220, start.width + (left ? -dx : dx));
        let height = Math.max(160, start.height + (top ? -dy : dy));
        if (start.type === "image" && !start.free_resize) {
          const ratio = canvasNodeAspectRatio(start);
          if (Math.abs(dx) >= Math.abs(dy)) height = width / ratio;
          else width = height * ratio;
          if (height < 160) { height = 160; width = height * ratio; }
          if (width < 220) { width = 220; height = width / ratio; }
        }
        onNodesChange(nodesRef.current.map((node) => node.id === start.id ? { ...node, x: left ? start.x + start.width - width : start.x, y: top ? start.y + start.height - height : start.y, width, height } : node));
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
        if (frameRef.current) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        if (!wasCancelled && wasMoved) {
          const next = { ...viewportRef.current, x: panRef.current.initialX + dx, y: panRef.current.initialY + dy };
          viewportRef.current = next;
          onViewportChange(next, true);
        } else if (!wasCancelled && !panRef.current.preserveSelection) {
          onSelectionChange(new Set(), "");
        }
      }
      if (dragRef.current.active) {
        const wasClick = event.type !== "pointercancel" && !dragRef.current.moved && dragRef.current.initial.length === 1;
        const clickedNodeID = dragRef.current.initial[0]?.id || "";
        const moved = dragRef.current.moved;
        dragRef.current.active = false;
        dragRef.current.moved = false;
        dragRef.current.initial = [];
        setNodeDragging(false);
        if (moved) onNodesCommit();
        else if (wasClick && clickedNodeID) onNodeActivate(clickedNodeID);
      }
      if (resizeRef.current.active) {
        resizeRef.current.active = false;
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
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (panRef.current.active && panRef.current.moved) onViewportChange(viewportRef.current, true);
      if (dragRef.current.active && dragRef.current.moved) onNodesCommit();
      if (resizeRef.current.active) onNodesCommit();
      panRef.current.active = false;
      dragRef.current.active = false;
      dragRef.current.moved = false;
      dragRef.current.initial = [];
      setNodeDragging(false);
      resizeRef.current.active = false;
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
  const resourceLabels = useMemo(
    () => canvasResourceLabels(nodes, connections, panelNodeID || activeNodeID),
    [activeNodeID, connections, nodes, panelNodeID],
  );
  const mentionReferencesByNodeID = useMemo(() => {
    const references = new Map<string, CanvasResourceReference[]>();
    nodes.forEach((node) => references.set(node.id, canvasNodeMentionReferences(node.id, nodes, connections)));
    return references;
  }, [connections, nodes]);
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
  const toolbarNodeID = selectedNodeIDs.size === 1 ? Array.from(selectedNodeIDs)[0] : "";
  const toolbarNode = toolbarNodeID ? nodeByID.get(toolbarNodeID) || null : null;
  const panelNode = panelNodeID ? nodeByID.get(panelNodeID) || null : null;
  const panelWidth = Math.min(500, Math.max(280, (containerRef.current?.clientWidth || 532) - 32));
  const panelNodeTop = panelNode ? viewport.y + panelNode.y * viewport.zoom : 0;
  const panelNodeBottom = panelNode ? viewport.y + (panelNode.y + panelNode.height) * viewport.zoom : 0;
  const panelHeight = 154;
  const canvasHeight = containerRef.current?.clientHeight || window.innerHeight;
  const spaceBelow = canvasHeight - panelNodeBottom - 88;
  const spaceAbove = panelNodeTop - 16;
  const panelLeft = panelNode
    ? Math.max(16 + panelWidth / 2, Math.min((containerRef.current?.clientWidth || window.innerWidth) - 16 - panelWidth / 2, viewport.x + (panelNode.x + panelNode.width / 2) * viewport.zoom))
    : 0;
  const panelTop = spaceBelow >= panelHeight
    ? panelNodeBottom + 12
    : spaceAbove >= panelHeight
      ? panelNodeTop - panelHeight - 12
      : Math.max(16, canvasHeight - panelHeight - 16);

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
            selected={!exporting && selectedNodeIDs.has(node.id)}
            related={!exporting && related.nodeIDs.has(node.id)}
            focusRelated={!exporting && activeNodeID === node.id}
            showPanel={!exporting && panelNodeID === node.id}
            running={runningNodeID === node.id}
            loading={!exporting && (loadingNodeID === node.id || node.generation_status === "loading")}
            connecting={!exporting && Boolean(connecting)}
            connectionTarget={!exporting && connectionTargetID === node.id}
            resourceLabel={exporting ? undefined : resourceLabels.get(node.id)}
            mentionReferences={mentionReferencesByNodeID.get(node.id) || []}
            configInputSummary={configInputSummaries.get(node.id) || { text: 0, image: 0, canGenerate: false }}
            batchClosing={Boolean(node.batch_root_id && collapsingBatchRootIDs.has(node.batch_root_id))}
            batchOpening={openingBatchRootIDs.has(node.id)}
            batchRecovering={collapsingBatchRootIDs.has(node.id)}
            batchMotion={canvasBatchMotion(node, nodeByID)}
            onMouseDown={startNodeDrag}
            onSelectCapture={captureNodeSelection}
            onResize={startResize}
            onConnect={startConnection}
            onPromptChange={onPromptChange}
            onTitleChange={onTitleChange}
            editRequestNonce={textEditRequest.nodeID === node.id ? textEditRequest.nonce : 0}
            onViewImage={onViewImage}
            onTextToImage={onTextToImage}
            onRetry={onNodeRetry}
            onToggleBatch={onToggleBatch}
            onSetBatchPrimary={onSetBatchPrimary}
            onContextMenu={onNodeContextMenu}
            onGenerate={onNodeGenerate}
            onStop={onNodeStop}
            onParametersChange={onNodeParametersChange}
            onHoverStart={setHoveredNodeID}
            onHoverEnd={(nodeID) => setHoveredNodeID((current) => current === nodeID ? "" : current)}
          />
        ))}

        {!exporting && selectionBox ? (
          <div className="pointer-events-none absolute border border-[#1456f0] bg-[#1456f0]/10" style={selectionBoxStyle(selectionBox)} />
        ) : null}
      </div>
      {!exporting && panelNode ? (
        <div
          data-canvas-no-pan
          className="absolute z-40"
          style={{ left: panelLeft, top: panelTop, width: panelWidth, transform: "translateX(-50%)" }}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          {renderNodePanel(panelNode)}
        </div>
      ) : null}
      {!exporting && toolbarNode && !nodeDragging ? (
        <CanvasNodeToolbar
          node={toolbarNode}
          viewport={viewport}
          canvasWidth={canvasSize.width}
          showPanel={panelNodeID === toolbarNode.id}
          running={runningNodeID === toolbarNode.id || loadingNodeID === toolbarNode.id || toolbarNode.generation_status === "loading"}
          uploading={uploadingNodeID === toolbarNode.id}
          onInfo={() => onNodeInfo(toolbarNode.id)}
          onEditText={() => setTextEditRequest((current) => ({ nodeID: toolbarNode.id, nonce: current.nonce + 1 }))}
          onDecreaseFont={() => onTextFontSizeChange(toolbarNode.id, Math.max(10, (toolbarNode.font_size || 14) - 2))}
          onIncreaseFont={() => onTextFontSizeChange(toolbarNode.id, Math.min(32, (toolbarNode.font_size || 14) + 2))}
          onPanelToggle={() => onNodePanelToggle(toolbarNode.id)}
            onUpload={() => onNodeUpload(toolbarNode.id)}
            onToggleFreeResize={() => onToggleFreeResize(toolbarNode.id)}
            onCropImage={() => onCropImage(toolbarNode.id)}
            onSplitImage={() => onSplitImage(toolbarNode.id)}
            onUpscaleImage={() => onUpscaleImage(toolbarNode.id)}
            onMaskEdit={() => onMaskEdit(toolbarNode.id)}
            onAngleImage={() => onAngleImage(toolbarNode.id)}
          onViewImage={() => onViewImage(toolbarNode.id)}
          onCopyPrompt={() => onCopyPrompt(toolbarNode.id)}
          onDownloadImage={() => onDownloadImage(toolbarNode.id)}
          onTextToImage={() => onTextToImage(toolbarNode.id)}
          onRetry={() => onNodeRetry(toolbarNode.id)}
          onDelete={() => onNodeDelete(toolbarNode.id)}
        />
      ) : null}
    </div>
  );
}

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

function CanvasDOMNode({ node, selected, related, focusRelated, showPanel, running, loading, connecting, connectionTarget, resourceLabel, mentionReferences, configInputSummary, batchClosing, batchOpening, batchRecovering, batchMotion, onMouseDown, onSelectCapture, onResize, onConnect, onPromptChange, onTitleChange, editRequestNonce, onViewImage, onTextToImage, onRetry, onToggleBatch, onSetBatchPrimary, onContextMenu, onGenerate, onStop, onParametersChange, onHoverStart, onHoverEnd }: {
  node: CanvasNode;
  selected: boolean;
  related: boolean;
  focusRelated: boolean;
  showPanel: boolean;
  running: boolean;
  loading: boolean;
  connecting: boolean;
  connectionTarget: boolean;
  resourceLabel?: CanvasResourceLabel;
  mentionReferences: readonly CanvasResourceReference[];
  configInputSummary: { text: number; image: number; canGenerate: boolean };
  batchClosing: boolean;
  batchOpening: boolean;
  batchRecovering: boolean;
  batchMotion?: { x: number; y: number; index: number };
  onMouseDown: (event: ReactMouseEvent, nodeID: string) => void;
  onSelectCapture: (event: ReactMouseEvent, nodeID: string) => void;
  onResize: (event: ReactMouseEvent, node: CanvasNode, corner: ResizeCorner) => void;
  onConnect: (event: ReactMouseEvent, nodeID: string, handleType: HandleType) => void;
  onPromptChange: (nodeID: string, prompt: string, commit?: boolean) => void;
  onTitleChange: (nodeID: string, title: string) => void;
  editRequestNonce: number;
  onViewImage: (nodeID: string) => void;
  onTextToImage: (nodeID: string) => void;
  onRetry: (nodeID: string) => void;
  onToggleBatch: (nodeID: string) => void;
  onSetBatchPrimary: (nodeID: string) => void;
  onContextMenu: (event: ReactMouseEvent, nodeID: string) => void;
  onGenerate: (nodeID: string) => void;
  onStop: () => void;
  onParametersChange: (nodeID: string, patch: Partial<CanvasNode>) => void;
  onHoverStart: (nodeID: string) => void;
  onHoverEnd: (nodeID: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title || "");
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const active = selected || connectionTarget || focusRelated;
  const batchCount = node.batch_child_ids?.length || 0;
  const isBatchRoot = node.type === "image" && batchCount > 1;
  const isBatchChild = Boolean(node.batch_root_id);
  const configCanGenerate = node.type !== "config" || configInputSummary.canGenerate;

  useEffect(() => {
    if (!editingTitle) setTitleDraft(node.title || "");
  }, [editingTitle, node.title]);

  const finishTitleEditing = useCallback(() => {
    const title = titleDraft.trim() || (node.type === "image" ? "图片" : node.type === "config" ? "生成配置" : "想法");
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
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        zIndex: selected || showPanel ? 50 : 10,
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
      <div data-canvas-no-pan className="absolute top-[-30px] left-2 z-30 max-w-[calc(100%-16px)]" onMouseDown={(event) => event.stopPropagation()}>
        {editingTitle ? (
          <input
            ref={titleInputRef}
            autoFocus
            value={titleDraft}
            maxLength={64}
            className="h-7 max-w-full rounded-md border border-border bg-card/92 px-2 text-left text-xs font-medium text-foreground shadow-sm outline-none backdrop-blur"
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
            className="block h-7 max-w-full truncate rounded-md border border-transparent bg-card/78 px-2 text-left text-xs font-medium leading-7 text-foreground/70 shadow-sm backdrop-blur transition hover:border-border hover:bg-card hover:text-foreground"
            onDoubleClick={(event) => {
              event.stopPropagation();
              setEditingTitle(true);
            }}
          >
            {node.title || (node.type === "image" ? "图片" : node.type === "config" ? "生成配置" : "想法")}
          </button>
        )}
      </div>
      <div
        className={cn(
          "relative size-full rounded-2xl border-2 transition-[border-color,box-shadow]",
          isBatchRoot ? "overflow-visible" : "overflow-hidden",
          node.type === "image" && node.url ? "bg-transparent" : "bg-card",
          active
            ? "border-[#1456f0] shadow-[0_0_0_1px_rgba(20,86,240,.34)]"
            : related
              ? "border-[var(--canvas-connection-muted)] shadow-[0_0_0_1px_var(--canvas-connection-shadow)]"
              : node.type === "image" && node.url ? "border-transparent" : "border-border",
        )}
        onMouseDown={(event) => onMouseDown(event, node.id)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (isBatchRoot) onToggleBatch(node.id);
          else if (node.type === "image" && node.url) onViewImage(node.id);
          else if (node.type === "text") setEditing(true);
        }}
      >
        {isBatchRoot ? <CanvasBatchStack count={batchCount} expanded={Boolean(node.batch_expanded)} opening={batchOpening} recovering={batchRecovering} /> : null}
        {node.type === "config" ? (
          <div className="flex size-full flex-col justify-between bg-card px-4 py-4">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600"><Settings2 className="size-5" /></span>
              <div className="min-w-0"><div className="text-sm font-semibold">生成配置</div><div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground"><span className="rounded-md bg-muted px-2 py-1">提示词 {configInputSummary.text} 个</span><span className="rounded-md bg-muted px-2 py-1">参考图 {configInputSummary.image} 张</span></div></div>
            </div>
            <div data-canvas-no-pan className="flex items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
              <CanvasImageParameterPopover node={node} onChange={(patch) => onParametersChange(node.id, patch)} />
              <button data-canvas-no-pan type="button" disabled={!running && !configCanGenerate} className={cn("flex h-9 min-w-24 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-xs font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-45", running ? "bg-rose-600 hover:bg-rose-700" : "bg-[#1456f0] hover:bg-[#0f45c8]")} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); if (running) onStop(); else onGenerate(node.id); }}>{running ? <><LoaderCircle className="size-3.5 animate-spin" />停止</> : <><Play className="size-3.5 fill-current" />开始生成</>}</button>
            </div>
          </div>
        ) : node.type === "image" ? node.generation_status === "error" ? (
          <div className="flex size-full flex-col items-center justify-center gap-3 bg-card px-6 text-center">
            <span className="grid size-9 place-items-center rounded-full bg-rose-500/10 text-rose-600"><AlertCircle className="size-4.5" /></span>
            <span className="max-w-[260px] text-xs leading-5 text-muted-foreground">{node.generation_error || "生成失败"}</span>
            <button data-canvas-no-pan type="button" className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground shadow-sm transition hover:bg-muted" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRetry(node.id); }}><RefreshCw className="size-3.5" />重试</button>
          </div>
        ) : node.url ? (
          <AuthenticatedImage src={node.url} alt={node.title || node.prompt || "画布图片"} draggable={false} className="pointer-events-none size-full rounded-[inherit] object-contain" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-3 bg-muted/35 text-muted-foreground">
            <span className="flex size-12 items-center justify-center rounded-xl bg-[#e7efff] text-[#1456f0]"><ImagePlus className="size-5" /></span>
            <span className="text-[11px] tracking-[0.16em] text-muted-foreground">空图片节点</span>
          </div>
        ) : editing ? (
          <CanvasResourceMentionTextarea
            ref={textEditorRef}
            autoFocus
            data-canvas-no-pan
            data-canvas-no-zoom
            value={node.prompt || ""}
            references={mentionReferences}
            highlightLabels={false}
            containerClassName="size-full"
            className="size-full resize-none border-0 bg-card px-4 py-4 pr-20 font-mono outline-none"
            style={{ fontSize: node.font_size || 14, lineHeight: 1.6 }}
            placeholder="输入你的想法"
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onChange={(value) => onPromptChange(node.id, value)}
            onBlur={(event) => { onPromptChange(node.id, event.target.value, true); setEditing(false); }}
            onKeyDown={(event) => { if (event.key === "Escape") finishTextEditing(); }}
          />
        ) : (
          <div data-canvas-no-zoom className="size-full overflow-y-auto whitespace-pre-wrap break-words bg-card px-4 py-4 pr-20 font-mono" style={{ fontSize: node.font_size || 14, lineHeight: 1.6 }} onWheel={(event) => event.stopPropagation()}>
            {node.prompt || <span className="text-muted-foreground">双击输入想法</span>}
          </div>
        )}
        {node.type === "text" ? <button data-canvas-no-pan type="button" className="absolute top-3 right-3 z-20 flex h-8 items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 text-xs font-medium shadow-sm backdrop-blur hover:bg-muted" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onTextToImage(node.id); }}><ImagePlus className="size-3.5" />生图</button> : null}
        {loading && node.type !== "config" ? node.url ? (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[inherit] bg-black/20">
            <span className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-2 text-xs font-medium text-white"><LoaderCircle className="size-4 animate-spin" />生成中</span>
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 rounded-[inherit] bg-card text-[#1456f0]">
            <LoaderCircle className="size-8 animate-spin" />
            <span className="text-[10px] font-medium tracking-[0.16em]">生成中</span>
          </div>
        ) : null}
        {isBatchRoot ? <button data-canvas-no-pan type="button" aria-label={node.batch_expanded ? "收起图片组" : "展开图片组"} className="absolute top-2.5 right-2.5 z-40 flex h-8 items-center gap-1 rounded-full border border-border bg-card/90 px-2.5 text-xs font-semibold shadow-sm backdrop-blur" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onToggleBatch(node.id); }}><span className="text-[#1456f0]">{batchCount}</span><ChevronRight className={cn("size-3.5 transition-transform", node.batch_expanded && "rotate-90")} /></button> : null}
        {isBatchChild && node.url ? <button data-canvas-no-pan type="button" className="absolute top-2.5 right-2.5 z-40 flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card/90 px-2.5 text-xs font-medium opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSetBatchPrimary(node.id); }}><Star className="size-3.5 text-[#1456f0]" />设为主图</button> : null}
        {resourceLabel ? <CanvasResourceBadge resource={resourceLabel} offset={node.type === "text" || isBatchRoot || isBatchChild} /> : null}
      </div>
      <ConnectionHandle side="left" visible={hovered || selected || connecting} onMouseDown={(event) => onConnect(event, node.id, "target")} />
      <ConnectionHandle side="right" visible={node.type !== "config" && (hovered || selected || connecting)} onMouseDown={(event) => onConnect(event, node.id, "source")} />
      {(["top-left", "top-right", "bottom-left", "bottom-right"] as ResizeCorner[]).map((corner) => <ResizeHandle key={corner} corner={corner} onMouseDown={(event) => onResize(event, node, corner)} />)}
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

function CanvasResourceBadge({ resource, offset }: { resource: CanvasResourceLabel; offset: boolean }) {
  return (
    <span className={cn(
      "pointer-events-none absolute right-2 z-30 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
      offset ? "top-12" : "top-2",
      resource.active ? "bg-[#1456f0] text-white shadow-sm" : "bg-black/35 text-white/75",
    )}>
      {resource.label}
    </span>
  );
}

function CanvasNodeToolbar({ node, viewport, canvasWidth, showPanel, running, uploading, onInfo, onEditText, onDecreaseFont, onIncreaseFont, onPanelToggle, onUpload, onToggleFreeResize, onCropImage, onSplitImage, onUpscaleImage, onMaskEdit, onAngleImage, onViewImage, onCopyPrompt, onDownloadImage, onTextToImage, onRetry, onDelete }: {
  node: CanvasNode;
  viewport: CanvasDocument["viewport"];
  canvasWidth: number;
  showPanel: boolean;
  running: boolean;
  uploading: boolean;
  onInfo: () => void;
  onEditText: () => void;
  onDecreaseFont: () => void;
  onIncreaseFont: () => void;
  onPanelToggle: () => void;
  onUpload: () => void;
  onToggleFreeResize: () => void;
  onCropImage: () => void;
  onSplitImage: () => void;
  onUpscaleImage: () => void;
  onMaskEdit: () => void;
  onAngleImage: () => void;
  onViewImage: () => void;
  onCopyPrompt: () => void;
  onDownloadImage: () => void;
  onTextToImage: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const placement = canvasNodeToolbarPlacement({
    nodeCenterX: viewport.x + (node.x + node.width / 2) * viewport.zoom,
    nodeTopY: viewport.y + node.y * viewport.zoom - 14,
    viewportWidth: canvasWidth,
  });
  return (
    <div
      data-canvas-no-pan
      data-canvas-node-toolbar
      className={cn(
        "hide-scrollbar absolute z-40 flex h-10 -translate-y-full items-center rounded-xl border border-border bg-card/96 text-xs shadow-[0_10px_26px_rgba(15,23,42,.13)] backdrop-blur-xl",
        placement.compact ? "min-w-0 overflow-x-auto" : "min-w-max -translate-x-1/2 overflow-hidden",
      )}
      style={{ left: placement.left, right: placement.right, top: placement.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <NodeAction label="信息" onClick={onInfo}><Info /></NodeAction>
      {running ? (
        <NodeAction label="生成中" disabled onClick={() => undefined}><LoaderCircle className="animate-spin" /></NodeAction>
      ) : node.generation_status === "error" ? (
        <>
          <NodeAction label="重试" onClick={onRetry}><RefreshCw /></NodeAction>
          {node.url ? (
            <>
              <NodeAction label="编辑" active={showPanel} onClick={onPanelToggle}><WandSparkles /></NodeAction>
              <NodeAction label={uploading ? "上传中" : "替换"} disabled={uploading} onClick={onUpload}>{uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}</NodeAction>
              <CanvasImageToolsMenu node={node} onToggleFreeResize={onToggleFreeResize} onCrop={onCropImage} onSplit={onSplitImage} onUpscale={onUpscaleImage} onMaskEdit={onMaskEdit} onAngle={onAngleImage} />
              <NodeAction label="查看" onClick={onViewImage}><Maximize2 /></NodeAction>
              <NodeAction label="下载" onClick={onDownloadImage}><Download /></NodeAction>
            </>
          ) : (
            <NodeAction label={uploading ? "上传中" : "上传图片"} disabled={uploading} onClick={onUpload}>{uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}</NodeAction>
          )}
        </>
      ) : node.type === "config" ? (
        <NodeAction label="生成配置" active={showPanel} onClick={onPanelToggle}><Settings2 /></NodeAction>
      ) : node.type === "text" ? (
        <>
          <NodeAction label="编辑文字" onClick={onEditText}><Pencil /></NodeAction>
          <NodeAction label="生图" onClick={onTextToImage}><Sparkles /></NodeAction>
          <NodeAction label="缩小字号" disabled={(node.font_size || 14) <= 10} onClick={onDecreaseFont}><Minus /></NodeAction>
          <NodeAction label="增大字号" disabled={(node.font_size || 14) >= 32} onClick={onIncreaseFont}><Plus /></NodeAction>
        </>
      ) : node.url ? (
        <>
          <NodeAction label="编辑" active={showPanel} onClick={onPanelToggle}><WandSparkles /></NodeAction>
          <NodeAction label="复制提示词" onClick={onCopyPrompt}><Copy /></NodeAction>
          <NodeAction label={uploading ? "上传中" : "替换"} disabled={uploading} onClick={onUpload}>{uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}</NodeAction>
          <CanvasImageToolsMenu node={node} onToggleFreeResize={onToggleFreeResize} onCrop={onCropImage} onSplit={onSplitImage} onUpscale={onUpscaleImage} onMaskEdit={onMaskEdit} onAngle={onAngleImage} />
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

function CanvasImageToolsMenu({ node, onToggleFreeResize, onCrop, onSplit, onUpscale, onMaskEdit, onAngle }: { node: CanvasNode; onToggleFreeResize: () => void; onCrop: () => void; onSplit: () => void; onUpscale: () => void; onMaskEdit: () => void; onAngle: () => void }) {
  const [open, setOpen] = useState(false);
  const run = (action: () => void) => { setOpen(false); action(); };
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><button type="button" title="图片工具" className="flex h-full shrink-0 items-center gap-1.5 whitespace-nowrap px-3 font-medium transition hover:bg-muted"><MoreHorizontal className="size-4" />工具</button></PopoverTrigger><PopoverContent side="top" align="center" className="w-44 p-1.5" onOpenAutoFocus={(event) => event.preventDefault()}><ImageToolMenuButton icon={node.free_resize ? <LockOpen /> : <Lock />} label={node.free_resize ? "锁定比例" : "自由缩放"} onClick={() => run(onToggleFreeResize)} /><ImageToolMenuButton icon={<Brush />} label="局部编辑" onClick={() => run(onMaskEdit)} /><ImageToolMenuButton icon={<Scissors />} label="裁剪" onClick={() => run(onCrop)} /><ImageToolMenuButton icon={<Grid2X2 />} label="切图" onClick={() => run(onSplit)} /><ImageToolMenuButton icon={<ZoomIn />} label="放大" onClick={() => run(onUpscale)} /><ImageToolMenuButton icon={<Camera />} label="多角度" onClick={() => run(onAngle)} /></PopoverContent></Popover>;
}

function ImageToolMenuButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return <button type="button" className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs font-medium hover:bg-muted" onClick={onClick}><span className="[&>svg]:size-4">{icon}</span>{label}</button>;
}

function NodeAction({ label, active = false, danger = false, disabled = false, onClick, children }: { label: string; active?: boolean; danger?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" title={label} disabled={disabled} className={cn("flex h-full shrink-0 items-center gap-1.5 whitespace-nowrap px-3 font-medium transition hover:bg-muted disabled:cursor-wait disabled:opacity-60", active && "bg-[#e7efff] text-[#1456f0]", danger && "border-l border-border text-rose-600")} onClick={onClick}><span className="[&>svg]:size-4">{children}</span>{label}</button>;
}

function ConnectionHandle({ side, visible, onMouseDown }: { side: "left" | "right"; visible: boolean; onMouseDown: (event: ReactMouseEvent) => void }) {
  return <div data-connection-handle={side === "left" ? "target" : "source"} className={cn("absolute z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150", visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0")} style={{ top: "50%", left: side === "left" ? -24 : undefined, right: side === "right" ? -24 : undefined }} onMouseDown={onMouseDown}><div className="size-3 rounded-full border-2 border-[var(--canvas-connection-muted)] bg-card transition-transform hover:scale-125" /></div>;
}

function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: ReactMouseEvent) => void }) {
  const position = { "top-left": "-top-[14px] -left-[14px] cursor-nwse-resize", "top-right": "-top-[14px] -right-[14px] cursor-nesw-resize", "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize", "bottom-right": "-right-[14px] -bottom-[14px] cursor-nwse-resize" }[corner];
  return <div data-resize-handle={corner} className={cn("absolute z-40 size-7", position)} onMouseDown={onMouseDown} />;
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
