import { toPng } from "html-to-image";
import { Bot, Camera, Check, ChevronDown, CircleDot, CircleHelp, Clipboard, Compass, Copy, Download, Eraser, FileDown, FileUp, Focus, FolderOpen, Grid2X2, Hand, ImagePlus, Images, Info, LoaderCircle, Map as MapIcon, Menu, Minus, Music, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Redo2, Settings2, Square, Trash2, Type, Undo2, Upload, Video, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { CanvasEngine } from "@/app/canvas/canvas-engine";
import { CanvasNodeActionsPanel, CanvasNodeQuickActions, type CanvasImageOperation } from "@/app/canvas/canvas-node-actions-panel";
import { CanvasProjectDialog, type CanvasProjectDialogMode } from "@/app/canvas/canvas-project-dialog";
import { canvasProjectPath } from "@/app/canvas/canvas-project-route";
import { CanvasAssetPicker } from "@/app/canvas/canvas-asset-picker";
import { CanvasSidePanel, type CanvasSidePanelTab } from "@/app/canvas/canvas-side-panel";
import { CanvasAgentPanel } from "@/app/canvas/canvas-agent-panel";
import { buildCanvasAgentContext, summarizeCanvasAgentNode, summarizeCanvasAgentTask } from "@/app/canvas/agent/canvas-agent-context";
import { arrangeCanvasAgentNodes, CANVAS_AGENT_PRIMARY_SCRIPT_NODE_SIZE, canvasAgentMediaLayoutSources, canvasAgentNodePosition, canvasAgentSourceNodeIDs, canvasAgentVideoDurationHint, canvasAgentVideoSupportsAudio, validateCanvasAgentVideoSeconds } from "@/app/canvas/agent/canvas-agent-generation";
import { clearCanvasAgentSessionReferences, syncCanvasAgentSessions } from "@/app/canvas/agent/canvas-agent-sessions";
import type { CanvasAgentAction, CanvasAgentToolResult } from "@/app/canvas/agent/canvas-agent-tools";
import type { CanvasAgentConfig, CanvasAgentState, CanvasAssistantReference, CanvasAssistantSession, CanvasInsertAssetPayload, CanvasPendingAgentRequest } from "@/app/canvas/agent/canvas-agent-types";
import { canvasPendingAgentAssetNode, createCanvasPendingAgentAsset, normalizeCanvasAgentConfig, preferredCanvasAgentVideoSize } from "@/app/canvas/agent/canvas-agent-starter";
import { applyCameraPrompt } from "@/app/canvas/canvas-camera";
import { CanvasCameraControl } from "@/app/canvas/canvas-camera-control";
import { CanvasGenerationFooter } from "@/app/canvas/canvas-generation-footer";
import { CanvasDirector, type CanvasDirectorCapture, type CanvasDirectorPanorama, type CanvasDirectorVideo } from "@/app/canvas/canvas-director";
import { fitDirectorVideoNodeSize, getNextDirectorOutputY } from "@/app/canvas/canvas-director-output";
import { buildCanvasAudioGenerationRequest, canvasAgentAudioNodeParameters, canvasAudioGenerationReferences, canvasAudioProvider, canvasAudioReferences, canvasAudioResponseFormat, isCanvasAudioFile, resolveCanvasAudioModel, type CanvasAudioReference } from "@/app/canvas/canvas-audio";
import { detachCanvasBatchRootForReplacement, expandCanvasBatchNodeIDs, reconcileCanvasBatchesAfterRemoval, setCanvasBatchPrimary, syncCanvasBatchRootAfterRetry, visibleCanvasNodes } from "@/app/canvas/canvas-batches";
import { CanvasConfigComposer } from "@/app/canvas/canvas-config-composer";
import { canGenerateCanvasConfig, canvasConfigInputs, canvasConfigPromptDisplay, canvasGenerationInputs, type CanvasConfigInput } from "@/app/canvas/canvas-config-inputs";
import { canCreateCanvasConnection, resolveCanvasConnection } from "@/app/canvas/canvas-connections";
import { buildCanvasGenerationContext, buildCanvasImageReferencePrompt, canvasGenerationCount, canvasGenerationModel, canvasGenerationNeedsRecovery, canvasGenerationRecoveryTaskID, canvasGenerationReferenceImageURLs, canvasGenerationRequestSize, canvasVideoGenerationReferences, findCanvasRetryConfigurationNode, markCanvasGenerationRecoveryPending, restoreInterruptedCanvasGenerations } from "@/app/canvas/canvas-generation-context";
import { canvasGenerationActiveNodeID, placeCanvasGenerationResultNodes, setCanvasConfigGenerationStatus } from "@/app/canvas/canvas-generation-layout";
import { canvasTextGenerationPlan, resolveCanvasTextModel } from "@/app/canvas/canvas-text-generation";
import { appendCanvasHistorySnapshot, canvasHistoryKey, commitCanvasGenerationHistory, restoreCanvasHistoryDocument } from "@/app/canvas/canvas-history";
import { canvasImageAngleLabel, canvasImageAnglePrompt, cropCanvasImage, splitCanvasImage, upscaleCanvasImage, type CanvasImageAngleParams, type CanvasImageCropRect, type CanvasImageSplitParams, type CanvasImageUpscaleParams } from "@/app/canvas/canvas-image-data";
import { canvasCenteredNodePosition, canvasCroppedNodeSize, canvasEmptyImageFrameFromSize, canvasImageReplacementFrame, canvasNodeAspectRatio, canvasNodeSizeFromRatio } from "@/app/canvas/canvas-node-geometry";
import { canvasGenerationStatusLabel, canvasNodeInfoJSON } from "@/app/canvas/canvas-node-info";
import { CANVAS_GROUP_PADDING, canvasNodeBounds, detachCanvasNodesFromRemovedGroups, expandCanvasGroupNodeIDs } from "@/app/canvas/canvas-groups";
import { CANVAS_NODE_DEFAULT_SIZE } from "@/app/canvas/canvas-node-specs";
import { PANORAMA_IMAGE_SIZE, PANORAMA_NODE_SIZE, buildPanoramaPrompt, isStrictPanoramaSize, panoramaGenerationCount, panoramaGenerationQuality, panoramaRetryPrompt, panoramaRetryReferenceURLs } from "@/app/canvas/canvas-panorama";
import { CanvasAngleDialog, CanvasCropDialog, CanvasMaskDialog, CanvasSplitDialog, CanvasUpscaleDialog, type CanvasMaskEditPayload } from "@/app/canvas/canvas-image-tools";
import { applyCanvasTaskImage, applyCanvasTaskProgressNodes, reconcileCancelledCanvasTaskNodes, reconcilePersistedCanvasTaskNodes, restoreCanvasTaskInitialImage, summarizeCanvasTaskResult } from "@/app/canvas/canvas-task-results";
import { canvasExportBounds } from "@/app/canvas/canvas-export";
import { createCanvasProjectArchive, downloadCanvasProjectArchive, readCanvasProjectArchive } from "@/app/canvas/canvas-project-transfer";
import { normalizeCanvasClipboard, remapCanvasNodeReferences } from "@/app/canvas/canvas-clipboard";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, resetCanvasViewport, setCanvasViewportZoom } from "@/app/canvas/canvas-viewport";
import { canvasSaveRequired, flushCanvasSaves } from "@/app/canvas/canvas-save";
import { resolveCanvasImageModel } from "@/app/canvas/canvas-image-model";
import { canvasImageTitle } from "@/app/canvas/canvas-image-title";
import { defaultCanvasImageParameters } from "@/app/canvas/canvas-image-parameter-defaults";
import { CanvasImageParameterPopover } from "@/app/canvas/canvas-image-parameters";
import { CanvasInlineModelSelect } from "@/app/canvas/canvas-inline-model-select";
import { CanvasPromptLibrary } from "@/app/canvas/canvas-prompt-library";
import { CanvasVideoNodeBindings } from "@/app/canvas/canvas-video-node-bindings";
import { CanvasVideoPreview } from "@/app/canvas/canvas-video-player";
import { canvasVideoDisplaySize, canvasVideoFileError } from "@/app/canvas/canvas-video-import";
import { ImageParameterLabel } from "@/app/image/components/image-parameter-ui";
import { IMAGE_ASPECT_RATIO_OPTIONS, IMAGE_ASPECT_RATIO_PRESET_OPTIONS, IMAGE_QUALITY_OPTIONS } from "@/app/image/image-options";
import { CanvasResourceMentionTextarea } from "@/app/canvas/canvas-resource-mention-textarea";
import { CanvasAudioPromptPanel, CanvasAudioSettingsFields, CanvasPanoramaPromptPanel, CanvasPanoramaViewer } from "@/app/canvas/canvas-special-nodes";
import { canvasNodeMentionReferences, type CanvasResourceReference } from "@/app/canvas/canvas-resources";
import { ImageLightbox } from "@/components/image-lightbox";
import {
  VideoSettingsPanel,
  type VideoSettingsValue,
} from "@/components/generation/video-settings-panel";
import {
  RelayTokenRequiredDialog,
  type RelayTokenCreationKind,
} from "@/components/relay-token-required-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppScrollArea, ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cancelCreationTask, createAudioGenerationTask, createChatGenerationTask, createImageEditTask, createImageGenerationTask, createVideoGenerationTask, DEFAULT_IMAGE_MODEL, fetchCreationTasks, fetchManagedImages, fetchModelConfig, imageReferenceImageLimit, PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, supportsImageEditing, supportsImageOutputControls, supportsImageQualityValue, supportsImageResolution, supportsImageStreaming, supportsStructuredImageParameters, uploadAudioReference, uploadVideoImageReference, uploadVideoReference, type CreationTask, type CreationTaskMessage, type ImageModel, type ManagedImage } from "@/lib/api";
import { fetchAuthenticatedImageBlob, primeAuthenticatedImageCache } from "@/lib/authenticated-image";
import { imageConversationReferenceLimitMessage } from "@/lib/image-conversation-assets";
import { isPublicReferenceURL } from "@/lib/public-reference-url";
import { getStoredRelayTokenName, relayTokenNameStorageKey, type RelayTokenKind } from "@/lib/relay-token-selection";
import { createMyAsset, fetchMyAssets, loadMyAssets, mergeMyAssets, saveMyAssets, syncMyAssets } from "@/lib/my-assets";
import { cn } from "@/lib/utils";
import { COLOR_THEME_CHANGE_EVENT, getPreferredColorTheme, type ColorTheme } from "@/lib/theme";
import { useImageGenerationPreferences } from "@/lib/use-image-generation-preferences";
import { DEFAULT_VIDEO_MODEL, supportsKlingElements, supportsVideoFrameReferences, supportsVideoMultimodalReferences, videoAllowsCustomDimensions, videoAllowsCustomResolution, videoAudioControl, videoDefaultResolution, videoDefaultSeconds, videoDefaultSize, videoMultimodalReferenceLimits, videoRequiresReferenceImage, videoResolutionOptions, videoSecondsIsValid, videoSizeLabel, videoSizeOptions, videoWorkbenchResolutionForModelSize, videoWorkbenchResolutionOptions, videoWorkbenchSecondsOptions, videoWorkbenchSizeForModelResolution } from "@/lib/video-model-capabilities";
import { normalizeVideoRequest } from "@/lib/video-request-normalizer";
import { normalizeVideoMultiPrompts } from "@/lib/video-kling-workbench";
import {
  clearCanvasDocument,
  fetchCanvasDocument,
  importCanvasProject,
  saveCanvasDocument,
  updateCanvasProject,
  type CanvasConnection,
  type CanvasDocument,
  type CanvasNode,
  type CanvasProjectSummary,
  type CanvasWorkspaceResponse,
} from "@/services/api/canvas";
import { resolveMediaURL, uploadMediaBlob } from "@/services/file-storage";
import { persistCreationTaskOutputs } from "@/services/generation-result-storage";
import { resolveImageURL, uploadImage } from "@/services/image-storage";
import type { StoredAuthSession } from "@/store/auth";

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
type PendingPanoramaImport = {
  url: string;
	storageKey: string;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  position: { x: number; y: number };
};
type CanvasGenerationOptions = { resultTitle?: string; generationModel?: string; referenceImageDataURLs?: string[]; forceImageGeneration?: boolean; resultBounds?: { width: number; height: number }; resultCount?: number; selectResultNode?: boolean; concurrent?: boolean };
const DEFAULT_AGENT_PANEL = { open: false, width: 390 };
const DEFAULT_DOCUMENT: CanvasDocument = { version: 1, id: "", revision: 0, title: "我的画布", background: "dots", show_image_info: false, nodes: [], connections: [], agent_panel: DEFAULT_AGENT_PANEL, viewport: { zoom: 1, x: 0, y: 0 } };
const MAX_HISTORY = 50;
const TASK_POLL_INTERVAL_MS = 1200;
const TASK_POLL_MAX_DURATION_MS = 8 * 60 * 1000;
const TASK_POLL_MAX_RETRY_DELAY_MS = 10_000;
const MINI_MAP_STORAGE_KEY = "yunmian-canvas-mini-map-open";
const SIDE_PANEL_STORAGE_KEY = "yunmian-canvas-side-panel";
const DEFAULT_SIDE_PANEL = { open: true, width: 304, tab: "canvas" as CanvasSidePanelTab };
const IMAGE_PROMPT_REVERSE_PRESET = `请根据参考图片反推一段适合用于 AI 生图的提示词。

要求：
1. 只输出提示词正文，不要解释。
2. 覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。
3. 尽量写成可直接用于生图模型的完整提示词。`;

class CanvasTaskPollingTimeoutError extends Error {}

function storedCanvasSidePanel(): typeof DEFAULT_SIDE_PANEL {
  if (typeof window === "undefined") return DEFAULT_SIDE_PANEL;
  try {
    const stored = JSON.parse(window.localStorage.getItem(SIDE_PANEL_STORAGE_KEY) || "null") as Partial<typeof DEFAULT_SIDE_PANEL> | null;
    return {
      open: stored?.open !== false,
      width: Math.min(480, Math.max(260, Number(stored?.width) || DEFAULT_SIDE_PANEL.width)),
      tab: stored?.tab === "assets" || stored?.tab === "prompts" ? stored.tab : "canvas" as CanvasSidePanelTab,
    };
  } catch {
    return DEFAULT_SIDE_PANEL;
  }
}

function cloneDocument(document: CanvasDocument) {
  return JSON.parse(JSON.stringify(document)) as CanvasDocument;
}

function randomID() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createdAt() {
  return new Date().toISOString();
}

function videoFileMetadata(file: File) {
  return new Promise<{ width: number; height: number; durationMS?: number }>((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const finish = () => {
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      const durationMS = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined;
      URL.revokeObjectURL(url);
      resolve({ width, height, durationMS });
    };
    video.preload = "metadata";
    video.onloadedmetadata = finish;
    video.onerror = finish;
    video.src = url;
  });
}

function storedCanvasAgentSessions(document: CanvasDocument): CanvasAssistantSession[] {
  const sessions = (document.agent_sessions || []).filter((value): value is CanvasAssistantSession => {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<CanvasAssistantSession>;
    return typeof item.id === "string" && typeof item.title === "string" && Array.isArray(item.messages)
      && Boolean(item.agentState) && Array.isArray(item.protocolMessages);
  });
  if (sessions.length) return syncCanvasAgentSessions(sessions, document.nodes, true);
  if (!document.agent_messages?.length) return [];
  const now = createdAt();
  const state: CanvasAgentState = { phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] };
  return [{
    id: `agent-${randomID()}`,
    title: document.agent_messages.find((message) => message.role === "user")?.content.slice(0, 18) || "历史对话",
    messages: document.agent_messages.map((message) => ({ id: message.id, role: message.role, text: message.content, status: "success" })),
    agentState: state,
    protocolMessages: document.agent_messages.map((message) => ({ role: message.role, content: message.content })),
    createdAt: document.agent_messages[0]?.created_at || now,
    updatedAt: document.agent_messages.at(-1)?.created_at || now,
  }];
}

function storedCanvasAgentConfig(document: CanvasDocument): CanvasAgentConfig | null {
  const value = document.agent_config;
  if (!value || typeof value !== "object") return null;
  const stringValue = (key: keyof CanvasAgentConfig) => typeof value[key] === "string" ? value[key] : "";
  return {
    imageQuality: stringValue("imageQuality"),
    imageSize: stringValue("imageSize"),
    videoQuality: stringValue("videoQuality"),
    videoSize: stringValue("videoSize"),
  };
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

function audioFileDuration(file: File) {
  return new Promise<number | undefined>((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    let settled = false;
    const timer = window.setTimeout(() => finish(), 5000);
    const finish = (value?: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
      resolve(value);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined);
    audio.onerror = () => finish();
    audio.src = url;
  });
}

async function canvasAudioCloneDataURL(reference: CanvasAudioReference, signal: AbortSignal) {
  const blob = await fetchAuthenticatedImageBlob(reference.url, signal);
  const rawType = (blob.type || reference.mimeType || "").toLowerCase().split(";", 1)[0];
  const mimeType = rawType === "audio/mpeg" || rawType === "audio/mp3"
    ? "audio/mpeg"
    : rawType === "audio/wav" || rawType === "audio/x-wav" || rawType === "audio/wave"
      ? "audio/wav"
      : "";
  if (!mimeType) throw new Error("参考音频仅支持 MP3 或 WAV");
  const dataURL = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取参考音频失败"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(blob);
  });
  const separator = dataURL.indexOf(",");
  const base64 = separator >= 0 ? dataURL.slice(separator + 1) : "";
  if (!base64) throw new Error("读取参考音频失败");
  if (base64.length > 10 * 1024 * 1024) throw new Error("参考音频 Base64 编码后不能超过 10MB");
  return `data:${mimeType};base64,${base64}`;
}

async function canvasReferenceDataURL(url: string, signal: AbortSignal) {
  if (isPublicReferenceURL(url)) return url;
  const blob = await fetchAuthenticatedImageBlob(url, signal);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取画布参考图片失败"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(blob);
  });
}

async function canvasTextGenerationMessages(prompt: string, referenceImageURLs: readonly string[], signal: AbortSignal): Promise<CreationTaskMessage[]> {
  if (!referenceImageURLs.length) return [{ role: "user", content: prompt }];
  const imageURLs = await Promise.all(referenceImageURLs.map((url) => canvasReferenceDataURL(url, signal)));
  return [{
    role: "user",
    content: [
      { type: "text", text: prompt || "请分析并回应所提供的参考图片。" },
      ...imageURLs.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ],
  }];
}

async function canvasDataURLFile(dataURL: string, fileName: string) {
  const response = await fetch(dataURL);
  if (!response.ok) throw new Error("无法读取处理后的图片");
  const blob = await response.blob();
	return new File([blob], fileName, { type: blob.type || "image/png" });
}

async function preparePublicVideoImageReference(value: string, signal?: AbortSignal) {
  const url = value.trim();
  if (!url || isPublicReferenceURL(url)) return url;
  const blob = await fetchAuthenticatedImageBlob(url, signal);
  const file = new File([blob], "canvas-video-reference.png", { type: blob.type || "image/png" });
  const uploaded = await uploadVideoImageReference(file);
  return uploaded.url;
}

async function preparePublicVideoMediaReference(value: string, kind: "video" | "audio", signal?: AbortSignal) {
  const url = value.trim();
  if (!url || isPublicReferenceURL(url)) return url;
  const blob = await fetchAuthenticatedImageBlob(url, signal);
  const fileName = kind === "video" ? "canvas-video-reference.mp4" : "canvas-audio-reference.mp3";
  const file = new File([blob], fileName, { type: blob.type || (kind === "video" ? "video/mp4" : "audio/mpeg") });
  const uploaded = kind === "video" ? await uploadVideoReference(file) : await uploadAudioReference(file);
  return uploaded.url;
}

async function prepareCanvasVideoElementList(items: Array<Record<string, unknown>>, signal?: AbortSignal) {
  return Promise.all(items.map(async (item) => {
    const references = Array.isArray(item.references) ? item.references : [];
    const preparedReferences = await Promise.all(references.map(async (value) => {
      const reference = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const kind = reference.kind === "video" || reference.kind === "audio" ? reference.kind : "image";
      const url = String(reference.url || "").trim();
      if (!url) return null;
      return {
        kind,
        url: kind === "image"
          ? await preparePublicVideoImageReference(url, signal)
          : await preparePublicVideoMediaReference(url, kind, signal),
      };
    }));
    return {
      name: String(item.name || ""),
      description: String(item.description || ""),
      references: preparedReferences.filter((reference): reference is { kind: "image" | "video" | "audio"; url: string } => Boolean(reference)),
    };
  }));
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
  if (type === "video") return "视频";
  if (type === "config") return "生成配置";
  if (type === "audio") return "音频";
  if (type === "panorama") return "全景图";
  if (type === "director") return "导演台";
  if (type === "group") return "组";
  return "文字";
}

function isCanvasAccessibleReferenceURL(value: string) {
  if (isPublicReferenceURL(value)) return true;
  try {
    return typeof window !== "undefined" && new URL(value, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

function canvasVideoParameters(node?: CanvasNode | null) {
	const model = node?.generation_video_model || DEFAULT_VIDEO_MODEL;
	const sizes = videoSizeOptions(model);
	const customDimensions = videoAllowsCustomDimensions(model);
	const selectedSeconds = node?.generation_video_seconds;
	const normalizedSeconds = typeof selectedSeconds === "number" && videoSecondsIsValid(model, selectedSeconds) ? selectedSeconds : videoDefaultSeconds(model);
	const resolutions = videoResolutionOptions(model, normalizedSeconds);
	const customResolution = videoAllowsCustomResolution(model);
	const defaultSize = videoDefaultSize(model);
	const storedSize = String(node?.generation_video_size || "");
	const normalizedSize = customDimensions
		? (/^\d+x\d+$/i.test(storedSize) || storedSize === "auto" || storedSize === "adaptive" ? storedSize : defaultSize)
		: sizes.includes(storedSize) ? storedSize : defaultSize;
	return {
    generation_video_model: model,
		generation_video_size: normalizedSize,
		generation_video_seconds: normalizedSeconds,
		generation_video_resolution: customResolution ? node?.generation_video_resolution || videoDefaultResolution(model, normalizedSeconds) : resolutions.includes(node?.generation_video_resolution || "") ? node?.generation_video_resolution : videoDefaultResolution(model, normalizedSeconds),
    generation_video_audio: videoAudioControl(model) === "toggle" ? (node?.generation_video_audio ?? false) : videoAudioControl(model) === "always",
    generation_video_watermark: node?.generation_video_watermark ?? false,
		generation_video_mode: node?.generation_video_mode || "std",
		generation_video_negative_prompt: node?.generation_video_negative_prompt || "",
		generation_video_multi_shot: node?.generation_video_multi_shot ?? false,
		generation_video_shot_type: node?.generation_video_shot_type === "customize" ? "customize" as const : "intelligence" as const,
		generation_video_multi_prompt: Array.isArray(node?.generation_video_multi_prompt) ? node.generation_video_multi_prompt : [],
		generation_video_element_list: Array.isArray(node?.generation_video_element_list) ? node.generation_video_element_list : [],
		generation_video_character_orientation: node?.generation_video_character_orientation === "image" ? "image" as const : "video" as const,
		generation_video_reference_mode: node?.generation_video_reference_mode === "reference" ? "reference" as const : "first-frame" as const,
		generation_video_reference_image_urls: Array.isArray(node?.generation_video_reference_image_urls) ? node.generation_video_reference_image_urls : [],
    generation_video_reference_urls: Array.isArray(node?.generation_video_reference_urls) ? node.generation_video_reference_urls : [],
			generation_video_reference_audio_urls: Array.isArray(node?.generation_video_reference_audio_urls) ? node.generation_video_reference_audio_urls : [],
			exclude_upstream_text: node?.exclude_upstream_text ?? false,
			generation_video_first_frame_node_id: node?.generation_video_first_frame_node_id,
			generation_video_last_frame_node_id: node?.generation_video_last_frame_node_id,
			generation_video_kling_image_node_ids: node?.generation_video_kling_image_node_ids || [],
			generation_video_kling_multi_prompt: node?.generation_video_kling_multi_prompt || [],
			generation_video_kling_element_list: node?.generation_video_kling_element_list || [],
  };
}

function canvasVideoModelPatch(model: string) {
  const presets = videoWorkbenchSecondsOptions(model);
  const seconds = presets.find((value) => value > 0) || videoDefaultSeconds(model);
  const resolutions = videoWorkbenchResolutionOptions(model, seconds);
  return {
    generation_video_model: model,
    generation_video_size: videoDefaultSize(model),
    generation_video_seconds: seconds,
    generation_video_resolution: resolutions[0] || videoDefaultResolution(model, seconds),
    generation_video_reference_mode: "first-frame" as const,
  };
}

function normalizeCanvasVideoNode(node: CanvasNode) {
  if (node.type !== "video") return node;
  const params = canvasVideoParameters(node);
  return {
    ...node,
    generation_video_model: params.generation_video_model,
    generation_video_size: params.generation_video_size,
    generation_video_seconds: params.generation_video_seconds,
    generation_video_resolution: params.generation_video_resolution,
    generation_video_audio: params.generation_video_audio,
    generation_video_watermark: params.generation_video_watermark,
		generation_video_mode: params.generation_video_mode,
		generation_video_negative_prompt: params.generation_video_negative_prompt,
		generation_video_multi_shot: params.generation_video_multi_shot,
		generation_video_shot_type: params.generation_video_shot_type,
		generation_video_multi_prompt: params.generation_video_multi_prompt,
		generation_video_element_list: params.generation_video_element_list,
		generation_video_character_orientation: params.generation_video_character_orientation,
    generation_video_reference_mode: params.generation_video_reference_mode,
    generation_video_reference_image_urls: params.generation_video_reference_image_urls,
    generation_video_reference_urls: params.generation_video_reference_urls,
    generation_video_reference_audio_urls: params.generation_video_reference_audio_urls,
		exclude_upstream_text: params.exclude_upstream_text,
		generation_video_first_frame_node_id: params.generation_video_first_frame_node_id,
		generation_video_last_frame_node_id: params.generation_video_last_frame_node_id,
		generation_video_kling_image_node_ids: params.generation_video_kling_image_node_ids,
		generation_video_kling_multi_prompt: params.generation_video_kling_multi_prompt,
		generation_video_kling_element_list: params.generation_video_kling_element_list,
  };
}

function canvasErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.includes("video node generation size is invalid")) {
    return "当前视频模型不支持尺寸参数，已自动清除尺寸设置，请重新保存。";
  }
  if (message.includes("video node generation duration is invalid")) {
    return "当前视频模型不支持当前时长，请选择该模型支持的时长。";
  }
  if (message.includes("video node generation resolution is invalid")) {
    return "当前视频模型不支持当前清晰度，请重新选择清晰度。";
  }
  if (message.includes("video node generation model is invalid")) {
    return "视频节点缺少有效的视频模型，请重新选择模型。";
  }
  if (message.includes("video node generation reference mode is invalid")) {
    return "视频参考模式无效，请重新选择参考模式。";
  }
  return message || "画布保存失败";
}

function CanvasVideoPromptPanel({ node, inputs, running, generationBusy, uploading = false, showPromptEditor = true, showGenerateFooter = true, videoModels, onPromptChange, onParametersChange, onGenerate, onStop, onUpload }: { node: CanvasNode; inputs: readonly CanvasConfigInput[]; running: boolean; generationBusy: boolean; uploading?: boolean; showPromptEditor?: boolean; showGenerateFooter?: boolean; videoModels: string[]; onPromptChange: (value: string, commit?: boolean) => void; onParametersChange: (patch: Partial<CanvasNode>) => void; onGenerate: (prompt: string) => void; onStop: () => void; onUpload?: () => void }) {
  const [prompt, setPrompt] = useState(node.prompt || "");
  const connectedPromptAvailable = inputs.some((input) => input.type === "text" && Boolean(input.text?.trim()));
  useEffect(() => setPrompt(node.prompt || ""), [node.id, node.prompt]);
  const params = canvasVideoParameters(node);
  const modelOptions = Array.from(new Set([...(videoModels || []), params.generation_video_model]));
  const klingElementsSupported = supportsKlingElements(params.generation_video_model);
  const videoReferenceSupported = supportsVideoMultimodalReferences(params.generation_video_model);
  const audioReferenceSupported = videoMultimodalReferenceLimits(params.generation_video_model).audio > 0;
  const referenceImageURL = params.generation_video_reference_image_urls[0] || "";
  const referenceVideoURL = params.generation_video_reference_urls[0] || "";
  const referenceAudioURL = params.generation_video_reference_audio_urls[0] || "";
  const [referenceUploading, setReferenceUploading] = useState<"image" | "video" | "audio" | "" >("");
  const referenceImageInputRef = useRef<HTMLInputElement>(null);
  const referenceVideoInputRef = useRef<HTMLInputElement>(null);
  const referenceAudioInputRef = useRef<HTMLInputElement>(null);
  const videoSettingsValue: VideoSettingsValue = {
    size: params.generation_video_size,
    seconds: String(params.generation_video_seconds),
    resolution: params.generation_video_resolution || "",
    mode: params.generation_video_mode,
    negativePrompt: params.generation_video_negative_prompt,
    multiShot: params.generation_video_multi_shot,
    shotType: params.generation_video_shot_type,
    multiPrompt: normalizeVideoMultiPrompts(params.generation_video_multi_prompt),
    characterOrientation: params.generation_video_character_orientation,
    generateAudio: params.generation_video_audio,
    watermark: params.generation_video_watermark,
    taskCount: 1,
  };
  function updateVideoSettings(patch: Partial<VideoSettingsValue>) {
    const linkedResolution = patch.size !== undefined && patch.resolution === undefined && videoAllowsCustomDimensions(params.generation_video_model)
      ? videoWorkbenchResolutionForModelSize(params.generation_video_model, patch.size, params.generation_video_resolution || "")
      : patch.resolution;
    const linkedSize = patch.resolution !== undefined && patch.size === undefined && videoAllowsCustomResolution(params.generation_video_model)
      ? videoWorkbenchSizeForModelResolution(params.generation_video_model, patch.resolution, params.generation_video_size)
      : patch.size;
    onParametersChange({
      ...(linkedSize !== undefined ? { generation_video_size: linkedSize } : {}),
      ...(patch.seconds !== undefined && videoSecondsIsValid(params.generation_video_model, Number(patch.seconds)) ? { generation_video_seconds: Number(patch.seconds) } : {}),
      ...(linkedResolution !== undefined ? { generation_video_resolution: linkedResolution } : {}),
      ...(patch.mode !== undefined ? { generation_video_mode: patch.mode } : {}),
      ...(patch.negativePrompt !== undefined ? { generation_video_negative_prompt: patch.negativePrompt } : {}),
      ...(patch.multiShot !== undefined ? { generation_video_multi_shot: patch.multiShot } : {}),
      ...(patch.shotType !== undefined ? { generation_video_shot_type: patch.shotType } : {}),
      ...(patch.multiPrompt !== undefined ? { generation_video_multi_prompt: patch.multiPrompt } : {}),
      ...(patch.characterOrientation !== undefined ? { generation_video_character_orientation: patch.characterOrientation } : {}),
      ...(patch.generateAudio !== undefined ? { generation_video_audio: patch.generateAudio } : {}),
      ...(patch.watermark !== undefined ? { generation_video_watermark: patch.watermark } : {}),
    });
  }
  async function uploadReferenceImage(file: File) {
    if (!file.type.startsWith("image/")) return toast.error("参考图片仅支持 PNG、JPG 或 WebP 格式");
    if (file.size > 20 * 1024 * 1024) return toast.error("参考图片不能超过 20 MiB");
    setReferenceUploading("image");
    try {
      const uploaded = await uploadImage(file);
      onParametersChange({ generation_video_reference_mode: "first-frame", generation_video_reference_image_urls: [uploaded.url], generation_video_reference_urls: [], generation_video_reference_audio_urls: [] });
      toast.success("参考图片已上传");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "参考图片上传失败");
    } finally {
      setReferenceUploading("");
    }
  }
  async function uploadReferenceVideo(file: File) {
    if (!videoReferenceSupported) return toast.error(`模型 ${params.generation_video_model} 不支持视频生视频`);
    const mime = file.type.toLowerCase().split(";", 1)[0];
    if (!(mime === "video/mp4" || mime === "video/quicktime" || /\.(mp4|mov)$/i.test(file.name))) return toast.error("参考视频仅支持 MP4 或 MOV 格式");
    if (file.size > 50 * 1024 * 1024) return toast.error("参考视频不能超过 50 MiB");
    setReferenceUploading("video");
    try {
      const uploaded = await uploadVideoReference(file);
      onParametersChange({ generation_video_reference_mode: "reference", generation_video_reference_image_urls: [], generation_video_reference_urls: [uploaded.url], generation_video_reference_audio_urls: [] });
      toast.success("参考视频已上传");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "参考视频上传失败");
    } finally {
      setReferenceUploading("");
    }
  }

  async function uploadReferenceAudio(file: File) {
    if (!audioReferenceSupported) return toast.error(`模型 ${params.generation_video_model} 不支持参考音频`);
    const mime = file.type.toLowerCase().split(";", 1)[0];
    if (!(mime === "audio/mpeg" || mime === "audio/wav" || /\.(mp3|wav)$/i.test(file.name))) return toast.error("参考音频仅支持 MP3 或 WAV 格式");
    if (file.size > 15 * 1024 * 1024) return toast.error("参考音频不能超过 15 MiB");
    setReferenceUploading("audio");
    try {
      const uploaded = await uploadAudioReference(file);
      onParametersChange({ generation_video_reference_mode: "reference", generation_video_reference_audio_urls: [uploaded.url] });
      toast.success("参考音频已上传");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "参考音频上传失败");
    } finally {
      setReferenceUploading("");
    }
  }
	return <div className="flex h-full min-h-0 flex-col gap-4">
			  {showPromptEditor ? <div className="overflow-hidden rounded-xl border border-border/90 bg-card/96 shadow-[0_14px_38px_rgba(15,23,42,.14)] backdrop-blur-xl transition-[border-color,box-shadow] focus-within:border-[#8eacf0] focus-within:shadow-[0_14px_38px_rgba(15,23,42,.13),0_0_0_2px_rgba(20,86,240,.07)]">
			    <textarea value={prompt} onChange={(event) => { setPrompt(event.target.value); onPromptChange(event.target.value); }} onBlur={(event) => onPromptChange(event.target.value, true)} placeholder="描述你想生成的视频" className="h-20 w-full resize-none border-0 bg-transparent px-3.5 py-3 text-sm leading-5 outline-none placeholder:text-muted-foreground/55 focus:ring-0" />
        <div className="flex min-w-0 items-center justify-between gap-2 border-t border-border/60 px-1.5 py-1"><CanvasInlineModelSelect value={params.generation_video_model} models={modelOptions} label="视频模型" onChange={(model) => onParametersChange(canvasVideoModelPatch(model))} /><CanvasPromptLibrary onSelect={(value) => { setPrompt(value); onPromptChange(value, true); }} /></div>
			  </div> : null}
	  <AppScrollArea className="h-0 flex-1" viewportClassName="pr-3">
	   <div className="space-y-4">
		    <div className="flex items-center justify-between gap-3">
		      <h3 className="text-xs font-semibold text-foreground">生成参数</h3>
		      <div className="flex items-center gap-2"><span className="text-[11px] text-muted-foreground">{params.generation_video_seconds < 0 ? "智能时长" : `${params.generation_video_seconds} 秒`}{params.generation_video_size ? ` · ${videoSizeLabel(params.generation_video_size)}` : ""}</span><CanvasCameraControl value={node.camera_control} onChange={(camera_control) => onParametersChange({ camera_control })} className="h-8 px-2.5 text-xs" /></div>
	    </div>
	  <div className="grid grid-cols-1 gap-4 text-xs">
				<VideoSettingsPanel
				  model={params.generation_video_model}
				  value={videoSettingsValue}
				  onChange={updateVideoSettings}
				  referenceImageCount={params.generation_video_reference_image_urls.filter(Boolean).length}
				  referenceVideoCount={params.generation_video_reference_urls.filter(Boolean).length}
				  showTaskCount={false}
				/>
		{videoReferenceSupported ? <label className="space-y-1.5"><ImageParameterLabel help="首帧图生视频使用一张开场图片；多模态参考可以组合图片、视频和音频。">参考模式</ImageParameterLabel><Select value={params.generation_video_reference_mode} onValueChange={(value: "first-frame" | "reference") => onParametersChange({ generation_video_reference_mode: value })}><SelectTrigger className="h-9 rounded-lg px-2.5 text-xs shadow-none"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="first-frame">首帧图生视频</SelectItem><SelectItem value="reference">多模态参考</SelectItem></SelectContent></Select></label> : null}
		  <div className="order-40 space-y-2 rounded-xl border border-border/80 bg-muted/15 p-3 text-xs">
		<div className="flex items-center justify-between"><span className="font-medium text-foreground">参考素材</span><span className="text-[11px] text-muted-foreground">按类型分别传入</span></div>
		<p className="text-[11px] leading-4 text-muted-foreground">图片参考用于图生视频；视频参考用于视频生视频。两者共用模型、尺寸、时长和清晰度参数，但提交给厂商的参考字段不同。</p>
		<input ref={referenceImageInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadReferenceImage(file); }} />
		<input ref={referenceVideoInputRef} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadReferenceVideo(file); }} />
		<input ref={referenceAudioInputRef} type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadReferenceAudio(file); }} />
		<div className="grid grid-cols-3 gap-2"><button type="button" disabled={Boolean(referenceUploading)} onClick={() => referenceImageInputRef.current?.click()} className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-background text-xs font-medium hover:border-[#1456f0] hover:text-[#1456f0] disabled:cursor-wait disabled:opacity-50"><Upload className="size-3.5" />{referenceUploading === "image" ? "上传中…" : referenceImageURL ? "替换参考图" : "上传参考图"}</button><button type="button" disabled={!videoReferenceSupported || Boolean(referenceUploading)} onClick={() => referenceVideoInputRef.current?.click()} className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-background text-xs font-medium hover:border-[#1456f0] hover:text-[#1456f0] disabled:cursor-not-allowed disabled:opacity-50"><Video className="size-3.5" />{referenceUploading === "video" ? "上传中…" : referenceVideoURL ? "替换参考视频" : "上传参考视频"}</button><button type="button" disabled={!audioReferenceSupported || Boolean(referenceUploading)} onClick={() => referenceAudioInputRef.current?.click()} className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-background text-xs font-medium hover:border-[#1456f0] hover:text-[#1456f0] disabled:cursor-not-allowed disabled:opacity-50"><Music className="size-3.5" />{referenceUploading === "audio" ? "上传中…" : referenceAudioURL ? "替换参考音频" : "上传参考音频"}</button></div>
		{referenceImageURL ? <p className="truncate text-[11px] text-emerald-600 dark:text-emerald-400">已设置参考图片，也可以连接图片节点</p> : null}
		{referenceVideoURL ? <p className="truncate text-[11px] text-emerald-600 dark:text-emerald-400">已设置参考视频，也可以连接视频节点</p> : null}
		<div className="grid gap-2"><label className="space-y-1"><span className="text-[11px] text-muted-foreground">参考图片 URL</span><Input type="url" value={referenceImageURL} onChange={(event) => onParametersChange({ generation_video_reference_image_urls: event.target.value ? [event.target.value] : [], generation_video_reference_urls: [], generation_video_reference_audio_urls: [] })} placeholder="https://图片地址" className="h-8 rounded-lg px-2 text-xs shadow-none" /></label><label className="space-y-1"><span className="text-[11px] text-muted-foreground">参考视频 URL</span><Input type="url" value={referenceVideoURL} disabled={!videoReferenceSupported} onChange={(event) => onParametersChange({ generation_video_reference_mode: "reference", generation_video_reference_urls: event.target.value ? [event.target.value] : [] })} placeholder={videoReferenceSupported ? "https://视频地址" : "当前模型不支持"} className="h-8 rounded-lg px-2 text-xs shadow-none disabled:opacity-60" /></label></div>
		{audioReferenceSupported ? <label className="block space-y-1"><span className="text-[11px] text-muted-foreground">参考音频 URL（可选）</span><Input type="url" value={referenceAudioURL} onChange={(event) => onParametersChange({ generation_video_reference_mode: "reference", generation_video_reference_audio_urls: event.target.value ? [event.target.value] : [] })} placeholder="https://音频地址" className="h-8 rounded-lg px-2 text-xs shadow-none" /></label> : null}
	  </div>
				  {(klingElementsSupported || supportsVideoFrameReferences(params.generation_video_model)) ? <CanvasVideoNodeBindings node={node} inputs={inputs} onChange={onParametersChange} /> : null}
	   </div>
	  </div>
	  </AppScrollArea>
	  {showGenerateFooter ? <CanvasGenerationFooter
	    running={running}
	    disabled={!running && (generationBusy || (!prompt.trim() && !connectedPromptAvailable) || !videoSecondsIsValid(params.generation_video_model, params.generation_video_seconds))}
	    secondaryAction={onUpload ? { label: node.url ? "替换视频" : "上传视频", icon: <Upload />, loading: uploading, disabled: uploading || running, onClick: onUpload } : undefined}
	    onGenerate={() => onGenerate(prompt.trim())}
	    onStop={onStop}
	  /> : null}
	</div>;
}

function isRetryableTaskPollError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
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
    generation_response_format_b64_json: node?.generation_response_format_b64_json ?? defaults.generation_response_format_b64_json,
    generation_codex_cli_compatibility: node?.generation_codex_cli_compatibility ?? defaults.generation_codex_cli_compatibility,
  };
}

function canvasAudioSettings(node: CanvasNode): Partial<CanvasNode> {
  return {
    generation_audio_model: node.generation_audio_model,
    generation_audio_voice: node.generation_audio_voice,
    generation_audio_format: node.generation_audio_format,
    generation_audio_speed: node.generation_audio_speed,
    generation_audio_instructions: node.generation_audio_instructions,
    generation_audio_grok_voice: node.generation_audio_grok_voice,
    generation_audio_grok_language: node.generation_audio_grok_language,
    generation_audio_grok_format: node.generation_audio_grok_format,
    generation_audio_grok_speed: node.generation_audio_grok_speed,
    generation_audio_glm_voice: node.generation_audio_glm_voice,
    generation_audio_glm_format: node.generation_audio_glm_format,
    generation_audio_glm_speed: node.generation_audio_glm_speed,
    generation_audio_mimo_voice: node.generation_audio_mimo_voice,
    generation_audio_mimo_format: node.generation_audio_mimo_format,
    generation_audio_mimo_voice_design_prompt: node.generation_audio_mimo_voice_design_prompt,
    generation_audio_mimo_voice_clone_node_id: node.generation_audio_mimo_voice_clone_node_id,
    generation_audio_gemini_voice: node.generation_audio_gemini_voice,
  };
}

function CanvasTextContentPanel({ node, onContentChange, onFontSizeChange }: {
  node: CanvasNode;
  onContentChange: (value: string, commit?: boolean) => void;
  onFontSizeChange: (value: number) => void;
}) {
  const [content, setContent] = useState(node.prompt || "");
  const fontSize = node.font_size || 14;

  useEffect(() => {
    setContent(node.prompt || "");
  }, [node.id, node.prompt]);

  function updateContent(value: string, commit = false) {
    setContent(value);
    onContentChange(value, commit);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="overflow-hidden rounded-xl border border-border/90 bg-card/96 shadow-[0_14px_38px_rgba(15,23,42,.14)] backdrop-blur-xl transition-[border-color,box-shadow] focus-within:border-[#8eacf0] focus-within:shadow-[0_14px_38px_rgba(15,23,42,.13),0_0_0_2px_rgba(20,86,240,.07)]">
        <Textarea
          value={content}
          onChange={(event) => updateContent(event.target.value)}
          onBlur={(event) => updateContent(event.target.value, true)}
          placeholder="输入文字内容"
          className="h-48 resize-none border-0 bg-transparent px-3.5 py-3 text-sm leading-6 shadow-none outline-none placeholder:text-muted-foreground/55 focus-visible:ring-0"
        />
        <div className="flex min-w-0 items-center justify-between gap-2 border-t border-border/60 px-1.5 py-1">
          <span className="px-2 text-[11px] tabular-nums text-muted-foreground">{content.length} 字</span>
          <CanvasPromptLibrary onSelect={(value) => updateContent(value, true)} />
        </div>
      </div>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">字号</span>
        <div className="flex h-9 items-center justify-between rounded-md border border-input bg-background px-1">
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="缩小字号" title="缩小字号" disabled={fontSize <= 10} onClick={() => onFontSizeChange(fontSize - 1)}><Minus /></Button>
          <span className="min-w-12 text-center text-sm tabular-nums">{fontSize}px</span>
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="放大字号" title="放大字号" disabled={fontSize >= 32} onClick={() => onFontSizeChange(fontSize + 1)}><Plus /></Button>
        </div>
      </div>
    </div>
  );
}

function CanvasNodePromptPanel({ node, mentionReferences, running, generationBusy, imageModel, imageModels, imageModelReady, cancelling, canStop, connectedPromptAvailable, onPromptChange, onParametersChange, onGenerate, onStop }: {
  node: CanvasNode;
  mentionReferences: readonly CanvasResourceReference[];
  running: boolean;
  generationBusy: boolean;
  imageModel: string;
  imageModels: string[];
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
    <div className="flex h-full min-h-0 flex-col gap-4">
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
        <div className="flex min-w-0 items-center justify-between gap-2 border-t border-border/60 px-1.5 py-1"><CanvasInlineModelSelect value={node.generation_model?.trim() || imageModel} models={imageModels} label="图片模型" onChange={(generation_model) => onParametersChange({ generation_model })} /><CanvasPromptLibrary onSelect={updatePrompt} /></div>
      </div>
      <AppScrollArea className="h-0 flex-1" viewportClassName="pr-3">
        <div className="space-y-3">
          <CanvasImageParameterPopover node={node} imageModel={imageModel} imageModels={imageModels} onChange={onParametersChange} expanded showModel={false} />
          <CanvasCameraControl value={node.camera_control} onChange={(camera_control) => onParametersChange({ camera_control })} className="w-full" />
        </div>
      </AppScrollArea>
      <CanvasGenerationFooter
        running={running}
        stopping={cancelling}
        disabled={running ? !canStop || cancelling : !imageModelReady || (!prompt.trim() && !connectedPromptAvailable) || generationBusy}
        onGenerate={submit}
        onStop={onStop}
      />
    </div>
  );
}

export default function CanvasPage({ session, projectID }: { session: StoredAuthSession; projectID?: string }) {
  const navigate = useNavigate();
  const { preferences: imageGenerationPreferences } = useImageGenerationPreferences(session.key);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef(cloneDocument(DEFAULT_DOCUMENT));
  const nodesRef = useRef<CanvasNode[]>([]);
  const connectionsRef = useRef<CanvasConnection[]>([]);
  const selectedNodeIDsRef = useRef(new Set<string>());
  const viewportRef = useRef(DEFAULT_DOCUMENT.viewport);
  const titleRef = useRef(DEFAULT_DOCUMENT.title);
  const backgroundRef = useRef(DEFAULT_DOCUMENT.background);
  const showImageInfoRef = useRef(Boolean(DEFAULT_DOCUMENT.show_image_info));
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
  const submittedTaskIDsRef = useRef(new Set<string>());
  const batchAnimationTimersRef = useRef(new Map<string, number>());
  const focusAnimationRef = useRef<number | null>(null);
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);

  const [nodes, setNodesState] = useState<CanvasNode[]>([]);
  const [connections, setConnectionsState] = useState<CanvasConnection[]>([]);
  const [viewport, setViewportState] = useState(DEFAULT_DOCUMENT.viewport);
  const [title, setTitle] = useState(DEFAULT_DOCUMENT.title);
  const [background, setBackground] = useState(DEFAULT_DOCUMENT.background);
  const [showImageInfo, setShowImageInfo] = useState(Boolean(DEFAULT_DOCUMENT.show_image_info));
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [selectedNodeIDs, setSelectedNodeIDs] = useState(new Set<string>());
  const [selectedConnectionID, setSelectedConnectionID] = useState("");
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ mode: CanvasProjectDialogMode; title: string } | null>(null);
  const [sidePanel, setSidePanel] = useState(storedCanvasSidePanel);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentWidth, setAgentWidth] = useState(DEFAULT_AGENT_PANEL.width);
  const [agentSessions, setAgentSessions] = useState<CanvasAssistantSession[]>([]);
  const [activeAgentSessionID, setActiveAgentSessionID] = useState("");
  const [initialAgentRequest, setInitialAgentRequest] = useState<{ prompt: string; references: CanvasAssistantReference[] } | null>(null);
  const [agentReferenceNodeClick, setAgentReferenceNodeClick] = useState<{ nodeID: string | null; version: number }>({ nodeID: null, version: 0 });
  const [agentConfig, setAgentConfig] = useState<CanvasAgentConfig | null>(null);
  const [openDirectorNodeID, setOpenDirectorNodeID] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryImages, setLibraryImages] = useState<ManagedImage[]>([]);
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<PendingConnectionCreate | null>(null);
  const [nodeCreateMenu, setNodeCreateMenu] = useState<CanvasNodeCreateMenu | null>(null);
  const [panelNodeID, setPanelNodeID] = useState("");
  const [exportingCanvas, setExportingCanvas] = useState(false);
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
  const [pendingPanoramaImport, setPendingPanoramaImport] = useState<PendingPanoramaImport | null>(null);
  const [imageTool, setImageTool] = useState<CanvasImageToolState | null>(null);
  const [imageToolBusy, setImageToolBusy] = useState(false);
  const [maskEditModel, setMaskEditModel] = useState("");
  const [collapsingBatchRootIDs, setCollapsingBatchRootIDs] = useState(new Set<string>());
  const [openingBatchRootIDs, setOpeningBatchRootIDs] = useState(new Set<string>());
  const [imageModel, setImageModel] = useState<ImageModel>("");
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [imageModelReady, setImageModelReady] = useState(false);
  const [textModel, setTextModel] = useState("gpt-5.5");
  const [textModels, setTextModels] = useState<string[]>([]);
  const [videoModel, setVideoModel] = useState(DEFAULT_VIDEO_MODEL);
  const [videoModels, setVideoModels] = useState([DEFAULT_VIDEO_MODEL]);
  const [audioModel, setAudioModel] = useState("gpt-4o-mini-tts");
  const [audioModels, setAudioModels] = useState(["gpt-4o-mini-tts"]);
  const imageRelayTokenStorageKey = relayTokenNameStorageKey(session, "image");
  const videoRelayTokenStorageKey = relayTokenNameStorageKey(session, "video");
  const audioRelayTokenStorageKey = relayTokenNameStorageKey(session, "audio");
  const textRelayTokenStorageKey = relayTokenNameStorageKey(session, "text");
  const [imageRelayTokenName, setImageRelayTokenName] = useState(() => getStoredRelayTokenName(session, "image"));
  const [videoRelayTokenName, setVideoRelayTokenName] = useState(() => getStoredRelayTokenName(session, "video"));
  const [audioRelayTokenName, setAudioRelayTokenName] = useState(() => getStoredRelayTokenName(session, "audio"));
  const [textRelayTokenName, setTextRelayTokenName] = useState(() => getStoredRelayTokenName(session, "text"));
  const [relayTokenDialogKind, setRelayTokenDialogKind] = useState<RelayTokenCreationKind | null>(null);
  const [, setSaveState] = useState<SaveState>("saved");
  const [switchPhase, setSwitchPhase] = useState<CanvasSwitchPhase>(null);
  const [loading, setLoading] = useState(true);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() => getPreferredColorTheme());
  const [, setHistoryVersion] = useState(0);

  useEffect(() => {
    selectedNodeIDsRef.current = selectedNodeIDs;
  }, [selectedNodeIDs]);

  useEffect(() => {
    const handleThemeChange = (event: Event) => {
      const nextTheme = (event as CustomEvent<ColorTheme>).detail;
      if (nextTheme === "light" || nextTheme === "dark") setColorTheme(nextTheme);
    };
    window.addEventListener(COLOR_THEME_CHANGE_EVENT, handleThemeChange);
    return () => window.removeEventListener(COLOR_THEME_CHANGE_EVENT, handleThemeChange);
  }, []);

  const preferredCanvasImageParameters = useCallback((): Partial<CanvasNode> => ({
    ...defaultCanvasImageParameters(),
    generation_count: imageGenerationPreferences.canvas_default_image_count,
    generation_stream: imageGenerationPreferences.stream,
    generation_partial_images: imageGenerationPreferences.partial_images,
    generation_response_format_b64_json: imageGenerationPreferences.response_format_b64_json,
    generation_codex_cli_compatibility: imageGenerationPreferences.codex_cli_compatibility,
  }), [imageGenerationPreferences]);

  function preferredCanvasAudioParameters(model = audioModel): Partial<CanvasNode> {
    return {
      generation_audio_model: model,
      ...canvasAgentAudioNodeParameters(model, imageGenerationPreferences.default_audio_voice, imageGenerationPreferences.audio_instructions, "", { format: imageGenerationPreferences.default_audio_format, speed: imageGenerationPreferences.default_audio_speed }),
    };
  }

  const defaultAgentImageParameters = defaultCanvasImageParameters();
  const defaultAgentVideoParameters = canvasVideoParameters({ generation_video_model: videoModel } as CanvasNode);
  const agentImageQualityValues = ["", ...IMAGE_QUALITY_OPTIONS.map((option) => option.value)];
  const agentImageSizeValues = Array.from(new Set([
    ...IMAGE_ASPECT_RATIO_OPTIONS.map((option) => option.value).filter(Boolean),
    ...IMAGE_ASPECT_RATIO_PRESET_OPTIONS.map((option) => option.size).filter((value) => value !== "auto"),
    ...(agentConfig?.imageSize ? [agentConfig.imageSize] : []),
  ]));
  const agentVideoQualityValues = videoResolutionOptions(videoModel, defaultAgentVideoParameters.generation_video_seconds);
  const agentVideoSizeValues = videoSizeOptions(videoModel);
  const preferredAgentVideoSize = preferredCanvasAgentVideoSize(
    agentVideoSizeValues,
    defaultAgentVideoParameters.generation_video_size || "",
  );
  const availableAgentVideoQualityValues = agentVideoQualityValues.length
    ? Array.from(new Set([...agentVideoQualityValues, ...(agentConfig?.videoQuality ? [agentConfig.videoQuality] : [])]))
    : [defaultAgentVideoParameters.generation_video_resolution || "720p"];
  const availableAgentVideoSizeValues = agentVideoSizeValues.length
    ? Array.from(new Set([...agentVideoSizeValues, ...(agentConfig?.videoSize ? [agentConfig.videoSize] : [])]))
    : [preferredAgentVideoSize];
  const resolvedAgentConfig = normalizeCanvasAgentConfig(agentConfig, {
    imageQuality: defaultAgentImageParameters.generation_quality || "",
    imageSize: agentImageSizeValues.includes(defaultAgentImageParameters.generation_size || "") ? defaultAgentImageParameters.generation_size || "1:1" : "1:1",
    videoQuality: defaultAgentVideoParameters.generation_video_resolution || availableAgentVideoQualityValues[0],
    videoSize: preferredAgentVideoSize,
  }, {
    imageQuality: agentImageQualityValues,
    imageSize: agentImageSizeValues,
    videoQuality: availableAgentVideoQualityValues,
    videoSize: availableAgentVideoSizeValues,
  });

  const selectedConnection = connections.find((connection) => connection.id === selectedConnectionID) || null;
  const openDirectorNode = openDirectorNodeID
    ? nodes.find((node) => node.id === openDirectorNodeID && node.type === "director") || null
    : null;
  const directorPanoramas = useMemo(() => {
    if (!openDirectorNode) return [] as CanvasDirectorPanorama[];
    const nodeByID = new Map(nodes.map((node) => [node.id, node]));
    return connections.flatMap((connection) => {
      if (connection.to_node_id !== openDirectorNode.id) return [];
      const source = nodeByID.get(connection.from_node_id);
      if (!source?.url || (source.type !== "image" && source.type !== "panorama")) return [];
      return [{
        edgeId: connection.id,
        sourceNodeId: source.id,
        imageUrl: source.url,
        fileName: source.title || "画布图片.png",
        projectionMode: source.type === "panorama" && source.panorama_projection === "equirectangular"
          ? "equirectangular" as const
          : "backdrop" as const,
      }];
    });
  }, [connections, nodes, openDirectorNode]);
  const previewImages = visibleCanvasNodes(nodes).flatMap((node) => node.type === "image" && node.url ? [{ id: node.id, src: node.url, fileName: node.title, outputFormat: node.generation_output_format, dimensions: `${Math.round(node.width)} × ${Math.round(node.height)}` }] : []);
  const previewIndex = Math.max(0, previewImages.findIndex((image) => image.id === previewNodeID));
  const previewPanorama = nodes.find((node) => node.id === previewNodeID && node.type === "panorama" && node.url) || null;
  const previewVideo = nodes.find((node) => node.id === previewNodeID && node.type === "video" && node.url) || null;

  useEffect(() => () => { if (imageTool?.sourceURL) URL.revokeObjectURL(imageTool.sourceURL); }, [imageTool?.sourceURL]);

  useEffect(() => {
    let active = true;
    void fetchModelConfig()
      .then(({ config }) => {
        if (active) {
          const personalImageModel = config.image_models.includes(imageGenerationPreferences.default_image_model)
            ? imageGenerationPreferences.default_image_model
            : config.default_image_model;
          const personalVideoModel = config.video_models.includes(imageGenerationPreferences.default_video_model)
            ? imageGenerationPreferences.default_video_model
            : config.default_video_model;
          const personalTextModel = config.text_models.includes(imageGenerationPreferences.default_text_model)
            ? imageGenerationPreferences.default_text_model
            : config.default_text_model;
          const personalAudioModel = config.audio_models.includes(imageGenerationPreferences.default_audio_model)
            ? imageGenerationPreferences.default_audio_model
            : config.default_audio_model;
          setImageModel(resolveCanvasImageModel(personalImageModel, config.image_models, DEFAULT_IMAGE_MODEL));
          setImageModels(config.image_models?.length ? config.image_models : [personalImageModel || DEFAULT_IMAGE_MODEL]);
          setTextModel(resolveCanvasTextModel(personalTextModel, config.text_models));
          setTextModels(config.text_models?.length ? config.text_models : [config.default_text_model].filter(Boolean));
          setVideoModel(personalVideoModel || config.video_models?.[0] || DEFAULT_VIDEO_MODEL);
          setVideoModels(config.video_models?.length ? config.video_models : [DEFAULT_VIDEO_MODEL]);
          setAudioModel(resolveCanvasAudioModel(personalAudioModel, config.audio_models));
          setAudioModels(config.audio_models?.length ? config.audio_models : [config.default_audio_model || "gpt-4o-mini-tts"]);
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
  }, [imageGenerationPreferences.default_audio_model, imageGenerationPreferences.default_image_model, imageGenerationPreferences.default_text_model, imageGenerationPreferences.default_video_model]);

  const refreshLibrary = useCallback((showLoading = false, notifyError = false) => {
    if (libraryRefreshPromiseRef.current) return libraryRefreshPromiseRef.current;
    const request = (async () => {
      if (showLoading) setLibraryLoading(true);
      try {
        const response = await fetchManagedImages({ scope: "mine" });
        if (mountedRef.current) setLibraryImages(response.items.slice(0, 120));
      } catch (error) {
        if (notifyError) toast.error(error instanceof Error ? error.message : "素材库加载失败");
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

  function handleNodeMediaLoad(nodeID: string, naturalWidth: number, naturalHeight: number, mediaBytes?: number) {
    const width = Math.round(Number(naturalWidth));
    const height = Math.round(Number(naturalHeight));
    const bytes = Math.round(Number(mediaBytes));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const node = nodesRef.current.find((item) => item.id === nodeID);
    if (!node || (node.type !== "image" && node.type !== "video") || !node.url) return;
    const dimensionsChanged = node.natural_width !== width || node.natural_height !== height;
    const bytesChanged = Number.isFinite(bytes) && bytes > 0 && node.bytes !== bytes;
    if (!dimensionsChanged && !bytesChanged) return;

    if (!dimensionsChanged) {
      replaceNodes(nodesRef.current.map((item) => item.id === nodeID ? { ...item, bytes } : item));
      scheduleSave();
      return;
    }

    // Keep the node's largest edge as the display bound while matching the loaded
    // media ratio. This removes letterboxing when the API omits output dimensions.
    const maxEdge = Math.max(220, node.width, node.height);
    const scale = Math.min(1, maxEdge / width, maxEdge / height);
    const nextWidth = Math.max(1, Math.round(width * scale));
    const nextHeight = Math.max(1, Math.round(height * scale));
    const centerX = node.x + node.width / 2;
    const centerY = node.y + node.height / 2;
    replaceNodes(nodesRef.current.map((item) => item.id === nodeID ? {
      ...item,
      x: centerX - nextWidth / 2,
      y: centerY - nextHeight / 2,
      width: nextWidth,
      height: nextHeight,
      natural_width: width,
      natural_height: height,
      ...(bytesChanged ? { bytes } : {}),
    } : item));
    scheduleSave();
  }

  function captureDocument(): CanvasDocument {
    return {
      ...documentRef.current,
      version: 1,
      title: titleRef.current,
      background: backgroundRef.current,
      show_image_info: showImageInfoRef.current,
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
      .then(() => saveCanvasDocument({
        ...payload,
        revision: documentRef.current.id === payload.id ? documentRef.current.revision : payload.revision,
      }));
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
      if (mountedRef.current && saveRequestVersionRef.current === requestVersion) toast.error(canvasErrorMessage(error));
      return false;
    }
  }

  function applyDocument(document: CanvasDocument, resetHistory = true) {
    loadedRef.current = false;
    canvasOperationEpochRef.current += 1;
    canvasRecoveryAbortControllerRef.current?.abort();
    canvasRecoveryAbortControllerRef.current = null;
    const recoveryTaskIDs = [...new Set((document.nodes || []).flatMap((node) => (
      canvasGenerationNeedsRecovery(node) ? [canvasGenerationRecoveryTaskID(node)] : []
    )))];
    const operationEpoch = canvasOperationEpochRef.current;
    const next = cloneDocument({
      ...document,
      nodes: (document.nodes || []).map((node) => normalizeCanvasNodeTitle(normalizeCanvasVideoNode(node))),
      connections: document.connections || [],
    });
    const restoredAgentSessions = storedCanvasAgentSessions(next);
    const restoredActiveAgentSessionID = next.active_agent_session_id && restoredAgentSessions.some((item) => item.id === next.active_agent_session_id)
      ? next.active_agent_session_id
      : restoredAgentSessions[0]?.id || "";
    documentRef.current = { ...next, agent_sessions: restoredAgentSessions, active_agent_session_id: restoredActiveAgentSessionID || undefined };
    replaceNodes(next.nodes || []);
    replaceConnections(next.connections || []);
    viewportRef.current = next.viewport || DEFAULT_DOCUMENT.viewport;
    titleRef.current = next.title || "我的画布";
    backgroundRef.current = next.background || "dots";
    showImageInfoRef.current = Boolean(next.show_image_info);
    setViewportState(viewportRef.current);
    setTitle(titleRef.current);
    setBackground(backgroundRef.current);
    setShowImageInfo(showImageInfoRef.current);
    setAgentConfig(storedCanvasAgentConfig(next));
    setAgentSessions(restoredAgentSessions);
    setActiveAgentSessionID(restoredActiveAgentSessionID);
    setAgentOpen(next.agent_panel?.open === true);
    setAgentWidth(next.agent_panel?.width || DEFAULT_AGENT_PANEL.width);
    setInitialAgentRequest(null);
    setSelectedNodeIDs(new Set());
    setSelectedConnectionID("");
    setPanelNodeID("");
    setPreviewNodeID("");
    setContextMenu(null);
    setPendingConnection(null);
    setNodeCreateMenu(null);
    setImageTool(null);
    setImageToolBusy(false);
    setMaskEditModel("");
    setUploadingNodeID("");
    if (resetHistory) {
      historyRef.current = [cloneDocument(documentRef.current)];
      redoRef.current = [];
      saveChangeVersionRef.current = 0;
      persistedChangeVersionRef.current = 0;
      setHistoryVersion((value) => value + 1);
    }
    setSaveState("saved");
    loadedRef.current = true;
	void hydrateCanvasStorageURLs(next, operationEpoch).then(() => {
      void consumePendingAgentRequest(next.pending_agent_request, next.id, operationEpoch)
        .catch((error) => toast.error(error instanceof Error ? error.message : "首页素材插入失败"));
    });
    if (recoveryTaskIDs.length) {
      const controller = new AbortController();
      canvasRecoveryAbortControllerRef.current = controller;
      void recoverCanvasTasks(next.id, operationEpoch, recoveryTaskIDs, controller.signal);
    }
  }

	async function hydrateCanvasStorageURLs(document: CanvasDocument, operationEpoch: number) {
		const hydratedStorageURLs = await Promise.all((document.nodes || []).map(async (node) => {
			if (!node.storage_key) return null;
			if (node.type === "image" || node.type === "panorama") {
				const url = await resolveImageURL(node.storage_key, node.url || "").catch(() => node.url || "");
				return url && url !== node.url ? { id: node.id, storageKey: node.storage_key, url } : null;
			}
			if (node.type === "video" || node.type === "audio") {
				const url = await resolveMediaURL(node.storage_key, node.url || "").catch(() => node.url || "");
				return url && url !== node.url ? { id: node.id, storageKey: node.storage_key, url } : null;
			}
			return null;
		}));
		if (!mountedRef.current || canvasOperationEpochRef.current !== operationEpoch || documentRef.current.id !== document.id) return;
		const hydratedURLByNodeID = new Map(hydratedStorageURLs.filter((item) => item !== null).map((item) => [item.id, item]));
		if (!hydratedURLByNodeID.size) return;
		let changed = false;
		const nextNodes = nodesRef.current.map((node) => {
			const hydrated = hydratedURLByNodeID.get(node.id);
			if (!hydrated || node.storage_key !== hydrated.storageKey || node.url === hydrated.url) return node;
			changed = true;
			return { ...node, url: hydrated.url };
		});
		if (!changed) return;
		documentRef.current = { ...documentRef.current, nodes: nextNodes };
		replaceNodes(nextNodes);
	}

  async function consumePendingAgentRequest(request: CanvasPendingAgentRequest | undefined, projectID: string, operationEpoch: number) {
    if (!request?.prompt.trim() || !mountedRef.current || canvasOperationEpochRef.current !== operationEpoch || documentRef.current.id !== projectID) return;
    const hydratedAssets = await Promise.all(request.assets.map(async (asset) => {
      const payload = asset.payload;
      if (payload.kind === "image" && payload.storageKey) {
        return { ...asset, payload: { ...payload, dataUrl: await resolveImageURL(payload.storageKey, payload.dataUrl) } };
      }
      if ((payload.kind === "video" || payload.kind === "audio") && payload.storageKey) {
        return { ...asset, payload: { ...payload, url: await resolveMediaURL(payload.storageKey, payload.url) } };
      }
      return asset;
    }));
    if (!mountedRef.current || canvasOperationEpochRef.current !== operationEpoch || documentRef.current.id !== projectID) return;
    const previousNodes = nodesRef.current;
    const center = canvasCenterPosition();
    const insertedNodes = hydratedAssets.map((asset, index) => canvasPendingAgentAssetNode(asset, index, hydratedAssets.length, center));
    if (insertedNodes.length) {
      replaceNodes([...nodesRef.current, ...insertedNodes]);
    }
    const nodeByID = new Map(nodesRef.current.map((node) => [node.id, node]));
    const references = hydratedAssets.flatMap((asset) => {
      const node = nodeByID.get(asset.nodeId);
      if (!node) return [];
      const reference: CanvasAssistantReference = {
        ...asset.reference,
        id: node.id,
        type: node.type,
        title: node.title || asset.reference.title,
        url: node.url,
        storageKey: node.storage_key,
        mimeType: node.mime_type,
        ...(node.type === "text" ? { text: node.prompt } : {}),
        ...((node.type === "image" || node.type === "panorama") && node.url ? { dataUrl: node.url } : {}),
      };
      return [reference];
    });
    documentRef.current = {
      ...documentRef.current,
      pending_agent_request: undefined,
      agent_panel: { ...(documentRef.current.agent_panel || DEFAULT_AGENT_PANEL), open: true },
    };
    scheduleSave();
    if (!await persistCanvas()) {
      if (documentRef.current.id === projectID) {
        replaceNodes(previousNodes);
        documentRef.current = { ...documentRef.current, pending_agent_request: request };
      }
      return;
    }
    if (!mountedRef.current || canvasOperationEpochRef.current !== operationEpoch || documentRef.current.id !== projectID) return;
    pushHistory();
    setAgentOpen(true);
    setInitialAgentRequest({ prompt: request.prompt.trim(), references });
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
      let normalizedPatch = patch;
      if (node.type === "config" && patch.generation_mode) {
        if (patch.generation_mode === "image") normalizedPatch = { generation_model: node.generation_model || imageModel, ...patch };
        if (patch.generation_mode === "text") normalizedPatch = { generation_text_model: node.generation_text_model || textModel, ...patch };
        if (patch.generation_mode === "video") normalizedPatch = { ...canvasVideoParameters({ ...node, generation_video_model: node.generation_video_model || videoModel }), ...patch };
        if (patch.generation_mode === "audio") normalizedPatch = { ...preferredCanvasAudioParameters(node.generation_audio_model || audioModel), ...patch };
      }
      const next = { ...node, ...normalizedPatch };
      const size = node.type === "image" && typeof patch.generation_size === "string"
        ? patch.generation_size
        : node.type === "video" && typeof patch.generation_video_size === "string"
          ? patch.generation_video_size
          : "";
      if ((node.type !== "image" && node.type !== "video") || node.url || !size) return next;
      const defaults = CANVAS_NODE_DEFAULT_SIZE[node.type];
      const frame = canvasEmptyImageFrameFromSize(node, size, defaults.width, defaults.height);
      return frame ? { ...next, ...frame } : next;
    }));
    pushHistory();
  }

  function updateViewport(next: CanvasDocument["viewport"], commit = false) {
    viewportRef.current = next;
    setViewportState(next);
    if (commit) scheduleSave();
  }

  function focusCanvasNode(nodeID: string) {
    const node = nodesRef.current.find((item) => item.id === nodeID);
    if (!node || canvasSize.width <= 0 || canvasSize.height <= 0) return;
    const zoom = Math.min(1, Math.max(
      CANVAS_MIN_ZOOM,
      Math.min(
        (canvasSize.width * 0.64) / Math.max(1, node.width),
        (canvasSize.height * 0.64) / Math.max(1, node.height),
      ),
    ));
    const from = viewportRef.current;
    const target = {
      zoom,
      x: canvasSize.width / 2 - (node.x + node.width / 2) * zoom,
      y: canvasSize.height / 2 - (node.y + node.height / 2) * zoom,
    };
    const startedAt = performance.now();
    if (focusAnimationRef.current !== null) window.cancelAnimationFrame(focusAnimationRef.current);
    selectionChanged(new Set([nodeID]));

    const animate = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / 360);
      const eased = 1 - Math.pow(1 - progress, 3);
      updateViewport({
        zoom: from.zoom + (target.zoom - from.zoom) * eased,
        x: from.x + (target.x - from.x) * eased,
        y: from.y + (target.y - from.y) * eased,
      }, progress === 1);
      if (progress < 1) focusAnimationRef.current = window.requestAnimationFrame(animate);
      else focusAnimationRef.current = null;
    };
    focusAnimationRef.current = window.requestAnimationFrame(animate);
  }

  function selectionChanged(ids: Set<string>, connectionID = "") {
    const next = new Set(ids);
    selectedNodeIDsRef.current = next;
    setSelectedNodeIDs(next);
    setSelectedConnectionID(connectionID);
    setContextMenu(null);
    if (!ids.size) setAgentReferenceNodeClick((current) => ({ ...current, nodeID: null }));
    if (ids.size !== 1 || !ids.has(panelNodeID)) setPanelNodeID("");
  }

  function activateNode(nodeID: string) {
    const node = nodesRef.current.find((item) => item.id === nodeID);
    setAgentReferenceNodeClick((current) => ({ nodeID, version: current.version + 1 }));
    if (agentOpen) {
      setPanelNodeID("");
      return;
    }
    setPanelNodeID(node?.type === "group" ? "" : node?.id || "");
  }

  function toggleCanvasFreeResize(nodeID: string) {
    const source = nodesRef.current.find((node) => node.id === nodeID && (node.type === "image" || node.type === "panorama"));
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

  function insertCanvasAsset(payload: CanvasInsertAssetPayload) {
    const asset = createCanvasPendingAgentAsset(payload, payload.title);
    const node = canvasPendingAgentAssetNode(asset, 0, 1, canvasCenterPosition());
    replaceNodes([...nodesRef.current, node]);
    setSelectedNodeIDs(new Set([node.id]));
    setSelectedConnectionID("");
    setPanelNodeID(node.type === "text" || node.type === "audio" ? "" : node.id);
    pushHistory();
  }

  function addTextNode() {
    addTextNodeAt(placement());
  }

  function addTextNodeAt(point: { x: number; y: number }, prompt = "", title = "文字") {
    const node: CanvasNode = { id: `text-${randomID()}`, type: "text", x: point.x, y: point.y, width: 340, height: 240, font_size: 14, scale_x: 1, scale_y: 1, title, prompt, created_at: createdAt() };
    addNode(node);
    setPanelNodeID(node.id);
  }

  function addBlankNode() {
    addBlankNodeAt(placement());
  }

  function addBlankNodeAt(point: { x: number; y: number }) {
    const node = { id: `image-${randomID()}`, type: "image" as const, x: point.x, y: point.y, width: 340, height: 240, scale_x: 1, scale_y: 1, title: "图片", prompt: "", ...preferredCanvasImageParameters(), created_at: createdAt() };
    addNode(node);
    setPanelNodeID(node.id);
  }

  function addBlankVideoNodeAt(point: { x: number; y: number }) {
    const node = buildVideoNode({}, point);
    addNode(node);
    setPanelNodeID(node.id);
  }

  function addBlankVideoNode() {
    addBlankVideoNodeAt(placement());
  }

  function addAudioNodeAt(point: { x: number; y: number }) {
    const node: CanvasNode = { id: `audio-${randomID()}`, type: "audio", x: point.x, y: point.y, ...CANVAS_NODE_DEFAULT_SIZE.audio, scale_x: 1, scale_y: 1, title: "音频", prompt: "", ...preferredCanvasAudioParameters(), created_at: createdAt() };
    addNode(node); setPanelNodeID(node.id);
  }

  function addPanoramaNodeAt(point: { x: number; y: number }) {
    const node: CanvasNode = { id: `panorama-${randomID()}`, type: "panorama", x: point.x, y: point.y, ...CANVAS_NODE_DEFAULT_SIZE.panorama, scale_x: 1, scale_y: 1, title: "全景图", prompt: "", panorama_source_prompt: "", ...preferredCanvasImageParameters(), generation_size: "2:1", created_at: createdAt() };
    addNode(node); setPanelNodeID(node.id);
  }

  function addDirectorNodeAt(point: { x: number; y: number }) {
    const node: CanvasNode = { id: `director-${randomID()}`, type: "director", x: point.x, y: point.y, ...CANVAS_NODE_DEFAULT_SIZE.director, scale_x: 1, scale_y: 1, title: "导演台", created_at: createdAt() };
    addNode(node);
    setPanelNodeID("");
  }

  function createGroupFromSelection(nodeIDs?: readonly string[], title = "组") {
    const selectedIDs = new Set(nodeIDs || [...selectedNodeIDs]);
    const selectedNodes = nodesRef.current.filter((node) => selectedIDs.has(node.id));
    if (selectedNodes.length < 2 || selectedNodes.some((node) => node.type === "group" || node.group_id)) return null;

    const bounds = canvasNodeBounds(selectedNodes);
    const group: CanvasNode = {
      id: `group-${randomID()}`,
      type: "group",
      x: bounds.left - CANVAS_GROUP_PADDING,
      y: bounds.top - CANVAS_GROUP_PADDING,
      width: bounds.right - bounds.left + CANVAS_GROUP_PADDING * 2,
      height: bounds.bottom - bounds.top + CANVAS_GROUP_PADDING * 2,
      scale_x: 1,
      scale_y: 1,
      title,
      created_at: createdAt(),
    };
    replaceNodes([
      ...nodesRef.current.map((node) => selectedIDs.has(node.id) ? { ...node, group_id: group.id } : node),
      group,
    ]);
    setSelectedNodeIDs(new Set([group.id]));
    setSelectedConnectionID("");
    setPanelNodeID("");
    pushHistory();
    return group.id;
  }

  function getCanvasAgentContext(agentState: CanvasAgentState) {
    const videoDefaults = canvasVideoParameters({
      generation_video_model: videoModel,
      generation_video_resolution: resolvedAgentConfig.videoQuality,
      generation_video_size: resolvedAgentConfig.videoSize,
    } as CanvasNode);
    const audioParameters = canvasAgentAudioNodeParameters(
      audioModel,
      imageGenerationPreferences.default_audio_voice,
      imageGenerationPreferences.audio_instructions,
      "",
      { format: imageGenerationPreferences.default_audio_format, speed: imageGenerationPreferences.default_audio_speed },
    );
    return buildCanvasAgentContext({
      projectId: documentRef.current.id,
      projectTitle: titleRef.current,
      nodes: nodesRef.current,
      connections: connectionsRef.current,
      selectedNodeIds: selectedNodeIDsRef.current,
      agentState,
      generation: {
        textModel,
        imageModel: imageModel || imageGenerationPreferences.default_image_model,
        videoModel: videoModel || imageGenerationPreferences.default_video_model,
        audioModel,
        imageQuality: resolvedAgentConfig.imageQuality,
        imageSize: resolvedAgentConfig.imageSize,
        videoQuality: resolvedAgentConfig.videoQuality || videoDefaults.generation_video_resolution || "",
        videoSize: resolvedAgentConfig.videoSize || videoDefaults.generation_video_size || "",
        imageCount: imageGenerationPreferences.canvas_default_image_count,
        videoSeconds: videoDefaults.generation_video_seconds || 0,
        videoGenerateAudio: Boolean(videoDefaults.generation_video_audio),
        videoSupportsAudio: canvasAgentVideoSupportsAudio(videoDefaults.generation_video_model),
        audioVoice: audioParameters.generation_audio_gemini_voice
          || audioParameters.generation_audio_glm_voice
          || audioParameters.generation_audio_grok_voice
          || audioParameters.generation_audio_mimo_voice
          || audioParameters.generation_audio_voice
          || "",
        audioLanguage: audioParameters.generation_audio_grok_language || "",
        audioFormat: audioParameters.generation_audio_glm_format
          || audioParameters.generation_audio_grok_format
          || audioParameters.generation_audio_mimo_format
          || audioParameters.generation_audio_format
          || "",
        audioSpeed: audioParameters.generation_audio_glm_speed
          || audioParameters.generation_audio_grok_speed
          || audioParameters.generation_audio_speed
          || 1,
      },
    });
  }

  async function executeCanvasAgentAction(action: CanvasAgentAction, messageReferenceNodeIDs: string[]): Promise<CanvasAgentToolResult> {
    const args = action.arguments;
    const stringValue = (key: string) => typeof args[key] === "string" ? String(args[key]).trim() : "";
    const stringValues = (key: string) => Array.isArray(args[key])
      ? [...new Set((args[key] as unknown[]).filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))]
      : [];
    const getNode = (nodeID: string) => nodesRef.current.find((node) => node.id === nodeID);
    const missingNode = (nodeID: string): CanvasAgentToolResult => ({ ok: false, code: "node_not_found", message: `找不到节点 ${nodeID}` });
    const missingNodeID = (nodeIDs: string[]) => nodeIDs.find((nodeID) => !getNode(nodeID)) || "";
    const selectOnly = (nodeID: string) => {
      const next = new Set([nodeID]);
      selectedNodeIDsRef.current = next;
      setSelectedNodeIDs(next);
      setSelectedConnectionID("");
    };
    const sourcePosition = (sourceNodes: CanvasNode[], size: { width: number; height: number }) =>
      canvasAgentNodePosition(size, sourceNodes, nodesRef.current, canvasCenterPosition());

    const agentWriteAction = action.name === "generate_image"
      || action.name === "edit_image"
      || action.name === "generate_video"
      || action.name === "generate_audio"
      || action.name === "create_text_node"
      || action.name === "update_text_node"
      || action.name === "update_node"
      || action.name === "delete_node"
      || action.name === "create_connection"
      || action.name === "delete_connection"
      || action.name === "create_group"
      || action.name === "arrange_nodes";
    const autoTitlePending = documentRef.current.agent_auto_title_pending === true;
    if (autoTitlePending && action.name !== "create_primary_script_node" && agentWriteAction) {
      documentRef.current = { ...documentRef.current, agent_auto_title_pending: false };
      scheduleSave();
    }

    try {
    if (action.name === "set_agent_state") {
      const referenced = [...stringValues("approvedNodeIds"), ...stringValues("referenceNodeIds")];
      const missing = missingNodeID(referenced);
      return missing ? missingNode(missing) : { ok: true };
    }
    if (action.name === "get_canvas_summary") {
      return { ok: true, project: { id: documentRef.current.id, title: titleRef.current }, selectedNodeIds: [...selectedNodeIDsRef.current], nodes: nodesRef.current.slice(0, 120).map(summarizeCanvasAgentNode), connections: connectionsRef.current.slice(0, 240) };
    }
    if (action.name === "get_selected_nodes") {
      return { ok: true, nodes: nodesRef.current.filter((node) => selectedNodeIDsRef.current.has(node.id)).map(summarizeCanvasAgentNode) };
    }
    if (action.name === "get_generation_config") {
      const generation = getCanvasAgentContext({ phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] }).generation;
      return {
        ok: true,
        models: {
          text: generation.textModel,
          image: generation.imageModel,
          video: generation.videoModel,
          audio: generation.audioModel,
        },
        imageQuality: generation.imageQuality,
        imageSize: generation.imageSize,
        videoQuality: generation.videoQuality,
        videoSize: generation.videoSize,
        imageCount: generation.imageCount,
        videoSeconds: generation.videoSeconds,
        videoGenerateAudio: generation.videoGenerateAudio,
        videoSupportsAudio: generation.videoSupportsAudio,
        videoDuration: canvasAgentVideoDurationHint(generation.videoModel),
        audioVoice: generation.audioVoice,
        audioLanguage: generation.audioLanguage,
        audioFormat: generation.audioFormat,
        audioSpeed: generation.audioSpeed,
      };
    }
    if (action.name === "get_node") {
      const nodeID = stringValue("nodeId");
      const node = getNode(nodeID);
      return node ? { ok: true, node: summarizeCanvasAgentNode(node) } : missingNode(nodeID);
    }
    if (action.name === "get_upstream_nodes" || action.name === "get_downstream_nodes" || action.name === "get_connected_nodes") {
      const nodeID = stringValue("nodeId");
      if (!getNode(nodeID)) return missingNode(nodeID);
      const upstreamIDs = connectionsRef.current.filter((connection) => connection.to_node_id === nodeID).map((connection) => connection.from_node_id);
      const downstreamIDs = connectionsRef.current.filter((connection) => connection.from_node_id === nodeID).map((connection) => connection.to_node_id);
      const upstream = nodesRef.current.filter((node) => upstreamIDs.includes(node.id)).map(summarizeCanvasAgentNode);
      const downstream = nodesRef.current.filter((node) => downstreamIDs.includes(node.id)).map(summarizeCanvasAgentNode);
      if (action.name === "get_upstream_nodes") return { ok: true, nodes: upstream };
      if (action.name === "get_downstream_nodes") return { ok: true, nodes: downstream };
      return { ok: true, upstream, downstream };
    }
    if (action.name === "get_generation_task" || action.name === "get_media_task_status") {
      const nodeID = stringValue("nodeId");
      const node = getNode(nodeID);
      if (!node) return missingNode(nodeID);
      if (!(["image", "panorama", "video", "audio"] as CanvasNode["type"][]).includes(node.type)) return { ok: false, code: "not_media_node", message: `节点 ${nodeID} 不是媒体节点` };
      return { ok: true, ...summarizeCanvasAgentTask(node) };
    }
    if (action.name === "create_primary_script_node" || action.name === "create_text_node") {
      const sourceNodeIDs = stringValues("sourceNodeIds");
      const missing = missingNodeID(sourceNodeIDs);
      if (missing) return missingNode(missing);
      const sourceNodes = sourceNodeIDs.map((nodeID) => getNode(nodeID)!);
      const size = action.name === "create_primary_script_node" ? CANVAS_AGENT_PRIMARY_SCRIPT_NODE_SIZE : CANVAS_NODE_DEFAULT_SIZE.text;
      const point = sourcePosition(sourceNodes, size);
      const content = stringValue("content");
      const node: CanvasNode = { id: `text-${randomID()}`, type: "text", ...point, ...size, font_size: 14, scale_x: 1, scale_y: 1, title: stringValue("title") || content.slice(0, 32) || "文字", prompt: content, generation_status: "success", created_at: createdAt() };
      const createdConnections = sourceNodeIDs.map((sourceNodeID): CanvasConnection => ({ id: `connection-${randomID()}`, from_node_id: sourceNodeID, to_node_id: node.id }));
      replaceNodes([...nodesRef.current, node]);
      replaceConnections([...connectionsRef.current, ...createdConnections]);
      selectOnly(node.id);
      if (action.name === "create_primary_script_node" && autoTitlePending) {
        const projectTitle = stringValue("projectTitle");
        if (projectTitle) {
          titleRef.current = projectTitle;
          setTitle(projectTitle);
        }
        documentRef.current = { ...documentRef.current, agent_auto_title_pending: false };
      }
      pushHistory();
      return { ok: true, nodeId: node.id, connectionIds: createdConnections.map((connection) => connection.id), node: summarizeCanvasAgentNode(node) };
    }
    if (action.name === "update_text_node") {
      const nodeID = stringValue("nodeId");
      const node = getNode(nodeID);
      if (!node) return missingNode(nodeID);
      if (node.type !== "text") return { ok: false, code: "invalid_node_type", message: "只能用 update_text_node 修改文本节点" };
      const titleValue = stringValue("title");
      const content = stringValue("content");
      const nextNodes = nodesRef.current.map((item) => item.id === nodeID ? { ...item, ...(titleValue ? { title: titleValue } : {}), ...(content ? { prompt: content, generation_status: "success" as const, generation_error: "" } : {}) } : item);
      replaceNodes(nextNodes); pushHistory();
      return { ok: true, nodeId: nodeID, node: summarizeCanvasAgentNode(nextNodes.find((item) => item.id === nodeID)!) };
    }
    if (action.name === "update_node") {
      const nodeID = stringValue("nodeId");
      if (!getNode(nodeID)) return missingNode(nodeID);
      const nextNodes = nodesRef.current.map((node) => node.id === nodeID ? { ...node, title: stringValue("title") || node.title } : node);
      replaceNodes(nextNodes); pushHistory();
      return { ok: true, nodeId: nodeID, node: summarizeCanvasAgentNode(nextNodes.find((node) => node.id === nodeID)!) };
    }
    if (action.name === "delete_node") {
      const nodeID = stringValue("nodeId");
      if (!getNode(nodeID)) return missingNode(nodeID);
      const before = nodesRef.current.map((node) => node.id);
      removeNodes(new Set([nodeID]));
      const remaining = new Set(nodesRef.current.map((node) => node.id));
      return { ok: true, deletedNodeIds: before.filter((id) => !remaining.has(id)) };
    }
    if (action.name === "create_connection") {
      const fromNodeID = stringValue("fromNodeId");
      const toNodeID = stringValue("toNodeId");
      const fromNode = getNode(fromNodeID);
      const toNode = getNode(toNodeID);
      if (!fromNode) return missingNode(fromNodeID);
      if (!toNode) return missingNode(toNodeID);
      if (fromNodeID === toNodeID) return { ok: false, code: "self_connection", message: "节点不能连接到自身" };
      if (fromNode.type === "config" && toNode.type === "config") return { ok: false, code: "invalid_connection", message: "配置节点之间不能连接" };
      const existing = connectionsRef.current.find((connection) => connection.from_node_id === fromNodeID && connection.to_node_id === toNodeID);
      if (existing) return { ok: true, connectionId: existing.id, alreadyExists: true };
      const connection: CanvasConnection = { id: `connection-${randomID()}`, from_node_id: fromNodeID, to_node_id: toNodeID };
      replaceConnections([...connectionsRef.current, connection]); pushHistory();
      return { ok: true, connectionId: connection.id };
    }
    if (action.name === "delete_connection") {
      const connectionID = stringValue("connectionId");
      if (!connectionsRef.current.some((connection) => connection.id === connectionID)) return { ok: false, code: "connection_not_found", message: `找不到连线 ${connectionID}` };
      replaceConnections(connectionsRef.current.filter((connection) => connection.id !== connectionID)); pushHistory();
      return { ok: true, deletedConnectionId: connectionID };
    }
    if (action.name === "create_group") {
      const nodeIDs = stringValues("nodeIds");
      const missing = missingNodeID(nodeIDs);
      if (missing) return missingNode(missing);
      const groupID = createGroupFromSelection(nodeIDs, stringValue("title") || "组");
      if (!groupID) return { ok: false, code: "invalid_group", message: "分组至少需要两个未分组的普通节点" };
      return { ok: true, groupId: groupID, nodeIds: nodeIDs };
    }
    if (action.name === "arrange_nodes") {
      const requestedIDs = stringValues("nodeIds");
      const missing = missingNodeID(requestedIDs);
      if (missing) return missingNode(missing);
      const arranged = arrangeCanvasAgentNodes(nodesRef.current, requestedIDs);
      replaceNodes(arranged.nodes); pushHistory();
      return { ok: true, arrangedNodeIds: arranged.arrangedNodeIDs };
    }
    if (action.name === "generate_image" || action.name === "edit_image" || action.name === "generate_video" || action.name === "generate_audio") {
      const sourceNodeIDs = canvasAgentSourceNodeIDs(args, messageReferenceNodeIDs);
      const missing = missingNodeID(sourceNodeIDs);
      if (missing) return missingNode(missing);
      const sourceNodes = sourceNodeIDs.map((nodeID) => getNode(nodeID)!);
      if (action.name === "edit_image" && !sourceNodes.some((node) => (node.type === "image" || node.type === "panorama") && Boolean(node.url))) return { ok: false, code: "image_reference_required", message: "图片编辑需要至少一个已有内容的图片节点" };
      const type: "image" | "video" | "audio" = action.name === "generate_video" ? "video" : action.name === "generate_audio" ? "audio" : "image";
      const generationModel = type === "video"
        ? videoModel || imageGenerationPreferences.default_video_model
        : type === "audio"
          ? audioModel
          : imageModel || imageGenerationPreferences.default_image_model;
      const relayTokenName = type === "video" ? videoRelayTokenName : type === "audio" ? audioRelayTokenName : imageRelayTokenName;
      if (!generationModel || !relayTokenName.trim()) return { ok: false, code: "model_not_configured", message: `请先在个人中心完成${type === "video" ? "视频" : type === "audio" ? "音频" : "图片"}模型和密钥配置` };
      let videoSeconds: number | undefined;
      let videoGenerateAudio: boolean | undefined;
      if (type === "video") {
        const generation = getCanvasAgentContext({ phase: "intake", approvedNodeIds: [], referenceNodeIds: [], pendingTaskIds: [], completedTaskIds: [] }).generation;
        videoSeconds = typeof args.seconds === "number" ? args.seconds : generation.videoSeconds;
        const durationError = validateCanvasAgentVideoSeconds(generationModel, videoSeconds);
        if (durationError) return { ok: false, code: "unsupported_duration", message: durationError, supported: canvasAgentVideoDurationHint(generationModel) };
        videoGenerateAudio = typeof args.generateAudio === "boolean" ? args.generateAudio : generation.videoGenerateAudio;
        if (videoGenerateAudio && !canvasAgentVideoSupportsAudio(generationModel)) return { ok: false, code: "video_audio_not_supported", message: "当前全局视频模型不支持视频原生声音" };
      }
      const size = CANVAS_NODE_DEFAULT_SIZE[type];
      const layoutSourceNodes = canvasAgentMediaLayoutSources(type, nodesRef.current, sourceNodes);
      const point = sourcePosition(layoutSourceNodes, size);
      const prompt = stringValue("prompt");
      const titleValue = stringValue("title") || prompt.slice(0, 32) || canvasNodeFallbackTitle(type);
      let node: CanvasNode;
      if (type === "image") {
        node = { id: `image-${randomID()}`, type, ...point, ...size, scale_x: 1, scale_y: 1, title: titleValue, prompt, exclude_upstream_text: true, ...preferredCanvasImageParameters(), generation_model: generationModel, ...(resolvedAgentConfig.imageQuality ? { generation_quality: resolvedAgentConfig.imageQuality as CanvasNode["generation_quality"] } : {}), ...(stringValue("size") || resolvedAgentConfig.imageSize ? { generation_size: stringValue("size") || resolvedAgentConfig.imageSize } : {}), generation_count: typeof args.count === "number" ? Math.max(1, Math.min(15, Math.floor(args.count))) : imageGenerationPreferences.canvas_default_image_count, created_at: createdAt() };
      } else if (type === "video") {
        node = { ...buildVideoNode({ title: titleValue, prompt }, point), exclude_upstream_text: true, generation_video_model: generationModel, ...(stringValue("size") || resolvedAgentConfig.videoSize ? { generation_video_size: stringValue("size") || resolvedAgentConfig.videoSize } : {}), ...(resolvedAgentConfig.videoQuality ? { generation_video_resolution: resolvedAgentConfig.videoQuality } : {}), generation_video_seconds: videoSeconds, generation_video_audio: videoGenerateAudio };
      } else {
        const cloneNodeID = sourceNodes.find((source) => source.type === "audio" && source.url)?.id || "";
        node = { id: `audio-${randomID()}`, type, ...point, ...size, scale_x: 1, scale_y: 1, title: titleValue, prompt, exclude_upstream_text: true, generation_audio_model: generationModel, ...canvasAgentAudioNodeParameters(generationModel, stringValue("voice") || imageGenerationPreferences.default_audio_voice, stringValue("instructions") || imageGenerationPreferences.audio_instructions, cloneNodeID, { format: imageGenerationPreferences.default_audio_format, speed: imageGenerationPreferences.default_audio_speed }), created_at: createdAt() };
      }
      const createdConnections = sourceNodeIDs.map((sourceNodeID): CanvasConnection => ({ id: `connection-${randomID()}`, from_node_id: sourceNodeID, to_node_id: node.id }));
      const allNodes = [...nodesRef.current, node];
      replaceNodes(allNodes);
      replaceConnections([...connectionsRef.current, ...createdConnections]);
      selectOnly(node.id);
      pushHistory();
      await runGeneration(node.id, prompt, false, type === "image" ? { resultTitle: titleValue, resultCount: typeof args.count === "number" ? args.count : undefined, selectResultNode: true, concurrent: true } : { concurrent: true });
      const generated = getNode(node.id) || node;
      const createdNodeIDs = [
        node.id,
        ...connectionsRef.current.filter((connection) => connection.from_node_id === node.id).map((connection) => connection.to_node_id),
      ].filter((nodeID, index, values) => values.indexOf(nodeID) === index && Boolean(getNode(nodeID)));
      const connectionIDs = createdConnections.map((connection) => connection.id);
      const status = generated.generation_status || "idle";
      const result = { nodeId: generated.id, createdNodeIds: createdNodeIDs, connectionIds: connectionIDs, ...summarizeCanvasAgentTask(generated) };
      if (status === "error") return { ok: false, code: "generation_failed", message: generated.generation_error || "生成失败", ...result };
      return { ok: true, ...result };
    }
    return { ok: false, code: "unsupported_tool", message: `未实现工具 ${action.name}` };
    } catch (error) {
      return { ok: false, code: "tool_error", message: error instanceof Error ? error.message : "画布工具执行失败" };
    }
  }

  function addConfigNodeAt(point: { x: number; y: number }) {
    const node: CanvasNode = {
      id: `config-${randomID()}`,
      type: "config",
      x: point.x,
      y: point.y,
      width: CANVAS_NODE_DEFAULT_SIZE.config.width,
      height: 240,
      scale_x: 1,
      scale_y: 1,
      title: "生成配置",
      prompt: "",
      ...preferredCanvasImageParameters(),
      generation_mode: "image",
      generation_model: imageModel,
      created_at: createdAt(),
    };
    addNode(node);
    setPanelNodeID(node.id);
  }

  function buildImageNode(image: { url: string; storageKey?: string; thumbnailURL?: string; title?: string; prompt?: string; width?: number; height?: number; bytes?: number; taskID?: string }, point: { x: number; y: number }, parent?: CanvasNode | null): CanvasNode {
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
      bytes: image.bytes,
      free_resize: false,
      scale_x: 1,
      scale_y: 1,
      url: image.url,
		storage_key: image.storageKey,
      thumbnail_url: image.thumbnailURL || "",
      title: image.title || "图片",
      prompt: image.prompt || "",
      task_id: image.taskID || "",
      ...canvasImageParameters(parent),
      created_at: createdAt(),
    };
  }

  function buildVideoNode(video: { url?: string; title?: string; prompt?: string; taskID?: string }, point: { x: number; y: number }, parent?: CanvasNode | null): CanvasNode {
    return {
      id: `video-${randomID()}`,
      type: "video",
      x: point.x,
      y: point.y,
      width: 420,
      height: 236,
      scale_x: 1,
      scale_y: 1,
      url: video.url || "",
      title: video.title || "视频",
      prompt: video.prompt || "",
      task_id: video.taskID || "",
      ...canvasVideoParameters(parent || ({ generation_video_model: videoModel } as CanvasNode)),
      created_at: createdAt(),
    };
  }

  function addImageNode(image: { url: string; thumbnailURL?: string; title?: string; prompt?: string; width?: number; height?: number; bytes?: number; taskID?: string }, options: { x?: number; y?: number; parentID?: string; centered?: boolean } = {}) {
    if (!image.url) return;
    const parent = options.parentID ? nodesRef.current.find((node) => node.id === options.parentID) : null;
    const hasPosition = options.x !== undefined && options.y !== undefined;
    const anchor = hasPosition ? { x: options.x!, y: options.y! } : parent ? placement(options.parentID) : canvasCenterPosition();
    const node = buildImageNode(image, anchor, parent);
    const centered = options.centered || (!hasPosition && !parent);
    addNode(centered ? { ...node, ...canvasCenteredNodePosition(anchor, node.width, node.height) } : node, options.parentID || "");
    setPanelNodeID(node.id);
  }

  function requestNodeMediaUpload(nodeID: string) {
    if (uploadingNodeID) return;
    const target = nodesRef.current.find((node) => node.id === nodeID);
    if (target?.type !== "image" && target?.type !== "panorama" && target?.type !== "video" && target?.type !== "audio") return;
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
    if (isCanvasAudioFile(file)) {
      await uploadAudioFile(file, nodeID, position || undefined);
      return;
    }
    if (file.type.startsWith("video/") || /\.(mp4|mov)$/i.test(file.name)) {
      await uploadVideoFile(file, nodeID, position || undefined);
      return;
    }
    await uploadImageFile(file, nodeID, position || undefined);
  }

  async function uploadVideoFile(file: File, nodeID = "", position?: { x: number; y: number }) {
    if (uploadingNodeID) return toast.error("已有素材正在上传");
    const validationError = canvasVideoFileError(file);
    if (validationError) return toast.error(validationError);
    const initialTarget = nodeID ? nodesRef.current.find((node) => node.id === nodeID && node.type === "video") : null;
    if (nodeID && !initialTarget) return toast.error("只能在视频节点中替换视频文件");
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setUploadingNodeID(nodeID || "canvas-upload");
    try {
      const [uploaded, metadata] = await Promise.all([uploadMediaBlob(file, file.name), videoFileMetadata(file)]);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch) return;
      const target = nodeID ? nodesRef.current.find((node) => node.id === nodeID && node.type === "video") : null;
      if (nodeID && !target) return;
      const size = canvasVideoDisplaySize(metadata.width, metadata.height);
      let selectedID = nodeID;
      if (target) {
        replaceNodes(nodesRef.current.map((node): CanvasNode => node.id === target.id ? {
          ...node,
          x: node.x + node.width / 2 - size.width / 2,
          y: node.y + node.height / 2 - size.height / 2,
          ...size,
          url: uploaded.url,
			storage_key: uploaded.storageKey,
          title: file.name,
          natural_width: metadata.width,
          natural_height: metadata.height,
			bytes: uploaded.bytes || file.size,
          duration_ms: metadata.durationMS,
			mime_type: uploaded.mimeType || file.type || "video/mp4",
          task_id: "",
          generation_status: "success",
          generation_error: "",
        } : node));
      } else {
        selectedID = `video-${randomID()}`;
        const center = position || canvasCenterPosition();
        replaceNodes([...nodesRef.current, {
          ...buildVideoNode({ url: uploaded.url, title: file.name }, {
            x: center.x - size.width / 2,
            y: center.y - size.height / 2,
          }),
          id: selectedID,
			storage_key: uploaded.storageKey,
          ...size,
          natural_width: metadata.width,
          natural_height: metadata.height,
			bytes: uploaded.bytes || file.size,
          duration_ms: metadata.durationMS,
			mime_type: uploaded.mimeType || file.type || "video/mp4",
          generation_status: "success",
        }]);
      }
      setSelectedNodeIDs(new Set([selectedID]));
      setSelectedConnectionID("");
      setPanelNodeID(selectedID);
      pushHistory();
      toast.success(target ? "视频已替换" : "视频已添加到画布");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "视频上传失败");
    } finally {
      setUploadingNodeID("");
    }
  }

  async function uploadAudioFile(file: File, nodeID = "", position?: { x: number; y: number }) {
    if (uploadingNodeID) return toast.error("已有素材正在上传");
    if (!isCanvasAudioFile(file)) return toast.error("请选择音频文件");
    const initialTarget = nodeID ? nodesRef.current.find((node) => node.id === nodeID && node.type === "audio") : null;
    if (nodeID && !initialTarget) return toast.error("只能在音频节点中替换音频文件");
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setUploadingNodeID(nodeID || "canvas-upload");
    try {
      const [uploaded, durationMS] = await Promise.all([uploadMediaBlob(file, file.name), audioFileDuration(file)]);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch) return;
      const target = nodeID ? nodesRef.current.find((node) => node.id === nodeID && node.type === "audio") : null;
      if (nodeID && !target) return;
      const spec = CANVAS_NODE_DEFAULT_SIZE.audio;
		const mimeType = uploaded.mimeType || (file.name.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg");
      let selectedID = nodeID;
      if (target) {
        replaceNodes(nodesRef.current.map((node): CanvasNode => node.id === target.id ? {
          ...node,
          x: node.x + node.width / 2 - spec.width / 2,
          y: node.y + node.height / 2 - spec.height / 2,
          ...spec,
          url: uploaded.url,
			storage_key: uploaded.storageKey,
          title: file.name,
			bytes: uploaded.bytes || file.size,
          duration_ms: durationMS,
          mime_type: mimeType,
          task_id: "",
          audio_task_id: "",
          audio_task_result_id: "",
          generation_status: "success",
          generation_error: "",
        } : node));
      } else {
        selectedID = `audio-${randomID()}`;
        const center = position || canvasCenterPosition();
        replaceNodes([...nodesRef.current, {
          id: selectedID,
          type: "audio",
          x: center.x - spec.width / 2,
          y: center.y - spec.height / 2,
          ...spec,
          scale_x: 1,
          scale_y: 1,
          url: uploaded.url,
			storage_key: uploaded.storageKey,
          title: file.name,
          prompt: "",
			bytes: uploaded.bytes || file.size,
          duration_ms: durationMS,
          mime_type: mimeType,
          ...preferredCanvasAudioParameters(),
          generation_status: "success",
          created_at: createdAt(),
        }]);
      }
      setSelectedNodeIDs(new Set([selectedID]));
      setSelectedConnectionID("");
      setPanelNodeID(selectedID);
      pushHistory();
      toast.success(target ? "音频已替换" : "音频已添加到画布");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "音频上传失败");
    } finally {
      setUploadingNodeID("");
    }
  }

  async function uploadImageFile(file: File, nodeID = "", position?: { x: number; y: number }) {
    if (uploadingNodeID) return toast.error("已有图片正在上传");
    if (!file.type.startsWith("image/")) return toast.error("请选择图片文件");
    const initialTarget = nodeID ? nodesRef.current.find((node) => node.id === nodeID && (node.type === "image" || node.type === "panorama")) : null;
    if (nodeID && !initialTarget) return;
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setUploadingNodeID(nodeID || "canvas-upload");
    try {
      const [uploaded, sourceSize] = await Promise.all([uploadImage(file), imageFileSize(file)]);
      await primeAuthenticatedImageCache(uploaded.url, file);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch) {
        void refreshLibrary();
        return;
      }
      const target = nodeID ? nodesRef.current.find((node) => node.id === nodeID && (node.type === "image" || node.type === "panorama")) : null;
      if (nodeID && !target) return;
      const size = fitImageNodeSize(sourceSize.width, sourceSize.height);
      const uploadedImageParameters = preferredCanvasImageParameters();
      let selectedID = nodeID;
      if (target) {
        const isPanorama = target.type === "panorama";
        const batchReplacement = detachCanvasBatchRootForReplacement(nodesRef.current, connectionsRef.current, target.id);
        const replacedBatchChildIDs = batchReplacement.removedNodeIDs;
        const replacementSize = isPanorama ? PANORAMA_NODE_SIZE : size;
        const replacementFrame = isPanorama ? {
          x: target.x + target.width / 2 - replacementSize.width / 2,
          y: target.y + target.height / 2 - replacementSize.height / 2,
          ...replacementSize,
        } : canvasImageReplacementFrame(target, replacementSize.width, replacementSize.height);
        const nextTarget = {
          ...target,
          type: isPanorama ? "panorama" as const : "image" as const,
          ...replacementFrame,
          natural_width: sourceSize.width,
          natural_height: sourceSize.height,
          bytes: file.size,
			storage_key: uploaded.storageKey,
          mime_type: uploaded.mimeType || file.type || "image/png",
          free_resize: false,
          url: uploaded.url,
          thumbnail_url: "",
          title: isPanorama ? target.title : canvasImageTitle(file.name),
          task_id: "",
          generation_model: isPanorama ? target.generation_model : undefined,
          generation_size: isPanorama ? PANORAMA_IMAGE_SIZE : uploadedImageParameters.generation_size,
          generation_quality: isPanorama ? target.generation_quality : uploadedImageParameters.generation_quality,
          generation_count: isPanorama ? target.generation_count : uploadedImageParameters.generation_count,
          generation_type: undefined,
          generation_reference_urls: undefined,
          generation_status: "success" as const,
          generation_error: "",
          panorama_final_prompt: undefined,
          panorama_projection: undefined,
          ...(isPanorama ? {} : uploadedImageParameters),
          ...(replacedBatchChildIDs.size ? { batch_child_ids: undefined, batch_primary_id: undefined, batch_expanded: undefined } : {}),
        };
        replaceNodes(batchReplacement.nodes
          .map((node) => {
            if (node.id === nodeID) return nextTarget;
            if (target.batch_root_id && node.id === target.batch_root_id && node.batch_primary_id === target.id) {
				return { ...node, url: uploaded.url, storage_key: uploaded.storageKey, thumbnail_url: "", width: replacementSize.width, height: replacementSize.height, natural_width: sourceSize.width, natural_height: sourceSize.height, bytes: file.size, mime_type: uploaded.mimeType || file.type || "image/png", free_resize: false };
            }
            return node;
        }));
        if (replacedBatchChildIDs.size) replaceConnections(batchReplacement.connections);
      } else {
        const center = position || { x: 0, y: 0 };
        if (isStrictPanoramaSize(sourceSize.width, sourceSize.height)) {
          setPendingPanoramaImport({
            url: uploaded.url,
			storageKey: uploaded.storageKey,
            fileName: file.name,
            width: sourceSize.width,
            height: sourceSize.height,
            bytes: file.size,
			mimeType: uploaded.mimeType || file.type || "image/png",
            position: center,
          });
          await refreshLibrary();
          return;
        }
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
          bytes: file.size,
			storage_key: uploaded.storageKey,
			mime_type: uploaded.mimeType || file.type || "image/png",
          scale_x: 1,
          scale_y: 1,
          url: uploaded.url,
          title: canvasImageTitle(file.name),
          prompt: "",
          ...preferredCanvasImageParameters(),
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

  function finishPanoramaImport(type: "image" | "panorama") {
    const imported = pendingPanoramaImport;
    if (!imported) return;
    const size = type === "panorama" ? PANORAMA_NODE_SIZE : fitImageNodeSize(imported.width, imported.height);
    const nodeID = `${type}-${randomID()}`;
    const node: CanvasNode = {
      id: nodeID,
      type,
      x: imported.position.x - size.width / 2,
      y: imported.position.y - size.height / 2,
      ...size,
      natural_width: imported.width,
      natural_height: imported.height,
      bytes: imported.bytes,
      mime_type: imported.mimeType || "image/png",
      free_resize: false,
      scale_x: 1,
      scale_y: 1,
      url: imported.url,
		storage_key: imported.storageKey,
      title: canvasImageTitle(imported.fileName),
      prompt: "",
      ...preferredCanvasImageParameters(),
      ...(type === "panorama" ? {
        generation_size: PANORAMA_IMAGE_SIZE,
        panorama_projection: "equirectangular" as const,
      } : {}),
      created_at: createdAt(),
    };
    setPendingPanoramaImport(null);
    replaceNodes([...nodesRef.current, node]);
    setSelectedNodeIDs(new Set([nodeID]));
    setSelectedConnectionID("");
    setPanelNodeID(nodeID);
    pushHistory();
    toast.success(type === "panorama" ? "全景图已导入" : "图片已上传到画布");
  }

  function createPendingNode(type: "text" | "image" | "video" | "audio" | "panorama" | "director" | "config") {
    if (!pendingConnection) return;
    const size = CANVAS_NODE_DEFAULT_SIZE[type];
    const node: CanvasNode = { id: `${type}-${randomID()}`, type, x: pendingConnection.position.x - size.width / 2, y: pendingConnection.position.y - size.height / 2, ...size, ...(type === "text" ? { font_size: 14 } : {}), scale_x: 1, scale_y: 1, title: canvasNodeFallbackTitle(type), prompt: "", ...(type === "image" || type === "panorama" || type === "config" ? preferredCanvasImageParameters() : type === "video" ? canvasVideoParameters() : type === "audio" ? preferredCanvasAudioParameters() : {}), ...(type === "config" ? { generation_mode: "image" as const, generation_model: imageModel } : {}), ...(type === "panorama" ? { generation_size: "2:1" } : {}), created_at: createdAt() };
    const connection = resolveCanvasConnection(pendingConnection, node.id, [...nodesRef.current, node]);
    if (!connection || !canConnect(connection.sourceID, connection.targetID)) {
      return toast.error("该节点不能与生成配置节点连接");
    }
    replaceNodes([...nodesRef.current, node]);
    setSelectedNodeIDs(new Set([node.id]));
    connectNodes(connection.sourceID, connection.targetID);
    setPanelNodeID(node.id);
    setPendingConnection(null);
  }

  function removeNodes(ids: Set<string>) {
    if (!ids.size) return;
    const removedIDs = expandCanvasBatchNodeIDs(ids, nodesRef.current);
    setAgentSessions((current) => {
      const next = clearCanvasAgentSessionReferences(current, removedIDs);
      documentRef.current = { ...documentRef.current, agent_sessions: next };
      return next;
    });
    const generationHistoryBase = removedIDs.has(runningNodeID) || removedIDs.has(runningResultNodeID)
      ? interruptActiveGeneration()
      : null;
    replaceNodes(detachCanvasNodesFromRemovedGroups(reconcileCanvasBatchesAfterRemoval(nodesRef.current, removedIDs), removedIDs));
    replaceConnections(connectionsRef.current.filter((connection) => !removedIDs.has(connection.from_node_id) && !removedIDs.has(connection.to_node_id)));
    if (panelNodeID && removedIDs.has(panelNodeID)) setPanelNodeID("");
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
    const source = nodesRef.current.find((node) => node.id === nodeID);
    if (!source) return;
    const id = `${source.type}-${randomID()}`;
    const duplicated: CanvasNode = {
      ...source,
      id,
      title: `${source.title || canvasNodeFallbackTitle(source.type)} Copy`,
      x: source.x + 36,
      y: source.y + 36,
      created_at: createdAt(),
    };
    replaceNodes([...nodesRef.current, duplicated]);
    setSelectedNodeIDs(new Set([id]));
    setSelectedConnectionID("");
    setPanelNodeID(duplicated.type !== "text" ? id : "");
    pushHistory();
  }

  function generateFromTextNode(nodeID: string) {
    const source = nodesRef.current.find((node) => node.id === nodeID && node.type === "text");
    if (!source) return;
    const text = (source.prompt || "").trim();
    if (!text) return toast.error("请先在右侧栏生成文字内容");
    const node: CanvasNode = {
      id: `config-${randomID()}`,
      type: "config",
      x: source.x + source.width + 96,
      y: source.y + source.height / 2 - 120,
      ...CANVAS_NODE_DEFAULT_SIZE.config,
      scale_x: 1,
      scale_y: 1,
      title: "生成配置",
      prompt: "",
      ...preferredCanvasImageParameters(),
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
    const node = nodesRef.current.find((item) => item.id === nodeID);
    const prompt = String(node?.type === "panorama" ? node.panorama_source_prompt || node.prompt : node?.prompt || "").trim();
    if (!prompt) return toast.error("当前节点没有提示词");
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success("提示词已复制");
    } catch {
      toast.error("复制提示词失败");
    }
  }

  async function saveCanvasNodeAsset(nodeID: string) {
    const node = nodesRef.current.find((item) => item.id === nodeID);
    if (!node) return;
    const kind = node.type === "panorama" ? "image" : node.type;
    if (kind !== "text" && kind !== "image" && kind !== "video" && kind !== "audio") return toast.error("该节点不能保存为素材");
    const content = node.prompt?.trim() || "";
    const url = node.url?.trim() || "";
    if (kind === "text" ? !content : !url) return toast.error("当前节点没有可保存的内容");
    try {
      let assets = loadMyAssets(session.key);
      try {
        assets = mergeMyAssets(await fetchMyAssets(), assets);
      } catch {
        // Keep local asset saving available during a temporary sync outage.
      }
      const duplicate = assets.some((asset) => asset.kind === kind && (kind === "text" ? asset.content === content : asset.url === url));
      if (duplicate) return toast.info("该内容已在我的素材中");
      const asset = createMyAsset({
        kind,
        title: node.title?.trim() || canvasNodeFallbackTitle(node.type),
        ...(kind === "text" ? { content } : { url }),
        ...(kind === "image" ? { coverUrl: url, width: node.natural_width, height: node.natural_height } : {}),
        ...(node.storage_key ? { storageKey: node.storage_key } : {}),
        ...(node.mime_type ? { mimeType: node.mime_type } : {}),
        ...(node.bytes !== undefined ? { bytes: node.bytes } : {}),
        ...(node.duration_ms !== undefined ? { durationMs: node.duration_ms } : {}),
        tags: [],
        visibility: "private",
        source: "无限画布",
        metadata: { projectId: documentRef.current.id, nodeId: node.id, nodeType: node.type, prompt: node.prompt || "" },
      });
      const next = [asset, ...assets];
      saveMyAssets(session.key, next);
      try {
        saveMyAssets(session.key, await syncMyAssets(next));
        toast.success("已保存到我的素材");
      } catch (error) {
        toast.error(error instanceof Error ? `已保存到本地，云端同步失败：${error.message}` : "已保存到本地，云端同步失败");
      }
    } catch (error) {
      toast.error(error instanceof Error ? `保存素材失败：${error.message}` : "保存素材失败");
    }
  }

  function createImageReversePromptNodes(nodeID: string) {
    const source = nodesRef.current.find((node) => node.id === nodeID && (node.type === "image" || node.type === "panorama") && node.url);
    if (!source) return toast.error("图片节点为空，无法反推提示词");
    const gap = 96;
    const textSize = CANVAS_NODE_DEFAULT_SIZE.text;
    const configSize = CANVAS_NODE_DEFAULT_SIZE.config;
    const centerY = source.y + source.height / 2;
    const textNode: CanvasNode = {
      id: `text-${randomID()}`,
      type: "text",
      x: source.x + source.width + gap,
      y: centerY - textSize.height / 2,
      ...textSize,
      font_size: 14,
      scale_x: 1,
      scale_y: 1,
      title: "反推提示词",
      prompt: IMAGE_PROMPT_REVERSE_PRESET,
      generation_status: "success",
      created_at: createdAt(),
    };
    const configNode: CanvasNode = {
      id: `config-${randomID()}`,
      type: "config",
      x: textNode.x + textNode.width + gap,
      y: centerY - configSize.height / 2,
      ...configSize,
      scale_x: 1,
      scale_y: 1,
      title: "反推提示词配置",
      prompt: "",
      composer_content: `参考图片：@[node:${source.id}]\n任务说明：@[node:${textNode.id}]`,
      ...preferredCanvasImageParameters(),
      generation_mode: "text",
      generation_text_model: textModel,
      generation_count: 1,
      created_at: createdAt(),
    };
    replaceNodes([...nodesRef.current, textNode, configNode]);
    replaceConnections([
      ...connectionsRef.current,
      { id: `connection-${randomID()}`, from_node_id: source.id, to_node_id: configNode.id },
      { id: `connection-${randomID()}`, from_node_id: textNode.id, to_node_id: configNode.id },
    ]);
    setSelectedNodeIDs(new Set([configNode.id]));
    setSelectedConnectionID("");
    setPanelNodeID(configNode.id);
    pushHistory();
  }

  async function downloadNodeImage(nodeID: string) {
    const node = nodesRef.current.find((item) => item.id === nodeID && (item.type === "image" || item.type === "panorama" || item.type === "video" || item.type === "audio"));
    if (!node?.url) return;
    try {
      const blob = await fetchAuthenticatedImageBlob(node.url);
      const objectURL = URL.createObjectURL(blob);
      const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg") || node.generation_output_format || (node.type === "video" ? "mp4" : node.type === "audio" ? "mp3" : "png");
      const rawTitle = (node.title || `${node.type}-${node.id}`).replace(/[\\/:*?"<>|]/g, "-");
      const fileName = /\.[a-z0-9]{2,5}$/i.test(rawTitle) ? rawTitle : `${rawTitle}.${extension}`;
      const link = document.createElement("a");
      link.href = objectURL;
      link.download = fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "文件下载失败");
    }
  }

  async function openCanvasImageTool(nodeID: string, kind: CanvasImageToolState["kind"]) {
    const node = nodesRef.current.find((item) => item.id === nodeID && (item.type === "image" || item.type === "panorama") && item.url);
    if (!node?.url || imageToolBusy) return;
    setImageToolBusy(true);
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    try {
      const blob = await fetchAuthenticatedImageBlob(node.url);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch || !nodesRef.current.some((item) => item.id === nodeID)) return;
      if (kind === "mask") setMaskEditModel(node.generation_model?.trim() || imageModel.trim());
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
    setMaskEditModel("");
  }

  async function uploadDerivedCanvasImage(dataURL: string, fileName: string) {
    const file = await canvasDataURLFile(dataURL, fileName);
    const [uploaded, dimensions] = await Promise.all([uploadImage(file), imageFileSize(file)]);
    await primeAuthenticatedImageCache(uploaded.url, file);
    return { uploaded, dimensions, bytes: file.size };
  }

  function handleDirectorProjectChange(project: Record<string, unknown>) {
    if (!openDirectorNodeID) return;
    replaceNodes(nodesRef.current.map((node) => node.id === openDirectorNodeID && node.type === "director"
      ? { ...node, director_project: project }
      : node));
    scheduleSave();
  }

  function handleDirectorPanoramaRemoved({ edgeId, sourceNodeId }: Pick<CanvasDirectorPanorama, "edgeId" | "sourceNodeId">) {
    if (!openDirectorNodeID) return;
    const exists = connectionsRef.current.some((connection) =>
      connection.id === edgeId
      && connection.from_node_id === sourceNodeId
      && connection.to_node_id === openDirectorNodeID,
    );
    if (!exists) return;
    replaceConnections(connectionsRef.current.filter((connection) => connection.id !== edgeId));
    pushHistory();
  }

  async function handleDirectorCapturesSent(directorNodeID: string, captures: CanvasDirectorCapture[]) {
    const director = nodesRef.current.find((node) => node.id === directorNodeID && node.type === "director");
    if (!director || !captures.length) return;
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    const toastID = toast.loading(captures.length > 1 ? `正在发送 ${captures.length} 张截图到画布` : "正在发送截图到画布");
    try {
      const uploaded = await Promise.all(captures.map((capture) =>
        uploadDerivedCanvasImage(capture.dataUrl, capture.fileName),
      ));
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch) return;
      const currentDirector = nodesRef.current.find((node) => node.id === directorNodeID && node.type === "director");
      if (!currentDirector) return;
      let y = getNextDirectorOutputY(currentDirector, nodesRef.current, connectionsRef.current);
      const imageNodes = uploaded.map((result, index) => {
        const node = buildImageNode({
          url: result.uploaded.url,
			storageKey: result.uploaded.storageKey,
          title: captures[index].fileName,
          width: result.dimensions.width,
          height: result.dimensions.height,
          bytes: result.bytes,
        }, { x: currentDirector.x + currentDirector.width + 96, y });
		node.mime_type = result.uploaded.mimeType || "image/png";
        y += node.height + 36;
        return node;
      });
      replaceNodes([...nodesRef.current, ...imageNodes]);
      replaceConnections([
        ...connectionsRef.current,
        ...imageNodes.map((node) => ({
          id: `connection-${randomID()}`,
          from_node_id: directorNodeID,
          to_node_id: node.id,
        })),
      ]);
      setSelectedNodeIDs(new Set(imageNodes.map((node) => node.id)));
      setSelectedConnectionID("");
      pushHistory();
      void refreshLibrary();
      toast.success(captures.length > 1 ? `已发送 ${captures.length} 张截图到画布` : "截图已发送到画布");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "截图发送到画布失败");
    } finally {
      toast.dismiss(toastID);
    }
  }

  async function handleDirectorVideoSent(directorNodeID: string, output: CanvasDirectorVideo) {
    const director = nodesRef.current.find((node) => node.id === directorNodeID && node.type === "director");
    if (!director) return;
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    const toastID = toast.loading("正在发送导演台视频到画布");
    try {
      const file = new File([output.blob], output.fileName, { type: output.blob.type || "video/mp4" });
      const uploaded = await uploadMediaBlob(file, output.fileName);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch) return;
      const currentDirector = nodesRef.current.find((node) => node.id === directorNodeID && node.type === "director");
      if (!currentDirector) return;
      const existingOutputBottom = getNextDirectorOutputY(currentDirector, nodesRef.current, connectionsRef.current);
      const width = uploaded.width || output.width;
      const height = uploaded.height || output.height;
      const size = fitDirectorVideoNodeSize(width, height);
      const node = {
        ...buildVideoNode({ url: uploaded.url, title: output.fileName }, {
          x: currentDirector.x + currentDirector.width + 96,
          y: existingOutputBottom,
        }),
        storage_key: uploaded.storageKey,
        width: size.width,
        height: size.height,
        natural_width: width,
        natural_height: height,
        bytes: uploaded.bytes || file.size,
        mime_type: uploaded.mimeType || file.type,
        duration_ms: uploaded.durationMs || Math.round(output.durationSeconds * 1000),
      };
      replaceNodes([...nodesRef.current, node]);
      replaceConnections([...connectionsRef.current, {
        id: `connection-${randomID()}`,
        from_node_id: directorNodeID,
        to_node_id: node.id,
      }]);
      setSelectedNodeIDs(new Set([node.id]));
      setSelectedConnectionID("");
      setPanelNodeID(node.id);
      pushHistory();
      toast.success("导演台视频已发送到画布");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "视频发送到画布失败");
    } finally {
      toast.dismiss(toastID);
    }
  }

  async function cropCanvasNode(crop: CanvasImageCropRect) {
    if (!imageTool || imageTool.kind !== "crop" || imageToolBusy) return;
    const source = nodesRef.current.find((node) => node.id === imageTool.nodeID && (node.type === "image" || node.type === "panorama"));
    if (!source) return closeCanvasImageTool();
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setImageToolBusy(true);
    try {
      const result = await uploadDerivedCanvasImage(await cropCanvasImage(imageTool.sourceURL, crop), `canvas-crop-${source.id}.png`);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch || !nodesRef.current.some((node) => node.id === source.id)) return;
      const size = canvasCroppedNodeSize(source.width, result.dimensions.width, result.dimensions.height);
      const child = {
		...buildImageNode({ url: result.uploaded.url, storageKey: result.uploaded.storageKey, title: `${source.title || "图片"} 裁剪`, prompt: source.prompt, width: result.dimensions.width, height: result.dimensions.height, bytes: result.bytes }, { x: source.x + source.width + 96, y: source.y }, source),
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
    const source = nodesRef.current.find((node) => node.id === imageTool.nodeID && (node.type === "image" || node.type === "panorama"));
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
		...buildImageNode({ url: piece.uploaded.url, storageKey: piece.uploaded.storageKey, title: `${source.title || "图片"} ${piece.row + 1}-${piece.column + 1}`, prompt: source.prompt, width: piece.dimensions.width, height: piece.dimensions.height, bytes: piece.bytes }, { x: source.x + source.width + 96 + piece.column * (cellWidth + gap), y: source.y + piece.row * (cellHeight + gap) }, source),
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
    const source = nodesRef.current.find((node) => node.id === imageTool.nodeID && (node.type === "image" || node.type === "panorama"));
    if (!source) return closeCanvasImageTool();
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setImageToolBusy(true);
    try {
      const result = await uploadDerivedCanvasImage(await upscaleCanvasImage(imageTool.sourceURL, params), `canvas-upscale-${source.id}.png`);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch || !nodesRef.current.some((node) => node.id === source.id)) return;
		const child = buildImageNode({ url: result.uploaded.url, storageKey: result.uploaded.storageKey, title: `${source.title || "图片"} 放大`, prompt: source.prompt, width: result.dimensions.width, height: result.dimensions.height, bytes: result.bytes }, { x: source.x + source.width + 96, y: source.y }, source);
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
    const source = nodesRef.current.find((node) => node.id === nodeID && (node.type === "image" || node.type === "panorama"));
    if (!source) return closeCanvasImageTool();
    setImageTool(null);
    setMaskEditModel("");
    setPanelNodeID(nodeID);
    const prompt = `参考图中蓝色高亮覆盖区域是需要修改的位置，蓝色只是编辑标记，不要保留在最终图像中。只修改蓝色高亮区域，其他区域的构图、人物、文字、光影和风格保持不变。修改要求：${payload.prompt.trim()}`;
    void runGeneration(nodeID, prompt, false, {
      resultTitle: payload.prompt.slice(0, 32) || "局部编辑结果",
      generationModel: payload.model,
      referenceImageDataURLs: [payload.markedDataURL],
      forceImageGeneration: true,
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
    void runGeneration(nodeID, canvasImageAnglePrompt(params), false, { forceImageGeneration: true, resultTitle: canvasImageAngleLabel(params), resultCount: 1, selectResultNode: true });
  }

  async function copySelected() {
    const copiedIDs = expandCanvasGroupNodeIDs(selectedNodeIDs, nodesRef.current);
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
        addNode({ id: `text-${randomID()}`, type: "text", x: center.x - 170, y: center.y - 120, width: 340, height: 240, font_size: 14, scale_x: 1, scale_y: 1, title: text.split(/\r?\n/, 1)[0].slice(0, 32) || "文字", prompt: text, created_at: createdAt() });
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
    setPanelNodeID(pastedNodes[0]?.type !== "text" && pastedNodes[0]?.type !== "group" ? pastedNodes[0].id : "");
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
    showImageInfoRef.current = Boolean(next.show_image_info);
    setTitle(next.title);
    setBackground(next.background);
    setShowImageInfo(showImageInfoRef.current);
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
    const serverTaskIDs = new Set([...submittedTaskIDsRef.current, ...(serverTaskID ? [serverTaskID] : [])]);
    const taskID = serverTaskID || pendingTaskIDRef.current;
    if (taskID) cancelledTaskIDsRef.current.add(taskID);
    generationEpochRef.current += 1;
    generationAbortControllerRef.current?.abort();
    generationAbortControllerRef.current = null;
    pendingTaskIDRef.current = "";
    submittedTaskIDRef.current = "";
    submittedTaskIDsRef.current.clear();
    replaceNodes(restoreInterruptedCanvasGenerations(nodesRef.current));
    setStopConfirmationOpen(false);
    setRunningNodeID("");
    setRunningResultNodeID("");
    setRunningControlNodeID("");
    setRunningTaskID("");
    setCancellingTaskID("");
    serverTaskIDs.forEach((submittedID) => {
      void cancelCreationTask(submittedID).catch((error) => toast.error(error instanceof Error ? `本地已停止，服务端停止失败：${error.message}` : "本地已停止，服务端停止失败"));
    });
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
        const request = input.action === "rename" || input.action === "delete"
          ? { ...input, revision: documentRef.current.revision }
          : input;
        const response = await updateCanvasProject(request);
        applyWorkspace(response);
        if (changesActiveProject && response.active_project_id) navigate(canvasProjectPath(response.active_project_id));
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

  function confirmCanvasProjectDialog(value?: string) {
    const dialog = projectDialog;
    setProjectDialog(null);
    if (!dialog) return;
    if (dialog.mode === "create") {
      if (value?.trim()) void runProject({ action: "create", title: value.trim() });
    } else if (dialog.mode === "rename") {
      if (value?.trim() && value.trim() !== title) void runProject({ action: "rename", project_id: documentRef.current.id, title: value.trim() });
    } else {
      void runProject({ action: "delete", project_id: documentRef.current.id });
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
    throw new CanvasTaskPollingTimeoutError("任务处理时间过长，请稍后在任务队列中查看结果");
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
    const nextNodes = nodesRef.current.map((node) => canvasGenerationRecoveryTaskID(node) === taskID && node.generation_status === "loading"
      ? { ...node, generation_status: "error" as const, generation_error: message }
      : node);
    replaceNodes(nextNodes);
    scheduleSave();
  }

  function markCanvasTaskRecoveryPending(taskID: string, projectID: string, operationEpoch: number, signal: AbortSignal) {
    if (!isCurrentCanvasRecovery(projectID, operationEpoch, signal)) return;
    replaceNodes(markCanvasGenerationRecoveryPending(nodesRef.current, taskID));
    scheduleSave();
  }

  async function recoverCanvasTasks(projectID: string, operationEpoch: number, taskIDs: string[], signal: AbortSignal) {
    let response: Awaited<ReturnType<typeof fetchCreationTasks>>;
    try {
      response = await fetchCreationTasks(taskIDs, { signal });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        if (isRetryableTaskPollError(error)) {
          taskIDs.forEach((taskID) => markCanvasTaskRecoveryPending(taskID, projectID, operationEpoch, signal));
        } else {
          const message = error instanceof Error ? error.message : "无法读取任务状态";
          taskIDs.forEach((taskID) => markCanvasTaskRecoveryError(taskID, message, projectID, operationEpoch, signal));
        }
      }
      return;
    }
    if (!isCurrentCanvasRecovery(projectID, operationEpoch, signal)) return;
    const tasksByID = new Map(response.items.map((task) => [task.id, task]));
    response.missing_ids.forEach((taskID) => markCanvasTaskRecoveryError(taskID, "任务记录不存在，无法恢复生成结果", projectID, operationEpoch, signal));
    await Promise.all(taskIDs.map(async (taskID) => {
      const task = tasksByID.get(taskID);
      if (!task) return;
      try {
        const recoveredTask = task.status === "success" || task.status === "error" || task.status === "cancelled"
          ? await persistCreationTaskOutputs(task)
          : task;
        const progress = applyRecoveredCanvasTask(recoveredTask, projectID, operationEpoch, signal);
        if (progress.terminal) return;
        const completedTask = await waitForTask(taskID, (nextTask) => {
          applyRecoveredCanvasTask(nextTask, projectID, operationEpoch, signal);
        }, signal);
        applyRecoveredCanvasTask(await persistCreationTaskOutputs(completedTask), projectID, operationEpoch, signal);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          if (error instanceof CanvasTaskPollingTimeoutError || isRetryableTaskPollError(error)) {
            markCanvasTaskRecoveryPending(taskID, projectID, operationEpoch, signal);
          } else {
            markCanvasTaskRecoveryError(taskID, error instanceof Error ? error.message : "恢复任务失败", projectID, operationEpoch, signal);
          }
        }
      }
    }));
  }

  async function stopGeneration() {
    if (!runningNodeID || cancellingTaskID) return;
    const serverTaskID = submittedTaskIDRef.current || runningTaskID;
    const serverTaskIDs = new Set([...submittedTaskIDsRef.current, ...(serverTaskID ? [serverTaskID] : [])]);
    const taskID = serverTaskID || pendingTaskIDRef.current;
    serverTaskIDs.forEach((submittedID) => cancelledTaskIDsRef.current.add(submittedID));
    if (taskID) cancelledTaskIDsRef.current.add(taskID);
    setCancellingTaskID(taskID || "pending");
    generationAbortControllerRef.current?.abort();
    try {
      await Promise.all([...serverTaskIDs].map((submittedID) => cancelCreationTask(submittedID)));
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

  async function runTextGeneration(nodeID: string, retry = false) {
    const requestedNode = nodesRef.current.find((node) => node.id === nodeID && (node.type === "text" || node.type === "config" && node.generation_mode === "text"));
    if (!requestedNode || runningNodeID) return;
    const retrying = requestedNode.type === "text" && retry && requestedNode.generation_status === "error";
    const retryConfiguration = retrying ? findCanvasRetryConfigurationNode(requestedNode.id, nodesRef.current, connectionsRef.current) : null;
    const sourceNode = retryConfiguration || requestedNode;
    const plan = canvasTextGenerationPlan(requestedNode);
    const sourcePrompt = retrying
      ? retryConfiguration?.composer_content ?? retryConfiguration?.prompt ?? requestedNode.composer_content ?? requestedNode.prompt ?? ""
      : plan.requestPrompt;
    const context = buildCanvasGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourcePrompt);
    if (!context.prompt.trim() && !context.referenceImageURLs.length) return toast.error("请填写文本指令或连接有效输入");
    if (!textRelayTokenName.trim()) { setRelayTokenDialogKind("text"); return; }
    const model = sourceNode.generation_text_model?.trim() || textModel;
    if (!model) return toast.error("没有可用的文本模型");
    const resultIDs = retrying ? [requestedNode.id] : plan.createsChildNodes ? Array.from({ length: plan.count }, () => `text-${randomID()}`) : [requestedNode.id];
    const childIDs = retrying ? [] : plan.createsChildNodes ? resultIDs : [];
    const clientTaskIDs = new Map(resultIDs.map((resultID) => [resultID, `canvas-text-${randomID()}`]));
    const controller = new AbortController();
    const generationStartedAt = Date.now();
    const historyBase = appendCanvasHistorySnapshot(historyRef.current, cloneDocument(captureDocument()), MAX_HISTORY);
    historyRef.current = historyBase;
    const childSize = CANVAS_NODE_DEFAULT_SIZE.text;
    const childNodes = childIDs.map((resultID, index): CanvasNode => ({
      id: resultID,
      type: "text",
      x: sourceNode.x + sourceNode.width + 96,
      y: sourceNode.y + sourceNode.height / 2 - childSize.height / 2 + (index - (plan.count - 1) / 2) * (childSize.height + 36),
      ...childSize,
      font_size: 14,
      scale_x: 1,
      scale_y: 1,
      title: context.prompt.slice(0, 32) || "生成文本",
      prompt: "",
      composer_content: context.prompt,
      generation_text_model: model,
      generation_status: "loading",
      generation_started_at: generationStartedAt,
      generation_progress: 0,
      task_id: clientTaskIDs.get(resultID),
      created_at: createdAt(),
    }));
    replaceNodes([
      ...nodesRef.current.map((node) => {
        if (retrying && node.id === requestedNode.id) return { ...node, prompt: "", composer_content: context.prompt, generation_text_model: model, task_id: clientTaskIDs.get(requestedNode.id), generation_status: "loading" as const, generation_started_at: generationStartedAt, generation_progress: 0, generation_error: "" };
        if (node.id !== sourceNode.id) return node;
        if (sourceNode.type === "config") return { ...node, task_id: clientTaskIDs.get(resultIDs[0] || ""), generation_status: "loading" as const, generation_started_at: generationStartedAt, generation_progress: 0, generation_error: "" };
        if (!plan.createsChildNodes) return { ...node, composer_content: context.prompt, generation_text_model: model, task_id: clientTaskIDs.get(sourceNode.id), generation_status: "loading" as const, generation_started_at: generationStartedAt, generation_progress: 0, generation_error: "" };
        return node;
      }),
      ...childNodes,
    ]);
    replaceConnections([
      ...connectionsRef.current,
      ...childIDs.map((resultID): CanvasConnection => ({ id: `connection-${randomID()}`, from_node_id: sourceNode.id, to_node_id: resultID })),
    ]);
    setRunningNodeID(retrying ? requestedNode.id : sourceNode.id);
    setRunningResultNodeID(resultIDs[0] || "");
    setRunningControlNodeID(retrying ? requestedNode.id : sourceNode.id);
    generationAbortControllerRef.current = controller;
    try {
      const messages = await canvasTextGenerationMessages(context.prompt.trim(), context.referenceImageURLs, controller.signal);
      const outcomes = await Promise.all(resultIDs.map(async (resultID) => {
        const clientTaskID = clientTaskIDs.get(resultID) || `canvas-text-${randomID()}`;
        try {
          const submitted = await createChatGenerationTask({ clientTaskId: clientTaskID, prompt: context.prompt.trim(), model, messages, relayTokenName: textRelayTokenName, requestOptions: { signal: controller.signal } });
          const serverTaskID = submitted.id || clientTaskID;
          submittedTaskIDsRef.current.add(serverTaskID);
          if (!submittedTaskIDRef.current) {
            submittedTaskIDRef.current = serverTaskID;
            pendingTaskIDRef.current = serverTaskID;
            setRunningTaskID(serverTaskID);
          }
          replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, task_id: serverTaskID } : node));
          if (!retrying && resultID === resultIDs[0] && sourceNode.type === "config") replaceNodes(nodesRef.current.map((node) => node.id === sourceNode.id ? { ...node, task_id: serverTaskID } : node));
          const completed = await waitForTask(serverTaskID, (task) => {
            const streamed = (task.data || []).map((item) => String(item.text_response || "")).join("\n").trim();
            if (streamed) replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, prompt: streamed } : node));
          }, controller.signal);
          const content = (completed.data || []).map((item) => String(item.text_response || "")).join("\n").trim();
          if (!content) throw new Error(completed.error || "文本任务完成但没有返回内容");
          replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, prompt: content, composer_content: context.prompt, generation_status: "success", generation_progress: 100, generation_error: "", task_id: completed.id || serverTaskID } : node));
          return true;
        } catch (error) {
          if (controller.signal.aborted) return false;
          const message = error instanceof Error ? error.message : "文本生成失败";
          replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, generation_status: "error", generation_error: message } : node));
          return false;
        }
      }));
      const succeeded = outcomes.filter(Boolean).length;
      if (!retrying && sourceNode.type === "config") replaceNodes(nodesRef.current.map((node) => node.id === sourceNode.id ? { ...node, generation_status: succeeded ? "success" : "error", generation_error: succeeded ? "" : "全部文本任务生成失败" } : node));
      commitGenerationHistory(historyBase);
      if (!succeeded) toast.error("全部文本任务生成失败");
      else if (succeeded < outcomes.length) toast.error(`已生成 ${succeeded} 个文本，${outcomes.length - succeeded} 个失败`);
      else toast.success(`已生成 ${succeeded} 个文本节点`);
    } catch (error) {
      if (controller.signal.aborted) {
        replaceNodes(nodesRef.current.map((node) => resultIDs.includes(node.id) || !retrying && node.id === sourceNode.id && sourceNode.type === "config"
          ? { ...node, generation_status: node.generation_status === "loading" ? "idle" as const : node.generation_status, generation_error: "" }
          : node));
        commitGenerationHistory(historyBase);
      } else {
        const message = error instanceof Error ? error.message : "文本生成失败";
        replaceNodes(nodesRef.current.map((node) => resultIDs.includes(node.id) || !retrying && node.id === sourceNode.id && sourceNode.type === "config" ? { ...node, generation_status: "error", generation_error: message } : node));
        commitGenerationHistory(historyBase);
        toast.error(message);
      }
    } finally {
      if (generationAbortControllerRef.current === controller) generationAbortControllerRef.current = null;
      submittedTaskIDsRef.current.forEach((submittedID) => cancelledTaskIDsRef.current.delete(submittedID));
      submittedTaskIDsRef.current.clear();
      pendingTaskIDRef.current = "";
      submittedTaskIDRef.current = "";
      setRunningNodeID(""); setRunningResultNodeID(""); setRunningControlNodeID(""); setRunningTaskID("");
    }
  }

  async function runAudioGeneration(nodeID: string, concurrent = false, retry = false) {
    const requestedNode = nodesRef.current.find((node) => node.id === nodeID && (node.type === "audio" || node.type === "config" && node.generation_mode === "audio"));
    if (!requestedNode || runningNodeID && !concurrent) return;
    const retrying = requestedNode.type === "audio" && retry && requestedNode.generation_status === "error";
    const retryConfiguration = retrying ? findCanvasRetryConfigurationNode(requestedNode.id, nodesRef.current, connectionsRef.current) : null;
    const sourceNode = retryConfiguration || requestedNode;
    const contextPrompt = retryConfiguration?.composer_content ?? retryConfiguration?.prompt ?? requestedNode.composer_content ?? requestedNode.prompt ?? "";
    const generationContext = buildCanvasGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, contextPrompt);
    const text = generationContext.prompt.trim();
    if (!text) return toast.error("请填写音频内容或连接文本节点");
    const relayTokenName = audioRelayTokenName;
    if (!relayTokenName.trim()) { setRelayTokenDialogKind("audio"); return; }
    const taskID = `canvas-audio-${randomID()}`;
    const controller = new AbortController();
    const generationStartedAt = Date.now();
    const createsResult = !retrying && (requestedNode.type === "config" || Boolean(requestedNode.url));
    const resultID = createsResult ? `audio-${randomID()}` : requestedNode.id;
    const generationAudioModel = sourceNode.generation_audio_model || audioModel;
    const settingsSource: CanvasNode = {
      ...canvasAgentAudioNodeParameters(generationAudioModel, imageGenerationPreferences.default_audio_voice, imageGenerationPreferences.audio_instructions, "", { format: imageGenerationPreferences.default_audio_format, speed: imageGenerationPreferences.default_audio_speed }),
      ...sourceNode,
      generation_audio_model: generationAudioModel,
      generation_audio_instructions: sourceNode.generation_audio_instructions ?? imageGenerationPreferences.audio_instructions,
    };
    const resultNode: CanvasNode = createsResult ? {
      id: resultID,
      type: "audio",
      x: requestedNode.x + requestedNode.width + 96,
      y: requestedNode.y + (requestedNode.height - CANVAS_NODE_DEFAULT_SIZE.audio.height) / 2,
      ...CANVAS_NODE_DEFAULT_SIZE.audio,
      scale_x: 1,
      scale_y: 1,
      title: text.slice(0, 32) || "音频",
      prompt: text,
      ...canvasAudioSettings(settingsSource),
      generation_status: "loading",
      generation_started_at: generationStartedAt,
      generation_progress: 0,
      task_id: taskID,
      audio_task_id: taskID,
      audio_task_result_id: undefined,
      created_at: createdAt(),
    } : { ...(retrying ? requestedNode : settingsSource), ...canvasAudioSettings(settingsSource), prompt: text, generation_status: "loading", generation_started_at: generationStartedAt, generation_progress: 0, generation_error: "", task_id: taskID, audio_task_id: taskID, audio_task_result_id: undefined };
    const historyBase = concurrent ? historyRef.current : appendCanvasHistorySnapshot(historyRef.current, cloneDocument(captureDocument()), MAX_HISTORY);
    if (!concurrent) historyRef.current = historyBase;
    const finishHistory = () => concurrent ? scheduleSave() : commitGenerationHistory(historyBase);
    replaceNodes(createsResult
      ? [...nodesRef.current.map((node) => node.id === requestedNode.id && requestedNode.type === "config" ? { ...node, generation_status: "success" as const, generation_error: "" } : node), resultNode]
      : nodesRef.current.map((node) => node.id === requestedNode.id ? resultNode : node));
    if (createsResult) replaceConnections([...connectionsRef.current, { id: `connection-${randomID()}`, from_node_id: requestedNode.id, to_node_id: resultID }]);
    setPanelNodeID(resultID);
    if (!concurrent) {
      setRunningNodeID(requestedNode.id); setRunningResultNodeID(resultID); setRunningControlNodeID(requestedNode.id); generationAbortControllerRef.current = controller;
      pendingTaskIDRef.current = taskID;
      submittedTaskIDRef.current = "";
    }
    try {
      const references = canvasAudioGenerationReferences(sourceNode.id, nodesRef.current, connectionsRef.current, generationContext.referenceAudioURLs);
      let cloneDataURL: string | undefined;
      if (canvasAudioProvider(resultNode.generation_audio_model || "") === "mimo-clone") {
        const selectedID = resultNode.generation_audio_mimo_voice_clone_node_id || (references.length === 1 ? references[0].nodeID : "");
        const selectedReference = references.find((reference) => reference.nodeID === selectedID);
        if (!selectedReference) {
          if (!references.length) throw new Error("请连接参考音频节点");
          throw new Error("已连接多个音频节点，请在音频设置中选择参考音频");
        }
        cloneDataURL = await canvasAudioCloneDataURL(selectedReference, controller.signal);
        replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, generation_audio_mimo_voice_clone_node_id: selectedReference.nodeID } : node));
      }
      const request = buildCanvasAudioGenerationRequest(resultNode, text, cloneDataURL);
      const submitted = await createAudioGenerationTask({ clientTaskId: taskID, request, relayTokenName, requestOptions: { signal: controller.signal } });
      const serverTaskID = submitted.id || taskID;
      if (!concurrent) {
        pendingTaskIDRef.current = serverTaskID;
        submittedTaskIDRef.current = serverTaskID;
        submittedTaskIDsRef.current.add(serverTaskID);
        setRunningTaskID(serverTaskID);
      }
      replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, task_id: serverTaskID, audio_task_id: serverTaskID } : node));
      const completed = await persistCreationTaskOutputs(await waitForTask(serverTaskID, undefined, controller.signal));
      const item = completed.data?.find((entry) => entry.audio_url || entry.url);
      const url = String(item?.audio_url || item?.url || "").trim();
      if (!url) throw new Error(completed.error || "音频任务完成但没有返回音频地址");
      replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, url, storage_key: item?.storageKey || item?.storage_key, mime_type: item?.mime_type || `audio/${canvasAudioResponseFormat(resultNode) === "mp3" ? "mpeg" : canvasAudioResponseFormat(resultNode)}`, bytes: item?.bytes, duration_ms: Date.now() - generationStartedAt, generation_status: "success", generation_progress: 100, generation_error: "", task_id: completed.id || serverTaskID, audio_task_id: completed.id || serverTaskID, audio_task_result_id: completed.id || serverTaskID } : node));
      finishHistory(); toast.success("已添加音频到画布");
    } catch (error) {
      if (controller.signal.aborted) {
        replaceNodes(nodesRef.current.map((node) => node.id === resultID && node.generation_status === "loading" || node.id === requestedNode.id && requestedNode.type === "config" ? { ...node, duration_ms: node.id === resultID ? Date.now() - generationStartedAt : node.duration_ms, generation_status: "idle", generation_error: "" } : node));
        finishHistory();
      } else {
        const message = error instanceof Error ? error.message : "音频生成失败";
        replaceNodes(nodesRef.current.map((node) => node.id === resultID || node.id === requestedNode.id && requestedNode.type === "config" ? { ...node, duration_ms: node.id === resultID ? Date.now() - generationStartedAt : node.duration_ms, generation_status: "error", generation_error: message } : node));
        finishHistory(); toast.error(message);
      }
    } finally {
      if (!concurrent) {
        if (generationAbortControllerRef.current === controller) generationAbortControllerRef.current = null;
        submittedTaskIDsRef.current.forEach((submittedID) => cancelledTaskIDsRef.current.delete(submittedID));
        submittedTaskIDsRef.current.clear();
        pendingTaskIDRef.current = "";
        submittedTaskIDRef.current = "";
        setRunningNodeID(""); setRunningResultNodeID(""); setRunningControlNodeID(""); setRunningTaskID("");
      }
    }
  }

  async function runPanoramaGeneration(nodeID: string, retry = false) {
    const sourceNode = nodesRef.current.find((node) => node.id === nodeID && node.type === "panorama");
    if (!sourceNode || runningNodeID) return;
    if (!imageRelayTokenName.trim()) { setRelayTokenDialogKind("image"); return; }
    const retrying = retry && sourceNode.generation_status === "error";
    const sourcePrompt = String(sourceNode.panorama_source_prompt || sourceNode.prompt || "").trim();
    const context = retrying ? null : buildCanvasGenerationContext(nodeID, nodesRef.current, connectionsRef.current, sourcePrompt);
    const effectivePrompt = context?.prompt.trim() || "";
    const generationModel = sourceNode.generation_model?.trim() || imageModel.trim();
    const referenceLimit = imageReferenceImageLimit(generationModel);
    const referenceImageURLs = (retrying
      ? panoramaRetryReferenceURLs(sourceNode.generation_type, sourceNode.generation_reference_urls)
      : Array.from(new Set([
        ...(sourceNode.url ? [sourceNode.url] : []),
        ...(context?.referenceImageURLs || []),
      ]))).slice(0, referenceLimit + 1);
    const prompt = retrying
      ? panoramaRetryPrompt(sourceNode.panorama_final_prompt)
      : buildPanoramaPrompt(effectivePrompt, referenceImageURLs.length > 0);
    if (retrying && !prompt) return toast.error("找不到全景图最终提示词，无法重试");
    if (retrying && sourceNode.generation_type === "edit" && !referenceImageURLs.length) return toast.error("参考图片已丢失，无法继续重试");
    if (!retrying && !effectivePrompt && !referenceImageURLs.length) return toast.error("请描述全景环境或连接参考图片");
    if (referenceImageURLs.length && !supportsImageEditing(generationModel)) return toast.error(`模型 ${generationModel} 暂不支持参考图编辑`);
    const referenceLimitMessage = imageConversationReferenceLimitMessage(0, referenceImageURLs.length, referenceLimit);
    if (referenceLimitMessage) return toast.error(referenceLimitMessage);

    const parameters = canvasImageParameters(sourceNode);
    const count = retrying ? 1 : panoramaGenerationCount(parameters.generation_count);
    const requestedQuality = panoramaGenerationQuality(parameters.generation_quality);
    const quality = requestedQuality as NonNullable<CanvasNode["generation_quality"]>;
    const structuredParameters = supportsStructuredImageParameters(generationModel);
    const resolution = structuredParameters && parameters.generation_resolution && parameters.generation_resolution !== "auto" && supportsImageResolution(generationModel, parameters.generation_resolution)
      ? parameters.generation_resolution
      : undefined;
    const outputFormat = supportsImageOutputControls(generationModel) ? parameters.generation_output_format : undefined;
    const outputCompression = outputFormat ? parameters.generation_output_compression : undefined;
    const stream = supportsImageStreaming(generationModel) && Boolean(parameters.generation_stream);
    const partialImages = stream ? parameters.generation_partial_images : 0;
    const sourceHasImage = !retrying && Boolean(sourceNode.url);
    const rootID = retrying ? sourceNode.id : sourceHasImage ? `panorama-${randomID()}` : sourceNode.id;
    const childIDs = count > 1 ? Array.from({ length: count }, () => `panorama-${randomID()}`) : [];
    const targetIDs = childIDs.length ? childIDs : [rootID];
    const taskIDs = new Map(targetIDs.map((targetID) => [targetID, `canvas-panorama-${randomID()}`]));
    const generationStartedAt = Date.now();
    const rootNode: CanvasNode = {
      ...sourceNode,
      id: rootID,
      type: "panorama",
      x: sourceHasImage ? sourceNode.x + sourceNode.width + 96 : sourceNode.x,
      y: sourceHasImage ? sourceNode.y + sourceNode.height / 2 - PANORAMA_NODE_SIZE.height / 2 : sourceNode.y,
      width: sourceHasImage ? PANORAMA_NODE_SIZE.width : sourceNode.width || PANORAMA_NODE_SIZE.width,
      height: sourceHasImage ? PANORAMA_NODE_SIZE.height : sourceNode.height || PANORAMA_NODE_SIZE.height,
      url: sourceHasImage || retrying ? "" : sourceNode.url,
      natural_width: sourceHasImage || retrying ? undefined : sourceNode.natural_width,
      natural_height: sourceHasImage || retrying ? undefined : sourceNode.natural_height,
      mime_type: sourceHasImage || retrying ? undefined : sourceNode.mime_type,
      title: sourceNode.title || "全景图",
      prompt: sourcePrompt,
      panorama_source_prompt: sourcePrompt,
      panorama_final_prompt: prompt,
      panorama_projection: undefined,
      generation_model: generationModel,
      generation_size: PANORAMA_IMAGE_SIZE,
      generation_type: referenceImageURLs.length ? "edit" : "generation",
      generation_reference_urls: referenceImageURLs,
      generation_status: "loading",
      generation_started_at: generationStartedAt,
      generation_progress: 0,
      generation_error: "",
      task_id: taskIDs.get(targetIDs[0]) || "",
      ...(retrying ? {} : {
        batch_child_ids: childIDs.length ? childIDs : undefined,
        batch_primary_id: childIDs.length ? targetIDs[0] : undefined,
        batch_expanded: childIDs.length ? true : undefined,
      }),
      created_at: sourceHasImage ? createdAt() : sourceNode.created_at,
    };
    const childNodes = childIDs.map((childID, index): CanvasNode => ({
      ...rootNode,
      id: childID,
      ...PANORAMA_NODE_SIZE,
      x: rootNode.x + rootNode.width + 120 + (index % 2) * (PANORAMA_NODE_SIZE.width + 36),
      y: rootNode.y + Math.floor(index / 2) * (PANORAMA_NODE_SIZE.height + 36),
      url: "",
      natural_width: undefined,
      natural_height: undefined,
      task_id: taskIDs.get(childID) || "",
      batch_child_ids: undefined,
      batch_root_id: rootID,
      batch_primary_id: undefined,
      batch_expanded: undefined,
      created_at: createdAt(),
    }));
    const controller = new AbortController();
    const historyBase = appendCanvasHistorySnapshot(historyRef.current, cloneDocument(captureDocument()), MAX_HISTORY);
    historyRef.current = historyBase;
    const startedNodes = nodesRef.current.map((node) => {
      if (node.id !== nodeID) return node;
      return sourceHasImage ? { ...node, generation_status: "success" as const, generation_error: "" } : rootNode;
    });
    replaceNodes([...startedNodes, ...(sourceHasImage ? [rootNode] : []), ...childNodes]);
    if (!retrying && (sourceHasImage || childIDs.length)) replaceConnections([
      ...connectionsRef.current,
      ...(sourceHasImage ? [{ id: `connection-${randomID()}`, from_node_id: sourceNode.id, to_node_id: rootID }] : []),
      ...childIDs.map((childID): CanvasConnection => ({ id: `connection-${randomID()}`, from_node_id: rootID, to_node_id: childID })),
    ]);
    setSelectedNodeIDs(new Set([nodeID]));
    setSelectedConnectionID("");
    setPanelNodeID(nodeID);
    setRunningNodeID(nodeID); setRunningResultNodeID(rootID); setRunningControlNodeID(nodeID); generationAbortControllerRef.current = controller;
    try {
      const referenceFiles = referenceImageURLs.length ? await Promise.all(referenceImageURLs.map(async (url, index) => {
        const blob = await fetchAuthenticatedImageBlob(url, controller.signal);
        const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
        return new File([blob], `panorama-reference-${index + 1}.${extension}`, { type: blob.type || "image/png" });
      })) : [];
      const results = await Promise.all(targetIDs.map(async (targetID) => {
        const clientTaskID = taskIDs.get(targetID) || `canvas-panorama-${randomID()}`;
        try {
          const submitted = referenceFiles.length
            ? await createImageEditTask(clientTaskID, referenceFiles, prompt, generationModel || undefined, PANORAMA_IMAGE_SIZE, PANORAMA_IMAGE_SIZE, quality, 1, "private", resolution, outputFormat, outputCompression, stream, partialImages, { apiMode: imageGenerationPreferences.api_mode, responseFormatB64JSON: sourceNode.generation_response_format_b64_json }, undefined, imageRelayTokenName, undefined, undefined, { signal: controller.signal })
            : await createImageGenerationTask(clientTaskID, prompt, generationModel || undefined, PANORAMA_IMAGE_SIZE, PANORAMA_IMAGE_SIZE, quality, 1, "private", resolution, outputFormat, outputCompression, stream, partialImages, { apiMode: imageGenerationPreferences.api_mode, responseFormatB64JSON: sourceNode.generation_response_format_b64_json }, undefined, imageRelayTokenName, undefined, undefined, { signal: controller.signal });
          const serverTaskID = submitted.id || clientTaskID;
          submittedTaskIDsRef.current.add(serverTaskID);
          if (!submittedTaskIDRef.current) {
            submittedTaskIDRef.current = serverTaskID;
            pendingTaskIDRef.current = serverTaskID;
            setRunningTaskID(serverTaskID);
          }
          replaceNodes(nodesRef.current.map((node) => node.id === targetID ? { ...node, task_id: serverTaskID } : node));
          const completed = await persistCreationTaskOutputs(await waitForTask(serverTaskID, undefined, controller.signal));
          const result = summarizeCanvasTaskResult(completed, 1);
          const image = result.images[0];
          if (!image?.url) throw new Error(result.error || "全景图任务没有返回图片");
          let nextNodes = nodesRef.current.map((node): CanvasNode => {
            if (node.id === targetID) return {
              ...node,
              ...PANORAMA_NODE_SIZE,
              url: image.url,
			  storage_key: image.storageKey,
              natural_width: image.width || PANORAMA_NODE_SIZE.width,
              natural_height: image.height || PANORAMA_NODE_SIZE.height,
              bytes: image.bytes,
              mime_type: image.mimeType || "image/png",
              panorama_projection: "equirectangular",
              duration_ms: Date.now() - generationStartedAt,
              generation_status: "success",
              generation_progress: 100,
              generation_error: "",
              task_id: completed.id || serverTaskID,
            };
            if (node.id === rootID && targetID !== rootID && node.batch_primary_id === targetID) return {
              ...node,
              ...PANORAMA_NODE_SIZE,
              url: image.url,
			  storage_key: image.storageKey,
              natural_width: image.width || PANORAMA_NODE_SIZE.width,
              natural_height: image.height || PANORAMA_NODE_SIZE.height,
              bytes: image.bytes,
              mime_type: image.mimeType || "image/png",
              panorama_projection: "equirectangular",
              duration_ms: Date.now() - generationStartedAt,
              generation_status: "success",
              generation_progress: 100,
              generation_error: "",
              task_id: completed.id || serverTaskID,
              batch_primary_id: targetID,
            };
            return node;
          });
          if (retrying && sourceNode.batch_root_id) nextNodes = syncCanvasBatchRootAfterRetry(nextNodes, sourceNode.id);
          replaceNodes(nextNodes);
          return true;
        } catch (error) {
          if (controller.signal.aborted) return false;
          const message = error instanceof Error ? error.message : "全景图生成失败";
          replaceNodes(nodesRef.current.map((node) => node.id === targetID ? { ...node, duration_ms: Date.now() - generationStartedAt, generation_status: "error", generation_error: message } : node));
          return false;
        }
      }));
      if (controller.signal.aborted) {
        replaceNodes(nodesRef.current.map((node) => targetIDs.includes(node.id) && node.generation_status === "loading"
          ? { ...node, duration_ms: Date.now() - generationStartedAt, generation_status: "idle", generation_error: "" }
          : node));
        commitGenerationHistory(historyBase);
        return;
      }
      const successCount = results.filter(Boolean).length;
      if (!successCount) {
        replaceNodes(nodesRef.current.map((node) => node.id === rootID ? { ...node, duration_ms: Date.now() - generationStartedAt, generation_status: "error", generation_error: "全部全景图任务生成失败" } : node));
        throw new Error("全部全景图任务生成失败");
      }
      commitGenerationHistory(historyBase);
      if (successCount < results.length) toast.error(`已生成 ${successCount} 张全景图，${results.length - successCount} 张失败`);
      else toast.success(count > 1 ? `已生成 ${count} 张全景图` : "全景图已生成");
    } catch (error) {
      if (!controller.signal.aborted) { const message = error instanceof Error ? error.message : "全景图生成失败"; replaceNodes(nodesRef.current.map((node) => node.id === rootID ? { ...node, duration_ms: Date.now() - generationStartedAt, generation_status: "error", generation_error: message } : node)); commitGenerationHistory(historyBase); toast.error(message); }
    } finally {
      if (generationAbortControllerRef.current === controller) generationAbortControllerRef.current = null;
      pendingTaskIDRef.current = "";
      submittedTaskIDRef.current = "";
      submittedTaskIDsRef.current.clear();
      setRunningNodeID(""); setRunningResultNodeID(""); setRunningControlNodeID(""); setRunningTaskID("");
    }
  }

  async function runVideoGeneration(nodeID: string, prompt?: string, concurrent = false) {
    const sourceNode = nodesRef.current.find((node) => node.id === nodeID && (node.type === "video" || node.type === "config" && node.generation_mode === "video"));
    if (!sourceNode || runningNodeID && !concurrent) return;
    if (!videoRelayTokenName.trim()) {
      setRelayTokenDialogKind("video");
      return;
    }
			const context = buildCanvasGenerationContext(nodeID, nodesRef.current, connectionsRef.current, prompt ?? sourceNode.composer_content ?? sourceNode.prompt ?? "");
    const text = context.prompt.trim();
		const requestPrompt = applyCameraPrompt(text, sourceNode.camera_control);
    if (!text && !context.referenceImageURLs.length && !context.firstFrameURL && !context.lastFrameURL && !context.referenceVideoURLs.length && !context.referenceAudioURLs.length) return toast.error("请填写视频描述或连接参考素材");
			const params = canvasVideoParameters(sourceNode);
			const configuredVideoReferenceURLs = params.generation_video_reference_urls.filter((url) => url.trim());
			const configuredImageReferenceURLs = params.generation_video_reference_image_urls.filter((url) => url.trim());
			const configuredAudioReferenceURLs = params.generation_video_reference_audio_urls.filter((url) => url.trim());
			const frameReferencesEnabled = supportsVideoFrameReferences(params.generation_video_model);
			const videoImageReferences = canvasVideoGenerationReferences(context, configuredImageReferenceURLs, frameReferencesEnabled);
			const allImageReferenceURLs = videoImageReferences.referenceImageURLs;
			const referenceVideoURLs = Array.from(new Set([...configuredVideoReferenceURLs, ...context.referenceVideoURLs])).slice(0, 3);
			const referenceAudioURLs = Array.from(new Set([...configuredAudioReferenceURLs, ...context.referenceAudioURLs])).slice(0, 3);
			const firstFrameURL = videoImageReferences.firstFrameURL;
			const lastFrameURL = videoImageReferences.lastFrameURL;
			const multiPrompt = context.videoMultiPrompt.length ? context.videoMultiPrompt : params.generation_video_multi_prompt;
			const elementList = context.videoElementList.length ? context.videoElementList : params.generation_video_element_list;
		let referenceMode: "first-frame" | "reference" = params.generation_video_reference_mode === "reference" ? "reference" : "first-frame";
		const supportsMultimodalReferences = supportsVideoMultimodalReferences(params.generation_video_model);
		const multimodalLimits = videoMultimodalReferenceLimits(params.generation_video_model);
			if (!supportsMultimodalReferences) {
			// A stale canvas node can retain the multimodal mode after switching to
			// an image-to-video model. Image-only references are still valid as a
			// first frame; video/audio references are not.
			if (referenceVideoURLs.length > 0 && multimodalLimits.video === 0) {
				return toast.error(`模型 ${params.generation_video_model} 不支持视频参考，请选择支持视频参考的模型`);
			}
			if (referenceAudioURLs.length > 0 && multimodalLimits.audio === 0) {
				return toast.error(`模型 ${params.generation_video_model} 不支持音频参考，请选择支持音频参考的模型`);
			}
				referenceMode = "first-frame";
			} else if (referenceVideoURLs.length > 0 || referenceAudioURLs.length > 0) {
				referenceMode = "reference";
			}
			const configuredImageURLs = allImageReferenceURLs.slice(0, referenceMode === "reference" ? 9 : 1);
			if ([...configuredImageURLs, firstFrameURL, lastFrameURL, ...referenceVideoURLs, ...referenceAudioURLs].filter(Boolean).some((url) => {
			return !isPublicReferenceURL(url) && !isCanvasAccessibleReferenceURL(url);
		})) {
			return toast.error("参考素材 URL 必须是公网可访问的 http(s) 地址，或当前站点已上传的素材地址");
		}
			if (referenceMode === "reference" && configuredImageURLs.length + referenceVideoURLs.length + referenceAudioURLs.length === 0 && !firstFrameURL && !lastFrameURL) {
			return toast.error("多模态参考模式至少需要一个公网图片、视频或音频 URL");
		}
			if (videoRequiresReferenceImage(params.generation_video_model) && configuredImageURLs.length === 0 && !firstFrameURL) {
			return toast.error(`模型 ${params.generation_video_model} 仅支持图生视频，请连接一张参考图片`);
		}
    const taskID = `canvas-video-${randomID()}`;
    const controller = new AbortController();
    const generationStartedAt = Date.now();
    const createsResult = sourceNode.type === "config" || Boolean(sourceNode.url);
    const resultNodeID = createsResult ? `video-${randomID()}` : sourceNode.id;
    const videoNodeSize = canvasNodeSizeFromRatio(params.generation_video_size, CANVAS_NODE_DEFAULT_SIZE.video.width, CANVAS_NODE_DEFAULT_SIZE.video.height) || CANVAS_NODE_DEFAULT_SIZE.video;
    const resultNode = createsResult ? { ...buildVideoNode({ title: text.slice(0, 32) || "视频", prompt: text, taskID }, { x: sourceNode.x + sourceNode.width + 96, y: sourceNode.y + sourceNode.height / 2 - videoNodeSize.height / 2 }, sourceNode), ...videoNodeSize, id: resultNodeID, generation_status: "loading" as const, generation_started_at: generationStartedAt, generation_progress: 0, generation_model: params.generation_video_model, task_id: taskID, camera_control: sourceNode.camera_control } : { ...sourceNode, prompt: text, task_id: taskID, generation_status: "loading" as const, generation_started_at: generationStartedAt, generation_progress: 0, generation_model: params.generation_video_model };
    const historyBase = concurrent ? historyRef.current : appendCanvasHistorySnapshot(historyRef.current, cloneDocument(captureDocument()), MAX_HISTORY);
    if (!concurrent) historyRef.current = historyBase;
    const finishHistory = () => concurrent ? scheduleSave() : commitGenerationHistory(historyBase);
    replaceNodes(createsResult
      ? [...nodesRef.current.map((node) => node.id === sourceNode.id && node.type === "config" ? { ...node, generation_status: "success" as const, generation_error: "" } : node), resultNode]
      : nodesRef.current.map((node) => node.id === nodeID ? resultNode : node));
    if (createsResult) replaceConnections([...connectionsRef.current, { id: `connection-${randomID()}`, from_node_id: sourceNode.id, to_node_id: resultNodeID }]);
    setPanelNodeID(resultNodeID); setSelectedNodeIDs(new Set([resultNodeID]));
    if (!concurrent) {
      setRunningNodeID(nodeID); setRunningResultNodeID(resultNodeID); setRunningControlNodeID(nodeID); generationAbortControllerRef.current = controller;
      pendingTaskIDRef.current = taskID;
      submittedTaskIDRef.current = "";
    }
    try {
			// Provider reference fields must contain short public URLs. Convert same-origin
			// canvas assets through the dedicated reference upload endpoint instead of
			// embedding a Base64 data URL (which upstream URL validators reject).
				const referenceImageURLs = await Promise.all(
					configuredImageURLs.map((url) => preparePublicVideoImageReference(url, controller.signal)),
				);
				const preparedFirstFrameURL = firstFrameURL ? await preparePublicVideoImageReference(firstFrameURL, controller.signal) : undefined;
				const preparedLastFrameURL = lastFrameURL ? await preparePublicVideoImageReference(lastFrameURL, controller.signal) : undefined;
			const preparedReferenceVideoURLs = await Promise.all(
				referenceVideoURLs.map((url) => preparePublicVideoMediaReference(url, "video", controller.signal)),
			);
				const preparedReferenceAudioURLs = await Promise.all(
					referenceAudioURLs.map((url) => preparePublicVideoMediaReference(url, "audio", controller.signal)),
				);
				const preparedElementList = context.videoElementList.length
					? await prepareCanvasVideoElementList(elementList, controller.signal)
					: elementList;
				const normalizedVideo = normalizeVideoRequest({
				model: params.generation_video_model,
				size: params.generation_video_size,
				seconds: params.generation_video_seconds,
				resolution: params.generation_video_resolution,
				generateAudio: params.generation_video_audio,
				watermark: params.generation_video_watermark,
				videoMode: params.generation_video_mode,
				negativePrompt: params.generation_video_negative_prompt,
				multiShot: params.generation_video_multi_shot,
				shotType: params.generation_video_shot_type,
					multiPrompt,
					elementList: preparedElementList,
				characterOrientation: params.generation_video_character_orientation,
					referenceImageURLs,
					firstFrameURL: preparedFirstFrameURL,
					lastFrameURL: preparedLastFrameURL,
				referenceVideoURLs: preparedReferenceVideoURLs,
				referenceAudioURLs: preparedReferenceAudioURLs,
				referenceMode,
			});
				const submitted = await createVideoGenerationTask({
				clientTaskId: taskID,
					prompt: requestPrompt,
				model: params.generation_video_model,
				size: normalizedVideo.size || undefined,
				seconds: normalizedVideo.seconds,
				resolution: normalizedVideo.resolution || undefined,
				generateAudio: normalizedVideo.generateAudio,
				watermark: normalizedVideo.watermark,
				videoMode: params.generation_video_mode,
				negativePrompt: params.generation_video_negative_prompt,
				multiShot: params.generation_video_multi_shot,
				shotType: params.generation_video_shot_type,
					multiPrompt: normalizedVideo.multiPrompt,
					elementList: normalizedVideo.elementList,
				characterOrientation: params.generation_video_character_orientation,
					referenceImageURLs,
					firstFrameURL: normalizedVideo.firstFrameURL,
					lastFrameURL: normalizedVideo.lastFrameURL,
				referenceVideoURLs: preparedReferenceVideoURLs,
				referenceAudioURLs: preparedReferenceAudioURLs,
				referenceMode,
					systemPrompt: imageGenerationPreferences.video_system_prompt || undefined,
				relayTokenName: videoRelayTokenName.trim() || undefined,
				requestOptions: { signal: controller.signal },
				});
      const serverTaskID = submitted.id || taskID;
      if (!concurrent) {
        pendingTaskIDRef.current = serverTaskID;
        submittedTaskIDRef.current = serverTaskID;
        submittedTaskIDsRef.current.add(serverTaskID);
        setRunningTaskID(serverTaskID);
      }
      replaceNodes(nodesRef.current.map((node) => node.id === resultNodeID ? { ...node, task_id: serverTaskID } : node));
      const completed = await persistCreationTaskOutputs(await waitForTask(serverTaskID, undefined, controller.signal));
      const item = completed.data?.find((entry) => String(entry.type || "") === "video" || entry.video_url || entry.url);
      const url = String(item?.video_url || item?.url || "").trim();
      if (!url) throw new Error(completed.error || "视频任务完成但没有返回视频地址");
      replaceNodes(nodesRef.current.map((node) => node.id === resultNodeID ? { ...node, url, storage_key: item?.storageKey || item?.storage_key, mime_type: item?.mime_type || "video/mp4", bytes: item?.bytes || item?.size, duration_ms: Date.now() - generationStartedAt, generation_status: "success" as const, generation_progress: 100, generation_error: "", task_id: completed.id || serverTaskID } : node));
      finishHistory(); toast.success("已添加视频到画布");
    } catch (error) {
      if (controller.signal.aborted) {
        replaceNodes(nodesRef.current.map((node) => node.id === resultNodeID && node.generation_status === "loading" ? { ...node, generation_status: "idle" as const, generation_error: "" } : node));
        finishHistory();
        return;
      }
      const message = error instanceof Error ? error.message : "视频生成失败";
      replaceNodes(nodesRef.current.map((node) => node.id === resultNodeID ? { ...node, duration_ms: Date.now() - generationStartedAt, generation_status: "error" as const, generation_error: message, task_id: taskID } : node));
      finishHistory(); toast.error(message);
    } finally {
      if (!concurrent) {
        if (generationAbortControllerRef.current === controller) generationAbortControllerRef.current = null;
        submittedTaskIDsRef.current.forEach((submittedID) => cancelledTaskIDsRef.current.delete(submittedID));
        submittedTaskIDsRef.current.clear();
        pendingTaskIDRef.current = "";
        submittedTaskIDRef.current = "";
        setRunningNodeID(""); setRunningResultNodeID(""); setRunningControlNodeID(""); setRunningTaskID("");
      }
    }
  }

  async function runGeneration(nodeID: string, prompt?: string, retry = false, options: CanvasGenerationOptions = {}) {
    const specialNode = nodesRef.current.find((node) => node.id === nodeID);
    if (specialNode?.type === "text") return runTextGeneration(nodeID, retry);
    if (specialNode?.type === "config" && specialNode.generation_mode === "text") return runTextGeneration(nodeID, retry);
    if (specialNode?.type === "audio" || specialNode?.type === "config" && specialNode.generation_mode === "audio") return runAudioGeneration(nodeID, Boolean(options.concurrent), retry);
    if (specialNode?.type === "panorama" && !options.forceImageGeneration) return runPanoramaGeneration(nodeID, retry);
    if (specialNode?.type === "config" && specialNode.generation_mode === "video") return runVideoGeneration(nodeID, prompt, Boolean(options.concurrent));
    const videoNode = nodesRef.current.find((node) => node.id === nodeID && node.type === "video");
    if (videoNode) return runVideoGeneration(nodeID, prompt, Boolean(options.concurrent));
    const sourceNode = nodesRef.current.find((node) => node.id === nodeID && (node.type === "image" || node.type === "config" || options.forceImageGeneration && node.type === "panorama"));
    if (!sourceNode) return;
    if (!imageRelayTokenName.trim()) {
      setRelayTokenDialogKind("image");
      return;
    }
    const retrying = sourceNode.type === "image" && retry && sourceNode.generation_status === "error";
    const retryConfiguration = retrying && !sourceNode.generation_type
      ? findCanvasRetryConfigurationNode(sourceNode.id, nodesRef.current, connectionsRef.current)
      : null;
    const contextNode = retryConfiguration || sourceNode;
    const generationModel = options.generationModel?.trim() || canvasGenerationModel(imageModel, sourceNode, retryConfiguration, retrying);
    const contextPrompt = prompt ?? retryConfiguration?.composer_content ?? retryConfiguration?.prompt ?? sourceNode.composer_content ?? sourceNode.prompt ?? "";
    const context = buildCanvasGenerationContext(contextNode.id, nodesRef.current, connectionsRef.current, contextPrompt);
    const text = retrying ? String(sourceNode.prompt || context.prompt).trim() : context.prompt;
    const requestPrompt = applyCameraPrompt(text, contextNode.camera_control);
    const referenceImageLimit = imageReferenceImageLimit(generationModel);
    const upstreamReferenceImageURLs = canvasGenerationReferenceImageURLs(contextNode, context.referenceImageURLs, referenceImageLimit + 1);
    const referenceImageURLs = options.referenceImageDataURLs?.length
      ? options.referenceImageDataURLs.slice(0, referenceImageLimit + 1)
      : retrying && sourceNode.generation_type
        ? (sourceNode.generation_reference_urls || []).slice(0, referenceImageLimit + 1)
        : upstreamReferenceImageURLs;
    const mode = referenceImageURLs.length ? "edit" : "generation";
    const createsResultNode = !retrying && (sourceNode.type === "config" || Boolean(sourceNode.url));
    if ((!text && !referenceImageURLs.length) || runningNodeID && !options.concurrent) return toast.error("请连接有效输入或填写画面描述");
    if (retrying && sourceNode.generation_type === "edit" && !referenceImageURLs.length) return toast.error("参考图片已丢失，无法继续重试");
    if (referenceImageURLs.length && !supportsImageEditing(generationModel)) return toast.error(`模型 ${generationModel} 暂不支持参考图编辑`);
    const referenceLimitMessage = imageConversationReferenceLimitMessage(0, referenceImageURLs.length, referenceImageLimit);
    if (referenceLimitMessage) return toast.error(referenceLimitMessage);
    const parameters = canvasImageParameters(retryConfiguration || sourceNode);
    const structuredParameters = supportsStructuredImageParameters(generationModel);
    const size = canvasGenerationRequestSize(generationModel, parameters.generation_size, parameters.generation_resolution);
    const resolution = structuredParameters && parameters.generation_resolution && parameters.generation_resolution !== "auto" && supportsImageResolution(generationModel, parameters.generation_resolution)
      ? parameters.generation_resolution
      : undefined;
    const quality = parameters.generation_quality && supportsImageQualityValue(generationModel, parameters.generation_quality)
      ? parameters.generation_quality
      : undefined;
    const outputFormat = supportsImageOutputControls(generationModel) ? parameters.generation_output_format : undefined;
    const outputCompression = outputFormat ? parameters.generation_output_compression : undefined;
    const count = canvasGenerationCount(generationModel, parameters.generation_count, options.resultCount, retrying);
    const stream = supportsImageStreaming(generationModel) && imageGenerationPreferences.stream;
    const partialImages = stream ? imageGenerationPreferences.partial_images : 0;
    const compatibilityOptions = {
      apiMode: imageGenerationPreferences.api_mode,
      responseFormatB64JSON: parameters.generation_response_format_b64_json ?? false,
      codexCLICompatibility: parameters.generation_codex_cli_compatibility ?? false,
    };
    const taskRelayTokenName = imageRelayTokenName.trim() || undefined;
    const taskID = `canvas-${mode}-${randomID()}`;
    const controller = new AbortController();
    const generationEpoch = options.concurrent ? generationEpochRef.current : generationEpochRef.current + 1;
    if (!options.concurrent) generationEpochRef.current = generationEpoch;
    const generationProjectID = documentRef.current.id;
    const generationIsCurrent = () => documentRef.current.id === generationProjectID
      && nodesRef.current.some((node) => node.id === sourceNode.id)
      && !controller.signal.aborted
      && (options.concurrent || generationEpochRef.current === generationEpoch && generationAbortControllerRef.current === controller);
    if (!options.concurrent) {
      generationAbortControllerRef.current = controller;
      pendingTaskIDRef.current = taskID;
      submittedTaskIDRef.current = "";
    }
    let activeTaskID = taskID;
    let taskCancelled = false;
    let taskSubmissionAttempted = false;
    let terminalTaskReceived = false;
    const completedProgressNodeIDs = new Set<string>();
    const resultTitle = options.resultTitle?.trim() || text.slice(0, 32) || "图片";
    const resultNodeID = createsResultNode ? `image-${randomID()}` : sourceNode.id;
    const generationState: Pick<CanvasNode, "title" | "prompt" | "task_id" | "generation_model" | "generation_status" | "generation_started_at" | "generation_progress" | "generation_error" | "generation_type" | "generation_reference_urls" | "camera_control"> = {
      title: resultTitle,
      prompt: text,
      task_id: taskID,
      generation_model: generationModel,
      generation_status: "loading" as const,
      generation_started_at: Date.now(),
      generation_progress: 0,
      generation_error: "",
      generation_type: mode,
      generation_reference_urls: referenceImageURLs,
      camera_control: contextNode.camera_control,
    };
    const generatedImageSize = options.resultBounds || canvasNodeSizeFromRatio(parameters.generation_size || "", CANVAS_NODE_DEFAULT_SIZE.image.width, CANVAS_NODE_DEFAULT_SIZE.image.height) || CANVAS_NODE_DEFAULT_SIZE.image;
    let resultNode: CanvasNode = { ...sourceNode, ...generationState };
    if (createsResultNode) {
      resultNode = {
        ...buildImageNode(
          { url: "", title: resultTitle, prompt: text, width: 340, height: 240, taskID },
          {
            x: sourceNode.x + sourceNode.width + 96,
            y: sourceNode.y + sourceNode.height / 2 - generatedImageSize.height / 2,
          },
          sourceNode,
        ),
        id: resultNodeID,
        ...generationState,
        ...generatedImageSize,
      };
    }
    const isBatch = count > 1;
    const batchChildren: CanvasNode[] = isBatch ? Array.from({ length: count }, (_, index) => ({
      ...buildImageNode(
        { url: "", title: resultTitle, prompt: text, width: 340, height: 240, taskID },
        {
          x: resultNode.x + resultNode.width + 120 + (index % 2) * (generatedImageSize.width + 36),
          y: resultNode.y + Math.floor(index / 2) * (generatedImageSize.height + 36),
        },
        resultNode,
      ),
      ...generationState,
      ...generatedImageSize,
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
    const generationHistoryBase = options.concurrent ? historyRef.current : appendCanvasHistorySnapshot(historyRef.current, cloneDocument(captureDocument()), MAX_HISTORY);
    if (!options.concurrent) historyRef.current = generationHistoryBase;
    const finishHistory = () => options.concurrent ? scheduleSave() : commitGenerationHistory(generationHistoryBase);
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
    if (!options.concurrent) {
      generationHistoryBaseRef.current = generationHistoryBase;
      setRunningNodeID(nodeID);
      setRunningResultNodeID(resultNodeID);
      setRunningControlNodeID(activeSelectionNodeID);
      setRunningTaskID("");
    }
    try {
      let submitted: CreationTask;
      if (referenceImageURLs.length) {
        const referenceFiles = await Promise.all(referenceImageURLs.map(async (url, index) => {
          const blob = await fetchAuthenticatedImageBlob(url, controller.signal);
          return new File([blob], `canvas-reference-${index + 1}.${blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png"}`, { type: blob.type || "image/png" });
        }));
        taskSubmissionAttempted = true;
        submitted = await createImageEditTask(taskID, referenceFiles, buildCanvasImageReferencePrompt(requestPrompt, referenceFiles.length), generationModel || undefined, size, size, quality, count, "private", resolution, outputFormat, outputCompression, stream, partialImages, compatibilityOptions, undefined, taskRelayTokenName, undefined, undefined, { signal: controller.signal });
      } else {
        taskSubmissionAttempted = true;
        submitted = await createImageGenerationTask(taskID, requestPrompt, generationModel || undefined, size, size, quality, count, "private", resolution, outputFormat, outputCompression, stream, partialImages, compatibilityOptions, undefined, taskRelayTokenName, undefined, undefined, { signal: controller.signal });
      }
      if (!generationIsCurrent()) return;
      activeTaskID = submitted.id || taskID;
      replaceNodes(setCanvasConfigGenerationStatus(nodesRef.current, sourceNode.id, "success", "", activeTaskID));
      if (!options.concurrent) {
        pendingTaskIDRef.current = activeTaskID;
        submittedTaskIDRef.current = activeTaskID;
        submittedTaskIDsRef.current.add(activeTaskID);
        setRunningTaskID(activeTaskID);
      }
      const completedTask = await persistCreationTaskOutputs(await waitForTask(activeTaskID, (task) => {
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
      }, controller.signal));
      terminalTaskReceived = true;
      if (!generationIsCurrent()) return;
      const taskResult = summarizeCanvasTaskResult(completedTask, outputNodeIDs.length);
      taskCancelled = taskResult.cancelled;
      if (taskCancelled) throw new DOMException("请求已取消", "AbortError");
      const images = taskResult.images;
      if (!images.length) throw new Error(taskResult.error || "任务完成但没有返回图片");
      const terminalImageError = taskResult.error || "任务完成但没有返回这张图片";
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
            generation_error: taskResult.error || "任务完成但图片组没有可用结果",
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
          generation_error: terminalImageError,
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
      finishHistory();
      void refreshLibrary();
      const missingCount = taskResult.missingCount;
      if (missingCount) toast.error(taskResult.error || `已完成 ${images.length} 张，${missingCount} 张生成失败`);
      else if (completedTask.status === "error") toast.error(completedTask.error || "任务返回异常状态");
      else toast.success(`已添加 ${images.length} 张图片到画布`);
    } catch (error) {
      if (!generationIsCurrent()) return;
      const cancelled = taskCancelled || controller.signal.aborted || cancelledTaskIDsRef.current.has(activeTaskID) || cancelledTaskIDsRef.current.has(taskID);
      const generationError = error instanceof Error ? error.message : "创作任务失败";
      const recoveryPending = !cancelled && taskSubmissionAttempted && !terminalTaskReceived && (
        error instanceof CanvasTaskPollingTimeoutError || isRetryableTaskPollError(error)
      );
      let cancelledTask: CreationTask | null = null;
      if (cancelled) {
        try { cancelledTask = await persistCreationTaskOutputs(await cancelCreationTask(activeTaskID)); } catch { /* A request cancelled before submission has no server task. */ }
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
      let nextNodes = recoveryPending
        ? markCanvasGenerationRecoveryPending(nodesRef.current, activeTaskID)
        : cancelledResult?.nodes || nodesRef.current.map((node): CanvasNode => resultNodeIDs.includes(node.id) ? {
          ...restoreCanvasTaskInitialImage(node, initialResultImageByID),
          task_id: activeTaskID,
          duration_ms: node.generation_started_at ? Math.max(0, Date.now() - node.generation_started_at) : node.duration_ms,
          generation_status: "error",
          generation_error: generationError,
        } : node);
      if (cancelled && retrying && sourceNode.batch_root_id && completedImageByNodeID.has(sourceNode.id)) nextNodes = syncCanvasBatchRootAfterRetry(nextNodes, sourceNode.id);
      if (!recoveryPending) nextNodes = setCanvasConfigGenerationStatus(nextNodes, sourceNode.id, cancelled ? "idle" : "error", cancelled ? "" : generationError, cancelled ? "" : activeTaskID);
      replaceNodes(nextNodes);
      finishHistory();
      if (completedImageByNodeID.size) void refreshLibrary();
      if (!cancelled) toast.error(recoveryPending ? "暂时无法同步后台任务，重新进入画布后将继续恢复" : generationError);
    } finally {
      if (!options.concurrent) {
        cancelledTaskIDsRef.current.delete(taskID);
        cancelledTaskIDsRef.current.delete(activeTaskID);
        if (generationEpochRef.current === generationEpoch && generationAbortControllerRef.current === controller) generationAbortControllerRef.current = null;
        if (generationEpochRef.current === generationEpoch && (pendingTaskIDRef.current === taskID || pendingTaskIDRef.current === activeTaskID)) pendingTaskIDRef.current = "";
        if (generationEpochRef.current === generationEpoch && submittedTaskIDRef.current === activeTaskID) submittedTaskIDRef.current = "";
        submittedTaskIDsRef.current.delete(activeTaskID);
      }
      if (!options.concurrent && mountedRef.current && generationEpochRef.current === generationEpoch) {
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
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        await saveQueueRef.current.catch(() => undefined);
        const projectID = documentRef.current.id;
        const response = await clearCanvasDocument(projectID, documentRef.current.revision);
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

  async function exportProjectArchive() {
    try {
      const blob = await createCanvasProjectArchive([captureDocument()]);
      downloadCanvasProjectArchive(blob, title || "无限画布");
      toast.success("画布已导出");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "画布导出失败");
    }
  }

  async function importProjectArchive(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    try {
      const projects = await readCanvasProjectArchive(file);
      if (projects.length !== 1) throw new Error("请在画布库中导入包含多个项目的压缩包");
      const [parsed] = projects;
      canvasOperationEpochRef.current += 1;
      interruptGenerationForProjectChange();
      await enqueueWorkspaceMutation(async () => {
        if (!await flushCanvasSaves({ save: persistCanvas, getChangeVersion: () => saveChangeVersionRef.current, getProjectID: () => documentRef.current.id })) return;
        const response = await importCanvasProject({
          ...parsed,
          version: 1,
          title: String(parsed.title || file.name.replace(/\.zip$/i, "") || "导入画布"),
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
      const files = Array.from(event.dataTransfer.files);
      const audioFile = files.find(isCanvasAudioFile);
    if (audioFile) {
      void uploadAudioFile(audioFile, "", position);
        return;
      }
      const videoFile = files.find((item) => item.type.startsWith("video/") || /\.(mp4|mov)$/i.test(item.name));
      if (videoFile) {
        void uploadVideoFile(videoFile, "", position);
        return;
      }
      const file = files.find((item) => item.type.startsWith("image/"));
    if (file?.type.startsWith("image/")) {
      void uploadImageFile(file, "", position);
      return;
    }
    const raw = event.dataTransfer.getData("application/x-yunmian-image");
    if (!raw) return;
    try {
      const image = JSON.parse(raw) as ManagedImage;
      addImageNode({ url: image.url || image.path, thumbnailURL: image.thumbnail_url, title: canvasLibraryImageTitle(image), prompt: image.prompt, width: image.width, height: image.height, bytes: image.size }, { x: position.x, y: position.y, centered: true });
    } catch {
      toast.error("无法添加这张图片");
    }
  }

  function renderNodeActions(node: CanvasNode) {
    const imageEditingModel = node.generation_model?.trim() || imageModel.trim();
    const openImageOperation = (operation: CanvasImageOperation) => {
      void openCanvasImageTool(node.id, operation);
    };
    return (
      <CanvasNodeActionsPanel
        node={node}
        running={runningControlNodeID === node.id}
        busy={Boolean(runningNodeID) || imageToolBusy}
        uploading={uploadingNodeID === node.id}
        imageEditingSupported={supportsImageEditing(imageEditingModel)}
        onUpload={() => requestNodeMediaUpload(node.id)}
        onPreview={() => { setPanelNodeID(""); setPreviewNodeID(node.id); }}
        onDownload={() => void downloadNodeImage(node.id)}
        onCopyPrompt={() => void copyNodePrompt(node.id)}
        onReversePrompt={() => createImageReversePromptNodes(node.id)}
        onSaveAsset={() => void saveCanvasNodeAsset(node.id)}
        onDuplicate={() => duplicateNode(node.id)}
        onToggleFreeResize={() => toggleCanvasFreeResize(node.id)}
        onImageOperation={openImageOperation}
        onTextToImage={() => generateFromTextNode(node.id)}
        onOpenDirector={() => { setPanelNodeID(""); setOpenDirectorNodeID(node.id); }}
      />
    );
  }

  function renderNodeQuickActions(node: CanvasNode) {
    const imageEditingModel = node.generation_model?.trim() || imageModel.trim();
    return (
      <CanvasNodeQuickActions
        node={node}
        busy={Boolean(runningNodeID) || imageToolBusy}
        imageEditingSupported={supportsImageEditing(imageEditingModel)}
        onImageOperation={(operation) => void openCanvasImageTool(node.id, operation)}
        onPreview={() => { setPanelNodeID(""); setPreviewNodeID(node.id); }}
        onDownload={() => void downloadNodeImage(node.id)}
        onCopyPrompt={() => void copyNodePrompt(node.id)}
        onReversePrompt={() => createImageReversePromptNodes(node.id)}
        onSaveAsset={() => void saveCanvasNodeAsset(node.id)}
        onDuplicate={() => duplicateNode(node.id)}
        onToggleFreeResize={() => toggleCanvasFreeResize(node.id)}
        onTextToImage={() => generateFromTextNode(node.id)}
        onOpenDirector={() => { setPanelNodeID(""); setOpenDirectorNodeID(node.id); }}
      />
    );
  }


  function renderNodePanel(node: CanvasNode) {
    if (node.type === "config") {
      const mode = node.generation_mode || "image";
      const inputs = canvasConfigInputs(node.id, nodesRef.current, connectionsRef.current);
      const canGenerate = canGenerateCanvasConfig(node, inputs);
      const nodeTextModel = node.generation_text_model || textModel;
      const configVideoParams = canvasVideoParameters(node);
      const canGenerateWithParameters = mode !== "video" || videoSecondsIsValid(configVideoParams.generation_video_model, configVideoParams.generation_video_seconds);
      const configPromptTools = mode === "image"
        ? <CanvasInlineModelSelect value={node.generation_model?.trim() || imageModel} models={imageModels} label="图片模型" onChange={(generation_model) => updateNodeGenerationParameters(node.id, { generation_model })} />
        : mode === "text"
          ? <CanvasInlineModelSelect value={nodeTextModel} models={textModels} label="文本模型" onChange={(generation_text_model) => updateNodeGenerationParameters(node.id, { generation_text_model })} />
          : mode === "audio"
            ? <CanvasInlineModelSelect value={node.generation_audio_model || audioModels[0] || "gpt-4o-mini-tts"} models={audioModels} label="音频模型" onChange={(generation_audio_model) => updateNodeGenerationParameters(node.id, { generation_audio_model })} />
            : <CanvasInlineModelSelect value={canvasVideoParameters(node).generation_video_model} models={videoModels} label="视频模型" onChange={(model) => updateNodeGenerationParameters(node.id, canvasVideoModelPatch(model))} />;
      return (
        <div className="flex h-full min-h-0 flex-col">
          <AppScrollArea className="h-0 flex-1" viewportClassName="pr-3">
            <div className="space-y-3">
              <CanvasConfigComposer
                node={node}
                inputs={inputs}
                promptTools={configPromptTools}
                onComposerChange={(value, commit) => updateNodeComposerContent(node.id, value, commit)}
                onClose={() => setPanelNodeID("")}
              >
                <label className="grid gap-1 text-xs"><span className="text-muted-foreground">生成模式</span><Select value={mode} onValueChange={(value: NonNullable<CanvasNode["generation_mode"]>) => updateNodeGenerationParameters(node.id, { generation_mode: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="image">图片</SelectItem><SelectItem value="text">文本</SelectItem><SelectItem value="video">视频</SelectItem><SelectItem value="audio">音频</SelectItem></SelectContent></Select></label>
                {mode === "image" ? <><CanvasImageParameterPopover node={node} imageModel={node.generation_model || imageModel} imageModels={imageModels} onChange={(patch) => updateNodeGenerationParameters(node.id, patch)} expanded showModel={false} /><CanvasCameraControl value={node.camera_control} onChange={(camera_control) => updateNodeGenerationParameters(node.id, { camera_control })} className="w-full" /></> : null}
                {mode === "audio" ? <CanvasAudioSettingsFields node={node} models={audioModels} audioReferences={canvasAudioReferences(node.id, nodesRef.current, connectionsRef.current)} relayTokenName={audioRelayTokenName} onChange={(patch) => updateNodeGenerationParameters(node.id, patch)} showModel={false} /> : null}
              </CanvasConfigComposer>
              {mode === "video" ? <div className="h-[640px] overflow-hidden rounded-xl border border-border bg-card p-3"><CanvasVideoPromptPanel node={{ ...node, prompt: node.composer_content ?? node.prompt }} inputs={inputs} running={runningControlNodeID === node.id} generationBusy={Boolean(runningNodeID)} showPromptEditor={false} showGenerateFooter={false} videoModels={videoModels} onPromptChange={(value, commit) => updateNodeComposerContent(node.id, value, commit)} onParametersChange={(patch) => updateNodeGenerationParameters(node.id, patch)} onGenerate={(prompt) => void runVideoGeneration(node.id, prompt)} onStop={requestStopGeneration} /></div> : null}
            </div>
          </AppScrollArea>
          <CanvasGenerationFooter
            className="mt-3"
            running={runningControlNodeID === node.id}
            disabled={runningControlNodeID !== node.id && (Boolean(runningNodeID) || !canGenerate || !canGenerateWithParameters)}
            onGenerate={mode === "video" ? () => void runVideoGeneration(node.id, (node.composer_content ?? node.prompt ?? "").trim()) : () => void runGeneration(node.id)}
            onStop={requestStopGeneration}
          />
        </div>
      );
    }
    if (node.type === "text") {
      return (
        <CanvasTextContentPanel
          node={node}
          onContentChange={(value, commit) => updateNodePrompt(node.id, value, commit)}
          onFontSizeChange={(value) => updateTextFontSize(node.id, value)}
        />
      );
    }
    if (node.type === "audio") {
      const context = buildCanvasGenerationContext(node.id, nodesRef.current, connectionsRef.current, node.prompt || "");
      return <CanvasAudioPromptPanel node={node} models={audioModels} audioReferences={canvasAudioReferences(node.id, nodesRef.current, connectionsRef.current)} relayTokenName={audioRelayTokenName} running={runningControlNodeID === node.id} busy={Boolean(runningNodeID)} uploading={uploadingNodeID === node.id} canGenerate={Boolean(context.prompt.trim())} onChange={(patch) => updateNodeGenerationParameters(node.id, patch)} onPromptChange={(value, commit) => updateNodePrompt(node.id, value, commit)} onUpload={() => requestNodeMediaUpload(node.id)} onGenerate={() => void runAudioGeneration(node.id)} onStop={requestStopGeneration} />;
    }
    if (node.type === "panorama") {
      const context = buildCanvasGenerationContext(node.id, nodesRef.current, connectionsRef.current, node.panorama_source_prompt || node.prompt || "");
      return <CanvasPanoramaPromptPanel node={node} imageModel={node.generation_model?.trim() || imageModel} imageModels={imageModels} running={runningControlNodeID === node.id} busy={Boolean(runningNodeID)} uploading={uploadingNodeID === node.id} canGenerate={Boolean(context.prompt.trim() || context.referenceImageURLs.length || node.url)} onChange={(patch) => updateNodeGenerationParameters(node.id, { ...patch, generation_size: PANORAMA_IMAGE_SIZE })} onPromptChange={(value, commit) => { replaceNodes(nodesRef.current.map((item) => item.id === node.id ? { ...item, panorama_source_prompt: value, prompt: value } : item)); scheduleSave(); if (commit) pushHistory(); }} onUpload={() => requestNodeMediaUpload(node.id)} onGenerate={() => void runPanoramaGeneration(node.id)} onStop={requestStopGeneration} />;
    }
    if (node.type === "director") return null;
    if (node.type === "video") {
      return <CanvasVideoPromptPanel node={node} inputs={canvasGenerationInputs(node.id, nodesRef.current, connectionsRef.current)} running={runningControlNodeID === node.id} generationBusy={Boolean(runningNodeID)} uploading={uploadingNodeID === node.id} videoModels={videoModels} onPromptChange={(value, commit) => updateNodePrompt(node.id, value, commit)} onParametersChange={(patch) => updateNodeGenerationParameters(node.id, patch)} onGenerate={(prompt) => void runVideoGeneration(node.id, prompt)} onStop={requestStopGeneration} onUpload={() => requestNodeMediaUpload(node.id)} />;
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
        imageModels={imageModels}
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
    const loadWorkspace = async () => {
      let workspace = await fetchCanvasDocument();
      if (!workspace.document?.id) {
        workspace = await updateCanvasProject({ action: "create", title: "我的画布" });
      }
      if (projectID && workspace.active_project_id !== projectID) {
        workspace = await updateCanvasProject({ action: "activate", project_id: projectID });
      }
      applyWorkspace(workspace);
    };
    void loadWorkspace().catch((error) => toast.error(error instanceof Error ? error.message : "画布加载失败")).finally(() => mountedRef.current && setLoading(false));
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
      if (focusAnimationRef.current !== null) window.cancelAnimationFrame(focusAnimationRef.current);
    };
  }, [projectID]);

  useEffect(() => {
    const handleTokenNameChange = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key === imageRelayTokenStorageKey) {
          setImageRelayTokenName(getStoredRelayTokenName(session, "image"));
        } else if (event.key === videoRelayTokenStorageKey) {
          setVideoRelayTokenName(getStoredRelayTokenName(session, "video"));
        } else if (event.key === audioRelayTokenStorageKey) {
          setAudioRelayTokenName(getStoredRelayTokenName(session, "audio"));
        } else if (event.key === textRelayTokenStorageKey) {
          setTextRelayTokenName(getStoredRelayTokenName(session, "text"));
        }
        return;
      }
      const detail = (event as CustomEvent<{ kind?: RelayTokenKind; tokenName?: string }>).detail;
      if (detail?.kind === "image") {
        setImageRelayTokenName(String(detail.tokenName ?? getStoredRelayTokenName(session, "image")));
      } else if (detail?.kind === "video") {
        setVideoRelayTokenName(String(detail.tokenName ?? getStoredRelayTokenName(session, "video")));
      } else if (detail?.kind === "audio") {
        setAudioRelayTokenName(String(detail.tokenName ?? getStoredRelayTokenName(session, "audio")));
      } else if (detail?.kind === "text") {
        setTextRelayTokenName(String(detail.tokenName ?? getStoredRelayTokenName(session, "text")));
      }
    };
    window.addEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
    window.addEventListener("storage", handleTokenNameChange);
    return () => {
      window.removeEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
      window.removeEventListener("storage", handleTokenNameChange);
    };
  }, [audioRelayTokenStorageKey, imageRelayTokenStorageKey, textRelayTokenStorageKey, videoRelayTokenStorageKey, session]);

  useEffect(() => {
    setImageRelayTokenName(getStoredRelayTokenName(session, "image"));
    setVideoRelayTokenName(getStoredRelayTokenName(session, "video"));
    setAudioRelayTokenName(getStoredRelayTokenName(session, "audio"));
    setTextRelayTokenName(getStoredRelayTokenName(session, "text"));
  }, [audioRelayTokenStorageKey, imageRelayTokenStorageKey, textRelayTokenStorageKey, videoRelayTokenStorageKey, session]);

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
    if (!sidePanel.open || sidePanel.tab !== "assets") return;
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
  }, [refreshLibrary, sidePanel.open, sidePanel.tab]);

  useEffect(() => {
    window.localStorage.setItem(SIDE_PANEL_STORAGE_KEY, JSON.stringify(sidePanel));
  }, [sidePanel]);

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
      else if (command && !event.altKey && event.key.toLowerCase() === "g") { event.preventDefault(); createGroupFromSelection(); }
      else if (command && !event.altKey && event.key.toLowerCase() === "c") { event.preventDefault(); void copySelected(); }
      else if (command && !event.altKey && event.key.toLowerCase() === "v") { event.preventDefault(); void pasteSelected(); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelected(); }
      else if (event.key === "Escape") {
        selectionChanged(new Set());
        setPendingConnection(null);
        setNodeCreateMenu(null);
        setPreviewNodeID("");
        setProjectMenuOpen(false);
        setCanvasMenuOpen(false);
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

  useEffect(() => {
    if (!canvasMenuOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("[data-canvas-menu]")) setCanvasMenuOpen(false);
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [canvasMenuOpen]);

  return (
    <section className="relative flex h-full min-h-[540px] overflow-hidden rounded-xl border border-border bg-card shadow-[0_16px_42px_-34px_rgba(15,23,42,0.34)]">
      <CanvasSidePanel
        nodes={nodes}
        selectedNodeIDs={selectedNodeIDs}
        open={sidePanel.open}
        width={sidePanel.width}
        tab={sidePanel.tab}
        libraryImages={libraryImages}
        libraryLoading={libraryLoading}
        onOpenChange={(open) => setSidePanel((current) => ({ ...current, open }))}
        onWidthChange={(width) => setSidePanel((current) => ({ ...current, width }))}
        onTabChange={(tab) => setSidePanel((current) => ({ ...current, tab }))}
        onFocusNode={focusCanvasNode}
        onInsertLibraryImage={(image) => addImageNode({
          url: image.url || image.path,
          thumbnailURL: image.thumbnail_url,
          title: canvasLibraryImageTitle(image),
          prompt: image.prompt,
          width: image.width,
          height: image.height,
        })}
        onOpenAssets={() => setAssetPickerOpen(true)}
        onInsertPrompt={(prompt, promptTitle) => addTextNodeAt(placement(), prompt, promptTitle.trim() || prompt.trim().slice(0, 32) || "文字")}
      />
      <div ref={hostRef} className="relative min-w-0 flex-1 overflow-hidden bg-[#f3f5f8] dark:bg-[#15181d]">
      <CanvasEngine nodes={nodes} connections={connections} viewport={viewport} background={background} showImageInfo={showImageInfo} canvasSize={canvasSize} exporting={exportingCanvas} exportBounds={exportingCanvas ? canvasExportBounds(visibleCanvasNodes(nodes)) : undefined} selectedNodeIDs={selectedNodeIDs} selectedConnectionID={selectedConnectionID} panelNodeID={panelNodeID} loadingNodeID={runningResultNodeID} pendingConnectionActive={Boolean(pendingConnection)} collapsingBatchRootIDs={collapsingBatchRootIDs} openingBatchRootIDs={openingBatchRootIDs} onNodesChange={replaceNodes} onNodesCommit={pushHistory} onViewportChange={updateViewport} onSelectionChange={selectionChanged} onConnect={connectNodes} canConnect={canConnect} onConnectionDropEmpty={(origin, position, menu) => setPendingConnection({ ...origin, position, menu })} onTitleChange={updateNodeTitle} onNodePanelToggle={(nodeID) => setPanelNodeID((current) => current === nodeID ? "" : nodeID)} onNodeMediaLoad={handleNodeMediaLoad} onViewImage={(nodeID) => { setPanelNodeID(""); setPreviewNodeID(nodeID); }} onDirectorOpen={(nodeID) => { setPanelNodeID(""); setOpenDirectorNodeID(nodeID); }} onTextToImage={generateFromTextNode} onNodeRetry={(nodeID) => void runGeneration(nodeID, undefined, true)} onNodeActivate={activateNode} onToggleBatch={toggleCanvasBatch} onSetBatchPrimary={makeCanvasBatchPrimary} onNodeDelete={(nodeID) => removeNodes(new Set([nodeID]))} onNodeContextMenu={openNodeContextMenu} onConnectionContextMenu={openConnectionContextMenu} onCanvasContextMenu={openCanvasContextMenu} onCanvasDoubleClick={(event, position) => { const rect = hostRef.current?.getBoundingClientRect(); setNodeCreateMenu({ position, menu: { x: event.clientX - (rect?.left || 0), y: event.clientY - (rect?.top || 0) } }); }} renderNodePanel={renderNodePanel} renderNodeQuickActions={renderNodeQuickActions} renderNodeActions={renderNodeActions} renderNodeInfo={(node) => <CanvasNodeInfoContent node={node} configInputs={node.type === "config" ? canvasConfigInputs(node.id, nodesRef.current, connectionsRef.current) : []} />} onDrop={handleCanvasDrop} />
      {openDirectorNode ? <CanvasDirector nodeId={openDirectorNode.id} project={openDirectorNode.director_project} panoramas={directorPanoramas} theme={colorTheme} onClose={() => setOpenDirectorNodeID("")} onProjectChange={handleDirectorProjectChange} onPanoramaRemoved={handleDirectorPanoramaRemoved} onCapturesSent={handleDirectorCapturesSent} onVideoSent={handleDirectorVideoSent} /> : null}

      {pendingConnection ? <div data-connection-create-menu className="absolute z-40 w-48 rounded-xl border border-border bg-card p-1.5 shadow-xl" style={{ left: Math.max(8, Math.min(pendingConnection.menu.x, (hostRef.current?.clientWidth || 240) - 200)), top: Math.max(64, Math.min(pendingConnection.menu.y, (hostRef.current?.clientHeight || 240) - 300)) }}><p className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">创建节点并连接</p><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("text")}><Type className="size-4" />文字节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("image")}><ImagePlus className="size-4" />空白图片节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("video")}><Video className="size-4" />视频生成节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("audio")}><Music className="size-4" />音频生成节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("panorama")}><Compass className="size-4" />全景图节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("director")}><Camera className="size-4" />导演台节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => createPendingNode("config")}><Settings2 className="size-4" />生成配置节点</button></div> : null}
      {nodeCreateMenu ? <div data-node-create-menu className="absolute z-40 w-48 rounded-xl border border-border bg-card p-1.5 shadow-xl" style={{ left: Math.max(8, Math.min(nodeCreateMenu.menu.x, (hostRef.current?.clientWidth || 240) - 200)), top: Math.max(64, Math.min(nodeCreateMenu.menu.y, (hostRef.current?.clientHeight || 240) - 300)) }}><p className="px-2 py-1.5 text-[11px] font-semibold text-muted-foreground">添加到画布</p><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addTextNodeAt({ x: nodeCreateMenu.position.x - 170, y: nodeCreateMenu.position.y - 120 }); setNodeCreateMenu(null); }}><Type className="size-4" />文字节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addBlankNodeAt({ x: nodeCreateMenu.position.x - 170, y: nodeCreateMenu.position.y - 120 }); setNodeCreateMenu(null); }}><ImagePlus className="size-4" />空白图片节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { const point = { x: nodeCreateMenu.position.x - 210, y: nodeCreateMenu.position.y - 118 }; const node = buildVideoNode({}, point); addNode(node); setPanelNodeID(node.id); setNodeCreateMenu(null); }}><Video className="size-4" />视频生成节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addAudioNodeAt({ x: nodeCreateMenu.position.x - 190, y: nodeCreateMenu.position.y - 110 }); setNodeCreateMenu(null); }}><Music className="size-4" />音频生成节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addPanoramaNodeAt({ x: nodeCreateMenu.position.x - 260, y: nodeCreateMenu.position.y - 146 }); setNodeCreateMenu(null); }}><Compass className="size-4" />全景图节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addDirectorNodeAt({ x: nodeCreateMenu.position.x - 280, y: nodeCreateMenu.position.y - 180 }); setNodeCreateMenu(null); }}><Camera className="size-4" />导演台节点</button><button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-muted" onClick={() => { addConfigNodeAt({ x: nodeCreateMenu.position.x - 170, y: nodeCreateMenu.position.y - 120 }); setNodeCreateMenu(null); }}><Settings2 className="size-4" />生成配置节点</button></div> : null}

      <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start gap-3">
        <div data-canvas-menu className="pointer-events-auto relative flex h-10 items-center rounded-xl border border-border bg-card/94 p-1 shadow-[0_8px_24px_rgba(15,23,42,.09)] backdrop-blur-xl">
          <Button
            aria-label={sidePanel.open ? "收起侧栏" : "展开侧栏"}
            title={sidePanel.open ? "收起侧栏" : "展开侧栏"}
            variant="ghost"
            size="icon"
            className={cn("size-8 rounded-full transition-[color,background-color,transform] duration-200 ease-in-out hover:scale-105 active:scale-90", sidePanel.open && "bg-muted text-[#1456f0]")}
            onClick={() => setSidePanel((current) => ({ ...current, open: !current.open }))}
          >
            <span className="relative size-4.5">
              <PanelLeftClose className={cn("absolute inset-0 size-4.5 transition-[opacity,transform] duration-200 ease-in-out", sidePanel.open ? "translate-x-0 scale-100 opacity-100" : "-translate-x-1 scale-75 opacity-0")} />
              <PanelLeftOpen className={cn("absolute inset-0 size-4.5 transition-[opacity,transform] duration-200 ease-in-out", sidePanel.open ? "translate-x-1 scale-75 opacity-0" : "translate-x-0 scale-100 opacity-100")} />
            </span>
          </Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button aria-label="画布菜单" title="画布菜单" variant="ghost" size="icon" className={cn("size-8 rounded-full", canvasMenuOpen && "bg-muted text-[#1456f0]")} onClick={() => { setCanvasMenuOpen((value) => !value); setProjectMenuOpen(false); }}><Menu className="size-5" /></Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button aria-label="画布项目" variant="ghost" size="sm" className="h-8 max-w-[30vw] rounded-lg px-2.5 text-xs font-semibold sm:max-w-56" onClick={() => setProjectMenuOpen((value) => !value)}><span className="truncate">{title}</span><ChevronDown className="size-3.5" /></Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button
            type="button"
            variant={agentOpen ? "secondary" : "ghost"}
            size="sm"
            className="h-8 rounded-lg px-2.5 text-xs font-semibold"
            aria-label="打开 Agent"
            onClick={() => {
              setPanelNodeID("");
              setAgentOpen(true);
              documentRef.current = { ...documentRef.current, agent_panel: { open: true, width: agentWidth } };
              scheduleSave();
            }}
          >
            <Bot />Agent
          </Button>
          {canvasMenuOpen ? <div className="absolute left-0 top-12 z-50 w-60 overflow-hidden rounded-xl border border-border bg-card p-1.5 text-sm shadow-xl">
            <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted" onClick={() => { setCanvasMenuOpen(false); navigate("/canvas"); }}><Images className="size-4 text-muted-foreground" />我的画布</button>
            <div className="my-1 h-px bg-border" />
            <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted" onClick={() => { setCanvasMenuOpen(false); setProjectDialog({ mode: "create", title: `无限画布 ${projects.length + 1}` }); }}><Plus className="size-4 text-muted-foreground" />新建画布</button>
            <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted" onClick={() => { setCanvasMenuOpen(false); setProjectDialog({ mode: "rename", title }); }}><Pencil className="size-4 text-muted-foreground" />重命名</button>
            <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30" onClick={() => { setCanvasMenuOpen(false); setProjectDialog({ mode: "delete", title }); }}><Trash2 className="size-4" />删除当前画布</button>
            <div className="my-1 h-px bg-border" />
            <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted" onClick={() => { setCanvasMenuOpen(false); requestCanvasImageUpload(); }}><Upload className="size-4 text-muted-foreground" />导入素材</button>
            <div className="my-1 h-px bg-border" />
            <button type="button" disabled={historyRef.current.length <= 1} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" onClick={() => { setCanvasMenuOpen(false); undo(); }}><span className="flex items-center gap-3"><Undo2 className="size-4" />撤销</span><kbd className="text-[11px] text-muted-foreground">⌘ Z</kbd></button>
            <button type="button" disabled={!redoRef.current.length} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40" onClick={() => { setCanvasMenuOpen(false); redo(); }}><span className="flex items-center gap-3"><Redo2 className="size-4" />重做</span><kbd className="text-[11px] text-muted-foreground">⌘ ⇧ Z</kbd></button>
          </div> : null}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center">
        <div className="hide-scrollbar pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto px-1">
          <div className="flex h-11 shrink-0 items-center gap-0.5 rounded-xl border border-border bg-card/95 p-1 shadow-[0_10px_28px_rgba(15,23,42,.12)] backdrop-blur-xl">
            <ToolButton active={!selectedNodeIDs.size && !selectedConnectionID} label="移动/选择" onClick={() => selectionChanged(new Set())}><Hand /></ToolButton>
            <ToolbarDivider />
            <ToolButton label="撤销" disabled={historyRef.current.length <= 1} onClick={undo}><Undo2 /></ToolButton>
            <ToolButton label="重做" disabled={!redoRef.current.length} onClick={redo}><Redo2 /></ToolButton>
            <ToolbarDivider />
            <ToolButton label="添加文字" onClick={addTextNode}><Type /></ToolButton>
            <ToolButton label="添加空白图片" onClick={addBlankNode}><ImagePlus /></ToolButton>
            <ToolButton label="添加视频生成" onClick={addBlankVideoNode}><Video /></ToolButton>
            <ToolButton label="添加音频生成" onClick={() => addAudioNodeAt(placement())}><Music /></ToolButton>
            <ToolButton label="添加全景图" onClick={() => addPanoramaNodeAt(placement())}><Compass /></ToolButton>
            <ToolButton label="添加导演台" onClick={() => addDirectorNodeAt(placement())}><Camera /></ToolButton>
            <ToolButton label="添加生成配置" onClick={() => addConfigNodeAt(placement())}><Settings2 /></ToolButton>
            <ToolButton label="上传素材" disabled={Boolean(uploadingNodeID)} onClick={() => requestCanvasImageUpload()}>{uploadingNodeID === "canvas-upload" ? <LoaderCircle className="animate-spin" /> : <Upload />}</ToolButton>
            <ToolButton active={sidePanel.open && sidePanel.tab === "assets"} label="素材库" onClick={() => setSidePanel((current) => ({ ...current, open: true, tab: "assets" }))}><FolderOpen /></ToolButton>
            <ToolbarDivider />
            <ToolButton label="删除所选" disabled={!selectedNodeIDs.size && !selectedConnection} className="text-rose-600" onClick={removeSelected}><Trash2 /></ToolButton>
            <ToolButton label="清空画布" disabled={!nodes.length} className="text-rose-600" onClick={() => setClearConfirmationOpen(true)}><Eraser /></ToolButton>
          </div>
        </div>
      </div>

      <div className="pointer-events-auto absolute bottom-3 left-3 z-30 hidden h-11 items-center gap-0.5 rounded-xl border border-border bg-card/95 p-1 shadow-[0_10px_28px_rgba(15,23,42,.12)] backdrop-blur-xl lg:flex">
        <ToolButton label="重置视图" onClick={resetViewport}><Focus /></ToolButton>
        <Slider aria-label="画布缩放" min={CANVAS_MIN_ZOOM * 100} max={CANVAS_MAX_ZOOM * 100} value={Math.round(viewport.zoom * 100)} className="w-20" onChange={(event) => updateViewport(setCanvasViewportZoom(viewportRef.current, canvasSize, Number(event.target.value) / 100), true)} />
        <span className="w-11 text-center text-[11px] font-semibold text-muted-foreground">{Math.round(viewport.zoom * 100)}%</span>
        <ToolButton active={miniMapOpen} label="小地图" onClick={() => setMiniMapOpen((value) => !value)}><MapIcon /></ToolButton>
        <ToolButton active={shortcutsOpen} label="快捷键" onClick={() => setShortcutsOpen(true)}><CircleHelp /></ToolButton>
      </div>

      {projectMenuOpen ? <aside className="absolute top-16 left-3 z-30 w-80 rounded-xl border border-border bg-card shadow-xl"><div className="border-b p-3"><p className="text-sm font-semibold">画布项目</p><p className="text-[11px] text-muted-foreground">跨设备自动同步</p></div><ScrollArea className="max-h-56 p-1.5">{projects.map((project) => <button key={project.id} className={cn("flex w-full items-center gap-2 rounded-lg p-2 text-left text-xs hover:bg-muted", project.id === documentRef.current.id && "bg-[#e7efff] text-[#1456f0] dark:bg-blue-950/50 dark:text-blue-300")} onClick={() => project.id !== documentRef.current.id && void runProject({ action: "activate", project_id: project.id })}><span className="flex size-7 items-center justify-center rounded-md bg-muted">{project.id === documentRef.current.id ? <Check className="size-3.5" /> : project.node_count}</span><span className="truncate font-semibold">{project.title}</span></button>)}</ScrollArea><div className="space-y-2 border-t p-2.5"><div className="flex rounded-lg bg-muted p-1"><BackgroundButton active={background === "dots"} label="点阵" onClick={() => { backgroundRef.current = "dots"; setBackground("dots"); setTimeout(pushHistory); }}><CircleDot /></BackgroundButton><BackgroundButton active={background === "grid"} label="网格" onClick={() => { backgroundRef.current = "grid"; setBackground("grid"); setTimeout(pushHistory); }}><Grid2X2 /></BackgroundButton><BackgroundButton active={background === "plain"} label="空白" onClick={() => { backgroundRef.current = "plain"; setBackground("plain"); setTimeout(pushHistory); }}><Square /></BackgroundButton></div><label className="flex items-center justify-between gap-3 rounded-lg px-1.5 py-1 text-xs"><span className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><Info className="size-3.5" />图片信息</span><Switch checked={showImageInfo} aria-label="显示图片信息" onCheckedChange={(enabled) => { showImageInfoRef.current = enabled; setShowImageInfo(enabled); pushHistory(); }} /></label></div></aside> : null}

      <CanvasAgentPanel
        key={documentRef.current.id}
        open={agentOpen}
        session={session}
        nodes={nodes}
        selectedNodeIDs={[...selectedNodeIDs]}
        referenceNodeClick={agentReferenceNodeClick}
        model={textModel}
        imageModel={imageModel}
        videoModel={videoModel}
        configuredSystemPrompt={imageGenerationPreferences.system_prompt}
        initialSessions={agentSessions}
        initialActiveSessionID={activeAgentSessionID}
        initialRequest={initialAgentRequest}
        agentConfig={resolvedAgentConfig}
        width={agentWidth}
        getAgentContext={getCanvasAgentContext}
        onSessionsChange={(sessions, activeSessionID) => {
          setAgentSessions(sessions);
          setActiveAgentSessionID(activeSessionID);
          documentRef.current = {
            ...documentRef.current,
            agent_sessions: sessions,
            active_agent_session_id: activeSessionID,
          };
          scheduleSave();
        }}
        onAgentConfigChange={(patch) => {
          const next = { ...resolvedAgentConfig, ...patch };
          setAgentConfig(next);
          documentRef.current = { ...documentRef.current, agent_config: next };
          scheduleSave();
        }}
        onWidthChange={(width) => {
          setAgentWidth(width);
          documentRef.current = { ...documentRef.current, agent_panel: { open: true, width } };
          scheduleSave();
        }}
        onExecuteAction={executeCanvasAgentAction}
        onOpenUpload={() => requestCanvasImageUpload()}
        onOpenAssets={() => setAssetPickerOpen(true)}
        onPasteImage={(file) => { void uploadImageFile(file, "", canvasCenterPosition()); }}
        onInitialRequestConsumed={() => setInitialAgentRequest(null)}
        onClose={() => {
          setAgentOpen(false);
          documentRef.current = { ...documentRef.current, agent_panel: { open: false, width: agentWidth } };
          scheduleSave();
        }}
      />

      <CanvasAssetPicker
        open={assetPickerOpen}
        session={session}
        onInsert={(payload) => {
          insertCanvasAsset(payload);
          setAssetPickerOpen(false);
        }}
        onClose={() => setAssetPickerOpen(false)}
      />

      {miniMapOpen && nodes.length && canvasSize.width > 0 ? <CanvasMiniMap nodes={nodes} viewport={viewport} viewportSize={canvasSize} onViewportChange={(next) => updateViewport(next, true)} /> : null}

      {contextMenu ? <CanvasRightClickMenu menu={contextMenu} onClose={() => setContextMenu(null)} onDuplicate={() => { if (contextMenu.type === "node") duplicateNode(contextMenu.nodeID); setContextMenu(null); }} onDelete={() => { if (contextMenu.type === "node") removeNodes(new Set([contextMenu.nodeID])); else if (contextMenu.type === "connection") { replaceConnections(connectionsRef.current.filter((connection) => connection.id !== contextMenu.connectionID)); setSelectedConnectionID(""); pushHistory(); } setContextMenu(null); }} onAddText={() => { if (contextMenu.type === "canvas") addTextNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 120 }); setContextMenu(null); }} onAddImage={() => { if (contextMenu.type === "canvas") addBlankNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 120 }); setContextMenu(null); }} onAddVideo={() => { if (contextMenu.type === "canvas") { const point = { x: contextMenu.position.x - 210, y: contextMenu.position.y - 118 }; const node = buildVideoNode({}, point); addNode(node); setPanelNodeID(node.id); } setContextMenu(null); }} onAddConfig={() => { if (contextMenu.type === "canvas") addConfigNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 120 }); setContextMenu(null); }} onPaste={() => { void pasteSelected(); setContextMenu(null); }} onExportImage={() => { void exportImage(); setContextMenu(null); }} onExportJSON={() => { void exportProjectArchive(); setContextMenu(null); }} onImport={() => { importRef.current?.click(); setContextMenu(null); }} onClear={() => { setClearConfirmationOpen(true); setContextMenu(null); }} /> : null}
      <RelayTokenRequiredDialog
        kind={relayTokenDialogKind || "image"}
        open={relayTokenDialogKind !== null}
        onOpenChange={(open) => {
          if (!open) setRelayTokenDialogKind(null);
        }}
      />
      <CanvasProjectDialog
        open={Boolean(projectDialog)}
        mode={projectDialog?.mode || "rename"}
        title={projectDialog?.title || title}
        onOpenChange={(open) => !open && setProjectDialog(null)}
        onConfirm={confirmCanvasProjectDialog}
      />
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent scrollable={false} className="w-[min(92vw,560px)] gap-0 rounded-lg p-0">
          <DialogHeader className="border-b px-6 py-5 pr-12">
            <DialogTitle>画布快捷键</DialogTitle>
            <DialogDescription>使用键盘和鼠标快速操作画布。</DialogDescription>
          </DialogHeader>
          <ScrollArea maxHeight="min(68dvh,560px)" viewportClassName="p-5 sm:p-6" viewClass="grid gap-1">
            <CanvasShortcut keys={["Space", "拖动"]} description="临时移动画布" />
            <CanvasShortcut keys={["滚轮"]} description="缩放画布" />
            <CanvasShortcut keys={["Shift / Ctrl / Cmd", "点击"]} description="追加选择节点" />
            <CanvasShortcut keys={["Ctrl / Cmd", "A"]} description="全选节点" />
            <CanvasShortcut keys={["Ctrl / Cmd", "G"]} description="创建组" />
            <CanvasShortcut keys={["Ctrl / Cmd", "C / V"]} description="复制 / 粘贴节点或剪贴板内容" />
            <CanvasShortcut keys={["Ctrl / Cmd", "Z"]} description="撤销" />
            <CanvasShortcut keys={["Ctrl / Cmd", "Shift", "Z"]} description="重做" />
            <CanvasShortcut keys={["Delete / Backspace"]} description="删除选中" />
            <CanvasShortcut keys={["Esc"]} description="取消选择并关闭浮层" />
          </ScrollArea>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(pendingPanoramaImport)} onOpenChange={(open) => { if (!open) setPendingPanoramaImport(null); }}>
        <DialogContent className="w-[min(92vw,420px)] rounded-2xl">
          <DialogHeader>
            <DialogTitle>导入 2:1 图片</DialogTitle>
            <DialogDescription>这张图片符合严格的 2:1 全景比例，请选择节点类型。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => finishPanoramaImport("image")}>作为普通图片导入</Button>
            <Button onClick={() => finishPanoramaImport("panorama")}>作为全景图导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={stopConfirmationOpen} onOpenChange={setStopConfirmationOpen}>
        <DialogContent className="w-[min(92vw,420px)] rounded-2xl">
          <DialogHeader>
            <DialogTitle>停止生成？</DialogTitle>
            <DialogDescription>当前生成请求会被中断，已经生成完成的结果会保留。</DialogDescription>
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
      <CanvasMaskDialog sourceURL={imageTool?.kind === "mask" ? imageTool.sourceURL : ""} open={imageTool?.kind === "mask"} busy={imageToolBusy} model={maskEditModel || imageModel} models={imageModels} onModelChange={setMaskEditModel} onClose={closeCanvasImageTool} onConfirm={maskEditCanvasNode} />
      <CanvasAngleDialog sourceURL={imageTool?.kind === "angle" ? imageTool.sourceURL : ""} open={imageTool?.kind === "angle"} busy={imageToolBusy} onClose={closeCanvasImageTool} onConfirm={angleCanvasNode} />
      {previewPanorama?.url ? (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={() => setPreviewNodeID("")}>
          <div className="relative h-[85vh] w-[85vw] overflow-hidden rounded-xl" onClick={(event) => event.stopPropagation()}>
            <CanvasPanoramaViewer src={previewPanorama.url} alt={previewPanorama.title || "全景图"} proxyGeneratedPanorama={Boolean(previewPanorama.task_id && !previewPanorama.storage_key)} immersive />
            <Button variant="secondary" size="icon" className="absolute right-3 top-3 z-20 size-9" aria-label="关闭全景图" title="关闭全景图" onClick={() => setPreviewNodeID("")}><X /></Button>
          </div>
        </div>
      ) : null}
      {previewVideo?.url ? <CanvasVideoPreview src={previewVideo.url} title={previewVideo.title || "视频"} onDownload={() => void downloadNodeImage(previewVideo.id)} onClose={() => setPreviewNodeID("")} /> : null}
      <ImageLightbox images={previewImages} currentIndex={previewIndex} open={Boolean(previewNodeID && !previewPanorama && !previewVideo)} onOpenChange={(open) => { if (!open) setPreviewNodeID(""); }} onIndexChange={(index) => setPreviewNodeID(previewImages[index]?.id || "")} />
      <Input ref={importRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importProjectArchive(event)} />
      <Input ref={imageInputRef} type="file" accept="image/*,video/mp4,video/quicktime,.mp4,.mov,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={(event) => void handleNodeImageUpload(event)} />
      {loading || switchPhase ? <CanvasSwitchShell revealing={!loading && switchPhase === "revealing"} /> : null}
      </div>
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
  return <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={label} className={cn("size-9 rounded-lg", active && "bg-[#e7efff] text-[#1456f0] dark:bg-blue-950/60 dark:text-blue-300", className)} {...props} /></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}

function ToolbarDivider() {
  return <span className="mx-0.5 h-6 w-px shrink-0 bg-border" />;
}

function CanvasShortcut({ keys, description }: { keys: string[]; description: string }) {
  return (
    <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_minmax(120px,auto)] items-center gap-4 rounded-lg px-2 py-1.5 hover:bg-muted/60">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        {keys.map((key, index) => (
          <span key={`${key}-${index}`} className="flex items-center gap-1.5">
            {index ? <span className="text-xs text-muted-foreground">+</span> : null}
            <kbd className="min-w-9 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-center text-xs font-medium leading-none shadow-sm">{key}</kbd>
          </span>
        ))}
      </span>
      <span className="text-right text-sm text-muted-foreground">{description}</span>
    </div>
  );
}

function BackgroundButton({ active, label, ...props }: React.ComponentProps<typeof Button> & { active: boolean; label: string }) {
  return <Button variant="ghost" size="sm" className={cn("h-8 flex-1 text-[11px]", active && "bg-card text-[#1456f0] dark:bg-background dark:text-blue-300")} {...props}>{props.children}{label}</Button>;
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
        {nodes.map((node) => { const point = toMap(node.x, node.y); return <span key={node.id} className={cn("pointer-events-none absolute rounded-sm", node.type === "image" ? "bg-[#1456f0]" : node.type === "video" ? "bg-orange-500" : node.type === "config" ? "bg-emerald-500" : "bg-amber-500")} style={{ left: point.x, top: point.y, width: Math.max(2, node.width * map.scale), height: Math.max(2, node.height * map.scale), opacity: .82 }} />; })}
        <span className="pointer-events-none absolute border border-[#1456f0] bg-[#1456f0]/10" style={{ left: viewportStart.x, top: viewportStart.y, width: Math.max(4, viewportEnd.x - viewportStart.x), height: Math.max(4, viewportEnd.y - viewportStart.y) }} />
      </div>
    </div>
  );
}

function CanvasRightClickMenu({ menu, onClose, onDuplicate, onDelete, onAddText, onAddImage, onAddVideo, onAddConfig, onPaste, onExportImage, onExportJSON, onImport, onClear }: {
  menu: CanvasContextMenu;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAddText: () => void;
  onAddImage: () => void;
  onAddVideo: () => void;
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
          <ContextMenuButton icon={<Type />} onClick={onAddText}>添加文字节点</ContextMenuButton>
          <ContextMenuButton icon={<ImagePlus />} onClick={onAddImage}>添加图片节点</ContextMenuButton>
          <ContextMenuButton icon={<Video />} onClick={onAddVideo}>添加视频生成节点</ContextMenuButton>
          <ContextMenuButton icon={<Settings2 />} onClick={onAddConfig}>添加生成配置节点</ContextMenuButton>
          <ContextMenuButton icon={<Clipboard />} onClick={onPaste}>粘贴节点</ContextMenuButton>
          <ContextMenuDivider />
          <ContextMenuButton icon={<Download />} onClick={onExportImage}>导出画布图片</ContextMenuButton>
          <ContextMenuButton icon={<FileDown />} onClick={onExportJSON}>导出画布</ContextMenuButton>
          <ContextMenuButton icon={<FileUp />} onClick={onImport}>导入画布</ContextMenuButton>
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

function CanvasNodeInfoContent({ node, configInputs }: { node: CanvasNode; configInputs: ReturnType<typeof canvasConfigInputs> }) {
  const [view, setView] = useState<"info" | "json">("info");
  useEffect(() => setView("info"), [node.id]);
  const json = useMemo(() => canvasNodeInfoJSON(node), [node]);
  const typeLabel = node.type === "image" ? "图片" : node.type === "video" ? "视频" : node.type === "audio" ? "音频" : node.type === "panorama" ? "全景图" : node.type === "director" ? "导演台" : node.type === "config" ? "生成配置" : node.type === "group" ? "组" : "文字";
  const nodeIcon = node.type === "image" ? <ImagePlus /> : node.type === "video" ? <Video /> : node.type === "audio" ? <Music /> : node.type === "panorama" ? <Compass /> : node.type === "director" ? <Camera /> : node.type === "config" ? <Settings2 /> : node.type === "group" ? <Grid2X2 /> : <Type />;
  const statusLabel = node.generation_status ? canvasGenerationStatusLabel(node.generation_status) : "普通节点";
  return (
    <div className="space-y-5 pb-2">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-3">
        <p className="text-xs font-semibold text-muted-foreground">节点数据</p>
        <div className="flex rounded-lg bg-muted p-1">
          <Button variant="ghost" size="sm" className={cn("h-7 rounded-md px-3 text-xs", view === "info" && "bg-card text-[#1456f0] shadow-sm")} onClick={() => setView("info")}>信息</Button>
          <Button variant="ghost" size="sm" className={cn("h-7 rounded-md px-3 text-xs", view === "json" && "bg-card text-[#1456f0] shadow-sm")} onClick={() => setView("json")}>JSON</Button>
        </div>
      </div>
      {view === "info" ? (
          <div className="space-y-5 text-sm">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#e7efff] text-[#1456f0] dark:bg-blue-950/55 dark:text-blue-300 [&>svg]:size-4.5">{nodeIcon}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-foreground">{node.title || canvasNodeFallbackTitle(node.type)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{typeLabel} · {statusLabel}</p>
              </div>
              {node.generation_status ? <span className={cn("shrink-0 rounded-full px-2 py-1 text-[11px] font-medium", node.generation_status === "success" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : node.generation_status === "error" ? "bg-rose-500/10 text-rose-600" : node.generation_status === "loading" ? "bg-blue-500/10 text-blue-600 dark:text-blue-300" : "bg-muted text-muted-foreground")}>{statusLabel}</span> : null}
            </div>
            <InfoSection title="基础信息">
              <InfoRow label="节点 ID" value={node.id} mono copyable />
              <InfoRow label="画布尺寸" value={`${Math.round(node.width)} × ${Math.round(node.height)}`} />
              {node.natural_width && node.natural_height ? <InfoRow label="原始尺寸" value={`${node.natural_width} × ${node.natural_height}`} /> : null}
              {node.bytes ? <InfoRow label="文件大小" value={formatCanvasFileBytes(node.bytes)} /> : null}
              <InfoRow label="位置" value={`${Math.round(node.x)}, ${Math.round(node.y)}`} />
              {node.type === "text" ? <InfoRow label="字号" value={`${node.font_size || 14}px`} /> : null}
              {node.batch_child_ids && node.batch_child_ids.length > 1 ? <InfoRow label="图片组" value={`${node.batch_child_ids.length} 张`} /> : null}
              {node.created_at ? <InfoRow label="创建时间" value={new Date(node.created_at).toLocaleString("zh-CN")} /> : null}
            </InfoSection>
            {node.prompt || node.composer_content ? <InfoSection title="内容">
              {node.prompt ? <InfoRow label="提示词" value={node.prompt} /> : null}
              {node.composer_content ? <InfoRow label="组装提示词" value={canvasConfigPromptDisplay(node.composer_content, configInputs)} /> : null}
            </InfoSection> : null}
            {node.task_id || node.generation_model || node.generation_type || node.generation_status || node.generation_error ? <InfoSection title="生成信息">
              {node.generation_model ? <InfoRow label="模型" value={node.generation_model} mono /> : null}
              {node.generation_type ? <InfoRow label="请求类型" value={node.generation_type === "edit" ? "图片编辑" : "图片生成"} /> : null}
              {node.generation_status ? <InfoRow label="状态" value={statusLabel} /> : null}
              {node.task_id ? <InfoRow label="任务 ID" value={node.task_id} mono copyable /> : null}
              {node.generation_error ? <InfoRow label="失败原因" value={node.generation_error} /> : null}
            </InfoSection> : null}
            {node.url ? <InfoSection title="资源">
              <InfoRow label={node.type === "video" ? "视频地址" : node.type === "audio" ? "音频地址" : node.type === "panorama" ? "全景图地址" : "图片地址"} value={node.url} mono copyable />
            </InfoSection> : null}
          </div>
        ) : (
          <ScrollArea className="max-h-[min(60dvh,32rem)] rounded-lg border border-border bg-muted/35" viewportClassName="p-4" viewClass="text-xs leading-5"><pre className="whitespace-pre-wrap break-words font-mono">{json}</pre></ScrollArea>
        )}
    </div>
  );
}

function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return <section><h3 className="mb-1.5 text-[11px] font-semibold uppercase text-muted-foreground">{title}</h3><div className="divide-y divide-border/65 border-y border-border/65">{children}</div></section>;
}

function InfoRow({ label, value, mono = false, copyable = false }: { label: string; value: string; mono?: boolean; copyable?: boolean }) {
  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("已复制");
    } catch {
      toast.error("复制失败");
    }
  };
  return <div className="grid min-h-10 grid-cols-[76px_minmax(0,1fr)] items-start gap-3 py-2.5"><span className="text-xs leading-5 text-muted-foreground">{label}</span><span className="flex min-w-0 items-start gap-1.5"><span className={cn("min-w-0 flex-1 break-words leading-5", mono && "font-mono text-xs")}>{value}</span>{copyable ? <Tooltip><TooltipTrigger asChild><button type="button" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label={`复制${label}`} onClick={() => void copyValue()}><Copy className="size-3.5" /></button></TooltipTrigger><TooltipContent>复制{label}</TooltipContent></Tooltip> : null}</span></div>;
}

function formatCanvasFileBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
