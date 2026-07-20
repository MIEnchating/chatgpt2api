import { toPng } from "html-to-image";
import { Bot, Check, ChevronDown, CircleDot, CircleStop, Clipboard, Copy, Download, FileDown, FileUp, Focus, Grid2X2, Hand, ImagePlus, Images, Info, LoaderCircle, Map as MapIcon, MousePointer2, Pencil, Plus, Redo2, Save, Sparkles, Square, Trash2, Type, Undo2, Upload, WandSparkles, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { CanvasEngine } from "@/app/canvas/canvas-engine";
import { resolveCanvasImageModel } from "@/app/canvas/canvas-image-model";
import { defaultCanvasImageParameters } from "@/app/canvas/canvas-image-parameter-defaults";
import { CanvasImageParameterPopover } from "@/app/canvas/canvas-image-parameters";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cancelCreationTask, clearCanvasDocument, createImageEditTask, createImageGenerationTask, DEFAULT_IMAGE_MODEL, fetchCanvasDocument, fetchCreationTasks, fetchManagedImages, fetchModelConfig, PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY, saveCanvasDocument, updateCanvasProject, uploadCanvasImage, type CanvasConnection, type CanvasDocument, type CanvasNode, type CanvasProjectSummary, type CanvasWorkspaceResponse, type CreationTask, type ImageModel, type ManagedImage } from "@/lib/api";
import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";
import { cn } from "@/lib/utils";

type SaveState = "saved" | "dirty" | "saving" | "error";
type CanvasTool = "select" | "pan";
type ConnectionOrigin = { nodeID: string; handleType: "source" | "target" };
type PendingConnectionCreate = ConnectionOrigin & { position: { x: number; y: number }; menu: { x: number; y: number } };
type CanvasNodeCreateMenu = { position: { x: number; y: number }; menu: { x: number; y: number } };
type CanvasContextMenu =
  | { type: "canvas"; x: number; y: number; position: { x: number; y: number } }
  | { type: "node"; x: number; y: number; nodeID: string }
  | { type: "connection"; x: number; y: number; connectionID: string };

const DEFAULT_DOCUMENT: CanvasDocument = { version: 1, id: "", revision: 0, title: "我的画布", background: "dots", nodes: [], connections: [], viewport: { zoom: 1, x: 0, y: 0 } };
const MAX_HISTORY = 40;
const TASK_POLL_INTERVAL_MS = 1200;
const TASK_POLL_LIMIT = 320;
const MINI_MAP_STORAGE_KEY = "yunmian-canvas-mini-map-open";

function cloneDocument(document: CanvasDocument) {
  return JSON.parse(JSON.stringify(document)) as CanvasDocument;
}

function randomID() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createdAt() {
  return new Date().toISOString();
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function imageFileSize(file: File) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: Math.max(1, image.naturalWidth), height: Math.max(1, image.naturalHeight) });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片尺寸"));
    };
    image.src = url;
  });
}

function fitImageNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);
  return { width: safeWidth * scale, height: safeHeight * scale };
}

function taskImageURL(task: CreationTask) {
  return (task.data || []).flatMap((item) => {
    const url = String(item.url || "").trim();
    if (url) return [{ url, width: item.width, height: item.height }];
    const b64 = String(item.b64_json || "").trim();
    return b64 ? [{ url: `data:image/png;base64,${b64}`, width: item.width, height: item.height }] : [];
  });
}

function saveLabel(state: SaveState) {
  if (state === "saving") return "保存中";
  if (state === "dirty") return "未保存";
  if (state === "error") return "保存失败";
  return "已保存";
}

function canvasImageParameters(node?: CanvasNode | null) {
  const defaults = defaultCanvasImageParameters();
  return {
    generation_size: node?.generation_size ?? defaults.generation_size,
    generation_resolution: node?.generation_resolution ?? defaults.generation_resolution,
    generation_quality: node?.generation_quality ?? defaults.generation_quality,
    generation_count: node?.generation_count ?? defaults.generation_count,
    generation_output_format: node?.generation_output_format ?? defaults.generation_output_format,
    generation_output_compression: node?.generation_output_compression ?? defaults.generation_output_compression,
    generation_stream: node?.generation_stream ?? defaults.generation_stream,
    generation_partial_images: node?.generation_partial_images ?? defaults.generation_partial_images,
  };
}

export default function CanvasPage() {
  const hostRef = useRef<HTMLElement | null>(null);
  const documentRef = useRef(cloneDocument(DEFAULT_DOCUMENT));
  const nodesRef = useRef<CanvasNode[]>([]);
  const connectionsRef = useRef<CanvasConnection[]>([]);
  const viewportRef = useRef(DEFAULT_DOCUMENT.viewport);
  const titleRef = useRef(DEFAULT_DOCUMENT.title);
  const backgroundRef = useRef(DEFAULT_DOCUMENT.background);
  const historyRef = useRef<CanvasDocument[]>([]);
  const redoRef = useRef<CanvasDocument[]>([]);
  const clipboardRef = useRef<{ nodes: CanvasNode[]; connections: CanvasConnection[] }>({ nodes: [], connections: [] });
  const saveTimerRef = useRef<number | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const uploadNodeIDRef = useRef("");
  const uploadPositionRef = useRef<{ x: number; y: number } | null>(null);
  const cancelledTaskIDsRef = useRef(new Set<string>());
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);

  const [nodes, setNodesState] = useState<CanvasNode[]>([]);
  const [connections, setConnectionsState] = useState<CanvasConnection[]>([]);
  const [viewport, setViewportState] = useState(DEFAULT_DOCUMENT.viewport);
  const [title, setTitle] = useState(DEFAULT_DOCUMENT.title);
  const [background, setBackground] = useState(DEFAULT_DOCUMENT.background);
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [selectedNodeIDs, setSelectedNodeIDs] = useState(new Set<string>());
  const [selectedConnectionID, setSelectedConnectionID] = useState("");
  const [tool, setTool] = useState<CanvasTool>("select");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryImages, setLibraryImages] = useState<ManagedImage[]>([]);
  const [miniMapOpen, setMiniMapOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(MINI_MAP_STORAGE_KEY) !== "false";
  });
  const [pendingConnection, setPendingConnection] = useState<PendingConnectionCreate | null>(null);
  const [nodeCreateMenu, setNodeCreateMenu] = useState<CanvasNodeCreateMenu | null>(null);
  const [panelNodeID, setPanelNodeID] = useState("");
  const [infoNodeID, setInfoNodeID] = useState("");
  const [previewNodeID, setPreviewNodeID] = useState("");
  const [uploadingNodeID, setUploadingNodeID] = useState("");
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null);
  const [runningNodeID, setRunningNodeID] = useState("");
  const [runningMode, setRunningMode] = useState<"generate" | "edit" | "">("");
  const [runningTaskID, setRunningTaskID] = useState("");
  const [cancellingTaskID, setCancellingTaskID] = useState("");
  const [runningPreviewImages, setRunningPreviewImages] = useState<Array<{ url: string; width?: number; height?: number }>>([]);
  const [imageModel, setImageModel] = useState<ImageModel>("");
  const [imageModelReady, setImageModelReady] = useState(false);
  const [relayTokenName, setRelayTokenName] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY) || "";
  });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [loading, setLoading] = useState(true);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [, setHistoryVersion] = useState(0);

  const selectedConnection = connections.find((connection) => connection.id === selectedConnectionID) || null;
  const infoNode = nodes.find((node) => node.id === infoNodeID) || null;
  const previewImages = nodes.flatMap((node) => node.type === "image" && node.url ? [{ id: node.id, src: node.url, fileName: node.title, outputFormat: node.generation_output_format, dimensions: `${Math.round(node.width)} × ${Math.round(node.height)}` }] : []);
  const previewIndex = Math.max(0, previewImages.findIndex((image) => image.id === previewNodeID));

  useEffect(() => {
    let active = true;
    void fetchModelConfig()
      .then(({ config }) => {
        if (active) {
          setImageModel(resolveCanvasImageModel(config.default_image_model, config.image_models, DEFAULT_IMAGE_MODEL));
          setImageModelReady(true);
        }
      })
      .catch(() => {
        if (active) {
          setImageModelReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const refreshLibrary = useCallback(async (showLoading = false, notifyError = false) => {
    if (showLoading) setLibraryLoading(true);
    try {
      const response = await fetchManagedImages({ scope: "mine" });
      if (mountedRef.current) setLibraryImages(response.items.slice(0, 120));
    } catch (error) {
      if (notifyError) toast.error(error instanceof Error ? error.message : "图片库加载失败");
    } finally {
      if (showLoading && mountedRef.current) setLibraryLoading(false);
    }
  }, []);

  function replaceNodes(next: CanvasNode[]) {
    nodesRef.current = next;
    setNodesState(next);
  }

  function replaceConnections(next: CanvasConnection[]) {
    connectionsRef.current = next;
    setConnectionsState(next);
  }

  function captureDocument(): CanvasDocument {
    return { ...documentRef.current, version: 1, title: titleRef.current, background: backgroundRef.current, nodes: nodesRef.current, connections: connectionsRef.current, viewport: viewportRef.current };
  }

  function historyKey(document: CanvasDocument) {
    return JSON.stringify({ title: document.title, background: document.background, nodes: document.nodes, connections: document.connections, viewport: document.viewport });
  }

  function scheduleSave() {
    if (!loadedRef.current) return;
    setSaveState("dirty");
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void persistCanvas(), 700);
  }

  function pushHistory() {
    const snapshot = cloneDocument(captureDocument());
    if (historyKey(historyRef.current.at(-1) || DEFAULT_DOCUMENT) !== historyKey(snapshot)) {
      historyRef.current = [...historyRef.current.slice(-(MAX_HISTORY - 1)), snapshot];
      redoRef.current = [];
      setHistoryVersion((value) => value + 1);
    }
    scheduleSave();
  }

  async function persistCanvas() {
    if (!loadedRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const payload = captureDocument();
    setSaveState("saving");
    try {
      const response = await saveCanvasDocument(payload);
      documentRef.current = { ...payload, revision: response.document.revision, updated_at: response.document.updated_at };
      setProjects((items) => items.map((item) => item.id === payload.id ? { ...item, title: payload.title, node_count: payload.nodes.length, updated_at: response.document.updated_at } : item));
      if (mountedRef.current) setSaveState("saved");
    } catch (error) {
      if (mountedRef.current) setSaveState("error");
      toast.error(error instanceof Error ? error.message : "画布保存失败");
    }
  }

  function applyDocument(document: CanvasDocument, resetHistory = true) {
    loadedRef.current = false;
    const next = cloneDocument({ ...document, connections: document.connections || [] });
    documentRef.current = next;
    replaceNodes(next.nodes || []);
    replaceConnections(next.connections || []);
    viewportRef.current = next.viewport || DEFAULT_DOCUMENT.viewport;
    titleRef.current = next.title || "我的画布";
    backgroundRef.current = next.background || "dots";
    setViewportState(viewportRef.current);
    setTitle(titleRef.current);
    setBackground(backgroundRef.current);
    setSelectedNodeIDs(new Set());
    setSelectedConnectionID("");
    if (resetHistory) {
      historyRef.current = [next];
      redoRef.current = [];
      setHistoryVersion((value) => value + 1);
    }
    setSaveState("saved");
    loadedRef.current = true;
  }

  function applyWorkspace(response: CanvasWorkspaceResponse) {
    setProjects(response.projects || []);
    applyDocument(response.document);
  }

  function canConnect(sourceID: string, targetID: string) {
    if (!sourceID || !targetID || sourceID === targetID) return false;
    if (connectionsRef.current.some((connection) => connection.from_node_id === sourceID && connection.to_node_id === targetID)) return false;
    const queue = [targetID];
    const visited = new Set<string>();
    while (queue.length) {
      const id = queue.shift() || "";
      if (id === sourceID) return false;
      if (!id || visited.has(id)) continue;
      visited.add(id);
      connectionsRef.current.filter((connection) => connection.from_node_id === id).forEach((connection) => queue.push(connection.to_node_id));
    }
    return true;
  }

  function connectNodes(sourceID: string, targetID: string) {
    if (!canConnect(sourceID, targetID)) return;
    replaceConnections([...connectionsRef.current, { id: `connection-${randomID()}`, from_node_id: sourceID, to_node_id: targetID }]);
    setSelectedConnectionID("");
    pushHistory();
  }

  function updateNodePrompt(nodeID: string, value: string, commit = false) {
    replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? { ...node, prompt: value } : node));
    scheduleSave();
    if (commit) pushHistory();
  }

  function updateNodeTitle(nodeID: string, value: string) {
    replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? { ...node, title: value } : node));
    pushHistory();
  }

  function updateNodeGenerationParameters(nodeID: string, patch: Partial<CanvasNode>) {
    replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? { ...node, ...patch } : node));
    pushHistory();
  }

  function updateViewport(next: CanvasDocument["viewport"], commit = false) {
    viewportRef.current = next;
    setViewportState(next);
    if (commit) scheduleSave();
  }

  function selectionChanged(ids: Set<string>, connectionID = "") {
    setSelectedNodeIDs(new Set(ids));
    setSelectedConnectionID(connectionID);
    setContextMenu(null);
    const nodeID = ids.size === 1 ? Array.from(ids)[0] : "";
    const node = nodeID ? nodesRef.current.find((item) => item.id === nodeID) : null;
    setPanelNodeID(node?.type === "image" ? node.id : "");
  }

  function placement(parentID = "") {
    const parent = nodesRef.current.find((node) => node.id === parentID);
    if (parent) return { x: parent.x + parent.width + 110, y: parent.y };
    const center = canvasCenterPosition();
    return { x: center.x - 160, y: center.y - 120 };
  }

  function canvasCenterPosition() {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return { x: 280, y: 240 };
    return { x: (rect.width / 2 - viewportRef.current.x) / viewportRef.current.zoom, y: (rect.height / 2 - viewportRef.current.y) / viewportRef.current.zoom };
  }

  function addNode(node: CanvasNode, parentID = "") {
    replaceNodes([...nodesRef.current, node]);
    setSelectedNodeIDs(new Set([node.id]));
    setSelectedConnectionID("");
    if (parentID) connectNodes(parentID, node.id);
    else pushHistory();
  }

  function addTextNode() {
    addTextNodeAt(placement());
  }

  function addTextNodeAt(point: { x: number; y: number }) {
    addNode({ id: `text-${randomID()}`, type: "text", x: point.x, y: point.y, width: 340, height: 220, scale_x: 1, scale_y: 1, title: "想法", prompt: "", created_at: createdAt() });
  }

  function addBlankNode() {
    addBlankNodeAt(placement());
  }

  function addBlankNodeAt(point: { x: number; y: number }) {
    const node = { id: `image-${randomID()}`, type: "image" as const, x: point.x, y: point.y, width: 340, height: 240, scale_x: 1, scale_y: 1, title: "图片", prompt: "", ...defaultCanvasImageParameters(), created_at: createdAt() };
    addNode(node);
    setPanelNodeID(node.id);
  }

  function buildImageNode(image: { url: string; thumbnailURL?: string; title?: string; prompt?: string; width?: number; height?: number; taskID?: string }, point: { x: number; y: number }, parent?: CanvasNode | null): CanvasNode {
    const dimensions = image.width && image.height ? fitImageNodeSize(image.width, image.height) : { width: 360, height: 360 };
    return {
      id: `image-${randomID()}`,
      type: "image",
      x: point.x,
      y: point.y,
      width: dimensions.width,
      height: dimensions.height,
      scale_x: 1,
      scale_y: 1,
      url: image.url,
      thumbnail_url: image.thumbnailURL || "",
      title: image.title || "图片",
      prompt: image.prompt || "",
      parent_id: parent?.id || "",
      task_id: image.taskID || "",
      ...canvasImageParameters(parent),
      created_at: createdAt(),
    };
  }

  function addImageNode(image: { url: string; thumbnailURL?: string; title?: string; prompt?: string; width?: number; height?: number; taskID?: string }, options: { x?: number; y?: number; parentID?: string } = {}) {
    if (!image.url) return;
    const point = options.x !== undefined && options.y !== undefined ? { x: options.x, y: options.y } : placement(options.parentID);
    const parent = options.parentID ? nodesRef.current.find((node) => node.id === options.parentID) : null;
    addNode(buildImageNode(image, point, parent), options.parentID || "");
  }

  function requestNodeImageUpload(nodeID: string) {
    if (uploadingNodeID) return;
    uploadNodeIDRef.current = nodeID;
    uploadPositionRef.current = null;
    imageInputRef.current?.click();
  }

  function requestCanvasImageUpload(position?: { x: number; y: number }) {
    if (uploadingNodeID) return;
    const rect = hostRef.current?.getBoundingClientRect();
    uploadNodeIDRef.current = "";
    uploadPositionRef.current = position || {
      x: ((rect?.width || 640) / 2 - viewportRef.current.x) / viewportRef.current.zoom,
      y: ((rect?.height || 480) / 2 - viewportRef.current.y) / viewportRef.current.zoom,
    };
    imageInputRef.current?.click();
  }

  async function handleNodeImageUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const nodeID = uploadNodeIDRef.current;
    const position = uploadPositionRef.current;
    uploadNodeIDRef.current = "";
    uploadPositionRef.current = null;
    if (!file) return;
    await uploadImageFile(file, nodeID, position || undefined);
  }

  async function uploadImageFile(file: File, nodeID = "", position?: { x: number; y: number }) {
    if (uploadingNodeID) return toast.error("已有图片正在上传");
    if (!file.type.startsWith("image/")) return toast.error("请选择图片文件");
    const target = nodeID ? nodesRef.current.find((node) => node.id === nodeID && node.type === "image") : null;
    if (nodeID && !target) return;
    setUploadingNodeID(nodeID || "canvas-upload");
    try {
      const [uploaded, sourceSize] = await Promise.all([uploadCanvasImage(file), imageFileSize(file)]);
      const size = fitImageNodeSize(sourceSize.width, sourceSize.height);
      let selectedID = nodeID;
      if (target) {
        replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? {
          ...node,
          type: "image",
          x: node.x + (node.width - size.width) / 2,
          y: node.y + (node.height - size.height) / 2,
          width: size.width,
          height: size.height,
          url: uploaded.url,
          thumbnail_url: "",
          title: file.name,
          task_id: "",
        } : node));
      } else {
        const center = position || { x: 0, y: 0 };
        selectedID = `image-${randomID()}`;
        replaceNodes([...nodesRef.current, {
          id: selectedID,
          type: "image",
          x: center.x - size.width / 2,
          y: center.y - size.height / 2,
          width: size.width,
          height: size.height,
          scale_x: 1,
          scale_y: 1,
          url: uploaded.url,
          title: file.name,
          prompt: "",
          ...defaultCanvasImageParameters(),
          created_at: createdAt(),
        }]);
      }
      setSelectedNodeIDs(new Set([selectedID]));
      setSelectedConnectionID("");
      setPanelNodeID(selectedID);
      pushHistory();
      await refreshLibrary();
      toast.success(target?.url ? "图片已替换" : "图片已上传到画布");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片上传失败");
    } finally {
      if (mountedRef.current) setUploadingNodeID("");
    }
  }

  function createPendingNode(type: "text" | "image") {
    if (!pendingConnection) return;
    const width = 340;
    const height = type === "image" ? 240 : 220;
    const node: CanvasNode = { id: `${type}-${randomID()}`, type, x: pendingConnection.position.x - width / 2, y: pendingConnection.position.y - height / 2, width, height, scale_x: 1, scale_y: 1, title: type === "image" ? "图片" : "想法", prompt: "", ...(type === "image" ? defaultCanvasImageParameters() : {}), created_at: createdAt() };
    replaceNodes([...nodesRef.current, node]);
    setSelectedNodeIDs(new Set([node.id]));
    if (pendingConnection.handleType === "source") connectNodes(pendingConnection.nodeID, node.id);
    else connectNodes(node.id, pendingConnection.nodeID);
    if (type === "image") setPanelNodeID(node.id);
    setPendingConnection(null);
  }

  function removeNodes(ids: Set<string>) {
    if (!ids.size) return;
    replaceNodes(nodesRef.current.filter((node) => !ids.has(node.id)));
    replaceConnections(connectionsRef.current.filter((connection) => !ids.has(connection.from_node_id) && !ids.has(connection.to_node_id)));
    if (panelNodeID && ids.has(panelNodeID)) setPanelNodeID("");
    if (infoNodeID && ids.has(infoNodeID)) setInfoNodeID("");
    if (previewNodeID && ids.has(previewNodeID)) setPreviewNodeID("");
    selectionChanged(new Set());
    pushHistory();
  }

  function removeSelected() {
    const ids = selectedNodeIDs;
    if (!ids.size && !selectedConnectionID) return;
    if (ids.size) return removeNodes(ids);
    replaceConnections(connectionsRef.current.filter((connection) => connection.id !== selectedConnectionID));
    setSelectedConnectionID("");
    pushHistory();
  }

  function duplicateNode(nodeID: string) {
    const source = nodesRef.current.find((node) => node.id === nodeID);
    if (!source) return;
    const next = { ...source, id: `${source.type}-${randomID()}`, x: source.x + 40, y: source.y + 40, title: source.title || (source.type === "image" ? "图片" : "想法"), created_at: createdAt() };
    replaceNodes([...nodesRef.current, next]);
    setSelectedNodeIDs(new Set([next.id]));
    setSelectedConnectionID("");
    setPanelNodeID(source.type === "image" ? next.id : "");
    pushHistory();
  }

  function generateFromTextNode(nodeID: string) {
    const source = nodesRef.current.find((node) => node.id === nodeID && node.type === "text");
    if (!source) return;
    const text = (source.prompt || "").trim();
    if (!text) return toast.error("请先双击想法节点输入内容");
    const node: CanvasNode = {
      id: `image-${randomID()}`,
      type: "image",
      x: source.x + source.width + 96,
      y: source.y + source.height / 2 - 120,
      width: 340,
      height: 240,
      scale_x: 1,
      scale_y: 1,
      title: "图片",
      prompt: text,
      ...defaultCanvasImageParameters(),
      parent_id: source.id,
      created_at: createdAt(),
    };
    replaceNodes([...nodesRef.current, node]);
    replaceConnections([...connectionsRef.current, { id: `connection-${randomID()}`, from_node_id: source.id, to_node_id: node.id }]);
    setSelectedNodeIDs(new Set([node.id]));
    setSelectedConnectionID("");
    setPanelNodeID(node.id);
    pushHistory();
  }

  async function copyNodePrompt(nodeID: string) {
    const prompt = nodesRef.current.find((node) => node.id === nodeID)?.prompt?.trim();
    if (!prompt) return toast.error("当前节点没有提示词");
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success("提示词已复制");
    } catch {
      toast.error("复制提示词失败");
    }
  }

  async function downloadNodeImage(nodeID: string) {
    const node = nodesRef.current.find((item) => item.id === nodeID && item.type === "image");
    if (!node?.url) return;
    try {
      const blob = await fetchAuthenticatedImageBlob(node.url);
      const objectURL = URL.createObjectURL(blob);
      const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg") || node.generation_output_format || "png";
      const rawTitle = (node.title || `image-${node.id}`).replace(/[\\/:*?"<>|]/g, "-");
      const fileName = /\.[a-z0-9]{2,5}$/i.test(rawTitle) ? rawTitle : `${rawTitle}.${extension}`;
      const link = document.createElement("a");
      link.href = objectURL;
      link.download = fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片下载失败");
    }
  }

  async function copySelected() {
    const copiedNodes = nodesRef.current.filter((node) => selectedNodeIDs.has(node.id));
    if (!copiedNodes.length) return;
    const ids = new Set(copiedNodes.map((node) => node.id));
    const copiedConnections = connectionsRef.current.filter((connection) => ids.has(connection.from_node_id) && ids.has(connection.to_node_id));
    clipboardRef.current = { nodes: copiedNodes, connections: copiedConnections };
    try { await navigator.clipboard.writeText(JSON.stringify({ type: "yunmian-canvas-nodes", nodes: copiedNodes, connections: copiedConnections })); } catch { /* Clipboard access is optional. */ }
    toast.success(`已复制 ${copiedNodes.length} 个节点`);
  }

  async function pasteSelected() {
    let copied = { nodes: [] as CanvasNode[], connections: [] as CanvasConnection[] };
    try {
      const items = await navigator.clipboard.read();
      const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
      const imageType = imageItem?.types.find((type) => type.startsWith("image/"));
      if (imageItem && imageType) {
        const blob = await imageItem.getType(imageType);
        await uploadImageFile(new File([blob], "clipboard-image.png", { type: imageType }), "", canvasCenterPosition());
        return;
      }
    } catch { /* Clipboard image access is optional. */ }
    let clipboardText = "";
    try {
      clipboardText = await navigator.clipboard.readText();
      const parsed = JSON.parse(clipboardText) as { type?: string; nodes?: CanvasNode[]; connections?: CanvasConnection[] };
      if (parsed.type === "yunmian-canvas-nodes" && parsed.nodes) copied = { nodes: parsed.nodes, connections: parsed.connections || [] };
    } catch { /* Invalid clipboard content is handled as plain text below. */ }
    if (!copied.nodes.length && clipboardText.trim()) {
      const text = clipboardText.trim();
      const center = canvasCenterPosition();
      addNode({ id: `text-${randomID()}`, type: "text", x: center.x - 170, y: center.y - 110, width: 340, height: 220, scale_x: 1, scale_y: 1, title: text.split(/\r?\n/, 1)[0].slice(0, 32) || "想法", prompt: text, created_at: createdAt() });
      toast.success("已从剪贴板添加文字");
      return;
    }
    if (!copied.nodes.length) copied = clipboardRef.current;
    if (!copied.nodes.length) return toast.error("剪贴板中没有可粘贴的内容");
    const bounds = copied.nodes.reduce((result, node) => ({
      left: Math.min(result.left, node.x),
      top: Math.min(result.top, node.y),
      right: Math.max(result.right, node.x + node.width),
      bottom: Math.max(result.bottom, node.y + node.height),
    }), { left: Number.POSITIVE_INFINITY, top: Number.POSITIVE_INFINITY, right: Number.NEGATIVE_INFINITY, bottom: Number.NEGATIVE_INFINITY });
    const center = canvasCenterPosition();
    const offsetX = center.x - (bounds.left + bounds.right) / 2;
    const offsetY = center.y - (bounds.top + bounds.bottom) / 2;
    const map = new Map(copied.nodes.map((node) => [node.id, `${node.type}-${randomID()}`]));
    const pastedNodes = copied.nodes.map((node) => ({ ...node, id: map.get(node.id) || node.id, x: node.x + offsetX, y: node.y + offsetY, created_at: createdAt() }));
    const pastedConnections = copied.connections.flatMap((connection) => {
      const source = map.get(connection.from_node_id);
      const target = map.get(connection.to_node_id);
      return source && target ? [{ id: `connection-${randomID()}`, from_node_id: source, to_node_id: target }] : [];
    });
    replaceNodes([...nodesRef.current, ...pastedNodes]);
    replaceConnections([...connectionsRef.current, ...pastedConnections]);
    setSelectedNodeIDs(new Set(pastedNodes.map((node) => node.id)));
    pushHistory();
  }

  function applyHistory(document: CanvasDocument) {
    const next = cloneDocument(document);
    documentRef.current = { ...documentRef.current, ...next, revision: documentRef.current.revision };
    replaceNodes(next.nodes);
    replaceConnections(next.connections);
    viewportRef.current = next.viewport;
    titleRef.current = next.title;
    backgroundRef.current = next.background;
    setViewportState(next.viewport);
    setTitle(next.title);
    setBackground(next.background);
    selectionChanged(new Set());
    scheduleSave();
  }

  function undo() {
    if (historyRef.current.length <= 1) return;
    const current = historyRef.current.pop();
    if (current) redoRef.current.push(current);
    const previous = historyRef.current.at(-1);
    if (previous) applyHistory(previous);
    setHistoryVersion((value) => value + 1);
  }

  function redo() {
    const next = redoRef.current.pop();
    if (!next) return;
    historyRef.current.push(next);
    applyHistory(next);
    setHistoryVersion((value) => value + 1);
  }

  function fitView() {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect || !nodesRef.current.length) return updateViewport({ zoom: 1, x: 0, y: 0 }, true);
    const left = Math.min(...nodesRef.current.map((node) => node.x));
    const top = Math.min(...nodesRef.current.map((node) => node.y));
    const right = Math.max(...nodesRef.current.map((node) => node.x + node.width));
    const bottom = Math.max(...nodesRef.current.map((node) => node.y + node.height));
    const zoom = Math.min(1.25, Math.max(0.08, Math.min((rect.width - 180) / Math.max(1, right - left), (rect.height - 220) / Math.max(1, bottom - top))));
    updateViewport({ zoom, x: rect.width / 2 - (left + (right - left) / 2) * zoom, y: rect.height / 2 - (top + (bottom - top) / 2) * zoom }, true);
  }

  async function runProject(input: Parameters<typeof updateCanvasProject>[0]) {
    try { applyWorkspace(await updateCanvasProject(input)); setProjectMenuOpen(false); } catch (error) { toast.error(error instanceof Error ? error.message : "画布项目操作失败"); }
  }

  async function waitForTask(taskID: string, onProgress?: (task: CreationTask) => void) {
    for (let index = 0; index < TASK_POLL_LIMIT; index += 1) {
      await sleep(TASK_POLL_INTERVAL_MS);
      const task = (await fetchCreationTasks([taskID])).items.find((item) => item.id === taskID);
      if (task) onProgress?.(task);
      if (task?.status === "success") return task;
      if (task?.status === "error" || task?.status === "cancelled") throw new Error(task.error || "图片生成失败");
    }
    throw new Error("图片任务等待超时");
  }

  async function stopGeneration() {
    if (!runningTaskID || cancellingTaskID) return;
    cancelledTaskIDsRef.current.add(runningTaskID);
    setCancellingTaskID(runningTaskID);
    try {
      await cancelCreationTask(runningTaskID);
      toast.success("已停止生成");
    } catch (error) {
      cancelledTaskIDsRef.current.delete(runningTaskID);
      if (mountedRef.current) setCancellingTaskID("");
      toast.error(error instanceof Error ? error.message : "停止生成失败");
    }
  }

  async function runGeneration(nodeID: string) {
    const sourceNode = nodesRef.current.find((node) => node.id === nodeID && node.type === "image");
    if (!sourceNode) return;
    const text = (sourceNode.prompt || "").trim();
    const mode = sourceNode.url ? "edit" : "generate";
    if (!text || runningNodeID) return toast.error("请输入画面描述");
    const parameters = canvasImageParameters(sourceNode);
    const size = parameters.generation_size || undefined;
    const resolution = parameters.generation_resolution && parameters.generation_resolution !== "auto" ? parameters.generation_resolution : undefined;
    const count = Math.max(1, Math.min(10, parameters.generation_count || 1));
    const stream = parameters.generation_stream ?? true;
    const taskRelayTokenName = relayTokenName.trim() || undefined;
    const taskID = `canvas-${mode}-${randomID()}`;
    let activeTaskID = taskID;
    setRunningNodeID(nodeID);
    setRunningMode(mode);
    setRunningTaskID("");
    setRunningPreviewImages([]);
    try {
      let submitted: CreationTask;
      if (mode === "edit" && sourceNode.url) {
        const blob = await fetchAuthenticatedImageBlob(sourceNode.url);
        submitted = await createImageEditTask(taskID, new File([blob], "canvas-source.png", { type: blob.type || "image/png" }), text, imageModel || undefined, size, size, parameters.generation_quality, count, undefined, "private", resolution, parameters.generation_output_format, parameters.generation_output_compression, stream, parameters.generation_partial_images, undefined, undefined, taskRelayTokenName);
      } else submitted = await createImageGenerationTask(taskID, text, imageModel || undefined, size, size, parameters.generation_quality, count, undefined, "private", resolution, parameters.generation_output_format, parameters.generation_output_compression, stream, parameters.generation_partial_images, undefined, undefined, taskRelayTokenName);
      activeTaskID = submitted.id || taskID;
      setRunningTaskID(activeTaskID);
      const images = taskImageURL(await waitForTask(activeTaskID, (task) => {
        const previews = taskImageURL(task);
        if (!previews.length) return;
        setRunningPreviewImages(previews);
        if (mode === "generate" && !sourceNode.url) {
          replaceNodes(nodesRef.current.map((node) => node.id === sourceNode.id ? { ...node, url: previews[0].url, thumbnail_url: "" } : node));
        }
      }));
      if (!images.length) throw new Error("任务完成但没有返回图片");
      let start = 0;
      let parentNode = sourceNode;
      let nextNodes = nodesRef.current;
      if (mode === "generate" && !sourceNode.url) {
        const image = images[0];
        const dimensions = image.width && image.height ? fitImageNodeSize(image.width, image.height) : { width: sourceNode.width, height: sourceNode.height };
        parentNode = {
          ...sourceNode,
          x: sourceNode.x + (sourceNode.width - dimensions.width) / 2,
          y: sourceNode.y + (sourceNode.height - dimensions.height) / 2,
          width: dimensions.width,
          height: dimensions.height,
          url: image.url,
          thumbnail_url: "",
          title: "图片",
          prompt: text,
          task_id: taskID,
        };
        nextNodes = nextNodes.map((node) => node.id === sourceNode.id ? parentNode : node);
        start = 1;
      }
      let nextY = parentNode.y;
      const childNodes = images.slice(start).map((image) => {
        const child = buildImageNode(
          { url: image.url, title: "图片", prompt: text, width: image.width, height: image.height, taskID },
          { x: parentNode.x + parentNode.width + 110, y: nextY },
          parentNode,
        );
        nextY += child.height + 48;
        return child;
      });
      replaceNodes([...nextNodes, ...childNodes]);
      if (childNodes.length) {
        replaceConnections([
          ...connectionsRef.current,
          ...childNodes.map((child) => ({ id: `connection-${randomID()}`, from_node_id: parentNode.id, to_node_id: child.id })),
        ]);
      }
      setSelectedNodeIDs(new Set([childNodes[0]?.id || parentNode.id]));
      setSelectedConnectionID("");
      setPanelNodeID("");
      pushHistory();
      void refreshLibrary();
      toast.success(`已添加 ${images.length} 张图片到画布`);
    } catch (error) {
      if (mode === "generate" && !sourceNode.url) {
        replaceNodes(nodesRef.current.map((node) => node.id === sourceNode.id ? {
          ...node,
          x: sourceNode.x,
          y: sourceNode.y,
          width: sourceNode.width,
          height: sourceNode.height,
          url: sourceNode.url,
          thumbnail_url: sourceNode.thumbnail_url,
          title: sourceNode.title,
          task_id: sourceNode.task_id,
        } : node));
      }
      if (!cancelledTaskIDsRef.current.has(activeTaskID)) toast.error(error instanceof Error ? error.message : "创作任务失败");
    } finally {
      cancelledTaskIDsRef.current.delete(activeTaskID);
      if (mountedRef.current) {
        setRunningNodeID("");
        setRunningMode("");
        setRunningTaskID("");
        setCancellingTaskID("");
        setRunningPreviewImages([]);
      }
    }
  }

  async function resetCanvas() {
    if (nodes.length && !window.confirm("确定清空当前画布吗？")) return;
    try { const response = await clearCanvasDocument(); applyDocument(response.document); } catch (error) { toast.error(error instanceof Error ? error.message : "清空画布失败"); }
  }

  async function exportImage() {
    const element = hostRef.current?.querySelector<HTMLElement>(".canvas-grid");
    if (!element) return;
    try { const url = await toPng(element, { backgroundColor: "#eef2f7", pixelRatio: 2 }); const link = document.createElement("a"); link.href = url; link.download = `云棉画布-${new Date().toISOString().slice(0, 10)}.png`; link.click(); } catch (error) { toast.error(error instanceof Error ? error.message : "画布导出失败"); }
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(captureDocument(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importJSON(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    try { const parsed = JSON.parse(await file.text()) as CanvasDocument; if (!Array.isArray(parsed.nodes)) throw new Error("画布文件格式无效"); applyDocument({ ...documentRef.current, title: parsed.title || title, background: parsed.background || "dots", nodes: parsed.nodes, connections: parsed.connections || [], viewport: parsed.viewport || DEFAULT_DOCUMENT.viewport }); scheduleSave(); } catch (error) { toast.error(error instanceof Error ? error.message : "画布导入失败"); }
  }

  function openNodeContextMenu(event: ReactMouseEvent, nodeID: string) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedNodeIDs(new Set([nodeID]));
    setSelectedConnectionID("");
    setPanelNodeID("");
    setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeID });
  }

  function openConnectionContextMenu(event: ReactMouseEvent<SVGPathElement>, connectionID: string) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedNodeIDs(new Set());
    setSelectedConnectionID(connectionID);
    setPanelNodeID("");
    setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionID });
  }

  function openCanvasContextMenu(event: ReactMouseEvent, position: { x: number; y: number }) {
    event.preventDefault();
    setSelectedNodeIDs(new Set());
    setSelectedConnectionID("");
    setPanelNodeID("");
    setContextMenu({ type: "canvas", x: event.clientX, y: event.clientY, position });
  }

  function handleCanvasDrop(event: ReactDragEvent<HTMLDivElement>, position: { x: number; y: number }) {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
    if (file) {
      void uploadImageFile(file, "", position);
      return;
    }
    const raw = event.dataTransfer.getData("application/x-yunmian-image");
    if (!raw) return;
    try {
      const image = JSON.parse(raw) as ManagedImage;
      addImageNode({ url: image.url || image.path, thumbnailURL: image.thumbnail_url, title: image.name || "图库图片", prompt: image.prompt, width: image.width, height: image.height }, { x: position.x - 180, y: position.y - 180 });
    } catch {
      toast.error("无法添加这张图片");
    }
  }

  function renderNodePanel(node: CanvasNode) {
    const running = runningNodeID === node.id;
    const editing = running ? runningMode === "edit" : Boolean(node.url);
    return (
      <div className="rounded-2xl border border-border bg-card p-3 shadow-2xl">
        {running && runningMode === "edit" && runningPreviewImages.length ? (
          <div className="mb-2 flex gap-2 overflow-x-auto rounded-xl border border-border bg-muted/25 p-2">
            {runningPreviewImages.map((image, index) => <AuthenticatedImage key={`${image.url}-${index}`} src={image.url} alt={`生成预览 ${index + 1}`} className="size-20 shrink-0 rounded-lg border border-border object-cover" />)}
          </div>
        ) : null}
        <Textarea
          value={node.prompt || ""}
          disabled={running}
          onChange={(event) => updateNodePrompt(node.id, event.target.value)}
          onBlur={(event) => updateNodePrompt(node.id, event.target.value, true)}
          placeholder={editing ? "描述要如何修改这张图片" : "描述要生成的图片内容"}
          className="h-28 resize-none rounded-xl bg-background px-3 py-3 text-sm leading-6 shadow-none"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="inline-flex h-9 min-w-0 max-w-[190px] shrink items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium text-muted-foreground"
              title={`模型：${imageModel || "默认模型"}`}
            >
              <Bot className="size-3.5 shrink-0" />
              <span className="shrink-0">模型</span>
              <span className="min-w-0 truncate font-semibold text-foreground">
                {imageModelReady ? imageModel || "默认模型" : "读取中"}
              </span>
            </span>
            <CanvasImageParameterPopover node={node} onChange={(patch) => updateNodeGenerationParameters(node.id, patch)} />
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">{editing ? "基于当前图片编辑" : "在当前节点生成图片"}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-9 rounded-full px-3 text-xs" onClick={() => setPanelNodeID("")}><X className="size-3.5" />关闭</Button>
            {running ? (
              <Button variant="destructive" size="sm" className="h-9 min-w-24 rounded-full px-4 text-xs" disabled={!runningTaskID || Boolean(cancellingTaskID)} onClick={() => void stopGeneration()}>
                {cancellingTaskID ? <LoaderCircle className="animate-spin" /> : <CircleStop />}
                {cancellingTaskID ? "停止中" : runningTaskID ? "停止生成" : "提交中"}
              </Button>
            ) : (
              <Button size="sm" className="h-9 min-w-20 rounded-full px-4 text-xs" disabled={!imageModelReady || !node.prompt?.trim() || Boolean(runningNodeID)} onClick={() => void runGeneration(node.id)}>
                {editing ? <WandSparkles /> : <Sparkles />}
                {editing ? "编辑" : "生成"}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  useEffect(() => {
    mountedRef.current = true;
    void fetchCanvasDocument().then(applyWorkspace).catch((error) => toast.error(error instanceof Error ? error.message : "画布加载失败")).finally(() => mountedRef.current && setLoading(false));
    return () => { mountedRef.current = false; if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current); };
  }, []);

  useEffect(() => {
    const handleTokenNameChange = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY) return;
      const eventTokenName = (event as CustomEvent<{ tokenName?: string }>).detail?.tokenName;
      setRelayTokenName(String(eventTokenName ?? window.localStorage.getItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY) ?? ""));
    };
    window.addEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
    window.addEventListener("storage", handleTokenNameChange);
    return () => {
      window.removeEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
      window.removeEventListener("storage", handleTokenNameChange);
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setCanvasSize({ width: host.clientWidth, height: host.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!libraryOpen) return;
    void refreshLibrary(true, true);
    const timer = window.setInterval(() => void refreshLibrary(), 4000);
    return () => window.clearInterval(timer);
  }, [libraryOpen, refreshLibrary]);

  useEffect(() => {
    window.localStorage.setItem(MINI_MAP_STORAGE_KEY, String(miniMapOpen));
  }, [miniMapOpen]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (command && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
      else if (command && event.key.toLowerCase() === "a") { event.preventDefault(); selectionChanged(new Set(nodesRef.current.map((node) => node.id))); }
      else if (command && event.key.toLowerCase() === "c") { event.preventDefault(); void copySelected(); }
      else if (command && event.key.toLowerCase() === "v") { event.preventDefault(); void pasteSelected(); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelected(); }
      else if (event.key === "Escape") {
        selectionChanged(new Set());
        setPendingConnection(null);
        setNodeCreateMenu(null);
        setInfoNodeID("");
        setProjectMenuOpen(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  useEffect(() => {
    if (!pendingConnection) return;
    const outside = (event: PointerEvent) => { const target = event.target instanceof Element ? event.target : null; if (!target?.closest("[data-connection-create-menu]")) setPendingConnection(null); };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [pendingConnection]);

  useEffect(() => {
    if (!nodeCreateMenu) return;
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("[data-node-create-menu]")) setNodeCreateMenu(null);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [nodeCreateMenu]);

  return (
    <section ref={hostRef} className="relative h-full min-h-[540px] overflow-hidden rounded-xl border border-border bg-[#eef2f7] shadow-[0_18px_48px_-34px_rgba(15,23,42,0.42)] dark:bg-[#161a20]">
      <CanvasEngine nodes={nodes} connections={connections} viewport={viewport} background={background} tool={tool} selectedNodeIDs={selectedNodeIDs} selectedConnectionID={selectedConnectionID} panelNodeID={panelNodeID} runningNodeID={runningNodeID} onNodesChange={replaceNodes} onNodesCommit={pushHistory} onViewportChange={updateViewport} onSelectionChange={selectionChanged} onConnect={connectNodes} canConnect={canConnect} onConnectionDropEmpty={(origin, position, menu) => setPendingConnection({ ...origin, position, menu })} onPromptChange={updateNodePrompt} onTitleChange={updateNodeTitle} onNodePanelToggle={(nodeID) => setPanelNodeID((current) => current === nodeID ? "" : nodeID)} onNodeUpload={requestNodeImageUpload} uploadingNodeID={uploadingNodeID} onViewImage={(nodeID) => { setPanelNodeID(""); setPreviewNodeID(nodeID); }} onCopyPrompt={(nodeID) => void copyNodePrompt(nodeID)} onDownloadImage={(nodeID) => void downloadNodeImage(nodeID)} onTextToImage={generateFromTextNode} onNodeInfo={setInfoNodeID} onNodeDelete={(nodeID) => removeNodes(new Set([nodeID]))} onNodeContextMenu={openNodeContextMenu} onConnectionContextMenu={openConnectionContextMenu} onCanvasContextMenu={openCanvasContextMenu} onCanvasDoubleClick={(event, position) => { const rect = hostRef.current?.getBoundingClientRect(); setNodeCreateMenu({ position, menu: { x: event.clientX - (rect?.left || 0), y: event.clientY - (rect?.top || 0) } }); }} renderNodePanel={renderNodePanel} onDrop={handleCanvasDrop} />

      {pendingConnection ? <div data-connection-create-menu className="absolute z-40 w-48 rounded-xl border border-border bg-card p-1.5 shadow-xl" style={{ left: Math.max(8, Math.min(pendingConnection.menu.x, (hostRef.current?.clientWidth || 240) - 200)), top: Math.max(64, Math.min(pendingConnection.menu.y, (hostRef.current?.clientHeight || 240) - 130)) }}><p className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">创建节点并连接</p><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("text")}><Type className="size-4" />想法节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("image")}><ImagePlus className="size-4" />空白图片节点</button></div> : null}
      {nodeCreateMenu ? <div data-node-create-menu className="absolute z-40 w-48 rounded-xl border border-border bg-card p-1.5 shadow-xl" style={{ left: Math.max(8, Math.min(nodeCreateMenu.menu.x, (hostRef.current?.clientWidth || 240) - 200)), top: Math.max(64, Math.min(nodeCreateMenu.menu.y, (hostRef.current?.clientHeight || 240) - 130)) }}><p className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">添加到画布</p><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addTextNodeAt({ x: nodeCreateMenu.position.x - 170, y: nodeCreateMenu.position.y - 110 }); setNodeCreateMenu(null); }}><Type className="size-4" />想法节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addBlankNodeAt({ x: nodeCreateMenu.position.x - 170, y: nodeCreateMenu.position.y - 120 }); setNodeCreateMenu(null); }}><ImagePlus className="size-4" />空白图片节点</button></div> : null}

      <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-3">
        <div className="pointer-events-auto flex h-11 items-center rounded-2xl border border-border bg-card/92 p-1.5 shadow-[0_10px_28px_rgba(15,23,42,.10)] backdrop-blur-xl">
          <Button variant="ghost" size="sm" className="h-8 max-w-56 rounded-xl px-3 text-xs font-semibold" onClick={() => setProjectMenuOpen((value) => !value)}><span className="truncate">{title}</span><ChevronDown className="size-3.5" /></Button>
        </div>
        <Button variant="ghost" size="sm" className="pointer-events-auto h-11 min-w-[94px] rounded-2xl border border-border bg-card/92 px-3 text-xs shadow-[0_10px_28px_rgba(15,23,42,.10)] backdrop-blur-xl" onClick={() => void persistCanvas()}>{saveState === "saving" ? <LoaderCircle className="animate-spin" /> : <Save />}{saveLabel(saveState)}</Button>
      </div>

      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center">
        <div className="hide-scrollbar pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto px-1">
          <div className="flex h-12 shrink-0 items-center gap-1 rounded-2xl border border-border bg-card/94 p-1.5 shadow-[0_12px_32px_rgba(15,23,42,.14)] backdrop-blur-xl">
            <ToolButton active={tool === "select"} label="选择" onClick={() => setTool("select")}><MousePointer2 /></ToolButton>
            <ToolButton active={tool === "pan"} label="移动画布" onClick={() => setTool("pan")}><Hand /></ToolButton>
            <ToolbarDivider />
            <ToolButton label="撤销" disabled={historyRef.current.length <= 1} onClick={undo}><Undo2 /></ToolButton>
            <ToolButton label="重做" disabled={!redoRef.current.length} onClick={redo}><Redo2 /></ToolButton>
            <ToolbarDivider />
            <ToolButton label="添加想法" onClick={addTextNode}><Type /></ToolButton>
            <ToolButton label="添加空白图片" onClick={addBlankNode}><ImagePlus /></ToolButton>
            <ToolButton label="上传图片" disabled={Boolean(uploadingNodeID)} onClick={() => requestCanvasImageUpload()}>{uploadingNodeID === "canvas-upload" ? <LoaderCircle className="animate-spin" /> : <Upload />}</ToolButton>
            <ToolButton active={libraryOpen} label="图片库" onClick={() => setLibraryOpen((value) => !value)}><Images /></ToolButton>
            <ToolButton label="导入画布" onClick={() => importRef.current?.click()}><FileUp /></ToolButton>
            <ToolbarDivider />
            <ToolButton label="删除所选" disabled={!selectedNodeIDs.size && !selectedConnection} className="text-rose-600" onClick={removeSelected}><Trash2 /></ToolButton>
            <ToolButton label="导出图片" disabled={!nodes.length} onClick={() => void exportImage()}><Download /></ToolButton>
            <ToolButton label="清空画布" disabled={!nodes.length} className="text-rose-600" onClick={() => void resetCanvas()}><X /></ToolButton>
          </div>
        </div>
      </div>

      <div className="pointer-events-auto absolute bottom-3 left-3 z-30 hidden h-12 items-center gap-1 rounded-2xl border border-border bg-card/94 p-1.5 shadow-[0_12px_32px_rgba(15,23,42,.14)] backdrop-blur-xl lg:flex">
        <ToolButton label="适应内容" onClick={fitView}><Focus /></ToolButton>
        <ToolButton label="缩小" onClick={() => updateViewport({ ...viewportRef.current, zoom: Math.max(.08, viewportRef.current.zoom / 1.2) }, true)}><ZoomOut /></ToolButton>
        <input aria-label="画布缩放" type="range" min="8" max="400" value={Math.round(viewport.zoom * 100)} className="h-1.5 w-20 cursor-pointer accent-[#1456f0]" onChange={(event) => updateViewport({ ...viewportRef.current, zoom: Number(event.target.value) / 100 }, true)} />
        <span className="w-11 text-center text-[11px] font-semibold text-muted-foreground">{Math.round(viewport.zoom * 100)}%</span>
        <ToolButton label="放大" onClick={() => updateViewport({ ...viewportRef.current, zoom: Math.min(4, viewportRef.current.zoom * 1.2) }, true)}><ZoomIn /></ToolButton>
        <ToolButton active={miniMapOpen} label="小地图" onClick={() => setMiniMapOpen((value) => !value)}><MapIcon /></ToolButton>
      </div>

      {projectMenuOpen ? <aside className="absolute top-16 left-3 z-30 w-80 rounded-xl border border-border bg-card shadow-xl"><div className="flex items-center justify-between border-b p-3"><div><p className="text-sm font-semibold">画布项目</p><p className="text-[11px] text-muted-foreground">跨设备自动同步</p></div><Button size="sm" className="h-8 text-xs" onClick={() => { const value = window.prompt("新画布名称", `无限画布 ${projects.length + 1}`)?.trim(); if (value) void runProject({ action: "create", title: value }); }}><Plus />新建</Button></div><div className="max-h-56 overflow-y-auto p-1.5">{projects.map((project) => <button key={project.id} className={cn("flex w-full items-center gap-2 rounded-lg p-2 text-left text-xs hover:bg-muted", project.id === documentRef.current.id && "bg-[#e7efff] text-[#1456f0]")} onClick={() => project.id !== documentRef.current.id && void runProject({ action: "activate", project_id: project.id })}><span className="flex size-7 items-center justify-center rounded-md bg-muted">{project.id === documentRef.current.id ? <Check className="size-3.5" /> : project.node_count}</span><span className="truncate font-semibold">{project.title}</span></button>)}</div><div className="space-y-2 border-t p-2.5"><div className="flex rounded-lg bg-muted p-1"><BackgroundButton active={background === "dots"} label="点阵" onClick={() => { backgroundRef.current = "dots"; setBackground("dots"); setTimeout(pushHistory); }}><CircleDot /></BackgroundButton><BackgroundButton active={background === "grid"} label="网格" onClick={() => { backgroundRef.current = "grid"; setBackground("grid"); setTimeout(pushHistory); }}><Grid2X2 /></BackgroundButton><BackgroundButton active={background === "plain"} label="空白" onClick={() => { backgroundRef.current = "plain"; setBackground("plain"); setTimeout(pushHistory); }}><Square /></BackgroundButton></div><div className="grid grid-cols-2 gap-2"><Button variant="outline" size="sm" onClick={() => { const value = window.prompt("画布名称", title)?.trim(); if (value) void runProject({ action: "rename", project_id: documentRef.current.id, title: value }); }}><Pencil />重命名</Button><Button variant="outline" size="sm" className="text-rose-600" onClick={() => window.confirm(`确定删除“${title}”吗？`) && void runProject({ action: "delete", project_id: documentRef.current.id })}><Trash2 />删除</Button></div></div></aside> : null}

      {libraryOpen ? <aside className="absolute inset-y-16 left-3 z-20 flex w-80 flex-col rounded-xl border border-border bg-card shadow-xl"><div className="flex h-12 items-center justify-between border-b px-3"><span className="text-sm font-semibold">图片库 · {libraryImages.length}</span><Button variant="ghost" size="icon" onClick={() => setLibraryOpen(false)}><X /></Button></div><div className="min-h-0 flex-1 overflow-y-auto p-2.5">{libraryLoading ? <LoaderCircle className="mx-auto mt-16 animate-spin" /> : <div className="grid grid-cols-2 gap-2">{libraryImages.map((image) => <button key={image.path} draggable className="relative aspect-square overflow-hidden rounded-lg border" onDragStart={(event) => event.dataTransfer.setData("application/x-yunmian-image", JSON.stringify(image))} onClick={() => addImageNode({ url: image.url || image.path, thumbnailURL: image.thumbnail_url, title: image.name, prompt: image.prompt, width: image.width, height: image.height })}><AuthenticatedImage src={image.thumbnail_url || image.url || image.path} alt={image.name} className="size-full object-cover" /></button>)}</div>}</div></aside> : null}

      {miniMapOpen && !libraryOpen && nodes.length && canvasSize.width > 0 ? <CanvasMiniMap nodes={nodes} viewport={viewport} viewportSize={canvasSize} onViewportChange={(next) => updateViewport(next, true)} /> : null}

      {contextMenu ? <CanvasRightClickMenu menu={contextMenu} onClose={() => setContextMenu(null)} onDuplicate={() => { if (contextMenu.type === "node") duplicateNode(contextMenu.nodeID); setContextMenu(null); }} onDelete={() => { if (contextMenu.type === "node") removeNodes(new Set([contextMenu.nodeID])); else if (contextMenu.type === "connection") { replaceConnections(connectionsRef.current.filter((connection) => connection.id !== contextMenu.connectionID)); setSelectedConnectionID(""); pushHistory(); } setContextMenu(null); }} onAddText={() => { if (contextMenu.type === "canvas") addTextNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 110 }); setContextMenu(null); }} onAddImage={() => { if (contextMenu.type === "canvas") addBlankNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 120 }); setContextMenu(null); }} onPaste={() => { void pasteSelected(); setContextMenu(null); }} onExportImage={() => { void exportImage(); setContextMenu(null); }} onExportJSON={() => { exportJSON(); setContextMenu(null); }} onImport={() => { importRef.current?.click(); setContextMenu(null); }} onClear={() => { void resetCanvas(); setContextMenu(null); }} /> : null}
      <CanvasNodeInfoDialog node={infoNode} open={Boolean(infoNode)} onOpenChange={(open) => { if (!open) setInfoNodeID(""); }} />
      <ImageLightbox images={previewImages} currentIndex={previewIndex} open={Boolean(previewNodeID)} onOpenChange={(open) => { if (!open) setPreviewNodeID(""); }} onIndexChange={(index) => setPreviewNodeID(previewImages[index]?.id || "")} />
      <Input ref={importRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importJSON(event)} />
      <Input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleNodeImageUpload(event)} />
      {loading ? <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/70"><LoaderCircle className="size-6 animate-spin text-[#1456f0]" /></div> : null}
    </section>
  );
}

function ToolButton({ active = false, label, className, ...props }: React.ComponentProps<typeof Button> & { active?: boolean; label: string }) {
  return <Button type="button" variant="ghost" size="icon" title={label} aria-label={label} className={cn("size-9 rounded-xl", active && "bg-[#e7efff] text-[#1456f0]", className)} {...props} />;
}

function ToolbarDivider() {
  return <span className="mx-0.5 h-6 w-px shrink-0 bg-border" />;
}

function BackgroundButton({ active, label, ...props }: React.ComponentProps<typeof Button> & { active: boolean; label: string }) {
  return <Button variant="ghost" size="sm" className={cn("h-8 flex-1 text-[11px]", active && "bg-card text-[#1456f0]")} {...props}>{props.children}{label}</Button>;
}

function CanvasMiniMap({ nodes, viewport, viewportSize, onViewportChange }: { nodes: CanvasNode[]; viewport: CanvasDocument["viewport"]; viewportSize: { width: number; height: number }; onViewportChange: (viewport: CanvasDocument["viewport"]) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const width = 240;
  const height = 160;
  const map = useMemo(() => {
    const minX = Math.min(...nodes.map((node) => node.x)) - 500;
    const minY = Math.min(...nodes.map((node) => node.y)) - 500;
    const maxX = Math.max(...nodes.map((node) => node.x + node.width)) + 500;
    const maxY = Math.max(...nodes.map((node) => node.y + node.height)) + 500;
    const worldWidth = Math.max(1, maxX - minX);
    const worldHeight = Math.max(1, maxY - minY);
    const scale = Math.min(width / worldWidth, height / worldHeight);
    return { minX, minY, scale, offsetX: (width - worldWidth * scale) / 2, offsetY: (height - worldHeight * scale) / 2 };
  }, [nodes]);

  const toMap = useCallback((x: number, y: number) => ({ x: (x - map.minX) * map.scale + map.offsetX, y: (y - map.minY) * map.scale + map.offsetY }), [map]);
  const viewportStart = toMap(-viewport.x / viewport.zoom, -viewport.y / viewport.zoom);
  const viewportEnd = toMap((-viewport.x + viewportSize.width) / viewport.zoom, (-viewport.y + viewportSize.height) / viewport.zoom);

  function navigate(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const worldX = (event.clientX - rect.left - map.offsetX) / map.scale + map.minX;
    const worldY = (event.clientY - rect.top - map.offsetY) / map.scale + map.minY;
    onViewportChange({ zoom: viewport.zoom, x: viewportSize.width / 2 - worldX * viewport.zoom, y: viewportSize.height / 2 - worldY * viewport.zoom });
  }

  return (
    <div className="absolute bottom-20 left-3 z-20 hidden overflow-hidden rounded-xl border border-border bg-card/90 shadow-xl backdrop-blur lg:block" style={{ width, height }}>
      <div ref={containerRef} className="relative size-full cursor-crosshair" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); navigate(event); }} onPointerMove={(event) => { if (dragging) navigate(event); }} onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)}>
        {nodes.map((node) => { const point = toMap(node.x, node.y); return <span key={node.id} className={cn("pointer-events-none absolute rounded-sm", node.type === "image" ? "bg-[#1456f0]" : "bg-amber-500")} style={{ left: point.x, top: point.y, width: Math.max(2, node.width * map.scale), height: Math.max(2, node.height * map.scale), opacity: .82 }} />; })}
        <span className="pointer-events-none absolute border border-[#1456f0] bg-[#1456f0]/10" style={{ left: viewportStart.x, top: viewportStart.y, width: Math.max(4, viewportEnd.x - viewportStart.x), height: Math.max(4, viewportEnd.y - viewportStart.y) }} />
      </div>
    </div>
  );
}

function CanvasRightClickMenu({ menu, onClose, onDuplicate, onDelete, onAddText, onAddImage, onPaste, onExportImage, onExportJSON, onImport, onClear }: {
  menu: CanvasContextMenu;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAddText: () => void;
  onAddImage: () => void;
  onPaste: () => void;
  onExportImage: () => void;
  onExportJSON: () => void;
  onImport: () => void;
  onClear: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [onClose]);

  const menuHeight = menu.type === "canvas" ? 338 : 96;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 208));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - menuHeight));

  return (
    <div className="fixed z-[100] min-w-48 overflow-hidden rounded-xl border border-border bg-card py-1.5 shadow-2xl" style={{ left, top }} onPointerDown={(event) => event.stopPropagation()}>
      {menu.type === "canvas" ? (
        <>
          <ContextMenuButton icon={<Type />} onClick={onAddText}>添加想法节点</ContextMenuButton>
          <ContextMenuButton icon={<ImagePlus />} onClick={onAddImage}>添加图片节点</ContextMenuButton>
          <ContextMenuButton icon={<Clipboard />} onClick={onPaste}>粘贴节点</ContextMenuButton>
          <ContextMenuDivider />
          <ContextMenuButton icon={<Download />} onClick={onExportImage}>导出画布图片</ContextMenuButton>
          <ContextMenuButton icon={<FileDown />} onClick={onExportJSON}>导出画布 JSON</ContextMenuButton>
          <ContextMenuButton icon={<FileUp />} onClick={onImport}>导入画布 JSON</ContextMenuButton>
          <ContextMenuDivider />
          <ContextMenuButton icon={<Trash2 />} danger onClick={onClear}>清空当前画布</ContextMenuButton>
        </>
      ) : (
        <>
          {menu.type === "node" ? <ContextMenuButton icon={<Copy />} onClick={onDuplicate}>复制</ContextMenuButton> : null}
          <ContextMenuButton icon={<Trash2 />} danger onClick={onDelete}>删除</ContextMenuButton>
        </>
      )}
    </div>
  );
}

function ContextMenuButton({ icon, danger = false, onClick, children }: { icon: ReactNode; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-muted", danger && "text-rose-600")} onClick={onClick}><span className="[&>svg]:size-4">{icon}</span>{children}</button>;
}

function ContextMenuDivider() {
  return <div className="my-1 h-px bg-border" />;
}

function CanvasNodeInfoDialog({ node, open, onOpenChange }: { node: CanvasNode | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [view, setView] = useState<"info" | "json">("info");
  useEffect(() => { if (open) setView("info"); }, [node?.id, open]);
  const json = node ? JSON.stringify(node, null, 2) : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,600px)] rounded-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-4 pr-8">
            <DialogTitle className="flex items-center gap-2"><Info className="size-4 text-[#1456f0]" />节点信息</DialogTitle>
            <div className="flex rounded-lg bg-muted p-1">
              <Button variant="ghost" size="sm" className={cn("h-7 px-3 text-xs", view === "info" && "bg-card text-[#1456f0]")} onClick={() => setView("info")}>信息</Button>
              <Button variant="ghost" size="sm" className={cn("h-7 px-3 text-xs", view === "json" && "bg-card text-[#1456f0]")} onClick={() => setView("json")}>JSON</Button>
            </div>
          </div>
          <DialogDescription>查看当前节点的内容、位置和生成信息。</DialogDescription>
        </DialogHeader>
        {node ? view === "info" ? (
          <div className="max-h-[56vh] space-y-2 overflow-y-auto pr-1 text-sm">
            <InfoRow label="ID" value={node.id} mono />
            <InfoRow label="名称" value={node.title || (node.type === "image" ? "图片" : "想法")} />
            <InfoRow label="类型" value={node.type === "image" ? "图片" : "想法"} />
            <InfoRow label="尺寸" value={`${Math.round(node.width)} × ${Math.round(node.height)}`} />
            <InfoRow label="位置" value={`${Math.round(node.x)}, ${Math.round(node.y)}`} />
            {node.prompt ? <InfoRow label="提示词" value={node.prompt} /> : null}
            {node.task_id ? <InfoRow label="任务 ID" value={node.task_id} mono /> : null}
            {node.created_at ? <InfoRow label="创建时间" value={new Date(node.created_at).toLocaleString("zh-CN")} /> : null}
            {node.url ? <InfoRow label="图片地址" value={node.url} mono /> : null}
          </div>
        ) : (
          <pre className="max-h-[56vh] overflow-auto rounded-xl border border-border bg-muted/45 p-4 text-xs leading-5">{json}</pre>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 rounded-xl border border-border bg-muted/20 px-3 py-2.5"><span className="text-muted-foreground">{label}</span><span className={cn("min-w-0 break-words", mono && "font-mono text-xs")}>{value}</span></div>;
}
