import { toPng } from "html-to-image";
import { ArrowUp, Bot, Check, ChevronDown, CircleDot, Clipboard, Copy, Download, FileDown, FileUp, Focus, Grid2X2, Hand, ImagePlus, Images, Info, LoaderCircle, Map as MapIcon, Pencil, Plus, Redo2, Save, Settings2, Sparkles, Square, Trash2, Type, Undo2, Upload, WandSparkles, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { CanvasEngine } from "@/app/canvas/canvas-engine";
import { detachCanvasBatchRootForReplacement, duplicateCanvasNodeGroup, expandCanvasBatchNodeIDs, reconcileCanvasBatchesAfterRemoval, setCanvasBatchPrimary, syncCanvasBatchRootAfterRetry, visibleCanvasNodes } from "@/app/canvas/canvas-batches";
import { CanvasConfigComposer } from "@/app/canvas/canvas-config-composer";
import { canvasConfigInputs, canvasConfigPromptDisplay } from "@/app/canvas/canvas-config-inputs";
import { canCreateCanvasConnection, resolveCanvasConnection } from "@/app/canvas/canvas-connections";
import { buildCanvasGenerationContext, buildCanvasImageReferencePrompt, canvasGenerationCount, canvasGenerationReferenceImageURLs, findCanvasRetryConfigurationNode, INTERRUPTED_CANVAS_GENERATION_ERROR, restoreInterruptedCanvasGenerations } from "@/app/canvas/canvas-generation-context";
import { canvasGenerationActiveNodeID, placeCanvasGenerationResultNodes, setCanvasConfigGenerationStatus } from "@/app/canvas/canvas-generation-layout";
import { appendCanvasHistorySnapshot, canvasHistoryKey, commitCanvasGenerationHistory, restoreCanvasHistoryDocument } from "@/app/canvas/canvas-history";
import { canvasImageAngleLabel, canvasImageAnglePrompt, cropCanvasImage, splitCanvasImage, upscaleCanvasImage, type CanvasImageAngleParams, type CanvasImageCropRect, type CanvasImageSplitParams, type CanvasImageUpscaleParams } from "@/app/canvas/canvas-image-data";
import { canvasCenteredNodePosition, canvasCroppedNodeSize, canvasEmptyImageFrameFromSize, canvasImageReplacementFrame, canvasNodeAspectRatio } from "@/app/canvas/canvas-node-geometry";
import { canvasGenerationStatusLabel, canvasNodeInfoJSON } from "@/app/canvas/canvas-node-info";
import { CanvasAngleDialog, CanvasCropDialog, CanvasMaskDialog, CanvasSplitDialog, CanvasUpscaleDialog, type CanvasMaskEditPayload } from "@/app/canvas/canvas-image-tools";
import { applyCanvasTaskImage, applyCanvasTaskProgressNodes, reconcileCancelledCanvasTaskNodes, reconcilePersistedCanvasTaskNodes, restoreCanvasTaskInitialImage, summarizeCanvasTaskResult } from "@/app/canvas/canvas-task-results";
import { canvasExportBounds } from "@/app/canvas/canvas-export";
import { normalizeCanvasClipboard, remapCanvasNodeReferences } from "@/app/canvas/canvas-clipboard";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, resetCanvasViewport, setCanvasViewportZoom } from "@/app/canvas/canvas-viewport";
import { canvasSaveRequired, flushCanvasSaves } from "@/app/canvas/canvas-save";
import { resolveCanvasImageModel } from "@/app/canvas/canvas-image-model";
import { canvasImageTitle } from "@/app/canvas/canvas-image-title";
import { defaultCanvasImageParameters } from "@/app/canvas/canvas-image-parameter-defaults";
import { CanvasImageParameterPopover } from "@/app/canvas/canvas-image-parameters";
import { CanvasResourceMentionTextarea } from "@/app/canvas/canvas-resource-mention-textarea";
import { canvasNodeMentionReferences, type CanvasResourceReference } from "@/app/canvas/canvas-resources";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cancelCreationTask, clearCanvasDocument, createImageEditTask, createImageGenerationTask, DEFAULT_IMAGE_MODEL, fetchCanvasDocument, fetchCreationTasks, fetchManagedImages, fetchModelConfig, importCanvasProject, PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY, saveCanvasDocument, updateCanvasProject, uploadCanvasImage, type CanvasConnection, type CanvasDocument, type CanvasNode, type CanvasProjectSummary, type CanvasWorkspaceResponse, type CreationTask, type ImageModel, type ManagedImage } from "@/lib/api";
import { fetchAuthenticatedImageBlob, primeAuthenticatedImageCache } from "@/lib/authenticated-image";
import { MAX_IMAGE_CONVERSATION_REFERENCE_IMAGES } from "@/lib/image-conversation-assets";
import { cn } from "@/lib/utils";

type SaveState = "saved" | "dirty" | "saving" | "error";
type CanvasSwitchPhase = "switching" | "revealing" | null;
type ConnectionOrigin = { nodeID: string; handleType: "source" | "target" };
type PendingConnectionCreate = ConnectionOrigin & { position: { x: number; y: number }; menu: { x: number; y: number } };
type CanvasNodeCreateMenu = { position: { x: number; y: number }; menu: { x: number; y: number } };
type CanvasContextMenu =
  | { type: "canvas"; x: number; y: number; position: { x: number; y: number } }
  | { type: "node"; x: number; y: number; nodeID: string }
  | { type: "connection"; x: number; y: number; connectionID: string };
type CanvasImageToolState = { kind: "crop" | "split" | "upscale" | "mask" | "angle"; nodeID: string; sourceURL: string };
type CanvasGenerationOptions = { resultTitle?: string; inputImageMask?: string; resultBounds?: { width: number; height: number }; resultCount?: number; selectResultNode?: boolean };

const DEFAULT_DOCUMENT: CanvasDocument = { version: 1, id: "", revision: 0, title: "我的画布", background: "dots", nodes: [], connections: [], viewport: { zoom: 1, x: 0, y: 0 } };
const MAX_HISTORY = 50;
const TASK_POLL_INTERVAL_MS = 1200;
const TASK_POLL_MAX_DURATION_MS = 8 * 60 * 1000;
const TASK_POLL_MAX_RETRY_DELAY_MS = 10_000;
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

function sleep(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(new DOMException("请求已取消", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("请求已取消", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
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

async function canvasDataURLFile(dataURL: string, fileName: string) {
  const response = await fetch(dataURL);
  if (!response.ok) throw new Error("无法读取处理后的图片");
  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

function fitImageNodeSize(width: number, height: number, maxWidth = 640, maxHeight = 640) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, maxWidth / safeWidth, maxHeight / safeHeight);
  return { width: safeWidth * scale, height: safeHeight * scale };
}

function canvasLibraryImageTitle(image: Pick<ManagedImage, "name" | "prompt">) {
  return canvasImageTitle(image.name, image.prompt);
}

function normalizeCanvasNodeTitle(node: CanvasNode) {
  if (node.type === "image") {
    const title = canvasImageTitle(node.title);
    return { ...node, title: title === "图片" ? canvasImageTitle(node.title, node.prompt) : title };
  }
  return node;
}

function canvasNodeFallbackTitle(type: CanvasNode["type"]) {
  if (type === "image") return "图片";
  if (type === "config") return "生成配置";
  return "想法";
}

function isRetryableTaskPollError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
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

function CanvasNodePromptPanel({ node, mentionReferences, running, generationBusy, imageModel, imageModelReady, cancelling, canStop, connectedPromptAvailable, onPromptChange, onParametersChange, onGenerate, onStop }: {
  node: CanvasNode;
  mentionReferences: readonly CanvasResourceReference[];
  running: boolean;
  generationBusy: boolean;
  imageModel: string;
  imageModelReady: boolean;
  cancelling: boolean;
  canStop: boolean;
  connectedPromptAvailable: boolean;
  onPromptChange: (value: string, commit?: boolean) => void;
  onParametersChange: (patch: Partial<CanvasNode>) => void;
  onGenerate: (prompt: string) => void;
  onStop: () => void;
}) {
  const editingExistingImage = Boolean(node.url);
  const [prompt, setPrompt] = useState(editingExistingImage ? "" : node.prompt || "");

  useEffect(() => {
    setPrompt(editingExistingImage ? "" : node.prompt || "");
    // The editor keeps a local draft after opening; node changes should not overwrite active input.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [editingExistingImage, node.id]);

  function updatePrompt(value: string) {
    setPrompt(value);
    if (!editingExistingImage) onPromptChange(value);
  }

  function submit() {
    const value = prompt.trim();
    if ((!value && !connectedPromptAvailable) || generationBusy) return;
    onGenerate(value);
    setPrompt("");
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/90 bg-card/96 shadow-[0_14px_38px_rgba(15,23,42,.14)] backdrop-blur-xl transition-[border-color,box-shadow] focus-within:border-[#8eacf0] focus-within:shadow-[0_14px_38px_rgba(15,23,42,.13),0_0_0_2px_rgba(20,86,240,.07)]">
      <CanvasResourceMentionTextarea
        value={prompt}
        references={mentionReferences}
        onChange={updatePrompt}
        onSubmit={submit}
        onBlur={(event) => { if (!editingExistingImage) onPromptChange(event.target.value, true); }}
        placeholder={editingExistingImage ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容"}
        containerClassName="h-20"
        className="h-20 resize-none border-0 bg-transparent px-3.5 py-3 text-sm leading-5 shadow-none outline-none placeholder:text-muted-foreground/55"
      />
      <div className="flex min-w-0 items-center justify-between gap-1.5 border-t border-border/70 bg-muted/20 px-2 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="inline-flex h-8 min-w-0 max-w-[180px] items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground transition hover:bg-muted"
            title={`模型：${imageModel || "默认模型"}`}
          >
            <Bot className="size-3.5 shrink-0" />
            <span className="hidden shrink-0 sm:inline">模型</span>
            <span className="min-w-0 truncate font-semibold text-foreground">{imageModelReady ? imageModel || "默认模型" : "读取中"}</span>
          </span>
          <CanvasImageParameterPopover node={node} onChange={onParametersChange} />
        </div>
        <Button
          size="sm"
          variant={running ? "destructive" : "default"}
          className={cn("h-8 shrink-0 rounded-lg px-2 text-xs", running ? "min-w-20" : "w-8 bg-[#1456f0] text-white hover:bg-[#0f45c8]")}
          disabled={running ? !canStop || cancelling : !imageModelReady || (!prompt.trim() && !connectedPromptAvailable) || generationBusy}
          aria-label={running ? "停止生成" : "生成"}
          onClick={() => running ? onStop() : submit()}
        >
          {running ? (
            <span className="flex items-center gap-1.5">
              {cancelling ? <LoaderCircle className="size-4 animate-spin" /> : <Square className="size-3.5 fill-current" />}
              <span>{cancelling ? "停止中" : "停止"}</span>
            </span>
          ) : <ArrowUp className="size-4" />}
        </Button>
      </div>
    </div>
  );
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
  const generationHistoryBaseRef = useRef<CanvasDocument[] | null>(null);
  const clipboardRef = useRef<{ nodes: CanvasNode[]; connections: CanvasConnection[] }>({ nodes: [], connections: [] });
  const saveTimerRef = useRef<number | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const libraryRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const saveChangeVersionRef = useRef(0);
  const persistedChangeVersionRef = useRef(0);
  const saveRequestVersionRef = useRef(0);
  const switchRevealTimerRef = useRef<number | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const uploadNodeIDRef = useRef("");
  const uploadPositionRef = useRef<{ x: number; y: number } | null>(null);
  const cancelledTaskIDsRef = useRef(new Set<string>());
  const generationAbortControllerRef = useRef<AbortController | null>(null);
  const canvasRecoveryAbortControllerRef = useRef<AbortController | null>(null);
  const generationEpochRef = useRef(0);
  const canvasOperationEpochRef = useRef(0);
  const pendingTaskIDRef = useRef("");
  const submittedTaskIDRef = useRef("");
  const batchAnimationTimersRef = useRef(new Map<string, number>());
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
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryImages, setLibraryImages] = useState<ManagedImage[]>([]);
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<PendingConnectionCreate | null>(null);
  const [nodeCreateMenu, setNodeCreateMenu] = useState<CanvasNodeCreateMenu | null>(null);
  const [panelNodeID, setPanelNodeID] = useState("");
  const [exportingCanvas, setExportingCanvas] = useState(false);
  const [infoNodeID, setInfoNodeID] = useState("");
  const [previewNodeID, setPreviewNodeID] = useState("");
  const [uploadingNodeID, setUploadingNodeID] = useState("");
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null);
  const [runningNodeID, setRunningNodeID] = useState("");
  const [runningResultNodeID, setRunningResultNodeID] = useState("");
  const [runningControlNodeID, setRunningControlNodeID] = useState("");
  const [runningTaskID, setRunningTaskID] = useState("");
  const [cancellingTaskID, setCancellingTaskID] = useState("");
  const [stopConfirmationOpen, setStopConfirmationOpen] = useState(false);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const [imageTool, setImageTool] = useState<CanvasImageToolState | null>(null);
  const [imageToolBusy, setImageToolBusy] = useState(false);
  const [collapsingBatchRootIDs, setCollapsingBatchRootIDs] = useState(new Set<string>());
  const [openingBatchRootIDs, setOpeningBatchRootIDs] = useState(new Set<string>());
  const [imageModel, setImageModel] = useState<ImageModel>("");
  const [imageModelReady, setImageModelReady] = useState(false);
  const [relayTokenName, setRelayTokenName] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY) || "";
  });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [switchPhase, setSwitchPhase] = useState<CanvasSwitchPhase>(null);
  const [loading, setLoading] = useState(true);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [, setHistoryVersion] = useState(0);

  const selectedConnection = connections.find((connection) => connection.id === selectedConnectionID) || null;
  const infoNode = nodes.find((node) => node.id === infoNodeID) || null;
  const infoNodeInputs = infoNode?.type === "config" ? canvasConfigInputs(infoNode.id, nodes, connections) : [];
  const previewImages = visibleCanvasNodes(nodes).flatMap((node) => node.type === "image" && node.url ? [{ id: node.id, src: node.url, fileName: node.title, outputFormat: node.generation_output_format, dimensions: `${Math.round(node.width)} × ${Math.round(node.height)}` }] : []);
  const previewIndex = Math.max(0, previewImages.findIndex((image) => image.id === previewNodeID));

  useEffect(() => () => { if (imageTool?.sourceURL) URL.revokeObjectURL(imageTool.sourceURL); }, [imageTool?.sourceURL]);

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

  const refreshLibrary = useCallback((showLoading = false, notifyError = false) => {
    if (libraryRefreshPromiseRef.current) return libraryRefreshPromiseRef.current;
    const request = (async () => {
      if (showLoading) setLibraryLoading(true);
      try {
        const response = await fetchManagedImages({ scope: "mine" });
        if (mountedRef.current) setLibraryImages(response.items.slice(0, 120));
      } catch (error) {
        if (notifyError) toast.error(error instanceof Error ? error.message : "图片库加载失败");
      } finally {
        if (showLoading && mountedRef.current) setLibraryLoading(false);
      }
    })();
    libraryRefreshPromiseRef.current = request;
    void request.finally(() => {
      if (libraryRefreshPromiseRef.current === request) libraryRefreshPromiseRef.current = null;
    });
    return request;
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
    return {
      ...documentRef.current,
      version: 1,
      title: titleRef.current,
      background: backgroundRef.current,
      nodes: nodesRef.current,
      connections: connectionsRef.current,
      viewport: viewportRef.current,
    };
  }

  function scheduleSave() {
    if (!loadedRef.current) return;
    saveChangeVersionRef.current += 1;
    setSaveState("dirty");
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void persistCanvas(), 700);
  }

  function pushHistory() {
    const snapshot = cloneDocument(captureDocument());
    if (generationHistoryBaseRef.current) {
      scheduleSave();
      return;
    }
    if (canvasHistoryKey(historyRef.current.at(-1) || DEFAULT_DOCUMENT) !== canvasHistoryKey(snapshot)) {
      historyRef.current = appendCanvasHistorySnapshot(historyRef.current, snapshot, MAX_HISTORY);
      redoRef.current = [];
      setHistoryVersion((value) => value + 1);
    }
    scheduleSave();
  }

  function commitGenerationHistory(baseHistory: readonly CanvasDocument[]) {
    const snapshot = cloneDocument(captureDocument());
    historyRef.current = commitCanvasGenerationHistory(baseHistory, snapshot, MAX_HISTORY);
    generationHistoryBaseRef.current = null;
    redoRef.current = [];
    setHistoryVersion((value) => value + 1);
    scheduleSave();
  }

  function enqueueWorkspaceMutation<T>(mutation: () => Promise<T>) {
    const request = workspaceMutationQueueRef.current
      .catch(() => undefined)
      .then(mutation);
    workspaceMutationQueueRef.current = request.then(() => undefined, () => undefined);
    return request;
  }

  async function persistCanvas() {
    if (!loadedRef.current) return true;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (!canvasSaveRequired(persistedChangeVersionRef.current, saveChangeVersionRef.current)) {
      if (mountedRef.current) setSaveState("saved");
      return true;
    }
    const payload = captureDocument();
    const changeVersion = saveChangeVersionRef.current;
    const requestVersion = saveRequestVersionRef.current + 1;
    saveRequestVersionRef.current = requestVersion;
    if (mountedRef.current && documentRef.current.id === payload.id) setSaveState("saving");
    let response: Awaited<ReturnType<typeof saveCanvasDocument>>;
    const request = saveQueueRef.current
      .catch(() => undefined)
      .then(() => saveCanvasDocument(payload));
    saveQueueRef.current = request.then(() => undefined, () => undefined);
    try {
      response = await request;
      if (documentRef.current.id === payload.id) {
        documentRef.current = { ...documentRef.current, revision: response.document.revision, updated_at: response.document.updated_at };
        persistedChangeVersionRef.current = Math.max(persistedChangeVersionRef.current, changeVersion);
      }
      if (mountedRef.current) {
        setProjects((items) => items.map((item) => item.id === payload.id ? { ...item, title: payload.title, node_count: payload.nodes.length, updated_at: response.document.updated_at } : item));
        if (documentRef.current.id === payload.id && saveRequestVersionRef.current === requestVersion) setSaveState(saveChangeVersionRef.current === changeVersion && saveTimerRef.current === null ? "saved" : "dirty");
      }
      return true;
    } catch (error) {
      if (mountedRef.current && documentRef.current.id === payload.id && saveRequestVersionRef.current === requestVersion) setSaveState(saveChangeVersionRef.current === changeVersion ? "error" : "dirty");
      if (mountedRef.current && saveRequestVersionRef.current === requestVersion) toast.error(error instanceof Error ? error.message : "画布保存失败");
      return false;
    }
  }

  function applyDocument(document: CanvasDocument, resetHistory = true) {
    loadedRef.current = false;
    canvasOperationEpochRef.current += 1;
    canvasRecoveryAbortControllerRef.current?.abort();
    canvasRecoveryAbortControllerRef.current = null;
    const recoveryTaskIDs = [...new Set((document.nodes || []).flatMap((node) => (
      node.task_id && (node.generation_status === "loading" || node.generation_error === INTERRUPTED_CANVAS_GENERATION_ERROR)
        ? [node.task_id]
        : []
    )))];
    const operationEpoch = canvasOperationEpochRef.current;
    const next = cloneDocument({
      ...document,
      nodes: (document.nodes || []).map(normalizeCanvasNodeTitle),
      connections: document.connections || [],
    });
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
    setPanelNodeID("");
    setInfoNodeID("");
    setPreviewNodeID("");
    setContextMenu(null);
    setPendingConnection(null);
    setNodeCreateMenu(null);
    setImageTool(null);
    setImageToolBusy(false);
    setUploadingNodeID("");
    if (resetHistory) {
      historyRef.current = [next];
      redoRef.current = [];
      saveChangeVersionRef.current = 0;
      persistedChangeVersionRef.current = 0;
      setHistoryVersion((value) => value + 1);
    }
    setSaveState("saved");
    loadedRef.current = true;
    if (recoveryTaskIDs.length) {
      const controller = new AbortController();
      canvasRecoveryAbortControllerRef.current = controller;
      void recoverCanvasTasks(next.id, operationEpoch, recoveryTaskIDs, controller.signal);
    }
  }

  function applyWorkspace(response: CanvasWorkspaceResponse) {
    setProjects(response.projects || []);
    applyDocument(response.document);
  }

  function canConnect(sourceID: string, targetID: string) {
    return canCreateCanvasConnection(sourceID, targetID, connectionsRef.current, nodesRef.current);
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

  function updateTextFontSize(nodeID: string, fontSize: number) {
    const nextFontSize = Math.max(10, Math.min(32, Math.round(fontSize)));
    replaceNodes(nodesRef.current.map((node) => node.id === nodeID && node.type === "text" ? { ...node, font_size: nextFontSize } : node));
    pushHistory();
  }

  function updateNodeComposerContent(nodeID: string, value: string, commit = false) {
    replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? { ...node, composer_content: value } : node));
    scheduleSave();
    if (commit) pushHistory();
  }

  function updateNodeTitle(nodeID: string, value: string) {
    replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? { ...node, title: value } : node));
    pushHistory();
  }

  function updateNodeGenerationParameters(nodeID: string, patch: Partial<CanvasNode>) {
    replaceNodes(nodesRef.current.map((node) => {
      if (node.id !== nodeID) return node;
      const next = { ...node, ...patch };
      if (node.type !== "image" || node.url || typeof patch.generation_size !== "string") return next;
      const frame = canvasEmptyImageFrameFromSize(node, patch.generation_size);
      return frame ? { ...next, ...frame } : next;
    }));
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
    if (ids.size !== 1 || !ids.has(panelNodeID)) setPanelNodeID("");
  }

  function activateNode(nodeID: string) {
    const node = nodesRef.current.find((item) => item.id === nodeID);
    setPanelNodeID(node?.type === "image" || node?.type === "config" ? node.id : "");
  }

  function toggleCanvasFreeResize(nodeID: string) {
    const source = nodesRef.current.find((node) => node.id === nodeID && node.type === "image");
    if (!source) return;
    const nextFreeResize = !source.free_resize;
    replaceNodes(nodesRef.current.map((node) => {
      if (node.id !== nodeID) return node;
      if (nextFreeResize) return { ...node, free_resize: true };
      const ratio = canvasNodeAspectRatio(node);
      const height = node.width / Math.max(0.01, ratio);
      return { ...node, y: node.y + (node.height - height) / 2, height, free_resize: false };
    }));
    pushHistory();
  }

  function toggleCanvasBatch(nodeID: string) {
    const root = nodesRef.current.find((node) => node.id === nodeID && node.batch_child_ids?.length);
    if (!root) return;
    const expanded = Boolean(root.batch_expanded);
    const previousTimer = batchAnimationTimersRef.current.get(nodeID);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    if (expanded) {
      setOpeningBatchRootIDs((current) => { const next = new Set(current); next.delete(nodeID); return next; });
      setCollapsingBatchRootIDs((current) => new Set(current).add(nodeID));
    } else {
      setCollapsingBatchRootIDs((current) => { const next = new Set(current); next.delete(nodeID); return next; });
      setOpeningBatchRootIDs((current) => new Set(current).add(nodeID));
    }
    replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? { ...node, batch_expanded: !expanded } : node));
    if (expanded) {
      setSelectedNodeIDs(new Set([nodeID]));
      setSelectedConnectionID("");
      if (panelNodeID && root.batch_child_ids?.includes(panelNodeID)) setPanelNodeID("");
    }
    const timer = window.setTimeout(() => {
      batchAnimationTimersRef.current.delete(nodeID);
      setCollapsingBatchRootIDs((current) => { const next = new Set(current); next.delete(nodeID); return next; });
      setOpeningBatchRootIDs((current) => { const next = new Set(current); next.delete(nodeID); return next; });
    }, expanded ? 320 : 260);
    batchAnimationTimersRef.current.set(nodeID, timer);
    pushHistory();
  }

  function makeCanvasBatchPrimary(childID: string) {
    const next = setCanvasBatchPrimary(nodesRef.current, childID);
    if (next.every((node, index) => node === nodesRef.current[index])) return;
    replaceNodes(next);
    pushHistory();
  }

  function placement(parentID = "") {
    const parent = nodesRef.current.find((node) => node.id === parentID);
    if (parent) return { x: parent.x + parent.width + 96, y: parent.y };
    const center = canvasCenterPosition();
    return { x: center.x - 170, y: center.y - 120 };
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
    addNode({ id: `text-${randomID()}`, type: "text", x: point.x, y: point.y, width: 340, height: 240, font_size: 14, scale_x: 1, scale_y: 1, title: "想法", prompt: "", created_at: createdAt() });
  }

  function addBlankNode() {
    addBlankNodeAt(placement());
  }

  function addBlankNodeAt(point: { x: number; y: number }) {
    const node = { id: `image-${randomID()}`, type: "image" as const, x: point.x, y: point.y, width: 340, height: 240, scale_x: 1, scale_y: 1, title: "图片", prompt: "", ...defaultCanvasImageParameters(), created_at: createdAt() };
    addNode(node);
    setPanelNodeID(node.id);
  }

  function addConfigNodeAt(point: { x: number; y: number }) {
    const node: CanvasNode = {
      id: `config-${randomID()}`,
      type: "config",
      x: point.x,
      y: point.y,
      width: 340,
      height: 240,
      scale_x: 1,
      scale_y: 1,
      title: "生成配置",
      prompt: "",
      ...defaultCanvasImageParameters(),
      created_at: createdAt(),
    };
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
      natural_width: image.width,
      natural_height: image.height,
      free_resize: false,
      scale_x: 1,
      scale_y: 1,
      url: image.url,
      thumbnail_url: image.thumbnailURL || "",
      title: image.title || "图片",
      prompt: image.prompt || "",
      task_id: image.taskID || "",
      ...canvasImageParameters(parent),
      created_at: createdAt(),
    };
  }

  function addImageNode(image: { url: string; thumbnailURL?: string; title?: string; prompt?: string; width?: number; height?: number; taskID?: string }, options: { x?: number; y?: number; parentID?: string; centered?: boolean } = {}) {
    if (!image.url) return;
    const parent = options.parentID ? nodesRef.current.find((node) => node.id === options.parentID) : null;
    const hasPosition = options.x !== undefined && options.y !== undefined;
    const anchor = hasPosition ? { x: options.x!, y: options.y! } : parent ? placement(options.parentID) : canvasCenterPosition();
    const node = buildImageNode(image, anchor, parent);
    const centered = options.centered || (!hasPosition && !parent);
    addNode(centered ? { ...node, ...canvasCenteredNodePosition(anchor, node.width, node.height) } : node, options.parentID || "");
    setPanelNodeID(node.id);
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
    const initialTarget = nodeID ? nodesRef.current.find((node) => node.id === nodeID && node.type === "image") : null;
    if (nodeID && !initialTarget) return;
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setUploadingNodeID(nodeID || "canvas-upload");
    try {
      const [uploaded, sourceSize] = await Promise.all([uploadCanvasImage(file), imageFileSize(file)]);
      await primeAuthenticatedImageCache(uploaded.url, file);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch) {
        void refreshLibrary();
        return;
      }
      const target = nodeID ? nodesRef.current.find((node) => node.id === nodeID && node.type === "image") : null;
      if (nodeID && !target) return;
      const size = fitImageNodeSize(sourceSize.width, sourceSize.height);
      const uploadedImageParameters = defaultCanvasImageParameters();
      let selectedID = nodeID;
      if (target) {
        const batchReplacement = detachCanvasBatchRootForReplacement(nodesRef.current, connectionsRef.current, target.id);
        const replacedBatchChildIDs = batchReplacement.removedNodeIDs;
        const nextTarget = {
          ...target,
          type: "image" as const,
          ...canvasImageReplacementFrame(target, size.width, size.height),
          natural_width: sourceSize.width,
          natural_height: sourceSize.height,
          free_resize: false,
          url: uploaded.url,
          thumbnail_url: "",
          title: canvasImageTitle(file.name),
          task_id: "",
          generation_type: undefined,
          generation_reference_urls: undefined,
          generation_status: "success" as const,
          generation_error: "",
          ...uploadedImageParameters,
          ...(replacedBatchChildIDs.size ? { batch_child_ids: undefined, batch_primary_id: undefined, batch_expanded: undefined } : {}),
        };
        replaceNodes(batchReplacement.nodes
          .map((node) => {
            if (node.id === nodeID) return nextTarget;
            if (target.batch_root_id && node.id === target.batch_root_id && node.batch_primary_id === target.id) {
              return { ...node, url: uploaded.url, thumbnail_url: "", width: size.width, height: size.height, natural_width: sourceSize.width, natural_height: sourceSize.height, free_resize: false };
            }
            return node;
        }));
        if (replacedBatchChildIDs.size) replaceConnections(batchReplacement.connections);
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
          natural_width: sourceSize.width,
          natural_height: sourceSize.height,
          scale_x: 1,
          scale_y: 1,
          url: uploaded.url,
          title: canvasImageTitle(file.name),
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

  function createPendingNode(type: "text" | "image" | "config") {
    if (!pendingConnection) return;
    const width = 340;
    const height = 240;
    const node: CanvasNode = { id: `${type}-${randomID()}`, type, x: pendingConnection.position.x - width / 2, y: pendingConnection.position.y - height / 2, width, height, ...(type === "text" ? { font_size: 14 } : {}), scale_x: 1, scale_y: 1, title: canvasNodeFallbackTitle(type), prompt: "", ...(type !== "text" ? defaultCanvasImageParameters() : {}), created_at: createdAt() };
    const connection = resolveCanvasConnection(pendingConnection, node.id, [...nodesRef.current, node]);
    if (!connection || !canConnect(connection.sourceID, connection.targetID)) {
      return toast.error("该节点不能与生成配置节点连接");
    }
    replaceNodes([...nodesRef.current, node]);
    setSelectedNodeIDs(new Set([node.id]));
    connectNodes(connection.sourceID, connection.targetID);
    if (type !== "text") setPanelNodeID(node.id);
    setPendingConnection(null);
  }

  function removeNodes(ids: Set<string>) {
    if (!ids.size) return;
    const removedIDs = expandCanvasBatchNodeIDs(ids, nodesRef.current);
    const generationHistoryBase = removedIDs.has(runningNodeID) || removedIDs.has(runningResultNodeID)
      ? interruptActiveGeneration()
      : null;
    replaceNodes(reconcileCanvasBatchesAfterRemoval(nodesRef.current, removedIDs));
    replaceConnections(connectionsRef.current.filter((connection) => !removedIDs.has(connection.from_node_id) && !removedIDs.has(connection.to_node_id)));
    if (panelNodeID && removedIDs.has(panelNodeID)) setPanelNodeID("");
    if (infoNodeID && removedIDs.has(infoNodeID)) setInfoNodeID("");
    if (previewNodeID && removedIDs.has(previewNodeID)) setPreviewNodeID("");
    if (pendingConnection && removedIDs.has(pendingConnection.nodeID)) setPendingConnection(null);
    if (imageTool && removedIDs.has(imageTool.nodeID)) setImageTool(null);
    setContextMenu(null);
    setCollapsingBatchRootIDs((current) => new Set([...current].filter((nodeID) => !removedIDs.has(nodeID))));
    setOpeningBatchRootIDs((current) => new Set([...current].filter((nodeID) => !removedIDs.has(nodeID))));
    selectionChanged(new Set());
    if (generationHistoryBase) commitGenerationHistory(generationHistoryBase);
    else pushHistory();
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
    const duplicated = duplicateCanvasNodeGroup(
      nodeID,
      nodesRef.current,
      connectionsRef.current,
      (prefix) => `${prefix}-${randomID()}`,
      createdAt,
    );
    if (!duplicated) return;
    replaceNodes([...nodesRef.current, ...duplicated.nodes]);
    replaceConnections([...connectionsRef.current, ...duplicated.connections]);
    setSelectedNodeIDs(new Set([duplicated.selectedNodeID]));
    setSelectedConnectionID("");
    setPanelNodeID(duplicated.nodes[0]?.type !== "text" ? duplicated.selectedNodeID : "");
    pushHistory();
  }

  function generateFromTextNode(nodeID: string) {
    const source = nodesRef.current.find((node) => node.id === nodeID && node.type === "text");
    if (!source) return;
    const text = (source.prompt || "").trim();
    if (!text) return toast.error("请先双击想法节点输入内容");
    const node: CanvasNode = {
      id: `config-${randomID()}`,
      type: "config",
      x: source.x + source.width + 96,
      y: source.y + source.height / 2 - 120,
      width: 340,
      height: 240,
      scale_x: 1,
      scale_y: 1,
      title: "生成配置",
      prompt: "",
      ...defaultCanvasImageParameters(),
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

  async function openCanvasImageTool(nodeID: string, kind: CanvasImageToolState["kind"]) {
    const node = nodesRef.current.find((item) => item.id === nodeID && item.type === "image" && item.url);
    if (!node?.url || imageToolBusy) return;
    setImageToolBusy(true);
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    try {
      const blob = await fetchAuthenticatedImageBlob(node.url);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch || !nodesRef.current.some((item) => item.id === nodeID)) return;
      setImageTool({ kind, nodeID, sourceURL: URL.createObjectURL(blob) });
      setPanelNodeID("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取图片失败");
    } finally {
      if (mountedRef.current) setImageToolBusy(false);
    }
  }

  function closeCanvasImageTool() {
    if (imageToolBusy) return;
    setImageTool(null);
  }

  async function uploadDerivedCanvasImage(dataURL: string, fileName: string) {
    const file = await canvasDataURLFile(dataURL, fileName);
    const [uploaded, dimensions] = await Promise.all([uploadCanvasImage(file), imageFileSize(file)]);
    await primeAuthenticatedImageCache(uploaded.url, file);
    return { uploaded, dimensions };
  }

  async function cropCanvasNode(crop: CanvasImageCropRect) {
    if (!imageTool || imageTool.kind !== "crop" || imageToolBusy) return;
    const source = nodesRef.current.find((node) => node.id === imageTool.nodeID && node.type === "image");
    if (!source) return closeCanvasImageTool();
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setImageToolBusy(true);
    try {
      const result = await uploadDerivedCanvasImage(await cropCanvasImage(imageTool.sourceURL, crop), `canvas-crop-${source.id}.png`);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch || !nodesRef.current.some((node) => node.id === source.id)) return;
      const size = canvasCroppedNodeSize(source.width, result.dimensions.width, result.dimensions.height);
      const child = {
        ...buildImageNode({ url: result.uploaded.url, title: `${source.title || "图片"} 裁剪`, prompt: source.prompt, width: result.dimensions.width, height: result.dimensions.height }, { x: source.x + source.width + 96, y: source.y }, source),
        ...size,
      };
      replaceNodes([...nodesRef.current, child]);
      replaceConnections([...connectionsRef.current, { id: `connection-${randomID()}`, from_node_id: source.id, to_node_id: child.id }]);
      setSelectedNodeIDs(new Set([child.id])); setSelectedConnectionID(""); setImageTool(null); setPanelNodeID(child.id); pushHistory(); void refreshLibrary();
      toast.success("已生成裁剪节点");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "裁剪图片失败");
    } finally {
      if (mountedRef.current) setImageToolBusy(false);
    }
  }

  async function splitCanvasNode(params: CanvasImageSplitParams) {
    if (!imageTool || imageTool.kind !== "split" || imageToolBusy) return;
    const source = nodesRef.current.find((node) => node.id === imageTool.nodeID && node.type === "image");
    if (!source) return closeCanvasImageTool();
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setImageToolBusy(true);
    try {
      const pieces = await splitCanvasImage(imageTool.sourceURL, params);
      const gap = 16;
      const cellWidth = source.width / params.columns;
      const cellHeight = source.height / params.rows;
      const uploaded = await Promise.all(pieces.map((piece) => uploadDerivedCanvasImage(piece.dataUrl, `canvas-split-${source.id}-${piece.row + 1}-${piece.column + 1}.png`).then((result) => ({ ...piece, ...result }))));
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch || !nodesRef.current.some((node) => node.id === source.id)) return;
      const children = uploaded.map((piece) => ({
        ...buildImageNode({ url: piece.uploaded.url, title: `${source.title || "图片"} ${piece.row + 1}-${piece.column + 1}`, prompt: source.prompt, width: piece.dimensions.width, height: piece.dimensions.height }, { x: source.x + source.width + 96 + piece.column * (cellWidth + gap), y: source.y + piece.row * (cellHeight + gap) }, source),
        width: cellWidth,
        height: cellHeight,
      }));
      replaceNodes([...nodesRef.current, ...children]);
      replaceConnections([...connectionsRef.current, ...children.map((child) => ({ id: `connection-${randomID()}`, from_node_id: source.id, to_node_id: child.id }))]);
      setSelectedNodeIDs(new Set(children.map((child) => child.id))); setSelectedConnectionID(""); setImageTool(null); setPanelNodeID(""); pushHistory(); void refreshLibrary();
      toast.success(`已切分为 ${children.length} 个子节点`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切分图片失败");
    } finally {
      if (mountedRef.current) setImageToolBusy(false);
    }
  }

  async function upscaleCanvasNode(params: CanvasImageUpscaleParams) {
    if (!imageTool || imageTool.kind !== "upscale" || imageToolBusy) return;
    const source = nodesRef.current.find((node) => node.id === imageTool.nodeID && node.type === "image");
    if (!source) return closeCanvasImageTool();
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setImageToolBusy(true);
    try {
      const result = await uploadDerivedCanvasImage(await upscaleCanvasImage(imageTool.sourceURL, params), `canvas-upscale-${source.id}.png`);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch || !nodesRef.current.some((node) => node.id === source.id)) return;
      const child = buildImageNode({ url: result.uploaded.url, title: `${source.title || "图片"} 放大`, prompt: source.prompt, width: result.dimensions.width, height: result.dimensions.height }, { x: source.x + source.width + 96, y: source.y }, source);
      replaceNodes([...nodesRef.current, child]);
      replaceConnections([...connectionsRef.current, { id: `connection-${randomID()}`, from_node_id: source.id, to_node_id: child.id }]);
      setSelectedNodeIDs(new Set([child.id])); setSelectedConnectionID(""); setImageTool(null); setPanelNodeID(child.id); pushHistory(); void refreshLibrary();
      toast.success("已生成放大节点");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "放大图片失败");
    } finally {
      if (mountedRef.current) setImageToolBusy(false);
    }
  }

  function maskEditCanvasNode(payload: CanvasMaskEditPayload) {
    if (!imageTool || imageTool.kind !== "mask" || imageToolBusy) return;
    const nodeID = imageTool.nodeID;
    const source = nodesRef.current.find((node) => node.id === nodeID && node.type === "image");
    if (!source) return closeCanvasImageTool();
    setImageTool(null);
    setPanelNodeID(nodeID);
    void runGeneration(nodeID, `只修改蒙版透明区域，其他区域保持不变。${payload.prompt}`, false, {
      resultTitle: payload.prompt.slice(0, 32) || "局部编辑结果",
      inputImageMask: payload.maskDataURL,
      resultBounds: { width: source.width, height: source.height },
      resultCount: 1,
      selectResultNode: true,
    });
  }

  function angleCanvasNode(params: CanvasImageAngleParams) {
    if (!imageTool || imageTool.kind !== "angle" || imageToolBusy) return;
    const nodeID = imageTool.nodeID;
    setImageTool(null);
    setPanelNodeID(nodeID);
    void runGeneration(nodeID, canvasImageAnglePrompt(params), false, { resultTitle: canvasImageAngleLabel(params), resultCount: 1, selectResultNode: true });
  }

  async function copySelected() {
    const copiedIDs = expandCanvasBatchNodeIDs(selectedNodeIDs, nodesRef.current);
    const copiedNodes = nodesRef.current.filter((node) => copiedIDs.has(node.id));
    if (!copiedNodes.length) return;
    const ids = new Set(copiedNodes.map((node) => node.id));
    const copiedConnections = connectionsRef.current.filter((connection) => ids.has(connection.from_node_id) && ids.has(connection.to_node_id));
    clipboardRef.current = { nodes: copiedNodes, connections: copiedConnections };
    try { await navigator.clipboard.writeText(JSON.stringify({ type: "yunmian-canvas-nodes", nodes: copiedNodes, connections: copiedConnections })); } catch { /* Clipboard access is optional. */ }
    toast.success(`已复制 ${copiedNodes.length} 个节点`);
  }

  async function pasteSelected() {
    let copied = normalizeCanvasClipboard(clipboardRef.current) || { nodes: [] as CanvasNode[], connections: [] as CanvasConnection[] };
    if (!copied.nodes.length) {
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
        if (parsed.type === "yunmian-canvas-nodes") {
          const normalized = normalizeCanvasClipboard(parsed);
          if (!normalized) return toast.error("剪贴板中的画布节点格式无效");
          copied = normalized;
        }
      } catch { /* Invalid clipboard content is handled as plain text below. */ }
      if (!copied.nodes.length && clipboardText.trim()) {
        const text = clipboardText.trim();
        const center = canvasCenterPosition();
        addNode({ id: `text-${randomID()}`, type: "text", x: center.x - 170, y: center.y - 120, width: 340, height: 240, font_size: 14, scale_x: 1, scale_y: 1, title: text.split(/\r?\n/, 1)[0].slice(0, 32) || "想法", prompt: text, created_at: createdAt() });
        toast.success("已从剪贴板添加文字");
        return;
      }
    }
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
    const pastedNodes = copied.nodes.map((node) => remapCanvasNodeReferences({
      ...node,
      id: map.get(node.id) || node.id,
      x: node.x + offsetX,
      y: node.y + offsetY,
      title: node.title?.endsWith(" Copy") ? node.title : `${node.title || canvasNodeFallbackTitle(node.type)} Copy`,
      created_at: createdAt(),
    }, map));
    const pastedConnections = copied.connections.flatMap((connection) => {
      const source = map.get(connection.from_node_id);
      const target = map.get(connection.to_node_id);
      return source && target ? [{ id: `connection-${randomID()}`, from_node_id: source, to_node_id: target }] : [];
    });
    replaceNodes([...nodesRef.current, ...pastedNodes]);
    replaceConnections([...connectionsRef.current, ...pastedConnections]);
    setSelectedNodeIDs(new Set(pastedNodes.map((node) => node.id)));
    setSelectedConnectionID("");
    setContextMenu(null);
    setPanelNodeID(pastedNodes[0]?.type !== "text" ? pastedNodes[0].id : "");
    pushHistory();
  }

  function applyHistory(document: CanvasDocument) {
    interruptActiveGeneration();
    canvasOperationEpochRef.current += 1;
    const next = restoreCanvasHistoryDocument(documentRef.current, cloneDocument(document));
    documentRef.current = next;
    replaceNodes(next.nodes);
    replaceConnections(next.connections);
    titleRef.current = next.title;
    backgroundRef.current = next.background;
    setTitle(next.title);
    setBackground(next.background);
    selectionChanged(new Set());
    scheduleSave();
  }

  function undo() {
    const generationHistoryBase = generationHistoryBaseRef.current;
    if (generationHistoryBase) {
      interruptActiveGeneration();
      historyRef.current = [...generationHistoryBase];
      redoRef.current = [];
      const previous = historyRef.current.at(-1);
      if (previous) applyHistory(previous);
      setHistoryVersion((value) => value + 1);
      return;
    }
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

  function resetViewport() {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    updateViewport(resetCanvasViewport(rect), true);
    setContextMenu(null);
  }

  function interruptActiveGeneration() {
    if (!generationAbortControllerRef.current && !runningNodeID) return null;
    const generationHistoryBase = generationHistoryBaseRef.current;
    generationHistoryBaseRef.current = null;
    const serverTaskID = submittedTaskIDRef.current || runningTaskID;
    const taskID = serverTaskID || pendingTaskIDRef.current;
    if (taskID) cancelledTaskIDsRef.current.add(taskID);
    generationEpochRef.current += 1;
    generationAbortControllerRef.current?.abort();
    generationAbortControllerRef.current = null;
    pendingTaskIDRef.current = "";
    submittedTaskIDRef.current = "";
    replaceNodes(restoreInterruptedCanvasGenerations(nodesRef.current));
    setStopConfirmationOpen(false);
    setRunningNodeID("");
    setRunningResultNodeID("");
    setRunningControlNodeID("");
    setRunningTaskID("");
    setCancellingTaskID("");
    if (serverTaskID) void cancelCreationTask(serverTaskID).catch((error) => toast.error(error instanceof Error ? `本地已停止，服务端停止失败：${error.message}` : "本地已停止，服务端停止失败"));
    return generationHistoryBase;
  }

  function interruptGenerationForProjectChange() {
    const generationHistoryBase = interruptActiveGeneration();
    if (generationHistoryBase) commitGenerationHistory(generationHistoryBase);
  }

  async function runProject(input: Parameters<typeof updateCanvasProject>[0]) {
    const changesActiveProject = input.action === "create"
      || input.action === "activate" && input.project_id !== documentRef.current.id
      || input.action === "delete" && (!input.project_id || input.project_id === documentRef.current.id);
    if (changesActiveProject) {
      canvasOperationEpochRef.current += 1;
      interruptGenerationForProjectChange();
      setProjectMenuOpen(false);
      if (switchRevealTimerRef.current !== null) window.clearTimeout(switchRevealTimerRef.current);
      switchRevealTimerRef.current = null;
      setSwitchPhase("switching");
    }
    try {
      await enqueueWorkspaceMutation(async () => {
        if (!await flushCanvasSaves({
          save: persistCanvas,
          getChangeVersion: () => saveChangeVersionRef.current,
          getProjectID: () => documentRef.current.id,
        })) return;
        const response = await updateCanvasProject(input);
        applyWorkspace(response);
        setProjectMenuOpen(false);
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "画布项目操作失败");
    } finally {
      if (changesActiveProject && mountedRef.current) {
        setSwitchPhase("revealing");
        switchRevealTimerRef.current = window.setTimeout(() => {
          switchRevealTimerRef.current = null;
          if (mountedRef.current) setSwitchPhase(null);
        }, 180);
      }
    }
  }

  async function waitForTask(taskID: string, onProgress?: (task: CreationTask) => void, signal?: AbortSignal) {
    const deadline = Date.now() + TASK_POLL_MAX_DURATION_MS;
    let delay = TASK_POLL_INTERVAL_MS;
    let errorCount = 0;
    while (Date.now() < deadline) {
      await sleep(delay, signal);
      let task: CreationTask | undefined;
      try {
        task = (await fetchCreationTasks([taskID], { signal })).items.find((item) => item.id === taskID);
        errorCount = 0;
      } catch (error) {
        if (!isRetryableTaskPollError(error)) throw error;
        errorCount += 1;
        const retryDelay = Math.min(TASK_POLL_MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.min(errorCount - 1, 4));
        await sleep(retryDelay, signal);
        continue;
      }
      if (task) onProgress?.(task);
      if (task?.status === "success" || task?.status === "error" || task?.status === "cancelled") return task;
      delay = Math.min(2500, Math.round(delay * 1.35));
    }
    throw new Error("图片任务处理时间过长，请稍后在任务队列中查看结果");
  }

  function isCurrentCanvasRecovery(projectID: string, operationEpoch: number, signal: AbortSignal) {
    return mountedRef.current
      && !signal.aborted
      && documentRef.current.id === projectID
      && canvasOperationEpochRef.current === operationEpoch;
  }

  function applyRecoveredCanvasTask(task: CreationTask, projectID: string, operationEpoch: number, signal: AbortSignal) {
    if (!isCurrentCanvasRecovery(projectID, operationEpoch, signal)) return { terminal: false, completedImageCount: 0 };
    const result = reconcilePersistedCanvasTaskNodes(nodesRef.current, task);
    if (!result.changed) return { terminal: result.terminal, completedImageCount: result.completedImageCount };
    replaceNodes(result.nodes);
    if (result.terminal || result.completedImageCount > 0) scheduleSave();
    return { terminal: result.terminal, completedImageCount: result.completedImageCount };
  }

  function markCanvasTaskRecoveryError(taskID: string, message: string, projectID: string, operationEpoch: number, signal: AbortSignal) {
    if (!isCurrentCanvasRecovery(projectID, operationEpoch, signal)) return;
    const nextNodes = nodesRef.current.map((node) => node.task_id === taskID && node.generation_status === "loading"
      ? { ...node, generation_status: "error" as const, generation_error: message }
      : node);
    replaceNodes(nextNodes);
    scheduleSave();
  }

  async function recoverCanvasTasks(projectID: string, operationEpoch: number, taskIDs: string[], signal: AbortSignal) {
    let response: Awaited<ReturnType<typeof fetchCreationTasks>>;
    try {
      response = await fetchCreationTasks(taskIDs, { signal });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const message = error instanceof Error ? error.message : "无法读取图片任务状态";
        taskIDs.forEach((taskID) => markCanvasTaskRecoveryError(taskID, message, projectID, operationEpoch, signal));
      }
      return;
    }
    if (!isCurrentCanvasRecovery(projectID, operationEpoch, signal)) return;
    const tasksByID = new Map(response.items.map((task) => [task.id, task]));
    response.missing_ids.forEach((taskID) => markCanvasTaskRecoveryError(taskID, "任务记录不存在，无法恢复生成结果", projectID, operationEpoch, signal));
    await Promise.all(taskIDs.flatMap((taskID) => {
      const task = tasksByID.get(taskID);
      if (!task) return [];
      const progress = applyRecoveredCanvasTask(task, projectID, operationEpoch, signal);
      if (progress.terminal) return [];
      return [
        (async () => {
          try {
            const completedTask = await waitForTask(taskID, (nextTask) => {
              applyRecoveredCanvasTask(nextTask, projectID, operationEpoch, signal);
            }, signal);
            applyRecoveredCanvasTask(completedTask, projectID, operationEpoch, signal);
          } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
              markCanvasTaskRecoveryError(taskID, error instanceof Error ? error.message : "恢复图片任务失败", projectID, operationEpoch, signal);
            }
          }
        })(),
      ];
    }));
  }

  async function stopGeneration() {
    if (!runningNodeID || cancellingTaskID) return;
    const serverTaskID = submittedTaskIDRef.current || runningTaskID;
    const taskID = serverTaskID || pendingTaskIDRef.current;
    if (taskID) cancelledTaskIDsRef.current.add(taskID);
    setCancellingTaskID(taskID || "pending");
    generationAbortControllerRef.current?.abort();
    try {
      if (serverTaskID) await cancelCreationTask(serverTaskID);
      toast.success("已停止生成");
    } catch (error) {
      if (mountedRef.current) setCancellingTaskID("");
      toast.error(error instanceof Error ? `本地已停止，服务端停止失败：${error.message}` : "本地已停止，服务端停止失败");
    }
  }

  function requestStopGeneration() {
    if (!runningNodeID || cancellingTaskID) return;
    setStopConfirmationOpen(true);
  }

  function confirmStopGeneration() {
    setStopConfirmationOpen(false);
    void stopGeneration();
  }

  async function runGeneration(nodeID: string, prompt?: string, retry = false, options: CanvasGenerationOptions = {}) {
    const sourceNode = nodesRef.current.find((node) => node.id === nodeID && (node.type === "image" || node.type === "config"));
    if (!sourceNode) return;
    const retrying = sourceNode.type === "image" && retry && sourceNode.generation_status === "error";
    const retryConfiguration = retrying && !sourceNode.generation_type
      ? findCanvasRetryConfigurationNode(sourceNode.id, nodesRef.current, connectionsRef.current)
      : null;
    const contextNode = retryConfiguration || sourceNode;
    const contextPrompt = prompt ?? retryConfiguration?.composer_content ?? retryConfiguration?.prompt ?? sourceNode.composer_content ?? sourceNode.prompt ?? "";
    const context = buildCanvasGenerationContext(contextNode.id, nodesRef.current, connectionsRef.current, contextPrompt);
    const text = retrying ? String(sourceNode.prompt || context.prompt).trim() : context.prompt;
    const upstreamReferenceImageURLs = canvasGenerationReferenceImageURLs(contextNode, context.referenceImageURLs, MAX_IMAGE_CONVERSATION_REFERENCE_IMAGES);
    const referenceImageURLs = retrying && sourceNode.generation_type
      ? (sourceNode.generation_reference_urls || []).slice(0, MAX_IMAGE_CONVERSATION_REFERENCE_IMAGES)
      : upstreamReferenceImageURLs;
    const mode = referenceImageURLs.length ? "edit" : "generate";
    const createsResultNode = !retrying && (sourceNode.type === "config" || Boolean(sourceNode.url));
    if ((!text && !referenceImageURLs.length) || runningNodeID) return toast.error("请连接有效输入或填写画面描述");
    if (retrying && sourceNode.generation_type === "edit" && !referenceImageURLs.length) return toast.error("参考图片已丢失，无法继续重试");
    const parameters = canvasImageParameters(retryConfiguration || sourceNode);
    const size = parameters.generation_size || undefined;
    const resolution = parameters.generation_resolution && parameters.generation_resolution !== "auto" ? parameters.generation_resolution : undefined;
    const count = canvasGenerationCount(parameters.generation_count, options.resultCount, retrying);
    const stream = parameters.generation_stream ?? true;
    const taskRelayTokenName = relayTokenName.trim() || undefined;
    const taskID = `canvas-${mode}-${randomID()}`;
    const controller = new AbortController();
    const generationEpoch = generationEpochRef.current + 1;
    generationEpochRef.current = generationEpoch;
    const generationProjectID = documentRef.current.id;
    const generationIsCurrent = () => generationEpochRef.current === generationEpoch
      && documentRef.current.id === generationProjectID
      && generationAbortControllerRef.current === controller;
    generationAbortControllerRef.current = controller;
    pendingTaskIDRef.current = taskID;
    submittedTaskIDRef.current = "";
    let activeTaskID = taskID;
    let taskCancelled = false;
    const completedProgressNodeIDs = new Set<string>();
    const resultTitle = options.resultTitle?.trim() || text.slice(0, 32) || "图片";
    const resultNodeID = createsResultNode ? `image-${randomID()}` : sourceNode.id;
    const generationState: Pick<CanvasNode, "title" | "prompt" | "task_id" | "generation_status" | "generation_error" | "generation_type" | "generation_reference_urls"> = {
      title: resultTitle,
      prompt: text,
      task_id: taskID,
      generation_status: "loading" as const,
      generation_error: "",
      generation_type: mode,
      generation_reference_urls: referenceImageURLs,
    };
    let resultNode: CanvasNode = { ...sourceNode, ...generationState };
    if (createsResultNode) {
      resultNode = {
        ...buildImageNode(
          { url: "", title: resultTitle, prompt: text, width: 340, height: 240, taskID },
          {
            x: sourceNode.x + sourceNode.width + 96,
            y: sourceNode.y + sourceNode.height / 2 - (options.resultBounds?.height || 240) / 2,
          },
          sourceNode,
        ),
        id: resultNodeID,
        ...generationState,
        ...(options.resultBounds ? { width: options.resultBounds.width, height: options.resultBounds.height } : {}),
      };
    }
    const isBatch = count > 1;
    const batchChildren: CanvasNode[] = isBatch ? Array.from({ length: count }, (_, index) => ({
      ...buildImageNode(
        { url: "", title: resultTitle, prompt: text, width: 340, height: 240, taskID },
        {
          x: resultNode.x + resultNode.width + 120 + (index % 2) * 376,
          y: resultNode.y + Math.floor(index / 2) * 276,
        },
        resultNode,
      ),
      ...generationState,
      batch_root_id: resultNode.id,
    })) : [];
    if (isBatch) {
      resultNode = {
        ...resultNode,
        batch_child_ids: batchChildren.map((node) => node.id),
        batch_primary_id: undefined,
        batch_expanded: true,
      };
    } else if (!retrying) {
      resultNode = { ...resultNode, batch_child_ids: undefined, batch_primary_id: undefined, batch_expanded: undefined };
    }
    const resultNodes = [resultNode, ...batchChildren];
    const initialResultImageByID = new Map(resultNodes.map((node) => [node.id, {
      url: node.url || "",
      thumbnailURL: node.thumbnail_url || "",
    }]));
    const outputNodeIDs = isBatch ? batchChildren.map((node) => node.id) : [resultNode.id];
    const resultNodeIDs = resultNodes.map((node) => node.id);
    const activeSelectionNodeID = canvasGenerationActiveNodeID(sourceNode.id, resultNode.id, createsResultNode, options.selectResultNode);
    const replacedBatchChildIDs = sourceNode.type === "image" && !createsResultNode && !retrying ? new Set(sourceNode.batch_child_ids || []) : new Set<string>();
    const resultConnections: CanvasConnection[] = [
      ...(createsResultNode ? [{ id: `connection-${randomID()}`, from_node_id: sourceNode.id, to_node_id: resultNode.id }] : []),
      ...batchChildren.map((node) => ({ id: `connection-${randomID()}`, from_node_id: resultNode.id, to_node_id: node.id })),
    ];
    const generationHistoryBase = appendCanvasHistorySnapshot(historyRef.current, cloneDocument(captureDocument()), MAX_HISTORY);
    historyRef.current = generationHistoryBase;
    const generationStartNodes = setCanvasConfigGenerationStatus(nodesRef.current, sourceNode.id, "loading", "", taskID);
    replaceNodes(placeCanvasGenerationResultNodes(generationStartNodes, sourceNode.id, resultNodes, replacedBatchChildIDs));
    replaceConnections([
      ...connectionsRef.current.filter((connection) => !replacedBatchChildIDs.has(connection.from_node_id) && !replacedBatchChildIDs.has(connection.to_node_id)),
      ...resultConnections,
    ]);
    setSelectedNodeIDs(new Set([activeSelectionNodeID]));
    setSelectedConnectionID("");
    setPanelNodeID(activeSelectionNodeID);
    pushHistory();
    generationHistoryBaseRef.current = generationHistoryBase;
    setRunningNodeID(nodeID);
    setRunningResultNodeID(resultNodeID);
    setRunningControlNodeID(activeSelectionNodeID);
    setRunningTaskID("");
    try {
      let submitted: CreationTask;
      if (referenceImageURLs.length) {
        const referenceFiles = await Promise.all(referenceImageURLs.map(async (url, index) => {
          const blob = await fetchAuthenticatedImageBlob(url, controller.signal);
          return new File([blob], `canvas-reference-${index + 1}.${blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png"}`, { type: blob.type || "image/png" });
        }));
        submitted = await createImageEditTask(taskID, referenceFiles, buildCanvasImageReferencePrompt(text, referenceFiles.length), imageModel || undefined, size, size, parameters.generation_quality, count, undefined, "private", resolution, parameters.generation_output_format, parameters.generation_output_compression, stream, parameters.generation_partial_images, options.inputImageMask ? { inputImageMask: options.inputImageMask } : undefined, undefined, taskRelayTokenName, undefined, undefined, { signal: controller.signal });
      } else submitted = await createImageGenerationTask(taskID, text, imageModel || undefined, size, size, parameters.generation_quality, count, undefined, "private", resolution, parameters.generation_output_format, parameters.generation_output_compression, stream, parameters.generation_partial_images, undefined, undefined, taskRelayTokenName, undefined, undefined, { signal: controller.signal });
      if (!generationIsCurrent()) return;
      activeTaskID = submitted.id || taskID;
      pendingTaskIDRef.current = activeTaskID;
      submittedTaskIDRef.current = activeTaskID;
      setRunningTaskID(activeTaskID);
      const completedTask = await waitForTask(activeTaskID, (task) => {
        if (!generationIsCurrent()) return;
        const progress = applyCanvasTaskProgressNodes(nodesRef.current, task, {
          outputNodeIDs,
          batchRootID: isBatch ? resultNodeID : undefined,
          taskID: activeTaskID,
        });
        let nextNodes = progress.nodes;
        let receivedNewFinal = false;
        progress.completedImageByNodeID.forEach((_image, completedNodeID) => {
          if (completedProgressNodeIDs.has(completedNodeID)) return;
          completedProgressNodeIDs.add(completedNodeID);
          receivedNewFinal = true;
        });
        if (receivedNewFinal) nextNodes = setCanvasConfigGenerationStatus(nextNodes, sourceNode.id, "success", "", activeTaskID);
        replaceNodes(nextNodes);
        if (receivedNewFinal) scheduleSave();
      }, controller.signal);
      if (!generationIsCurrent()) return;
      const taskResult = summarizeCanvasTaskResult(completedTask, outputNodeIDs.length);
      taskCancelled = taskResult.cancelled;
      if (taskCancelled) throw new DOMException("请求已取消", "AbortError");
      const images = taskResult.images;
      if (!images.length) throw new Error(taskResult.error || "任务完成但没有返回图片");
      const imageByNodeID = new Map(taskResult.slots.flatMap((slot, index) => slot.image ? [[outputNodeIDs[index], slot.image] as const] : []));
      const currentNodeIDs = new Set(nodesRef.current.map((node) => node.id));
      const currentBatchRoot = isBatch ? nodesRef.current.find((node) => node.id === resultNodeID) : null;
      const batchPrimaryID = currentBatchRoot?.batch_primary_id && imageByNodeID.has(currentBatchRoot.batch_primary_id)
        ? currentBatchRoot.batch_primary_id
        : outputNodeIDs.find((outputNodeID) => currentNodeIDs.has(outputNodeID) && imageByNodeID.has(outputNodeID));
      let nextNodes = nodesRef.current.map((node): CanvasNode => {
        if (!resultNodeIDs.includes(node.id)) return node;
        if (isBatch && node.id === resultNodeID) {
          const image = batchPrimaryID ? imageByNodeID.get(batchPrimaryID) : undefined;
          if (!image) return {
            ...restoreCanvasTaskInitialImage(node, initialResultImageByID),
            generation_status: "error",
            generation_error: "任务完成但图片组没有可用结果",
            task_id: activeTaskID,
            batch_primary_id: undefined,
          };
          return {
            ...applyCanvasTaskImage(node, image, activeTaskID),
            batch_primary_id: batchPrimaryID && node.batch_child_ids?.includes(batchPrimaryID) ? batchPrimaryID : undefined,
          };
        }
        const image = imageByNodeID.get(node.id);
        if (!image) return {
          ...restoreCanvasTaskInitialImage(node, initialResultImageByID),
          generation_status: "error",
          generation_error: "任务完成但没有返回这张图片",
          task_id: activeTaskID,
        };
        return applyCanvasTaskImage(node, image, activeTaskID);
      });
      if (retrying && sourceNode.batch_root_id) {
        nextNodes = syncCanvasBatchRootAfterRetry(nextNodes, sourceNode.id);
      }
      nextNodes = setCanvasConfigGenerationStatus(nextNodes, sourceNode.id, "success", "", activeTaskID);
      replaceNodes(nextNodes);
      setSelectedNodeIDs(new Set([activeSelectionNodeID]));
      setSelectedConnectionID("");
      commitGenerationHistory(generationHistoryBase);
      void refreshLibrary();
      const missingCount = taskResult.missingCount;
      if (missingCount) toast.error(`已完成 ${images.length} 张，${missingCount} 张生成失败`);
      else if (completedTask.status === "error") toast.error(completedTask.error || "图片任务返回异常状态");
      else toast.success(`已添加 ${images.length} 张图片到画布`);
    } catch (error) {
      if (!generationIsCurrent()) return;
      const cancelled = taskCancelled || controller.signal.aborted || cancelledTaskIDsRef.current.has(activeTaskID) || cancelledTaskIDsRef.current.has(taskID);
      const generationError = error instanceof Error ? error.message : "创作任务失败";
      let cancelledTask: CreationTask | null = null;
      if (cancelled) {
        try { cancelledTask = await cancelCreationTask(activeTaskID); } catch { /* A request cancelled before submission has no server task. */ }
        if (!generationIsCurrent()) return;
      }
      const cancelledResult = cancelled ? reconcileCancelledCanvasTaskNodes(nodesRef.current, cancelledTask, {
        resultNodeIDs,
        outputNodeIDs,
        batchRootID: isBatch ? resultNodeID : undefined,
        taskID: activeTaskID,
        initialImageByNodeID: initialResultImageByID,
      }) : null;
      const completedImageByNodeID = cancelledResult?.completedImageByNodeID || new Map();
      let nextNodes = cancelledResult?.nodes || nodesRef.current.map((node): CanvasNode => resultNodeIDs.includes(node.id) ? {
        ...restoreCanvasTaskInitialImage(node, initialResultImageByID),
        task_id: activeTaskID,
        generation_status: "error",
        generation_error: generationError,
      } : node);
      if (cancelled && retrying && sourceNode.batch_root_id && completedImageByNodeID.has(sourceNode.id)) nextNodes = syncCanvasBatchRootAfterRetry(nextNodes, sourceNode.id);
      nextNodes = setCanvasConfigGenerationStatus(nextNodes, sourceNode.id, cancelled ? "idle" : "error", cancelled ? "" : generationError, cancelled ? "" : activeTaskID);
      replaceNodes(nextNodes);
      commitGenerationHistory(generationHistoryBase);
      if (completedImageByNodeID.size) void refreshLibrary();
      if (!cancelled) toast.error(generationError);
    } finally {
      cancelledTaskIDsRef.current.delete(taskID);
      cancelledTaskIDsRef.current.delete(activeTaskID);
      if (generationEpochRef.current === generationEpoch && generationAbortControllerRef.current === controller) generationAbortControllerRef.current = null;
      if (generationEpochRef.current === generationEpoch && (pendingTaskIDRef.current === taskID || pendingTaskIDRef.current === activeTaskID)) pendingTaskIDRef.current = "";
      if (generationEpochRef.current === generationEpoch && submittedTaskIDRef.current === activeTaskID) submittedTaskIDRef.current = "";
      if (mountedRef.current && generationEpochRef.current === generationEpoch) {
        setStopConfirmationOpen(false);
        setRunningNodeID("");
        setRunningResultNodeID("");
        setRunningControlNodeID("");
        setRunningTaskID("");
        setCancellingTaskID("");
      }
    }
  }

  async function resetCanvas() {
    setClearConfirmationOpen(false);
    canvasOperationEpochRef.current += 1;
    interruptActiveGeneration();
    try {
      await enqueueWorkspaceMutation(async () => {
        const projectID = documentRef.current.id;
        const response = await clearCanvasDocument(projectID);
        applyDocument(response.document);
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清空画布失败");
    }
  }

  async function exportImage() {
    if (exportingCanvas || !nodesRef.current.length) return;
    setExportingCanvas(true);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const element = hostRef.current?.querySelector<HTMLElement>("[data-canvas-export-root]");
    if (!element) {
      setExportingCanvas(false);
      return;
    }
    try {
      const backgroundColor = getComputedStyle(element).backgroundColor || "#eef2f7";
      const url = await toPng(element, { backgroundColor, pixelRatio: 2, cacheBust: true });
      const link = document.createElement("a");
      link.href = url;
      link.download = `云棉画布-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "画布导出失败");
    } finally {
      setExportingCanvas(false);
    }
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
    try {
      const parsed = JSON.parse(await file.text()) as CanvasDocument;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.nodes)) throw new Error("画布文件格式无效");
      canvasOperationEpochRef.current += 1;
      interruptGenerationForProjectChange();
      await enqueueWorkspaceMutation(async () => {
        if (!await flushCanvasSaves({ save: persistCanvas, getChangeVersion: () => saveChangeVersionRef.current, getProjectID: () => documentRef.current.id })) return;
        const response = await importCanvasProject({
          ...parsed,
          version: 1,
          title: String(parsed.title || file.name.replace(/\.json$/i, "") || "导入画布"),
          background: parsed.background || "dots",
          connections: Array.isArray(parsed.connections) ? parsed.connections : [],
          viewport: parsed.viewport || DEFAULT_DOCUMENT.viewport,
        });
        applyWorkspace(response);
        setProjectMenuOpen(false);
        toast.success("画布已作为新项目导入");
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "画布导入失败");
    }
  }

  function openNodeContextMenu(event: ReactMouseEvent, nodeID: string) {
    event.preventDefault();
    event.stopPropagation();
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
      addImageNode({ url: image.url || image.path, thumbnailURL: image.thumbnail_url, title: canvasLibraryImageTitle(image), prompt: image.prompt, width: image.width, height: image.height }, { x: position.x, y: position.y, centered: true });
    } catch {
      toast.error("无法添加这张图片");
    }
  }

  function renderNodePanel(node: CanvasNode) {
    if (node.type === "config") {
      return (
        <CanvasConfigComposer
          node={node}
          inputs={canvasConfigInputs(node.id, nodesRef.current, connectionsRef.current)}
          onComposerChange={(value, commit) => updateNodeComposerContent(node.id, value, commit)}
          onClose={() => setPanelNodeID("")}
        />
      );
    }
    const running = runningControlNodeID === node.id;
    const connectedPromptAvailable = Boolean(buildCanvasGenerationContext(node.id, nodesRef.current, connectionsRef.current, node.prompt || "").prompt);
    return (
      <CanvasNodePromptPanel
        node={node}
        mentionReferences={canvasNodeMentionReferences(node.id, nodesRef.current, connectionsRef.current)}
        running={running}
        generationBusy={Boolean(runningNodeID)}
        imageModel={imageModel}
        imageModelReady={imageModelReady}
        cancelling={Boolean(cancellingTaskID)}
        canStop={Boolean(runningNodeID)}
        connectedPromptAvailable={connectedPromptAvailable}
        onPromptChange={(value, commit) => updateNodePrompt(node.id, value, commit)}
        onParametersChange={(patch) => updateNodeGenerationParameters(node.id, patch)}
        onGenerate={(prompt) => void runGeneration(node.id, prompt)}
        onStop={requestStopGeneration}
      />
    );
  }

  useEffect(() => {
    const batchAnimationTimers = batchAnimationTimersRef.current;
    mountedRef.current = true;
    void fetchCanvasDocument().then(applyWorkspace).catch((error) => toast.error(error instanceof Error ? error.message : "画布加载失败")).finally(() => mountedRef.current && setLoading(false));
    const flushPendingSave = () => {
      if (saveTimerRef.current === null) return;
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      void persistCanvas();
    };
    window.addEventListener("pagehide", flushPendingSave);
    return () => {
      mountedRef.current = false;
      generationEpochRef.current += 1;
      generationAbortControllerRef.current?.abort();
      generationAbortControllerRef.current = null;
      canvasRecoveryAbortControllerRef.current?.abort();
      canvasRecoveryAbortControllerRef.current = null;
      flushPendingSave();
      window.removeEventListener("pagehide", flushPendingSave);
      batchAnimationTimers.forEach((timer) => window.clearTimeout(timer));
      batchAnimationTimers.clear();
      if (switchRevealTimerRef.current !== null) window.clearTimeout(switchRevealTimerRef.current);
    };
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
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshLibrary();
    };
    const timer = window.setInterval(refreshWhenVisible, 4000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [libraryOpen, refreshLibrary]);

  useEffect(() => {
    window.localStorage.setItem(MINI_MAP_STORAGE_KEY, String(miniMapOpen));
  }, [miniMapOpen]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT"
        || target?.tagName === "TEXTAREA"
        || target?.tagName === "SELECT"
        || target?.isContentEditable
        || target?.closest("[data-canvas-no-pan],[role='dialog'],[role='listbox']")
      ) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && !event.altKey && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (command && !event.altKey && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
      else if (command && !event.altKey && event.key.toLowerCase() === "a") { event.preventDefault(); selectionChanged(new Set(nodesRef.current.map((node) => node.id))); }
      else if (command && !event.altKey && event.key.toLowerCase() === "c") { event.preventDefault(); void copySelected(); }
      else if (command && !event.altKey && event.key.toLowerCase() === "v") { event.preventDefault(); void pasteSelected(); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelected(); }
      else if (event.key === "Escape") {
        selectionChanged(new Set());
        setPendingConnection(null);
        setNodeCreateMenu(null);
        setInfoNodeID("");
        setPreviewNodeID("");
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
    <section ref={hostRef} className="relative h-full min-h-[540px] overflow-hidden rounded-xl border border-border bg-[#f3f5f8] shadow-[0_16px_42px_-34px_rgba(15,23,42,0.34)] dark:bg-[#15181d]">
      <CanvasEngine nodes={nodes} connections={connections} viewport={viewport} background={background} canvasSize={canvasSize} exporting={exportingCanvas} exportBounds={exportingCanvas ? canvasExportBounds(visibleCanvasNodes(nodes)) : undefined} selectedNodeIDs={selectedNodeIDs} selectedConnectionID={selectedConnectionID} panelNodeID={panelNodeID} runningNodeID={runningControlNodeID} loadingNodeID={runningResultNodeID} pendingConnectionActive={Boolean(pendingConnection)} collapsingBatchRootIDs={collapsingBatchRootIDs} openingBatchRootIDs={openingBatchRootIDs} onNodesChange={replaceNodes} onNodesCommit={pushHistory} onViewportChange={updateViewport} onSelectionChange={selectionChanged} onConnect={connectNodes} canConnect={canConnect} onConnectionDropEmpty={(origin, position, menu) => setPendingConnection({ ...origin, position, menu })} onPromptChange={updateNodePrompt} onTextFontSizeChange={updateTextFontSize} onTitleChange={updateNodeTitle} onNodePanelToggle={(nodeID) => setPanelNodeID((current) => current === nodeID ? "" : nodeID)} onNodeGenerate={(nodeID) => void runGeneration(nodeID)} onNodeStop={requestStopGeneration} onNodeParametersChange={updateNodeGenerationParameters} onNodeUpload={requestNodeImageUpload} onToggleFreeResize={toggleCanvasFreeResize} onCropImage={(nodeID) => void openCanvasImageTool(nodeID, "crop")} onSplitImage={(nodeID) => void openCanvasImageTool(nodeID, "split")} onUpscaleImage={(nodeID) => void openCanvasImageTool(nodeID, "upscale")} onMaskEdit={(nodeID) => void openCanvasImageTool(nodeID, "mask")} onAngleImage={(nodeID) => void openCanvasImageTool(nodeID, "angle")} uploadingNodeID={uploadingNodeID} onViewImage={(nodeID) => { setPanelNodeID(""); setPreviewNodeID(nodeID); }} onCopyPrompt={(nodeID) => void copyNodePrompt(nodeID)} onDownloadImage={(nodeID) => void downloadNodeImage(nodeID)} onTextToImage={generateFromTextNode} onNodeRetry={(nodeID) => void runGeneration(nodeID, undefined, true)} onNodeActivate={activateNode} onToggleBatch={toggleCanvasBatch} onSetBatchPrimary={makeCanvasBatchPrimary} onNodeInfo={setInfoNodeID} onNodeDelete={(nodeID) => removeNodes(new Set([nodeID]))} onNodeContextMenu={openNodeContextMenu} onConnectionContextMenu={openConnectionContextMenu} onCanvasContextMenu={openCanvasContextMenu} onCanvasDoubleClick={(event, position) => { const rect = hostRef.current?.getBoundingClientRect(); setNodeCreateMenu({ position, menu: { x: event.clientX - (rect?.left || 0), y: event.clientY - (rect?.top || 0) } }); }} renderNodePanel={renderNodePanel} onDrop={handleCanvasDrop} />

      {pendingConnection ? <div data-connection-create-menu className="absolute z-40 w-48 rounded-xl border border-border bg-card p-1.5 shadow-xl" style={{ left: Math.max(8, Math.min(pendingConnection.menu.x, (hostRef.current?.clientWidth || 240) - 200)), top: Math.max(64, Math.min(pendingConnection.menu.y, (hostRef.current?.clientHeight || 240) - 168)) }}><p className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">创建节点并连接</p><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("text")}><Type className="size-4" />想法节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("image")}><ImagePlus className="size-4" />空白图片节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("config")}><Settings2 className="size-4" />生成配置节点</button></div> : null}
      {nodeCreateMenu ? <div data-node-create-menu className="absolute z-40 w-48 rounded-xl border border-border bg-card p-1.5 shadow-xl" style={{ left: Math.max(8, Math.min(nodeCreateMenu.menu.x, (hostRef.current?.clientWidth || 240) - 200)), top: Math.max(64, Math.min(nodeCreateMenu.menu.y, (hostRef.current?.clientHeight || 240) - 168)) }}><p className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">添加到画布</p><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addTextNodeAt({ x: nodeCreateMenu.position.x - 170, y: nodeCreateMenu.position.y - 120 }); setNodeCreateMenu(null); }}><Type className="size-4" />想法节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addBlankNodeAt({ x: nodeCreateMenu.position.x - 170, y: nodeCreateMenu.position.y - 120 }); setNodeCreateMenu(null); }}><ImagePlus className="size-4" />空白图片节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addConfigNodeAt({ x: nodeCreateMenu.position.x - 170, y: nodeCreateMenu.position.y - 120 }); setNodeCreateMenu(null); }}><Settings2 className="size-4" />生成配置节点</button></div> : null}

      <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-3">
        <div className="pointer-events-auto flex h-10 items-center rounded-xl border border-border bg-card/94 p-1 shadow-[0_8px_24px_rgba(15,23,42,.09)] backdrop-blur-xl">
          <Button aria-label="画布项目" variant="ghost" size="sm" className="h-8 max-w-56 rounded-lg px-2.5 text-xs font-semibold" onClick={() => setProjectMenuOpen((value) => !value)}><span className="truncate">{title}</span><ChevronDown className="size-3.5" /></Button>
        </div>
        <Button variant="ghost" size="sm" className="pointer-events-auto h-10 min-w-[88px] rounded-xl border border-border bg-card/94 px-2.5 text-xs shadow-[0_8px_24px_rgba(15,23,42,.09)] backdrop-blur-xl" onClick={() => void persistCanvas()}>{saveState === "saving" ? <LoaderCircle className="animate-spin" /> : <Save />}{saveLabel(saveState)}</Button>
      </div>

      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center">
        <div className="hide-scrollbar pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto px-1">
          <div className="flex h-11 shrink-0 items-center gap-0.5 rounded-xl border border-border bg-card/95 p-1 shadow-[0_10px_28px_rgba(15,23,42,.12)] backdrop-blur-xl">
            <ToolButton active={!selectedNodeIDs.size && !selectedConnectionID} label="移动/选择" onClick={() => selectionChanged(new Set())}><Hand /></ToolButton>
            <ToolbarDivider />
            <ToolButton label="撤销" disabled={historyRef.current.length <= 1} onClick={undo}><Undo2 /></ToolButton>
            <ToolButton label="重做" disabled={!redoRef.current.length} onClick={redo}><Redo2 /></ToolButton>
            <ToolbarDivider />
            <ToolButton label="添加想法" onClick={addTextNode}><Type /></ToolButton>
            <ToolButton label="添加空白图片" onClick={addBlankNode}><ImagePlus /></ToolButton>
            <ToolButton label="添加生成配置" onClick={() => addConfigNodeAt(placement())}><Settings2 /></ToolButton>
            <ToolButton label="上传图片" disabled={Boolean(uploadingNodeID)} onClick={() => requestCanvasImageUpload()}>{uploadingNodeID === "canvas-upload" ? <LoaderCircle className="animate-spin" /> : <Upload />}</ToolButton>
            <ToolButton active={libraryOpen} label="图片库" onClick={() => setLibraryOpen((value) => !value)}><Images /></ToolButton>
            <ToolButton label="导入画布" onClick={() => importRef.current?.click()}><FileUp /></ToolButton>
            <ToolbarDivider />
            <ToolButton label="删除所选" disabled={!selectedNodeIDs.size && !selectedConnection} className="text-rose-600" onClick={removeSelected}><Trash2 /></ToolButton>
            <ToolButton label="导出图片" disabled={!nodes.length || exportingCanvas} onClick={() => void exportImage()}>{exportingCanvas ? <LoaderCircle className="animate-spin" /> : <Download />}</ToolButton>
            <ToolButton label="清空画布" disabled={!nodes.length} className="text-rose-600" onClick={() => setClearConfirmationOpen(true)}><X /></ToolButton>
          </div>
        </div>
      </div>

      <div className="pointer-events-auto absolute bottom-3 left-3 z-30 hidden h-11 items-center gap-0.5 rounded-xl border border-border bg-card/95 p-1 shadow-[0_10px_28px_rgba(15,23,42,.12)] backdrop-blur-xl lg:flex">
        <ToolButton label="重置视图" onClick={resetViewport}><Focus /></ToolButton>
        <ToolButton label="缩小" onClick={() => updateViewport(setCanvasViewportZoom(viewportRef.current, canvasSize, viewportRef.current.zoom / 1.2), true)}><ZoomOut /></ToolButton>
        <input aria-label="画布缩放" type="range" min={CANVAS_MIN_ZOOM * 100} max={CANVAS_MAX_ZOOM * 100} value={Math.round(viewport.zoom * 100)} className="h-1.5 w-20 cursor-pointer accent-[#1456f0]" onChange={(event) => updateViewport(setCanvasViewportZoom(viewportRef.current, canvasSize, Number(event.target.value) / 100), true)} />
        <span className="w-11 text-center text-[11px] font-semibold text-muted-foreground">{Math.round(viewport.zoom * 100)}%</span>
        <ToolButton label="放大" onClick={() => updateViewport(setCanvasViewportZoom(viewportRef.current, canvasSize, viewportRef.current.zoom * 1.2), true)}><ZoomIn /></ToolButton>
        <ToolButton active={miniMapOpen} label="小地图" onClick={() => setMiniMapOpen((value) => !value)}><MapIcon /></ToolButton>
      </div>

      {projectMenuOpen ? <aside className="absolute top-16 left-3 z-30 w-80 rounded-xl border border-border bg-card shadow-xl"><div className="flex items-center justify-between border-b p-3"><div><p className="text-sm font-semibold">画布项目</p><p className="text-[11px] text-muted-foreground">跨设备自动同步</p></div><Button size="sm" className="h-8 text-xs" onClick={() => { const value = window.prompt("新画布名称", `无限画布 ${projects.length + 1}`)?.trim(); if (value) void runProject({ action: "create", title: value }); }}><Plus />新建</Button></div><div className="max-h-56 overflow-y-auto p-1.5">{projects.map((project) => <button key={project.id} className={cn("flex w-full items-center gap-2 rounded-lg p-2 text-left text-xs hover:bg-muted", project.id === documentRef.current.id && "bg-[#e7efff] text-[#1456f0]")} onClick={() => project.id !== documentRef.current.id && void runProject({ action: "activate", project_id: project.id })}><span className="flex size-7 items-center justify-center rounded-md bg-muted">{project.id === documentRef.current.id ? <Check className="size-3.5" /> : project.node_count}</span><span className="truncate font-semibold">{project.title}</span></button>)}</div><div className="space-y-2 border-t p-2.5"><div className="flex rounded-lg bg-muted p-1"><BackgroundButton active={background === "dots"} label="点阵" onClick={() => { backgroundRef.current = "dots"; setBackground("dots"); setTimeout(pushHistory); }}><CircleDot /></BackgroundButton><BackgroundButton active={background === "grid"} label="网格" onClick={() => { backgroundRef.current = "grid"; setBackground("grid"); setTimeout(pushHistory); }}><Grid2X2 /></BackgroundButton><BackgroundButton active={background === "plain"} label="空白" onClick={() => { backgroundRef.current = "plain"; setBackground("plain"); setTimeout(pushHistory); }}><Square /></BackgroundButton></div><div className="grid grid-cols-2 gap-2"><Button variant="outline" size="sm" onClick={() => { const value = window.prompt("画布名称", title)?.trim(); if (value) void runProject({ action: "rename", project_id: documentRef.current.id, title: value }); }}><Pencil />重命名</Button><Button variant="outline" size="sm" className="text-rose-600" onClick={() => window.confirm(`确定删除“${title}”吗？`) && void runProject({ action: "delete", project_id: documentRef.current.id })}><Trash2 />删除</Button></div></div></aside> : null}

      {libraryOpen ? <aside className="absolute inset-y-16 left-3 z-20 flex w-80 flex-col rounded-xl border border-border bg-card shadow-xl"><div className="flex h-12 items-center justify-between border-b px-3"><span className="text-sm font-semibold">图片库 · {libraryImages.length}</span><Button variant="ghost" size="icon" onClick={() => setLibraryOpen(false)}><X /></Button></div><div className="min-h-0 flex-1 overflow-y-auto p-2.5">{libraryLoading ? <LoaderCircle className="mx-auto mt-16 animate-spin" /> : <div className="grid grid-cols-2 gap-2">{libraryImages.map((image) => <button key={image.path} draggable className="relative aspect-square overflow-hidden rounded-lg border" onDragStart={(event) => event.dataTransfer.setData("application/x-yunmian-image", JSON.stringify(image))} onClick={() => addImageNode({ url: image.url || image.path, thumbnailURL: image.thumbnail_url, title: canvasLibraryImageTitle(image), prompt: image.prompt, width: image.width, height: image.height })}><AuthenticatedImage src={image.thumbnail_url || image.url || image.path} alt={canvasLibraryImageTitle(image)} className="size-full object-cover" /></button>)}</div>}</div></aside> : null}

      {miniMapOpen && !libraryOpen && nodes.length && canvasSize.width > 0 ? <CanvasMiniMap nodes={nodes} viewport={viewport} viewportSize={canvasSize} onViewportChange={(next) => updateViewport(next, true)} /> : null}

      {contextMenu ? <CanvasRightClickMenu menu={contextMenu} onClose={() => setContextMenu(null)} onDuplicate={() => { if (contextMenu.type === "node") duplicateNode(contextMenu.nodeID); setContextMenu(null); }} onDelete={() => { if (contextMenu.type === "node") removeNodes(new Set([contextMenu.nodeID])); else if (contextMenu.type === "connection") { replaceConnections(connectionsRef.current.filter((connection) => connection.id !== contextMenu.connectionID)); setSelectedConnectionID(""); pushHistory(); } setContextMenu(null); }} onAddText={() => { if (contextMenu.type === "canvas") addTextNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 120 }); setContextMenu(null); }} onAddImage={() => { if (contextMenu.type === "canvas") addBlankNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 120 }); setContextMenu(null); }} onAddConfig={() => { if (contextMenu.type === "canvas") addConfigNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 120 }); setContextMenu(null); }} onPaste={() => { void pasteSelected(); setContextMenu(null); }} onExportImage={() => { void exportImage(); setContextMenu(null); }} onExportJSON={() => { exportJSON(); setContextMenu(null); }} onImport={() => { importRef.current?.click(); setContextMenu(null); }} onClear={() => { setClearConfirmationOpen(true); setContextMenu(null); }} /> : null}
      <CanvasNodeInfoDialog node={infoNode} configInputs={infoNodeInputs} open={Boolean(infoNode)} onOpenChange={(open) => { if (!open) setInfoNodeID(""); }} />
      <Dialog open={stopConfirmationOpen} onOpenChange={setStopConfirmationOpen}>
        <DialogContent className="w-[min(92vw,420px)] rounded-2xl">
          <DialogHeader>
            <DialogTitle>停止生成？</DialogTitle>
            <DialogDescription>当前生成请求会被中断，已经生成完成的图片会保留。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopConfirmationOpen(false)}>继续生成</Button>
            <Button variant="destructive" onClick={confirmStopGeneration}>停止</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={clearConfirmationOpen} onOpenChange={setClearConfirmationOpen}>
        <DialogContent className="w-[min(92vw,420px)] rounded-2xl">
          <DialogHeader>
            <DialogTitle>清空画布？</DialogTitle>
            <DialogDescription>这会删除当前画布上的所有节点和连线。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearConfirmationOpen(false)}>取消</Button>
            <Button variant="destructive" onClick={() => void resetCanvas()}>清空</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CanvasCropDialog sourceURL={imageTool?.kind === "crop" ? imageTool.sourceURL : ""} open={imageTool?.kind === "crop"} busy={imageToolBusy} onClose={closeCanvasImageTool} onConfirm={(crop) => void cropCanvasNode(crop)} />
      <CanvasSplitDialog sourceURL={imageTool?.kind === "split" ? imageTool.sourceURL : ""} open={imageTool?.kind === "split"} busy={imageToolBusy} onClose={closeCanvasImageTool} onConfirm={(params) => void splitCanvasNode(params)} />
      <CanvasUpscaleDialog sourceURL={imageTool?.kind === "upscale" ? imageTool.sourceURL : ""} open={imageTool?.kind === "upscale"} busy={imageToolBusy} onClose={closeCanvasImageTool} onConfirm={(params) => void upscaleCanvasNode(params)} />
      <CanvasMaskDialog sourceURL={imageTool?.kind === "mask" ? imageTool.sourceURL : ""} open={imageTool?.kind === "mask"} busy={imageToolBusy} onClose={closeCanvasImageTool} onConfirm={maskEditCanvasNode} />
      <CanvasAngleDialog sourceURL={imageTool?.kind === "angle" ? imageTool.sourceURL : ""} open={imageTool?.kind === "angle"} busy={imageToolBusy} onClose={closeCanvasImageTool} onConfirm={angleCanvasNode} />
      <ImageLightbox images={previewImages} currentIndex={previewIndex} open={Boolean(previewNodeID)} onOpenChange={(open) => { if (!open) setPreviewNodeID(""); }} onIndexChange={(index) => setPreviewNodeID(previewImages[index]?.id || "")} />
      <Input ref={importRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importJSON(event)} />
      <Input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleNodeImageUpload(event)} />
      {loading || switchPhase ? <CanvasSwitchShell revealing={!loading && switchPhase === "revealing"} /> : null}
    </section>
  );
}

function CanvasSwitchShell({ revealing = false }: { revealing?: boolean }) {
  return (
    <div className={cn("absolute inset-0 z-50 overflow-hidden bg-[#f3f5f8] transition-opacity duration-200 dark:bg-[#15181d]", revealing && "pointer-events-none opacity-0")} aria-label="正在加载画布">
      <div className="absolute inset-0 opacity-55" style={{ backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
      <div className="absolute inset-x-3 top-3 flex items-center justify-between">
        <div className="h-10 w-44 animate-pulse rounded-xl border border-border bg-card/90 shadow-sm" />
        <div className="h-10 w-24 animate-pulse rounded-xl border border-border bg-card/90 shadow-sm" />
      </div>
      <div className="absolute left-[18%] top-[28%] h-28 w-44 animate-pulse rounded-lg border border-border bg-card/80 shadow-sm" />
      <div className="absolute left-[48%] top-[40%] h-40 w-56 animate-pulse rounded-lg border border-border bg-card/80 shadow-sm" />
      <div className="absolute bottom-3 left-1/2 h-11 w-[min(80%,430px)] -translate-x-1/2 animate-pulse rounded-xl border border-border bg-card/90 shadow-lg" />
      <div className="absolute bottom-3 left-3 hidden h-11 w-72 animate-pulse rounded-xl border border-border bg-card/90 shadow-lg lg:block" />
    </div>
  );
}

function ToolButton({ active = false, label, className, ...props }: React.ComponentProps<typeof Button> & { active?: boolean; label: string }) {
  return <Button type="button" variant="ghost" size="icon" title={label} aria-label={label} className={cn("size-9 rounded-lg", active && "bg-[#e7efff] text-[#1456f0]", className)} {...props} />;
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
        {nodes.map((node) => { const point = toMap(node.x, node.y); return <span key={node.id} className={cn("pointer-events-none absolute rounded-sm", node.type === "image" ? "bg-[#1456f0]" : node.type === "config" ? "bg-emerald-500" : "bg-amber-500")} style={{ left: point.x, top: point.y, width: Math.max(2, node.width * map.scale), height: Math.max(2, node.height * map.scale), opacity: .82 }} />; })}
        <span className="pointer-events-none absolute border border-[#1456f0] bg-[#1456f0]/10" style={{ left: viewportStart.x, top: viewportStart.y, width: Math.max(4, viewportEnd.x - viewportStart.x), height: Math.max(4, viewportEnd.y - viewportStart.y) }} />
      </div>
    </div>
  );
}

function CanvasRightClickMenu({ menu, onClose, onDuplicate, onDelete, onAddText, onAddImage, onAddConfig, onPaste, onExportImage, onExportJSON, onImport, onClear }: {
  menu: CanvasContextMenu;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAddText: () => void;
  onAddImage: () => void;
  onAddConfig: () => void;
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

  const menuHeight = menu.type === "canvas" ? 382 : 96;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 208));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - menuHeight));

  return (
    <div className="fixed z-[100] min-w-48 overflow-hidden rounded-xl border border-border bg-card py-1.5 shadow-2xl" style={{ left, top }} onPointerDown={(event) => event.stopPropagation()}>
      {menu.type === "canvas" ? (
        <>
          <ContextMenuButton icon={<Type />} onClick={onAddText}>添加想法节点</ContextMenuButton>
          <ContextMenuButton icon={<ImagePlus />} onClick={onAddImage}>添加图片节点</ContextMenuButton>
          <ContextMenuButton icon={<Settings2 />} onClick={onAddConfig}>添加生成配置节点</ContextMenuButton>
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

function CanvasNodeInfoDialog({ node, configInputs, open, onOpenChange }: { node: CanvasNode | null; configInputs: ReturnType<typeof canvasConfigInputs>; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [view, setView] = useState<"info" | "json">("info");
  useEffect(() => { if (open) setView("info"); }, [node?.id, open]);
  const json = useMemo(() => node ? canvasNodeInfoJSON(node) : "", [node]);
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
            <InfoRow label="名称" value={node.title || canvasNodeFallbackTitle(node.type)} />
            <InfoRow label="类型" value={node.type === "image" ? "图片" : node.type === "config" ? "生成配置" : "想法"} />
            <InfoRow label="尺寸" value={`${Math.round(node.width)} × ${Math.round(node.height)}`} />
            <InfoRow label="位置" value={`${Math.round(node.x)}, ${Math.round(node.y)}`} />
            {node.type === "text" ? <InfoRow label="字号" value={`${node.font_size || 14}px`} /> : null}
            {node.batch_child_ids && node.batch_child_ids.length > 1 ? <InfoRow label="图片组" value={`${node.batch_child_ids.length} 张`} /> : null}
            {node.prompt ? <InfoRow label="提示词" value={node.prompt} /> : null}
            {node.composer_content ? <InfoRow label="组装提示词" value={canvasConfigPromptDisplay(node.composer_content, configInputs)} /> : null}
            {node.task_id ? <InfoRow label="任务 ID" value={node.task_id} mono /> : null}
            {node.generation_type ? <InfoRow label="请求类型" value={node.generation_type === "edit" ? "图片编辑" : "图片生成"} /> : null}
            {node.generation_status ? <InfoRow label="生成状态" value={canvasGenerationStatusLabel(node.generation_status)} /> : null}
            {node.generation_error ? <InfoRow label="失败原因" value={node.generation_error} /> : null}
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
