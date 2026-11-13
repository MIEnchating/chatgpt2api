"use client";

import { canvasScriptProductionNodes, canvasScriptShotPosition } from "./canvas-script-layout";
import { downloadCanvasNodeMedia } from "./canvas-media-download";

import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui/empty-state";


import { LabeledField } from "@/components/labeled-field";
import { Label } from "@/components/ui/label";
import { mergeCanvasAgentMessageQueues } from "./agent/canvas-agent-message-queue";

import { CodeBlock, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block";

import { Item, ItemMedia } from "@/components/ui/item";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

import { Toggle } from "@/components/ui/toggle";

import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";


import { uploadTemporaryMedia } from "@/services/file-storage";

import { CanvasAgentSessionConflictError, forkCanvasAgentSessionConflicts, mergeCanvasDocuments, mergeCanvasHistory } from "./canvas-document-merge";
import { canvasDocumentValuesEqual } from "./canvas-document-equality";
import { fetchCanvasAgentRun } from "./agent/canvas-agent-backend";
import { canvasAgentHistoryChanges, canvasAgentHistoryReceipt, canvasAgentHistorySummaries } from "./agent/canvas-agent-history";

import { canvasAgentStarterAttachment } from "./agent/canvas-agent-attachments";

import { resolveCanvasAgentMediaSettings } from "./agent/canvas-agent-media-settings";
import { canvasAgentAttachmentURLs } from "./agent/canvas-agent-reference";

import { waitForCreationTask, CreationTaskTimeoutError } from "@/lib/creation-task-events";
import { stopCreationTasks } from "@/lib/stop-creation-tasks";
import { imageMaskEditPrompt } from "@/lib/image-mask-edit";
import { Bot, Camera, ChevronDown, CircleDot, Clipboard, Compass, Copy, Download, Eraser, FileDown, FileUp, Grid2X2, ImagePlus, Images, Info, Menu, Music, Paperclip, Pencil, Plus, Redo2, Settings2, SlidersHorizontal, Square, Trash2, Type, Undo2, Upload, Video, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useBlocker, useNavigate, useParams, type Blocker, type BlockerFunction } from "react-router-dom";
import { toast } from "sonner";

import { CanvasNodeReferences, CanvasReferenceReturn } from "./canvas-node-references";
import { CanvasShareButton } from "@/app/canvas/canvas-share-button";
import { copyClipboardText } from "@/lib/clipboard-text";
import { CanvasEngine } from "@/app/canvas/canvas-engine";
import { CanvasNodeQuickActions, type CanvasMediaOperation } from "@/app/canvas/canvas-node-actions-panel";
import { CanvasProjectDialog, type CanvasProjectDialogMode } from "@/app/canvas/canvas-project-dialog";
import { canvasProjectIDFromRoute, canvasProjectPath } from "@/lib/canvas-project-route";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { CanvasSidePanel, type CanvasSidePanelTab } from "@/app/canvas/canvas-side-panel";
import { buildCanvasAgentContext, summarizeCanvasAgentNode, summarizeCanvasAgentTask } from "@/app/canvas/agent/canvas-agent-context";
import { queryCanvasAgentNodes } from "@/app/canvas/agent/canvas-agent-query";
import { arrangeCanvasAgentNodes, canvasAgentMediaLayoutSources, canvasAgentNodePosition, canvasAgentSourceNodeIDs, canvasAgentVideoDurationHint, canvasAgentVideoSupportsAudio, validateCanvasAgentVideoSeconds } from "@/app/canvas/agent/canvas-agent-generation";
import { isCanvasAgentSession, parseCanvasAgentSessions, clearCanvasAgentSessionReferences, syncCanvasAgentSessions } from "@/app/canvas/agent/canvas-agent-sessions";
import type { CanvasAgentAction, CanvasAgentToolResult } from "@/app/canvas/agent/canvas-agent-tools";
import type { CanvasAgentConfig, CanvasAgentState, CanvasAssistantReference, CanvasAssistantSession, CanvasInsertAssetPayload, CanvasPendingAgentRequest } from "@/app/canvas/agent/canvas-agent-types";
import { canvasPendingAgentAssetNode, createCanvasPendingAgentAsset, normalizeCanvasAgentConfig } from "@/app/canvas/agent/canvas-agent-starter";
import { applyCameraPrompt } from "@/app/canvas/canvas-camera";
import { CanvasCameraControl } from "@/app/canvas/canvas-camera-control";
import { CanvasGenerationFooter } from "@/app/canvas/canvas-generation-footer";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CanvasScriptActions, CanvasScriptPromptPanel } from "@/app/canvas/canvas-script-node";
import { concatenateScriptPrompts, createScriptProject, parseGeneratedScript, parseScriptPrompts, scriptAssetImage, scriptAssetPosition, scriptAssetConnections, scriptAssetsToGenerate, type ScriptAssetGeneration, scriptGenerationInstruction, scriptCanGenerateMedia, scriptPromptInstruction, scriptMediaPlan, scriptMediaSelection, reconcileScriptMediaDependencies, reconcileScriptProject, scriptMediaIssues, scriptShotImageNodeIDs } from "@/app/canvas/canvas-script";
import { CanvasDirector, type CanvasDirectorCapture, type CanvasDirectorPanorama, type CanvasDirectorVideo } from "@/app/canvas/canvas-director";
import { fitDirectorVideoNodeSize, getNextDirectorOutputY } from "@/app/canvas/canvas-director-output";
import { buildCanvasAudioGenerationRequest, canvasAgentAudioNodeParameters, canvasAudioGenerationReferences, canvasAudioProvider, canvasAudioReferences, canvasAudioResponseFormat, isCanvasAudioFile, resolveCanvasAudioModel, type CanvasAudioReference } from "@/app/canvas/canvas-audio";
import { detachCanvasBatchRootForReplacement, expandCanvasBatchNodeIDs, reconcileCanvasBatchesAfterRemoval, setCanvasBatchPrimary, syncCanvasBatchRootAfterRetry, visibleCanvasNodes } from "@/app/canvas/canvas-batches";
import { CanvasConfigComposer } from "@/app/canvas/canvas-config-composer";
import { canGenerateCanvasConfig, canvasConfigInputLabel, canvasConfigInputs, canvasConfigPromptDisplay, canvasGenerationInputs, type CanvasConfigInput } from "@/app/canvas/canvas-config-inputs";
import { canCreateCanvasConnection, resolveCanvasConnection } from "@/app/canvas/canvas-connections";
import { buildCanvasGenerationContext, buildCanvasImageReferencePrompt, canvasGenerationCount, canvasGenerationModel, canvasGenerationNeedsRecovery, canvasGenerationRecoveryTaskID, canvasGenerationReferenceImageURLs, canvasGenerationRequestSize, canvasVideoGenerationReferences, findCanvasRetryConfigurationNode, markCanvasGenerationRecoveryPending, restoreInterruptedCanvasGenerations } from "@/app/canvas/canvas-generation-context";
import { canvasGenerationActiveNodeID, placeCanvasGenerationResultNodes, setCanvasConfigGenerationStatus } from "@/app/canvas/canvas-generation-layout";
import { canvasTextGenerationPlan, resolveCanvasTextModel } from "@/app/canvas/canvas-text-generation";
import { createCanvasHistorySnapshot, type CanvasHistorySnapshot, appendCanvasHistorySnapshot, canvasHistoryKey, canvasHistoryLeaseExpired, canvasHistoryStorageObjectIDs, canvasHistoryStorageObjectURLs, commitCanvasGenerationHistory, restoreCanvasHistoryDocument } from "@/app/canvas/canvas-history";
import { canvasImageAngleLabel, canvasImageAnglePrompt, cropCanvasImage, splitCanvasImage, upscaleCanvasImage, type CanvasImageAngleParams, type CanvasImageCropRect, type CanvasImageSplitParams, type CanvasImageUpscaleParams } from "@/app/canvas/canvas-image-data";
import { canvasCenteredNodePosition, canvasCroppedNodeSize, canvasEmptyImageFrameFromSize, canvasEmptyMediaNodeFrame, canvasImageReplacementFrame, canvasNodeAspectRatio, canvasNodeSizeFromRatio } from "@/app/canvas/canvas-node-geometry";
import { canvasGenerationStatusLabel, canvasNodeInfoJSON } from "@/app/canvas/canvas-node-info";
import { CANVAS_GROUP_PADDING, canvasNodeBounds, expandCanvasRemovalNodeIDs, expandCanvasGroupNodeIDs } from "@/app/canvas/canvas-groups";
import { CANVAS_NODE_DEFAULT_SIZE } from "@/app/canvas/canvas-node-specs";
import { PANORAMA_IMAGE_SIZE, PANORAMA_NODE_SIZE, buildPanoramaPrompt, isStrictPanoramaSize, panoramaGenerationCount, panoramaGenerationQuality, panoramaRetryPrompt, panoramaRetryReferenceURLs } from "@/app/canvas/canvas-panorama";
import type { CanvasMaskEditPayload } from "@/app/canvas/canvas-mask-dialog";
import { applyCanvasVideoTaskProgressNodes, applyCanvasTaskImage, applyCanvasTaskProgressNodes, reconcileCancelledCanvasTaskNodes, reconcilePersistedCanvasTaskNodes, restoreCanvasTaskInitialImage, summarizeCanvasTaskResult } from "@/app/canvas/canvas-task-results";
import { canvasExportBounds } from "@/app/canvas/canvas-export";
import { createCanvasProjectArchive, downloadCanvasProjectArchive, readCanvasProjectArchive } from "@/app/canvas/canvas-project-transfer";
import { normalizeCanvasClipboard, remapCanvasNodeReferences } from "@/app/canvas/canvas-clipboard";
import { CANVAS_MIN_ZOOM, resetCanvasViewport, setCanvasViewportZoom } from "@/app/canvas/canvas-viewport";
import { canvasSaveRequired, flushCanvasSaves } from "@/app/canvas/canvas-save";
import { canvasRecoveryDraftScope, captureCanvasDraftChanges, clearCanvasRecoveryDraft, listCanvasRecoveryDrafts, readCanvasRecoveryDraft, recoverCanvasDraftDocument, writeCanvasRecoveryDraft, type CanvasRecoveryDraftSummary } from "@/app/canvas/canvas-recovery-draft";
import { resolveCanvasImageModel } from "@/app/canvas/canvas-image-model";
import { canvasImageTitle } from "@/app/canvas/canvas-image-title";
import { defaultCanvasImageParameters } from "@/app/canvas/canvas-image-parameter-defaults";
import { CanvasImageParameterPopover } from "@/app/canvas/canvas-image-parameters";
import { CanvasInlineModelSelect } from "@/app/canvas/canvas-inline-model-select";
import { CanvasPromptLibrary } from "@/app/canvas/canvas-prompt-library";
import { CanvasVideoReferences, type VideoReferenceSlot } from "@/app/canvas/canvas-video-references";
import { CanvasParameterPopover } from "@/app/canvas/canvas-parameter-popover";
import { CanvasAudioTrimDialog } from "@/app/canvas/canvas-audio-trim-dialog";
import { canvasMediaBlob, captureCanvasVideoFrame, extractCanvasAudio, type CanvasAudioTrim, type CanvasVideoFramePosition } from "@/app/canvas/canvas-media-editing";
import { AUTH_SESSION_CHANGE_EVENT, canAccessPath, type StoredAuthSession } from "@/lib/auth-session";
import { CanvasVideoPreview } from "@/app/canvas/canvas-video-player";
import { canvasVideoDisplaySize, canvasVideoFileError } from "@/app/canvas/canvas-video-import";
import { remapCanvasResourceLabels } from "./canvas-resource-mentions";
import { CanvasResourceMentionTextarea } from "@/app/canvas/canvas-resource-mention-textarea";
import { CanvasAudioPromptPanel, CanvasAudioSettingsFields, CanvasPanoramaPromptPanel, CanvasPanoramaViewer } from "@/app/canvas/canvas-special-nodes";
import { canvasNodeReferenceCandidates, type CanvasResourceReference } from "@/app/canvas/canvas-resources";
import { PromptTextareaFrame } from "@/components/generation/prompt-textarea-frame";
import {
  VideoSettingsPanel,
  type VideoSettingsValue,
} from "@/components/generation/video-settings-panel";
import {
  RelayTokenRequiredDialog,
  type RelayTokenCreationKind,
} from "@/components/relay-token-required-dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { CanvasNodeInputToolbar } from "@/app/canvas/canvas-node-input-toolbar";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CanvasEmptyState } from "./canvas-empty-state";
import { CANVAS_AGENT_WIDTH, canvasWorkspaceControlsStacked, type CanvasTool } from "./canvas-workspace-layout";
import { CANVAS_DOCK_BREAKPOINT, CANVAS_DOCK_MIN_WIDTH, CANVAS_DOCK_COMPACT_WIDTH, CANVAS_DOCK_WIDTH, CanvasNodeCreatePalette, CanvasWorkspaceControls, type CanvasCreatableNodeType } from "@/app/canvas/canvas-workspace-controls";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipHint } from "@/components/ui/tooltip";
import { cancelCreationTask, createAudioGenerationTask, createChatGenerationTask, createImageEditTask, createImageGenerationTask, createVideoGenerationTask, recoverVideoTask, fetchCreationTasks, fetchManagedImages, fetchModelConfig, imageReferenceImageLimit, supportsImageEditing, supportsImageOutputControls, supportsImageQualityValue, supportsImageResolution, supportsImageStreaming, supportsStructuredImageParameters, uploadAudioReference, uploadVideoImageReference, uploadVideoReference, type CreationTask, type CreationTaskMessage, type ImageModel, type ManagedImage } from "@/lib/api";
import { fetchAuthenticatedImageBlob, isManagedImageURL, primeAuthenticatedImageCache } from "@/lib/authenticated-image";
import { imageConversationReferenceLimitMessage } from "@/lib/image-conversation-assets";
import { isRetryableTaskPollError } from "@/lib/generation-task-contract";
import { configuredModelNames } from "@/lib/model-config-selection";
import { isPublicHTTPSReferenceURL, isPublicReferenceURL } from "@/lib/public-reference-url";
import { AutoDLWorkflowFields } from "@/components/autodl-workflow-fields";
import { isAutoDLRelay } from "@/services/api/autodl";
import { prepareImageEditReferences } from "@/lib/image-edit-references";
import { useRelayTokenPreferences } from "@/lib/use-relay-token-preferences";
import { createMyAsset, fetchMyAssets, upsertMyAsset } from "@/lib/my-assets";
import { cn } from "@/lib/utils";
import { COLOR_THEME_CHANGE_EVENT, getPreferredColorTheme, type ColorTheme } from "@/lib/theme";
import { useImageGenerationPreferences } from "@/lib/use-image-generation-preferences";
import { activateCanvasTaskQueueSession, clearCanvasTaskQueueForCanvas, clearCanvasTaskQueueForSession, syncCanvasTaskQueue } from "@/store/canvas-task-queue";
import { resolveConfiguredVideoModel, resolveVideoSeconds, supportsVideoFrameReferences, supportsVideoMultimodalReferences, videoAudioControl, videoDefaultReferenceMode, videoDefaultResolution, videoDefaultSeconds, videoDefaultSize, videoModelRequiresHTTPSReferences, videoMultimodalReferenceLimits, videoRequiresReferenceImage, videoSecondsIsValid, videoSizeLabel, videoSizeOptions, videoWorkbenchDisplayResolution, videoWorkbenchResolutionOptions, videoWorkbenchSecondsOptions } from "@/lib/video-model-capabilities";
import { normalizeVideoRequest } from "@/lib/video-request-normalizer";
import { videoContractUIState, videoModelContract } from "@/lib/video-model-contracts";
import {
  clearCanvasDocument,
  fetchCanvasDocument,
  fetchCanvasAgentHistorySession,
  importCanvasProject,
  saveCanvasDocument,
  updateCanvasProject,
  type CanvasConnection,
  type CanvasAgentSessionSummary,
  type CanvasDocument,
  type CanvasNode,
  type CanvasProjectSummary,
  type CanvasScriptProject,
  type CanvasWorkspaceResponse,
} from "@/services/api/canvas";
import { resolveMediaURL, uploadMediaBlob } from "@/services/file-storage";
import { persistCreationTaskOutputs } from "@/services/generation-result-storage";
import { resolveImageURL, uploadImage } from "@/services/image-storage";
import { getCachedAuthSession } from "@/lib/session";

const loadCanvasAgentPanel = () => import("@/app/canvas/canvas-agent-panel").then((module) => ({ default: module.CanvasAgentPanel }));
const CanvasAgentPanel = lazy(loadCanvasAgentPanel);
const CanvasAssetPicker = lazy(() => import("@/app/canvas/canvas-asset-picker").then((module) => ({ default: module.CanvasAssetPicker })));
const CanvasScriptWorkspace = lazy(() => import("@/app/canvas/canvas-script-workspace").then((module) => ({ default: module.CanvasScriptWorkspace })));
import { CanvasCropDialog, CanvasSplitDialog, CanvasUpscaleDialog, CanvasAngleDialog } from "@/app/canvas/canvas-image-tools";
import { CanvasMaskDialog } from "@/app/canvas/canvas-mask-dialog";
import { ImageLightbox } from "@/components/image-lightbox";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";

type CanvasSwitchPhase = "switching" | "revealing" | null;
type ConnectionOrigin = { nodeID: string; handleType: "source" | "target" };
type PendingConnectionCreate = ConnectionOrigin & { position: { x: number; y: number }; menu: { x: number; y: number } };
type CanvasNodeCreateMenu = { position: { x: number; y: number }; menu: { x: number; y: number } };
type CanvasContextMenu =
  | { type: "canvas"; position: { x: number; y: number } }
  | { type: "node"; nodeID: string }
  | { type: "connection"; connectionID: string };
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
type CanvasGenerationOptions = { onSubmitted?: (taskID: string) => void; resultTitle?: string; generationModel?: string; referenceImageDataURLs?: string[]; forceImageGeneration?: boolean; resultBounds?: { width: number; height: number }; resultCount?: number; selectResultNode?: boolean; concurrent?: boolean };
type CanvasActiveGeneration = {
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
  sessionKey: string;
  nodeIDs: Set<string>;
  taskIDs: Set<string>;
  submittedTaskIDs: Set<string>;
};
const DEFAULT_AGENT_PANEL = { open: false, width: CANVAS_AGENT_WIDTH, mode: "floating" as const };
const DEFAULT_DOCUMENT: CanvasDocument = { version: 1, id: "", revision: 0, title: "我的画布", background: "dots", show_image_info: false, nodes: [], connections: [], agent_panel: DEFAULT_AGENT_PANEL, viewport: { zoom: 1, x: 0, y: 0 } };
const MAX_HISTORY = 50;
const SIDE_PANEL_STORAGE_KEY = "yunmian-canvas-side-panel";
const DEFAULT_SIDE_PANEL = { open: false, width: 304, tab: "canvas" as CanvasSidePanelTab };
const IMAGE_PROMPT_REVERSE_PRESET = `请根据参考图片反推一段适合用于 AI 生图的提示词。

要求：
1. 只输出提示词正文，不要解释。
2. 覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。
3. 尽量写成可直接用于生图模型的完整提示词。`;


function storedCanvasSidePanel(): typeof DEFAULT_SIDE_PANEL {
  if (typeof window === "undefined") return DEFAULT_SIDE_PANEL;
  const desktop = window.matchMedia("(min-width: 768px)").matches;
  try {
    const stored = JSON.parse(window.localStorage.getItem(SIDE_PANEL_STORAGE_KEY) || "null") as Partial<typeof DEFAULT_SIDE_PANEL> | null;
    return {
      open: desktop && stored?.open === true,
      width: Math.min(480, Math.max(260, Number(stored?.width) || DEFAULT_SIDE_PANEL.width)),
      tab: stored?.tab === "assets" || stored?.tab === "prompts" ? stored.tab : "canvas" as CanvasSidePanelTab,
    };
  } catch {
    return DEFAULT_SIDE_PANEL;
  }
}

function cloneDocument(document: CanvasDocument, baseline?: CanvasDocument): CanvasDocument {
  if (!baseline || !document.agent_sessions?.length) return JSON.parse(JSON.stringify(document)) as CanvasDocument;
  // Reuse only fields already isolated in the immutable server baseline.
  const previous = new Map(parseCanvasAgentSessions(baseline.agent_sessions).map(session => [session.id, session]));
  const retained: Record<string, unknown>[] = [];
  const changes = parseCanvasAgentSessions(document.agent_sessions).map(session => {
    const original = previous.get(session.id) as unknown as Record<string, unknown> | undefined;
    const keep: Record<string, unknown> = Object.create(null), changed: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(session)) {
      if (value === undefined) continue;
      if (original && Object.hasOwn(original, key) && canvasDocumentValuesEqual(value, original[key])) keep[key] = original[key];
      else changed[key] = value;
    }
    retained.push(keep);
    return changed;
  });
  const copy = JSON.parse(JSON.stringify({ ...document, agent_sessions: changes })) as CanvasDocument;
  copy.agent_sessions = (copy.agent_sessions || []).map((session, index) => ({ ...retained[index], ...(session as Record<string, unknown>) }));
  return copy;
}

function randomID() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function createdAt() {
  return new Date().toISOString();
}

function storedCanvasAgentSessions(document: CanvasDocument, restoreInterrupted = true): CanvasAssistantSession[] {
  const sessions = parseCanvasAgentSessions(document.agent_sessions);
  if (sessions.length) return syncCanvasAgentSessions(sessions, document.nodes, restoreInterrupted && (!document.agent_run || document.agent_run.engine === "codex-tools" && document.agent_run.status !== "running"));
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
  return normalizeCanvasAgentConfig(value);
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
  if (isPublicReferenceURL(url) && !isManagedImageURL(url)) return url;
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
  if (!url || isPublicReferenceURL(url) && !isManagedImageURL(url)) return url;
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
  if (type === "script") return "脚本";
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
	const model = node?.generation_video_model || "";
	const sizes = videoSizeOptions(model);
	const normalizedSeconds = resolveVideoSeconds(model, node?.generation_video_seconds);
	const defaultSize = videoDefaultSize(model);
	const storedSize = String(node?.generation_video_size || "");
	const normalizedSize = sizes.includes(storedSize) ? storedSize : defaultSize;
	let referenceMode = videoDefaultReferenceMode(model);
  if (node?.generation_video_reference_mode === "reference" && supportsVideoMultimodalReferences(model)) {
    referenceMode = "reference";
  } else if (node?.generation_video_reference_mode === "first-frame" && supportsVideoFrameReferences(model)) {
    referenceMode = "first-frame";
  }
	return {
    generation_video_model: model,
		generation_video_size: normalizedSize,
		generation_video_seconds: normalizedSeconds,
    generation_video_parameters: node?.generation_video_parameters,
			generation_video_resolution: videoWorkbenchDisplayResolution(model, node?.generation_video_resolution || ""),
	    generation_video_audio: videoAudioControl(model) === "toggle" ? (node?.generation_video_audio ?? false) : videoAudioControl(model) === "always",
	    generation_video_watermark: node?.generation_video_watermark ?? false,
			generation_video_reference_mode: referenceMode,
		generation_video_reference_image_urls: Array.isArray(node?.generation_video_reference_image_urls) ? node.generation_video_reference_image_urls : [],
    generation_video_reference_urls: Array.isArray(node?.generation_video_reference_urls) ? node.generation_video_reference_urls : [],
			generation_video_reference_audio_urls: Array.isArray(node?.generation_video_reference_audio_urls) ? node.generation_video_reference_audio_urls : [],
				exclude_upstream_text: node?.exclude_upstream_text ?? false,
				generation_video_first_frame_node_id: node?.generation_video_first_frame_node_id,
				generation_video_last_frame_node_id: node?.generation_video_last_frame_node_id,
    generation_video_last_frame_url: node?.generation_video_last_frame_url || "",
	  };
}

function canvasVideoModelPatch(model: string) {
  const presets = videoWorkbenchSecondsOptions(model);
  const seconds = presets.find((value) => value > 0) || videoDefaultSeconds(model);
  const resolutions = videoWorkbenchResolutionOptions(model);
  return {
    generation_video_model: model,
    generation_video_size: videoDefaultSize(model),
    generation_video_seconds: seconds,
    generation_video_parameters: {},
    generation_video_resolution: resolutions[0] || videoDefaultResolution(model),
    generation_video_reference_mode: videoDefaultReferenceMode(model),
  };
}

function normalizeCanvasVideoNode(node: CanvasNode) {
  if (node.type !== "video" || node.generation_video_model === "local-video-merge") return node;
  const params = canvasVideoParameters(node);
  return {
    ...node,
    generation_video_model: params.generation_video_model,
    generation_video_size: params.generation_video_size,
    generation_video_seconds: params.generation_video_seconds,
    generation_video_parameters: params.generation_video_parameters,
    generation_video_resolution: params.generation_video_resolution,
	    generation_video_audio: params.generation_video_audio,
	    generation_video_watermark: params.generation_video_watermark,
	    generation_video_reference_mode: params.generation_video_reference_mode,
    generation_video_reference_image_urls: params.generation_video_reference_image_urls,
    generation_video_reference_urls: params.generation_video_reference_urls,
    generation_video_reference_audio_urls: params.generation_video_reference_audio_urls,
    generation_video_last_frame_url: params.generation_video_last_frame_url,
				exclude_upstream_text: params.exclude_upstream_text,
				generation_video_first_frame_node_id: params.generation_video_first_frame_node_id,
				generation_video_last_frame_node_id: params.generation_video_last_frame_node_id,
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

function CanvasVideoPromptPanel({ node, mentionReferences = [], onReferenceSelect, relayTokenName, inputs, running, generationBusy, showPromptEditor = true, showGenerateFooter = true, videoModels, onPromptChange, onParametersChange, onGenerate, onStop }: { node: CanvasNode; mentionReferences?: readonly CanvasResourceReference[]; onReferenceSelect?: (reference: CanvasResourceReference) => void; relayTokenName: string; inputs: readonly CanvasConfigInput[]; running: boolean; generationBusy: boolean; uploading?: boolean; showPromptEditor?: boolean; showGenerateFooter?: boolean; videoModels: string[]; onPromptChange: (value: string, commit?: boolean) => void; onParametersChange: (patch: Partial<CanvasNode>) => void; onGenerate: (prompt: string) => void; onStop: () => void; onUpload?: () => void }) {
  const [prompt, setPrompt] = useState(node.prompt || "");
  const [parameterSection, setParameterSection] = useState<"output" | "references">("output");
  const connectedPromptAvailable = inputs.some((input) => input.type === "text" && Boolean(input.text?.trim()));
  useEffect(() => setPrompt(node.prompt || ""), [node.id, node.prompt]);
  const params = canvasVideoParameters(node);
  const modelOptions = videoModels;
  const modelAvailable = modelOptions.includes(params.generation_video_model);
  const videoReferenceSupported = supportsVideoMultimodalReferences(params.generation_video_model);
  const audioReferenceSupported = videoMultimodalReferenceLimits(params.generation_video_model).audio > 0;
  const referenceImageURL = params.generation_video_reference_image_urls[0] || "";
  const referenceVideoURL = params.generation_video_reference_urls[0] || "";
  const referenceAudioURL = params.generation_video_reference_audio_urls[0] || "";
  const videoRuleValues = {
    first_frame: params.generation_video_reference_mode === "first-frame" ? referenceImageURL || params.generation_video_first_frame_node_id || "" : "",
    last_frame: params.generation_video_reference_mode === "first-frame" ? params.generation_video_last_frame_url || params.generation_video_last_frame_node_id || "" : "",
    reference_image: params.generation_video_reference_mode === "reference" ? params.generation_video_reference_image_urls.length : 0,
    reference_video: params.generation_video_reference_mode === "reference" ? params.generation_video_reference_urls.length : 0,
    reference_audio: params.generation_video_reference_mode === "reference" ? params.generation_video_reference_audio_urls.length : 0,
    generate_audio: params.generation_video_audio,
    size: params.generation_video_size,
    resolution: params.generation_video_resolution,
    duration: params.generation_video_seconds,
    watermark: params.generation_video_watermark,
  };
  const videoContractUI = videoContractUIState(videoModelContract(params.generation_video_model), videoRuleValues);
  const videoFieldVisible = (field: "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio") => !videoContractUI.hidden.has(field);
  const videoFieldDisabled = (field: "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio") => videoContractUI.disabled.has(field);
  const imageRuleField = params.generation_video_reference_mode === "reference" ? "reference_image" : "first_frame";
  const visibleReferenceMaterials = videoFieldVisible(imageRuleField) || videoFieldVisible("reference_video") || videoFieldVisible("reference_audio");
  const [referenceUploading, setReferenceUploading] = useState<VideoReferenceSlot | "" >("");
  const videoSettingsValue: VideoSettingsValue = {
    size: params.generation_video_size,
    seconds: String(params.generation_video_seconds),
    parameters: params.generation_video_parameters,
    resolution: params.generation_video_resolution || "",
    generateAudio: params.generation_video_audio,
    watermark: params.generation_video_watermark,
    taskCount: 1,
  };
  function updateVideoSettings(patch: Partial<VideoSettingsValue>) {
    onParametersChange({
      ...(patch.size !== undefined ? { generation_video_size: patch.size } : {}),
      ...(patch.parameters !== undefined ? {generation_video_parameters:patch.parameters} : {}),
      ...(patch.seconds !== undefined && videoSecondsIsValid(params.generation_video_model, Number(patch.seconds)) ? { generation_video_seconds: Number(patch.seconds) } : {}),
      ...(patch.resolution !== undefined ? { generation_video_resolution: patch.resolution } : {}),
      ...(patch.generateAudio !== undefined ? { generation_video_audio: patch.generateAudio } : {}),
      ...(patch.watermark !== undefined ? { generation_video_watermark: patch.watermark } : {}),
    });
  }
  async function uploadReferenceImage(file: File, slot: "image" | "last-frame" = "image") {
    if (!file.type.startsWith("image/")) return toast.error("参考图片仅支持 PNG、JPG 或 WebP 格式");
    if (file.size > 20 * 1024 * 1024) return toast.error("参考图片不能超过 20 MiB");
    setReferenceUploading(slot);
    try {
      const uploaded = await uploadImage(file);
      onParametersChange(slot === "last-frame" ? { generation_video_last_frame_url: uploaded.url, generation_video_last_frame_node_id: undefined } : { generation_video_reference_image_urls: [uploaded.url], ...(params.generation_video_reference_mode === "first-frame" ? { generation_video_first_frame_node_id: undefined } : {}) });
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
      onParametersChange({ generation_video_reference_urls: [uploaded.url] });
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
      onParametersChange({ generation_video_reference_audio_urls: [uploaded.url] });
      toast.success("参考音频已上传");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "参考音频上传失败");
    } finally {
      setReferenceUploading("");
    }
  }
  const referenceFrameVisible = supportsVideoFrameReferences(params.generation_video_model) && (videoFieldVisible("first_frame") || videoFieldVisible("last_frame"));
  const referencePanelVisible = visibleReferenceMaterials || referenceFrameVisible;
  const durationLabel = params.generation_video_seconds < 0 ? "智能时长" : `${params.generation_video_seconds} 秒`;
  const parameterSummary = params.generation_video_size ? `${durationLabel} · ${videoSizeLabel(params.generation_video_size)}` : durationLabel;
  const workflowFields = <AutoDLWorkflowFields tokenName={relayTokenName} model={params.generation_video_model} value={node.generation_workflow_inputs || {}} onChange={(generation_workflow_inputs) => onParametersChange({ generation_workflow_inputs })} disabled={running} />;
  return <div className="flex h-full min-h-0 flex-col gap-2">
    {showPromptEditor ? <PromptTextareaFrame value={prompt} className="min-h-0 flex-1">
      <CanvasResourceMentionTextarea references={mentionReferences} onReferenceSelect={onReferenceSelect} value={prompt} onChange={(value) => { setPrompt(value); onPromptChange(value); }} onBlur={(event) => onPromptChange(event.target.value, true)} placeholder="描述你想生成的视频" containerClassName="min-h-full" className="min-h-full w-full resize-none overflow-hidden" />
    </PromptTextareaFrame> : null}
    <CanvasNodeInputToolbar action={showGenerateFooter ? <CanvasGenerationFooter
      running={running}
      disabled={!running && (generationBusy || !modelAvailable || (!prompt.trim() && !connectedPromptAvailable && videoModelContract(params.generation_video_model)?.capability.prompt?.required !== false) || !videoSecondsIsValid(params.generation_video_model, params.generation_video_seconds))}
      onGenerate={() => onGenerate(prompt.trim())}
      onStop={onStop}
    /> : undefined}>
      {showPromptEditor ? <CanvasInlineModelSelect value={params.generation_video_model} models={modelOptions} label="视频模型" onChange={(model) => onParametersChange(canvasVideoModelPatch(model))} /> : null}
      <CanvasParameterPopover icon={<SlidersHorizontal />} label="视频参数" summary={parameterSummary} width={440}>
        {referencePanelVisible ? <div role="group" aria-label="视频设置分类" className="mb-4 grid grid-cols-2 gap-1 p-1">
          <Toggle  type="button" pressed={parameterSection === "output"} className="flex items-center justify-center" onClick={() => setParameterSection("output")}><Video  />视频参数</Toggle>
          <Toggle  type="button" pressed={parameterSection === "references"} className="flex items-center justify-center" onClick={() => setParameterSection("references")}><Paperclip  />参考素材</Toggle>
        </div> : null}
        <div hidden={referencePanelVisible && parameterSection !== "output"} className="space-y-4 text-xs">
          {workflowFields}
          <VideoSettingsPanel model={params.generation_video_model} value={videoSettingsValue} ruleValues={videoRuleValues} onChange={updateVideoSettings} showTaskCount={false} />
        </div>
        {referencePanelVisible ? <div hidden={parameterSection !== "references"}>
          <CanvasVideoReferences node={node} inputs={inputs} mode={params.generation_video_reference_mode} supportsFrames={supportsVideoFrameReferences(params.generation_video_model)} supportsMultimodal={videoReferenceSupported}
            supportsLastFrame={Boolean(videoModelContract(params.generation_video_model)?.generation.modes.some(mode => mode.materials.last_frame.max > 0))}
            supportsText={Boolean(videoModelContract(params.generation_video_model)?.generation.modes.some(mode => mode.kind === "text"))}
            uploading={referenceUploading} onChange={onParametersChange}
            onUpload={async (slot, file) => { if (slot === "video") await uploadReferenceVideo(file); else if (slot === "audio") await uploadReferenceAudio(file); else await uploadReferenceImage(file, slot); }}
            materials={[
              { slot: "image", label: params.generation_video_reference_mode === "reference" ? "参考图" : "首帧", hint: "PNG / JPG / WebP", help: "首帧确定开场画面，参考图用于提供主体和风格依据。", accept: "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp", url: referenceImageURL, nodeID: params.generation_video_reference_mode === "first-frame" ? params.generation_video_first_frame_node_id : undefined, visible: videoFieldVisible(imageRuleField), disabled: videoFieldDisabled(imageRuleField) },
              { slot: "last-frame", label: "尾帧", hint: "PNG / JPG / WebP", help: "确定视频结束时的画面；需要成对提供首尾帧时，请同时添加两张图片。", accept: "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp", url: params.generation_video_last_frame_url, nodeID: params.generation_video_last_frame_node_id, visible: params.generation_video_reference_mode === "first-frame" && videoFieldVisible("last_frame") && Boolean(videoModelContract(params.generation_video_model)?.generation.modes.some(mode => mode.materials.last_frame.max > 0)), disabled: videoFieldDisabled("last_frame") },
              { slot: "video", label: "参考视频", hint: "MP4 / MOV", help: "提供动作或镜头参考，具体能力由模型决定。", accept: "video/mp4,video/quicktime,.mp4,.mov", url: referenceVideoURL, visible: params.generation_video_reference_mode === "reference" && videoFieldVisible("reference_video") && videoMultimodalReferenceLimits(params.generation_video_model).video > 0, disabled: videoFieldDisabled("reference_video") },
              { slot: "audio", label: "参考音频", hint: "MP3 / WAV", help: "提供声音参考，能否驱动口型由模型决定。", accept: "audio/mpeg,audio/wav,.mp3,.wav", url: referenceAudioURL, visible: params.generation_video_reference_mode === "reference" && videoFieldVisible("reference_audio") && audioReferenceSupported, disabled: videoFieldDisabled("reference_audio") },
            ]} />
        </div> : null}
      </CanvasParameterPopover>
      {showPromptEditor ? <CanvasPromptLibrary onSelect={(value) => { setPrompt(value); onPromptChange(value, true); }} /> : null}
    </CanvasNodeInputToolbar>
  </div>;
}

function canvasImageParameters(node?: CanvasNode | null) {
  const defaults = defaultCanvasImageParameters();
  return {
    generation_size: node?.generation_size ?? defaults.generation_size,
    generation_resolution: node?.generation_resolution ?? defaults.generation_resolution,
    generation_quality: node?.generation_quality ?? defaults.generation_quality,
    generation_image_options: node?.generation_image_options,
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
    generation_workflow_inputs: node.generation_workflow_inputs,
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

function CanvasTextPromptPanel({ node, mentionReferences, onReferenceSelect, model, models, running, cancelling, canGenerate, onPromptChange, onModelChange, onGenerate, onStop }: {
  node: CanvasNode;
  mentionReferences: readonly CanvasResourceReference[];
  onReferenceSelect: (reference: CanvasResourceReference) => void;
  model: string;
  models: string[];
  running: boolean;
  cancelling: boolean;
  canGenerate: boolean;
  onPromptChange: (value: string, commit?: boolean) => void;
  onModelChange: (value: string) => void;
  onGenerate: () => void;
  onStop: () => void;
}) {
  const [content, setContent] = useState(node.composer_content || "");

  useEffect(() => {
    setContent(node.composer_content || "");
  }, [node.id, node.composer_content]);

  function updateContent(value: string, commit = false) {
    setContent(value);
    onPromptChange(value, commit);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <PromptTextareaFrame value={content} className="min-h-0 flex-1">
        <CanvasResourceMentionTextarea
          value={content}
          references={mentionReferences}
          onReferenceSelect={onReferenceSelect}
          onChange={updateContent}
          onBlur={(event) => updateContent(event.target.value, true)}
          onSubmit={() => { if (canGenerate && !running) onGenerate(); }}
          aria-label="文本生成要求"
          placeholder="输入生成或修改要求，@ 引用画布节点"
          containerClassName="min-h-full"
          className="min-h-full resize-none overflow-hidden"
        />
      </PromptTextareaFrame>
      <CanvasNodeInputToolbar action={<CanvasGenerationFooter running={running} stopping={cancelling} disabled={running ? cancelling : !canGenerate} onGenerate={onGenerate} onStop={onStop} />}>
        <CanvasInlineModelSelect value={model} models={models} label="文本模型" onChange={onModelChange} />
        <CanvasPromptLibrary onSelect={(value) => updateContent(value, true)} />
      </CanvasNodeInputToolbar>
    </div>
  );
}

function CanvasNodePromptPanel({ node, prompt, onDraftChange, mentionReferences, onReferenceSelect, running, generationBusy, imageModel, imageModels, imageModelReady, cancelling, canStop, connectedPromptAvailable, onPromptChange, onParametersChange, onGenerate, onStop }: {
  node: CanvasNode;
  prompt: string;
  onDraftChange: (value: string) => void;
  mentionReferences: readonly CanvasResourceReference[];
  onReferenceSelect: (reference: CanvasResourceReference) => void;
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
  function updatePrompt(value: string) {
    onDraftChange(value);
    if (!editingExistingImage) onPromptChange(value);
  }

  function submit() {
    const value = prompt.trim();
    if ((!value && !connectedPromptAvailable) || generationBusy) return;
    onGenerate(value);
    onDraftChange("");
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <PromptTextareaFrame value={prompt} className="min-h-0 flex-1">
        <CanvasResourceMentionTextarea
          value={prompt}
          references={mentionReferences}
          onReferenceSelect={onReferenceSelect}
          onChange={updatePrompt}
          onSubmit={submit}
          onBlur={(event) => { if (!editingExistingImage) onPromptChange(event.target.value, true); }}
          aria-label="图片生成要求"
          placeholder={editingExistingImage ? "描述你想如何修改这张图，@ 引用画布节点" : "描述要生成的图片，@ 引用画布节点"}
          containerClassName="min-h-full"
          className="min-h-full resize-none overflow-hidden"
        />
      </PromptTextareaFrame>
      <CanvasNodeInputToolbar action={<CanvasGenerationFooter
          running={running}
          stopping={cancelling}
          disabled={running ? !canStop || cancelling : !imageModelReady || (!prompt.trim() && !connectedPromptAvailable) || generationBusy}
          onGenerate={submit}
          onStop={onStop}
        />}>
        <CanvasInlineModelSelect value={node.generation_model?.trim() || imageModel} models={imageModels} label="图片模型" onChange={(generation_model) => onParametersChange({ generation_model })} />
        <CanvasImageParameterPopover node={node} imageModel={imageModel} imageModels={imageModels} onChange={onParametersChange} showModel={false} />
        <CanvasCameraControl value={node.camera_control} onChange={(camera_control) => onParametersChange({ camera_control })} className="h-8 shrink-0" />
        <CanvasPromptLibrary onSelect={updatePrompt} />
      </CanvasNodeInputToolbar>
    </div>
  );
}

export default function CanvasRoute() {
  const { projectID: routeProjectID } = useParams<{ projectID?: string }>();
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/canvas");
  if (isCheckingAuth || !session) return <LoadingState label="正在加载画布" />;
  return <CanvasPage session={session} projectID={canvasProjectIDFromRoute(routeProjectID)} />;
}

function CanvasPage({ session, projectID }: { session: StoredAuthSession; projectID?: string }) {
  const navigate = useNavigate();
  const { preferences: imageGenerationPreferences } = useImageGenerationPreferences(session.key);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const agentAreaRef = useRef<HTMLDivElement | null>(null);
  const [agentAreaWidth, setAgentAreaWidth] = useState(0);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const documentRef = useRef(cloneDocument(DEFAULT_DOCUMENT));
  const serverDocumentRef = useRef(cloneDocument(DEFAULT_DOCUMENT));
  const [backendAgentRun, setBackendAgentRun] = useState<CanvasDocument["agent_run"]>();
  const [agentLocallyObserving, setAgentLocallyObserving] = useState(false);
  const [agentSyncError, setAgentSyncError] = useState("");
  const [canvasSaveError, setCanvasSaveError] = useState("");
  const [savingCanvas, setSavingCanvas] = useState(false);
  const [recoveryDrafts, setRecoveryDrafts] = useState<CanvasRecoveryDraftSummary[]>([]);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [discardRecoveryDraft, setDiscardRecoveryDraft] = useState<CanvasRecoveryDraftSummary | null>(null);
  const [processingRecoveryDraft, setProcessingRecoveryDraft] = useState(false);
  const [recoveryDraftError, setRecoveryDraftError] = useState("");
  const [agentHistoryConflict, setAgentHistoryConflict] = useState<CanvasAgentSessionConflictError | null>(null);
  const agentHistoryConflictRef = useRef<CanvasAgentSessionConflictError | null>(null);
  const [resolvingAgentHistory, setResolvingAgentHistory] = useState(false);
  const backendSnapshotRef = useRef<(document: CanvasDocument) => void>(() => {});
  const nodesRef = useRef<CanvasNode[]>([]);
  const connectionsRef = useRef<CanvasConnection[]>([]);
  const selectedNodeIDsRef = useRef(new Set<string>());
  const viewportRef = useRef(DEFAULT_DOCUMENT.viewport);
  const titleRef = useRef(DEFAULT_DOCUMENT.title);
  const backgroundRef = useRef(DEFAULT_DOCUMENT.background);
  const showImageInfoRef = useRef(Boolean(DEFAULT_DOCUMENT.show_image_info));
  const historyRef = useRef<CanvasHistorySnapshot[]>([]);
  const redoRef = useRef<CanvasHistorySnapshot[]>([]);
  const generationHistoryBaseRef = useRef<CanvasHistorySnapshot[] | null>(null);
  const clipboardRef = useRef<{ nodes: CanvasNode[]; connections: CanvasConnection[] }>({ nodes: [], connections: [] });
  const saveTimerRef = useRef<number | null>(null);
  const recoveryDraftTimerRef = useRef<number | null>(null);
  const recoveryDraftWriterRef = useRef("");
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const libraryRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const saveChangeVersionRef = useRef(0);
  const persistedChangeVersionRef = useRef(0);
  const saveRequestVersionRef = useRef(0);
  const canvasDocumentEpochRef = useRef(0);
  const switchRevealTimerRef = useRef<number | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const temporaryUploadRef = useRef(false);
  const batchUploadRef = useRef(false);
  const uploadNodeIDRef = useRef("");
  const uploadPositionRef = useRef<{ x: number; y: number } | null>(null);
  const cancelledTaskIDsRef = useRef(new Set<string>());
  const generationAbortControllerRef = useRef<AbortController | null>(null);
  const activeGenerationsRef = useRef(new Map<string, CanvasActiveGeneration>());
  const canvasRecoveryAbortControllerRef = useRef<AbortController | null>(null);
  const generationEpochRef = useRef(0);
  const canvasOperationEpochRef = useRef(0);
  const mediaOperationsRef = useRef(new Map<string, AbortController>());
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
  // Keep the array identity stable so the Agent panel is not handed a new prop on every canvas frame.
  const agentSelectedNodeIDs = useMemo(() => [...selectedNodeIDs], [selectedNodeIDs]);
  const [selectedConnectionID, setSelectedConnectionID] = useState("");
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ mode: CanvasProjectDialogMode; title: string } | null>(null);
  const [sidePanel, setSidePanel] = useState(storedCanvasSidePanel);
  const [canvasTool, setCanvasTool] = useState<CanvasTool>("select");
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentPanelMounted, setAgentPanelMounted] = useState(false);
  const [assetPickerMounted, setAssetPickerMounted] = useState(false);
  const [imageToolsMounted, setImageToolsMounted] = useState(false);
  const [imageLightboxMounted, setImageLightboxMounted] = useState(false);
  const [agentDisplayMode, setAgentDisplayMode] = useState<"floating" | "docked">("floating");
  const [agentSessions, setAgentSessions] = useState<CanvasAssistantSession[]>([]);
  const [agentSessionSummaries, setAgentSessionSummaries] = useState<CanvasAgentSessionSummary[]>([]);
  const [activeAgentSessionID, setActiveAgentSessionID] = useState("");
  const [agentHistoryLoadError, setAgentHistoryLoadError] = useState("");
  const [agentHistoryReload, setAgentHistoryReload] = useState(0);
  const agentHistoryMissing = agentSessionSummaries.some((item) => item.id === activeAgentSessionID)
    && !agentSessions.some((item) => item.id === activeAgentSessionID);
  const [initialAgentRequest, setInitialAgentRequest] = useState<{ prompt: string; references: CanvasAssistantReference[] } | null>(null);
  const [agentReferenceNodeClick, setAgentReferenceNodeClick] = useState<{ nodeID: string | null; version: number }>({ nodeID: null, version: 0 });
  const [agentConfig, setAgentConfig] = useState<CanvasAgentConfig | null>(null);
  const scriptMediaSubmissionsRef = useRef(new Map<string, AbortController>());
  const [openScriptNodeID, setOpenScriptNodeID] = useState("");
  const [regenerateScriptNodeID, setRegenerateScriptNodeID] = useState("");
  const [openDirectorNodeID, setOpenDirectorNodeID] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryImages, setLibraryImages] = useState<ManagedImage[]>([]);
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [showConnections, setShowConnections] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<PendingConnectionCreate | null>(null);
  const [nodeCreateMenu, setNodeCreateMenu] = useState<CanvasNodeCreateMenu | null>(null);
  const [panelNodeID, setPanelNodeID] = useState("");
  const [imagePromptDrafts, setImagePromptDrafts] = useState<Record<string, string>>({});
  const [referenceReturn, setReferenceReturn] = useState<{ nodeID: string; viewport: CanvasDocument["viewport"]; panelNodeID: string; expiresAt: number } | null>(null);
  useEffect(() => {
    if (!referenceReturn) return;
    const timer = window.setTimeout(() => setReferenceReturn(null), Math.max(0, referenceReturn.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [referenceReturn]);
  const [exportingCanvas, setExportingCanvas] = useState(false);
  const [previewNodeID, setPreviewNodeID] = useState("");
  const [uploadingNodeID, setUploadingNodeID] = useState("");
  const [nodeInfoID, setNodeInfoID] = useState("");
  const nodeInfo = nodes.find((node) => node.id === nodeInfoID);
  const contextMenuTriggerID = useId();
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null);
  const [runningNodeID, setRunningNodeID] = useState("");
  const [runningResultNodeID, setRunningResultNodeID] = useState("");
  const [runningTaskID, setRunningTaskID] = useState("");
  const [activeGenerationNodeIDs, setActiveGenerationNodeIDs] = useState(new Set<string>());
  const [cancellingGenerationNodeIDs, setCancellingGenerationNodeIDs] = useState(new Set<string>());
  const [stopTargetNodeID, setStopTargetNodeID] = useState("");
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const [pendingPanoramaImport, setPendingPanoramaImport] = useState<PendingPanoramaImport | null>(null);
  const [imageTool, setImageTool] = useState<CanvasImageToolState | null>(null);
  const [imageToolBusy, setImageToolBusy] = useState(false);
  const [mediaBusyNodeIDs, setMediaBusyNodeIDs] = useState(new Set<string>());
  const [audioTrimNodeID, setAudioTrimNodeID] = useState("");
  const [maskEditModel, setMaskEditModel] = useState("");
  const [collapsingBatchRootIDs, setCollapsingBatchRootIDs] = useState(new Set<string>());
  const [openingBatchRootIDs, setOpeningBatchRootIDs] = useState(new Set<string>());
  const [imageModel, setImageModel] = useState<ImageModel>("");
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [imageModelReady, setImageModelReady] = useState(false);
  const [textModel, setTextModel] = useState("gpt-5.5");
  const [textModels, setTextModels] = useState<string[]>([]);
  const [videoModel, setVideoModel] = useState("");
  const [videoModels, setVideoModels] = useState<string[]>([]);
  const [audioModel, setAudioModel] = useState("");
  const [audioModels, setAudioModels] = useState<string[]>([]);
  const defaultCanvasModelsRef = useRef({ imageModel: "", textModel: "gpt-5.5", videoModel: "" });
  const { tokenNameForModel, nextTokenNameForModel } = useRelayTokenPreferences();
  const [relayTokenDialogKind, setRelayTokenDialogKind] = useState<RelayTokenCreationKind | null>(null);
  const [switchPhase, setSwitchPhase] = useState<CanvasSwitchPhase>(null);
  const [switchLabel, setSwitchLabel] = useState("正在切换画布…");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() => getPreferredColorTheme());
  const [, setHistoryVersion] = useState(0);

  useEffect(() => {
    selectedNodeIDsRef.current = selectedNodeIDs;
  }, [selectedNodeIDs]);

  useEffect(() => {
    if (agentOpen || agentSessions.some((session) => session.resumeAssistantMessageId || session.messages.some((message) => message.status === "thinking" || message.status === "running"))) setAgentPanelMounted(true);
  }, [agentOpen, agentSessions]);

  useEffect(() => {
    if (assetPickerOpen) setAssetPickerMounted(true);
  }, [assetPickerOpen]);

  useEffect(() => {
    if (imageTool) setImageToolsMounted(true);
  }, [imageTool]);

  useEffect(() => {
    if (previewNodeID) setImageLightboxMounted(true);
  }, [previewNodeID]);

  useEffect(() => {
    const handleThemeChange = (event: Event) => {
      const nextTheme = (event as CustomEvent<ColorTheme>).detail;
      if (nextTheme === "light" || nextTheme === "dark") setColorTheme(nextTheme);
    };
    window.addEventListener(COLOR_THEME_CHANGE_EVENT, handleThemeChange);
    return () => window.removeEventListener(COLOR_THEME_CHANGE_EVENT, handleThemeChange);
  }, []);

  const preferredCanvasImageParameters = useCallback((): Partial<CanvasNode> => ({
    ...defaultCanvasImageParameters(imageGenerationPreferences),
  }), [imageGenerationPreferences]);

  function preferredCanvasAudioParameters(model = audioModel): Partial<CanvasNode> {
    return {
      generation_audio_model: model,
      ...canvasAgentAudioNodeParameters(model, imageGenerationPreferences.default_audio_voice, imageGenerationPreferences.audio_instructions, "", { format: imageGenerationPreferences.default_audio_format, speed: imageGenerationPreferences.default_audio_speed }),
    };
  }

  const resolvedAgentConfig = useMemo(() => normalizeCanvasAgentConfig(agentConfig), [agentConfig]);

  const openScriptNode = nodes.find((node) => node.id === openScriptNodeID && node.type === "script") || null;
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


  useEffect(() => {
    let active = true;
    void fetchModelConfig()
      .then(({ config }) => {
        if (active) {
          const configuredImageModels = configuredModelNames(config.image_models)
            .filter((model) => model.toLowerCase() !== "auto");
          const configuredTextModels = configuredModelNames(config.text_models);
          const configuredVideoModels = configuredModelNames(config.video_models);
          const configuredAudioModels = configuredModelNames(config.audio_models);
          const personalImageModel = configuredImageModels.includes(imageGenerationPreferences.default_image_model)
            ? imageGenerationPreferences.default_image_model
            : config.default_image_model;
          const personalVideoModel = resolveConfiguredVideoModel(
            configuredVideoModels,
            imageGenerationPreferences.workbench.video_model,
            imageGenerationPreferences.default_video_model,
            config.default_video_model,
          );
          const personalTextModel = configuredTextModels.includes(imageGenerationPreferences.default_text_model)
            ? imageGenerationPreferences.default_text_model
            : config.default_text_model;
          const personalAudioModel = configuredAudioModels.includes(imageGenerationPreferences.default_audio_model)
            ? imageGenerationPreferences.default_audio_model
            : config.default_audio_model;
          const defaults = {
            imageModel: resolveCanvasImageModel(personalImageModel, configuredImageModels),
            textModel: resolveCanvasTextModel(personalTextModel, configuredTextModels),
            videoModel: personalVideoModel,
          };
          defaultCanvasModelsRef.current = defaults;
          const saved = storedCanvasAgentConfig(documentRef.current);
          setImageModel(saved?.imageModel || defaults.imageModel);
          setImageModels(configuredImageModels);
          setTextModel(saved?.textModel || defaults.textModel);
          setTextModels(configuredTextModels);
          setVideoModel(saved?.videoModel || defaults.videoModel);
          setVideoModels(configuredVideoModels);
          setAudioModel(resolveCanvasAudioModel(personalAudioModel, configuredAudioModels));
          setAudioModels(configuredAudioModels);
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
  }, [imageGenerationPreferences.default_audio_model, imageGenerationPreferences.default_image_model, imageGenerationPreferences.default_text_model, imageGenerationPreferences.default_video_model, imageGenerationPreferences.workbench.video_model]);

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
    next = reconcileScriptMediaDependencies(next, nodesRef.current);
    mediaOperationsRef.current.forEach((controller, nodeID) => {
      const before = nodesRef.current.find((node) => node.id === nodeID);
      const after = next.find((node) => node.id === nodeID);
      if (!after || after.url !== before?.url || after.storage_key !== before?.storage_key) controller.abort();
    });
    nodesRef.current = next;
    setNodesState(next);
    syncCanvasTaskQueue(session.key, documentRef.current.id, titleRef.current, next);
  }

  function registerActiveGeneration(controller: AbortController, nodeIDs: Iterable<string>, taskIDs: Iterable<string> = []) {
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const generation: CanvasActiveGeneration = {
      controller,
      settled,
      settle,
      sessionKey: session.key,
      nodeIDs: new Set([...nodeIDs].filter(Boolean)),
      taskIDs: new Set([...taskIDs].filter(Boolean)),
      submittedTaskIDs: new Set(),
    };
    generation.nodeIDs.forEach((nodeID) => activeGenerationsRef.current.set(nodeID, generation));
    setActiveGenerationNodeIDs((current) => new Set([...current, ...generation.nodeIDs]));
    return generation;
  }

  function addActiveGenerationTask(generation: CanvasActiveGeneration, taskID: string, previousTaskID = "") {
    if (previousTaskID && previousTaskID !== taskID) generation.taskIDs.delete(previousTaskID);
    if (taskID) {
      generation.taskIDs.add(taskID);
      generation.submittedTaskIDs.add(taskID);
      if (generation.controller.signal.aborted) {
        void stopCreationTasks([taskID], undefined, generation.sessionKey).catch(() => undefined);
      }
    }
  }

  function releaseActiveGeneration(generation: CanvasActiveGeneration) {
    generation.settle();
    generation.nodeIDs.forEach((nodeID) => {
      if (activeGenerationsRef.current.get(nodeID) === generation) activeGenerationsRef.current.delete(nodeID);
    });
    setActiveGenerationNodeIDs((current) => new Set([...current].filter((nodeID) => activeGenerationsRef.current.has(nodeID))));
    setCancellingGenerationNodeIDs((current) => new Set([...current].filter((nodeID) => activeGenerationsRef.current.has(nodeID))));
  }

  function completeActiveGeneration(generation: CanvasActiveGeneration) {
    generation.taskIDs.forEach((taskID) => cancelledTaskIDsRef.current.delete(taskID));
    releaseActiveGeneration(generation);
  }

  function interruptGenerationRecords(records: Iterable<CanvasActiveGeneration>, notifyServer = true) {
    const uniqueRecords = new Set(records);
    uniqueRecords.forEach((generation) => {
      generation.controller.abort();
      generation.taskIDs.forEach((taskID) => cancelledTaskIDsRef.current.add(taskID));
      if (notifyServer) generation.submittedTaskIDs.forEach((taskID) => {
        void cancelCreationTask(taskID).catch((error) => toast.error(error instanceof Error ? `本地已停止，服务端停止失败：${error.message}` : "本地已停止，服务端停止失败"));
      });
      releaseActiveGeneration(generation);
    });
  }

  function nodeGenerationRunning(nodeID: string) {
    return activeGenerationNodeIDs.has(nodeID);
  }

  function replaceConnections(next: CanvasConnection[]) {
    connectionsRef.current = next;
    setConnectionsState(next);
  }

  function handleNodeMediaLoad(nodeID: string, naturalWidth: number, naturalHeight: number, mediaBytes?: number, sourceURL?: string, durationMS?: number) {
    const width = Math.round(Number(naturalWidth));
    const height = Math.round(Number(naturalHeight));
    const bytes = Math.round(Number(mediaBytes));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const node = nodesRef.current.find((item) => item.id === nodeID);
    if (!node || (node.type !== "image" && node.type !== "video") || !node.url || sourceURL !== node.url) return;
    const mediaMetadata = node.type === "video" && durationMS && Number.isFinite(durationMS) && durationMS > 0 ? { ...node.media_metadata, width, height, duration_ms: durationMS } : node.media_metadata;
    const metadataChanged = JSON.stringify(mediaMetadata) !== JSON.stringify(node.media_metadata);
    const dimensionsChanged = node.natural_width !== width || node.natural_height !== height;
    const bytesChanged = Number.isFinite(bytes) && bytes > 0 && node.bytes !== bytes;
    const ratioChanged = !node.free_resize && Math.abs(node.width / node.height - width / height) > 0.001;
    if (!dimensionsChanged && !bytesChanged && !ratioChanged && !metadataChanged) return;

    if (!dimensionsChanged && !ratioChanged) {
      replaceNodes(nodesRef.current.map((item) => item.id === nodeID ? { ...item, ...(bytesChanged ? { bytes } : {}), media_metadata: mediaMetadata } : item));
      scheduleSave();
      return;
    }

    // Keep the node's largest edge as the display bound while matching the loaded
    // media ratio. This removes letterboxing when the API omits output dimensions.
    const maxEdge = Math.max(220, node.width, node.height);
    const scale = Math.min(1, maxEdge / width, maxEdge / height);
    const nextWidth = node.free_resize ? node.width : Math.max(1, Math.round(width * scale));
    const nextHeight = node.free_resize ? node.height : Math.max(1, Math.round(height * scale));
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
      media_metadata: mediaMetadata,
      ...(bytesChanged ? { bytes } : {}),
    } : item));
    scheduleSave();
  }

  function updateCanvasAgentConfig(patch: Partial<CanvasAgentConfig>) {
    if (documentRef.current.id !== renderedCanvasID) return;
    const next = { ...normalizeCanvasAgentConfig(documentRef.current.agent_config), ...patch };
    setAgentConfig(next);
    documentRef.current = { ...documentRef.current, agent_config: next };
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
    if (session.subjectId && recoveryDraftTimerRef.current === null) recoveryDraftTimerRef.current = window.setTimeout(checkpointCanvasDraft, 150);
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void persistCanvas(), 700);
  }

  function checkpointCanvasDraft() {
    if (recoveryDraftTimerRef.current === null) return;
    window.clearTimeout(recoveryDraftTimerRef.current);
    recoveryDraftTimerRef.current = null;
    if (!session.subjectId || !loadedRef.current || !canvasSaveRequired(persistedChangeVersionRef.current, saveChangeVersionRef.current)) return;
    const current = captureDocument();
    const base = serverDocumentRef.current;
    const epoch = canvasDocumentEpochRef.current;
    if (!recoveryDraftWriterRef.current) recoveryDraftWriterRef.current = randomID();
    void writeCanvasRecoveryDraft({
      id: recoveryDraftWriterRef.current,
      scope: canvasRecoveryDraftScope(session.subjectId, current.id),
      revision: base.revision,
      version: saveChangeVersionRef.current,
      updatedAt: Date.now(),
    }, captureCanvasDraftChanges(base, current)).then(() => {
      if (mountedRef.current && canvasDocumentEpochRef.current === epoch) setRecoveryDraftError("");
    }).catch(() => {
      if (mountedRef.current && canvasDocumentEpochRef.current === epoch) setRecoveryDraftError("无法保存本地草稿。关闭页面前请重试保存画布。");
    });
  }

  function refreshCanvasDrafts(projectID: string, epoch: number) {
    if (!session.subjectId) return;
    const isCurrent = () => mountedRef.current && canvasDocumentEpochRef.current === epoch;
    void listCanvasRecoveryDrafts(canvasRecoveryDraftScope(session.subjectId, projectID)).then((drafts) => {
      if (isCurrent()) setRecoveryDrafts(drafts.filter(item => item.id !== recoveryDraftWriterRef.current));
    }).catch(() => {
      if (isCurrent()) setRecoveryDraftError("无法读取此浏览器保存的画布草稿。");
    });
  }

  async function actOnCanvasDraft(draft: CanvasRecoveryDraftSummary, restore: boolean) {
    const projectID = documentRef.current.id;
    const epoch = canvasDocumentEpochRef.current;
    const version = saveChangeVersionRef.current;
    const isCurrent = () => mountedRef.current && canvasDocumentEpochRef.current === epoch && getCachedAuthSession()?.key === session.key;
    if (processingRecoveryDraft || draft.scope !== canvasRecoveryDraftScope(session.subjectId, projectID)) return;
    setProcessingRecoveryDraft(true);
    setRecoveryDraftError("");
    try {
      await enqueueWorkspaceMutation(async () => {
        if (!isCurrent()) return;
        let saved: CanvasDocument | undefined, copyID: string | undefined;
        if (restore) {
          if (canvasSaveRequired(persistedChangeVersionRef.current, saveChangeVersionRef.current)) throw new Error("请先保存当前修改，再恢复本地草稿。");
          const changes = await readCanvasRecoveryDraft(draft);
          if (!changes) throw new Error("本地草稿已更新，请重新选择。");
          const { document: remote } = await fetchCanvasDocument(projectID);
          if (!isCurrent()) return;
          if (version !== saveChangeVersionRef.current) throw new Error("当前画布有新修改，请保存后重试。");
          const sameRevision = remote.revision === draft.revision && remote.agent_run?.status !== "running";
          const restored = recoverCanvasDraftDocument(remote, changes, false);
          if (!canvasDocumentValuesEqual(remote, restored)) {
            if (sameRevision) {
              saved = (await saveCanvasDocument(restored)).document;
            } else {
              copyID = (await importCanvasProject(recoverCanvasDraftDocument(remote, changes, true), "active")).document.id;
            }
          }
        }
        const cleared = await clearCanvasRecoveryDraft(draft.scope, draft.id, draft.version);
        if (!restore && !cleared) throw new Error("本地草稿已更新，请重新选择。");
        if (!isCurrent()) return;
        setDiscardRecoveryDraft(null);
        if (!restore) return;
        if (version === saveChangeVersionRef.current) {
          if (saved) applyDocument(saved);
          if (copyID) navigate(canvasProjectPath(copyID));
        }
        toast.success(saved ? "已恢复草稿并保存到原画布" : copyID ? "已将草稿恢复为独立画布" : "草稿中的修改已保存");
      });
    } catch (error) {
      if (isCurrent()) {
        setDiscardRecoveryDraft(null);
        setRecoveryDialogOpen(true);
        setRecoveryDraftError(canvasErrorMessage(error));
      }
    } finally {
      if (isCurrent()) {
        refreshCanvasDrafts(projectID, epoch);
        setProcessingRecoveryDraft(false);
      }
    }
  }

  function pushHistory() {
    const snapshot = createCanvasHistorySnapshot(captureDocument());
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

  function commitGenerationHistory(baseHistory: readonly CanvasHistorySnapshot[]) {
    expireCanvasHistoryLease();
    const snapshot = createCanvasHistorySnapshot(captureDocument());
    // Expiry replaces every snapshot, invalidating bases captured by pending tasks.
    const currentSnapshots = new Set(historyRef.current);
    const baseIsCurrent = generationHistoryBaseRef.current === baseHistory || baseHistory.some((item) => currentSnapshots.has(item));
    historyRef.current = commitCanvasGenerationHistory(baseIsCurrent ? baseHistory : historyRef.current, snapshot, MAX_HISTORY);
    if (generationHistoryBaseRef.current === baseHistory) generationHistoryBaseRef.current = null;
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

  function flushCanvasBeforeLeave(event: Event) {
    const pending = (event as CustomEvent<Promise<void>[]>).detail;
    if (!Array.isArray(pending)) return;
    pending.push(flushCanvasSaves({
      save: persistCanvas,
      getChangeVersion: () => saveChangeVersionRef.current,
      getProjectID: () => documentRef.current.id,
    }).then((saved) => {
      if (!saved) throw new Error("画布保存失败，请重试后退出");
    }));
  }

  async function flushBlockedCanvasNavigation(blocker: Blocker, signal: AbortSignal) {
    if (blocker.state !== "blocked") return;
    const projectID = documentRef.current.id;
    const epoch = canvasDocumentEpochRef.current;
    try {
      const saved = await flushCanvasSaves({
        save: persistCanvas,
        getChangeVersion: () => saveChangeVersionRef.current,
        getProjectID: () => documentRef.current.id,
      });
      if (signal.aborted) return;
      if (saved && mountedRef.current && documentRef.current.id === projectID && canvasDocumentEpochRef.current === epoch
        && !canvasSaveRequired(persistedChangeVersionRef.current, saveChangeVersionRef.current)) {
        blocker.proceed();
        return;
      }
      blocker.reset();
    } catch (error) {
      if (signal.aborted) return;
      blocker.reset();
      toast.error(canvasErrorMessage(error));
    }
  }

  async function persistCanvas() {
    if (!loadedRef.current) return true;
    checkpointCanvasDraft();
    expireCanvasHistoryLease();
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (!canvasSaveRequired(persistedChangeVersionRef.current, saveChangeVersionRef.current)) return true;
    let payload = {
      ...captureDocument(),
      retained_storage_object_ids: canvasHistoryStorageObjectIDs(historyRef.current, redoRef.current, generationHistoryBaseRef.current || []),
      retained_storage_object_urls: canvasHistoryStorageObjectURLs(historyRef.current, redoRef.current, generationHistoryBaseRef.current || []),
    };
    // Server baselines are isolated on receipt and replaced, never edited in place.
    let base = serverDocumentRef.current;
    let changeVersion = saveChangeVersionRef.current;
    const recoveryWriter = recoveryDraftWriterRef.current;
    const recoveryScope = canvasRecoveryDraftScope(session.subjectId, payload.id);
    const epoch = canvasDocumentEpochRef.current;
    const requestVersion = saveRequestVersionRef.current + 1;
    saveRequestVersionRef.current = requestVersion;
    if (mountedRef.current) setSavingCanvas(true);
    let response: Awaited<ReturnType<typeof saveCanvasDocument>>;
    let submittedDocument: CanvasDocument;
    let submittedPayload: CanvasDocument;
    const request = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        // Earlier saves may have acknowledged this page's edits while queued.
        // Refresh both sides together, but keep the original snapshot after navigation.
        if (documentRef.current.id === payload.id && canvasDocumentEpochRef.current === epoch) {
          checkpointCanvasDraft();
          payload = {
            ...captureDocument(),
            retained_storage_object_ids: canvasHistoryStorageObjectIDs(historyRef.current, redoRef.current, generationHistoryBaseRef.current || []),
            retained_storage_object_urls: canvasHistoryStorageObjectURLs(historyRef.current, redoRef.current, generationHistoryBaseRef.current || []),
          };
          base = serverDocumentRef.current;
          changeVersion = saveChangeVersionRef.current;
        }
        let remote = serverDocumentRef.current.id === payload.id && canvasDocumentEpochRef.current === epoch ? serverDocumentRef.current : base;
        for (let attempt = 0; ; attempt++) {
          try {
            submittedDocument = mergeCanvasDocuments(base, payload, remote);
            submittedPayload = canvasAgentHistoryChanges(submittedDocument, remote);
            return await saveCanvasDocument(submittedPayload);
          }
          catch (error) {
            if ((error as { status?: number }).status !== 409 || attempt >= 3) throw error;
            remote = (await fetchCanvasDocument(payload.id, "active", (payload.agent_sessions || []).filter(isCanvasAgentSession).map(item => item.id))).document;
          }
        }
      });
    saveQueueRef.current = request.then(() => undefined, () => undefined);
    try {
      response = await request;
      response = { ...response, document: canvasAgentHistoryReceipt(response.document, { ...submittedDocument!, agent_session_updates: submittedPayload!.agent_session_updates }) };
      if (recoveryWriter) void clearCanvasRecoveryDraft(recoveryScope, recoveryWriter, changeVersion).catch(() => undefined);
      if (documentRef.current.id === payload.id && canvasDocumentEpochRef.current === epoch) {
        const current = captureDocument();
        const rebased = mergeCanvasDocuments(payload, current, submittedDocument!);
        applyBackendAgentDocument(response.document, {
          base: { ...serverDocumentRef.current, agent_sessions: submittedDocument!.agent_sessions },
          local: { ...current, agent_sessions: rebased.agent_sessions },
        });
        if (!response.document.retained_storage_objects_until && canvasHistoryLeaseExpired(payload)) {
          historyRef.current = [createCanvasHistorySnapshot(captureDocument())];
          redoRef.current = [];
          generationHistoryBaseRef.current = null;
          setHistoryVersion((value) => value + 1);
        }
        persistedChangeVersionRef.current = Math.max(persistedChangeVersionRef.current, changeVersion);
        if (!canvasSaveRequired(persistedChangeVersionRef.current, saveChangeVersionRef.current)) setCanvasSaveError("");
      }
      if (mountedRef.current) {
        setProjects((items) => items.map((item) => item.id === payload.id ? { ...item, title: payload.title, node_count: payload.nodes.length, updated_at: response.document.updated_at } : item));
      }
      return true;
    } catch (error) {
      if (error instanceof CanvasAgentSessionConflictError && mountedRef.current && documentRef.current.id === payload.id && canvasDocumentEpochRef.current === epoch) {
        agentHistoryConflictRef.current = error;
        setAgentHistoryConflict(error);
        setAgentOpen(true);
      }
      if (mountedRef.current && documentRef.current.id === payload.id && canvasDocumentEpochRef.current === epoch && saveRequestVersionRef.current === requestVersion) {
        const message = canvasErrorMessage(error);
        setCanvasSaveError(message);
        toast.error(message);
      }
      return false;
    } finally {
      if (mountedRef.current && documentRef.current.id === payload.id && canvasDocumentEpochRef.current === epoch && saveRequestVersionRef.current === requestVersion) setSavingCanvas(false);
    }
  }

  async function persistGenerationCheckpoint() {
    scheduleSave();
    const projectID = documentRef.current.id;
    if (!await persistCanvas() || documentRef.current.id !== projectID) {
      if (documentRef.current.id === projectID && agentHistoryConflictRef.current) throw agentHistoryConflictRef.current;
      throw new Error("执行记录保存失败，请重试后继续生成");
    }
  }

  function applyBackendAgentDocument(document: CanvasDocument, edits?: { base: CanvasDocument; local: CanvasDocument; hydrateHistory?: boolean }) {
    if (!mountedRef.current || documentRef.current.id !== document.id || document.revision < documentRef.current.revision) return;
    const sessions = storedCanvasAgentSessions(document, false);
    if (!edits && document.revision === documentRef.current.revision && document.agent_run?.status === documentRef.current.agent_run?.status) { setAgentSyncError(""); return; }
    const arrangements = new Set<string>();
    for (const session of edits?.hydrateHistory ? [] : sessions) {
      for (const message of session.messages) {
        for (const entry of message.trace || []) {
          if (entry.type === "operation" && entry.tool?.name === "arrange_nodes" && entry.status === "success") arrangements.add(entry.id);
        }
      }
    }
    if (arrangements.size) {
      for (const session of storedCanvasAgentSessions(serverDocumentRef.current, false)) {
        for (const message of session.messages) {
          for (const entry of message.trace || []) {
            if (entry.type === "operation" && entry.tool?.name === "arrange_nodes" && entry.status === "success") arrangements.delete(entry.id);
          }
        }
      }
    }
    const arranged = arrangements.size > 0;
    const local = edits?.local || captureDocument();
    const merged = mergeCanvasDocuments(edits?.base || serverDocumentRef.current, local, document);
    const mergedSessions = storedCanvasAgentSessions(merged, edits?.hydrateHistory === true);
    if (serverDocumentRef.current.agent_run?.status === "running" || document.agent_run?.status === "running") {
      const snapshots = new Set([...historyRef.current, ...redoRef.current, ...(generationHistoryBaseRef.current || [])]);
      const serverChanges = mergeCanvasDocuments(local, serverDocumentRef.current, document);
      for (const snapshot of snapshots) {
        const rebased = mergeCanvasHistory(serverDocumentRef.current, local, snapshot, document, serverChanges);
        Object.assign(snapshot, rebased);
        if (rebased.show_image_info === undefined) delete snapshot.show_image_info;
      }
    }
    serverDocumentRef.current = mergeCanvasDocuments(serverDocumentRef.current, serverDocumentRef.current, cloneDocument(document, serverDocumentRef.current));
    documentRef.current = merged;
    const mergedAgentConfig = storedCanvasAgentConfig(merged);
    setAgentConfig(mergedAgentConfig);
    setImageModel(mergedAgentConfig?.imageModel || defaultCanvasModelsRef.current.imageModel);
    setTextModel(mergedAgentConfig?.textModel || defaultCanvasModelsRef.current.textModel);
    setVideoModel(mergedAgentConfig?.videoModel || defaultCanvasModelsRef.current.videoModel);
    titleRef.current = merged.title;
    setTitle(merged.title);
    replaceNodes(merged.nodes);
    replaceConnections(merged.connections);
    setAgentSessions(mergedSessions);
    setAgentSessionSummaries(canvasAgentHistorySummaries({ ...merged, agent_sessions: mergedSessions }));
    setActiveAgentSessionID(merged.active_agent_session_id || "");
    setBackendAgentRun(document.agent_run);
    setAgentSyncError("");
    if (arranged) fitCanvasContent();
  }
  backendSnapshotRef.current = applyBackendAgentDocument;

  async function resolveAgentHistoryConflict() {
    if (!agentHistoryConflict || resolvingAgentHistory) return;
    const projectID = documentRef.current.id, epoch = canvasOperationEpochRef.current;
    setResolvingAgentHistory(true);
    try {
      await saveQueueRef.current;
      const document = (await fetchCanvasDocument(projectID, "active", (captureDocument().agent_sessions || []).filter(isCanvasAgentSession).map(item => item.id))).document;
      if (!mountedRef.current || documentRef.current.id !== projectID || canvasOperationEpochRef.current !== epoch) return;
      const local = forkCanvasAgentSessionConflicts(captureDocument(), agentHistoryConflict.sessionIDs, randomID);
      applyBackendAgentDocument(document, { base: serverDocumentRef.current, local });
      agentHistoryConflictRef.current = null;
      setAgentHistoryConflict(null);
      scheduleSave();
      if (await persistCanvas()) toast.success("两份对话均已保存，本页版本已另存为新对话");
    } catch (error) {
      if (mountedRef.current && documentRef.current.id === projectID && canvasOperationEpochRef.current === epoch) {
        if (error instanceof CanvasAgentSessionConflictError) {
          agentHistoryConflictRef.current = error;
          setAgentHistoryConflict(error);
        }
        toast.error(canvasErrorMessage(error));
      }
    } finally {
      if (mountedRef.current) setResolvingAgentHistory(false);
    }
  }

  async function loadAgentHistorySession(sessionID: string, signal?: AbortSignal): Promise<CanvasAssistantSession> {
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    if (!await flushCanvasSaves({ save: persistCanvas, getChangeVersion: () => saveChangeVersionRef.current, getProjectID: () => documentRef.current.id })) throw new Error("当前对话保存失败，请重试后打开历史");
    signal?.throwIfAborted();
    if (!mountedRef.current || canvasOperationEpochRef.current !== operationEpoch || documentRef.current.id !== projectID) throw new DOMException("画布已切换", "AbortError");
    let body: unknown;
    try {
      body = (await fetchCanvasAgentHistorySession(projectID, sessionID, documentRef.current.revision, signal)).session;
    } catch (error) {
      if ((error as { status?: number }).status !== 409) throw error;
      const refreshed = (await fetchCanvasDocument(projectID, "active", [sessionID], signal)).document;
      if (!mountedRef.current || canvasOperationEpochRef.current !== operationEpoch || documentRef.current.id !== projectID) throw new DOMException("画布已切换", "AbortError");
      applyBackendAgentDocument(refreshed);
      body = (refreshed.agent_sessions || []).find(item => isCanvasAgentSession(item) && item.id === sessionID);
    }
    signal?.throwIfAborted();
    if (!mountedRef.current || canvasOperationEpochRef.current !== operationEpoch || documentRef.current.id !== projectID) throw new DOMException("画布已切换", "AbortError");
    if (!isCanvasAgentSession(body)) throw new Error("历史对话数据无效，原记录未被替换");
    const loaded = syncCanvasAgentSessions([body], nodesRef.current, false)[0];
    serverDocumentRef.current = { ...serverDocumentRef.current, agent_sessions: [
      ...(serverDocumentRef.current.agent_sessions || []).filter(item => !isCanvasAgentSession(item) || item.id !== sessionID),
      structuredClone(loaded),
    ] };
    return loaded;
  }

  async function loadDeferredAgentHistory(signal: AbortSignal) {
    const projectID = documentRef.current.id;
    const epoch = canvasDocumentEpochRef.current;
    const current = () => !signal.aborted && mountedRef.current && documentRef.current.id === projectID && canvasDocumentEpochRef.current === epoch;
    setAgentHistoryLoadError("");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { document } = await fetchCanvasDocument(projectID, "active", [], signal);
        if (!current()) return;
        if (document.id !== projectID) throw new Error("对话记录所属画布不一致");
        if (document.revision < documentRef.current.revision) continue;
        const active = document.active_agent_session_id;
        if (active && document.agent_session_summaries?.some(item => item.id === active)
          && !document.agent_sessions?.some(item => isCanvasAgentSession(item) && item.id === active)) {
          throw new Error("当前对话正文缺失");
        }
        applyBackendAgentDocument(document, { base: serverDocumentRef.current, local: captureDocument(), hydrateHistory: true });
        return;
      }
      throw new Error("画布仍在更新，请重试加载对话");
    } catch (error) {
      if (current()) setAgentHistoryLoadError(error instanceof Error ? error.message : "加载对话失败");
    }
  }

  useEffect(() => {
    if (backendAgentRun?.status !== "running" || agentLocallyObserving) return;
    const projectID = documentRef.current.id;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const { document } = await fetchCanvasAgentRun(projectID, controller.signal);
        if (!controller.signal.aborted && documentRef.current.id === projectID) backendSnapshotRef.current(document);
      } catch (error) {
        if (!controller.signal.aborted && documentRef.current.id === projectID) setAgentSyncError(error instanceof Error ? error.message : "暂时无法读取后台进度");
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 1000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [backendAgentRun?.id, backendAgentRun?.status, agentLocallyObserving]);

  function applyDocument(document: CanvasDocument, resetHistory = true) {
    checkpointCanvasDraft();
    const next = structuredClone({
      ...document,
      nodes: (document.nodes || []).map((node) => canvasEmptyMediaNodeFrame(normalizeCanvasNodeTitle(normalizeCanvasVideoNode(node)))),
      connections: document.connections || [],
    });
    const restoredAgentSessions = storedCanvasAgentSessions(next);
    const restoredActiveAgentSessionID = next.active_agent_session_id && (restoredAgentSessions.some((item) => item.id === next.active_agent_session_id)
      || next.agent_session_summaries?.some((item) => item.id === next.active_agent_session_id))
      ? next.active_agent_session_id
      : restoredAgentSessions[0]?.id || "";
    // The editable document above is isolated; retain the untouched response as its baseline.
    serverDocumentRef.current = document;
    recoveryDraftWriterRef.current = "";
    setAgentSyncError("");
    setCanvasSaveError("");
    setSavingCanvas(false);
    setRecoveryDrafts([]);
    setRecoveryDialogOpen(false);
    setDiscardRecoveryDraft(null);
    setProcessingRecoveryDraft(false);
    setRecoveryDraftError("");
    agentHistoryConflictRef.current = null;
    setAgentHistoryConflict(null);
    setBackendAgentRun(document.agent_run);
    loadedRef.current = false;
    canvasDocumentEpochRef.current += 1;
    canvasOperationEpochRef.current += 1;
    cancelCanvasMediaOperations();
    setOpenScriptNodeID("");
    canvasRecoveryAbortControllerRef.current?.abort();
    canvasRecoveryAbortControllerRef.current = null;
    const recoveryTaskIDs = [...new Set((document.nodes || []).flatMap((node) => (
      canvasGenerationNeedsRecovery(node) ? [canvasGenerationRecoveryTaskID(node)] : []
    )))];
    const operationEpoch = canvasOperationEpochRef.current;
    const previousCanvasID = documentRef.current.id;
    if (previousCanvasID && previousCanvasID !== next.id) clearCanvasTaskQueueForCanvas(session.key, previousCanvasID);
    documentRef.current = { ...next, agent_sessions: restoredAgentSessions, active_agent_session_id: restoredActiveAgentSessionID || undefined };
    titleRef.current = next.title || "我的画布";
    replaceNodes(next.nodes || []);
    replaceConnections(next.connections || []);
    viewportRef.current = next.viewport || DEFAULT_DOCUMENT.viewport;
    backgroundRef.current = next.background || "dots";
    showImageInfoRef.current = Boolean(next.show_image_info);
    setViewportState(viewportRef.current);
    setTitle(titleRef.current);
    setBackground(backgroundRef.current);
    setShowImageInfo(showImageInfoRef.current);
    setAgentConfig(storedCanvasAgentConfig(next));
    const savedModels = storedCanvasAgentConfig(next);
    setImageModel(savedModels?.imageModel || defaultCanvasModelsRef.current.imageModel);
    setTextModel(savedModels?.textModel || defaultCanvasModelsRef.current.textModel);
    setVideoModel(savedModels?.videoModel || defaultCanvasModelsRef.current.videoModel);
    setAgentSessions(restoredAgentSessions);
    setAgentSessionSummaries(canvasAgentHistorySummaries({ ...next, agent_sessions: restoredAgentSessions }));
    setActiveAgentSessionID(restoredActiveAgentSessionID);
    setAgentOpen(next.agent_panel?.open === true);
    setAgentDisplayMode(next.agent_panel?.mode || "floating");
    setInitialAgentRequest(null);
    setSelectedNodeIDs(new Set());
    setSelectedConnectionID("");
    setPanelNodeID("");
    setReferenceReturn(null);
    setImagePromptDrafts({});
    setPreviewNodeID("");
    setNodeInfoID("");
    setContextMenu(null);
    setPendingConnection(null);
    setNodeCreateMenu(null);
    setImageTool(null);
    setImageToolBusy(false);
    setMaskEditModel("");
    setUploadingNodeID("");
    if (resetHistory) {
      historyRef.current = [createCanvasHistorySnapshot(documentRef.current)];
      redoRef.current = [];
      saveChangeVersionRef.current = 0;
      persistedChangeVersionRef.current = 0;
      setHistoryVersion((value) => value + 1);
    }
    loadedRef.current = true;
    refreshCanvasDrafts(next.id, canvasDocumentEpochRef.current);
	void hydrateCanvasStorageURLs(next, operationEpoch).then(() => {
      void consumePendingAgentRequest(next.pending_agent_request, next.id, operationEpoch)
        .catch((error) => toast.error(error instanceof Error ? error.message : "首页素材插入失败"));
    });
    if (recoveryTaskIDs.length && document.agent_run?.status !== "running") {
      const controller = new AbortController();
      canvasRecoveryAbortControllerRef.current = controller;
      void recoverCanvasTasks(next.id, operationEpoch, recoveryTaskIDs, session.key, controller.signal);
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
    const references = hydratedAssets.map(canvasAgentStarterAttachment);
    documentRef.current = {
      ...documentRef.current,
      agent_panel: { ...(documentRef.current.agent_panel || DEFAULT_AGENT_PANEL), open: true },
    };
    scheduleSave();
    setAgentOpen(true);
    setInitialAgentRequest({ prompt: request.prompt.trim(), references });
  }

  function applyWorkspace(response: CanvasWorkspaceResponse) {
    applyDocument(response.document);
    setProjects(response.projects || []);
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
        if (patch.generation_mode === "video") normalizedPatch = { ...canvasVideoParameters({ generation_video_audio: imageGenerationPreferences.workbench.video_generate_audio, ...node, generation_video_model: node.generation_video_model || videoModel }), ...patch };
        if (patch.generation_mode === "audio") normalizedPatch = { ...preferredCanvasAudioParameters(node.generation_audio_model || audioModel), ...patch };
      }
      const next = { ...node, ...normalizedPatch };
      const size = node.type === "image" && typeof patch.generation_size === "string"
        ? patch.generation_size
        : node.type === "video" && typeof patch.generation_video_size === "string"
          ? patch.generation_video_size
          : "";
      if ((node.type !== "image" && node.type !== "video") || node.url || node.free_resize || !size) return next;
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

  function focusCanvasNode(nodeID: string, size = canvasSize) {
    const node = nodesRef.current.find((item) => item.id === nodeID);
    if (!node || size.width <= 0 || size.height <= 0) return;
    const root = node.batch_root_id ? nodesRef.current.find(item => item.id === node.batch_root_id) : undefined;
    if (root && !root.batch_expanded) {
      replaceNodes(nodesRef.current.map(item => item.id === root.id ? { ...item, batch_expanded: true } : item));
    }
    const zoom = Math.min(1.5, Math.max(
      CANVAS_MIN_ZOOM,
      Math.min(
        (size.width * 0.64) / Math.max(1, node.width),
        (size.height * 0.64) / Math.max(1, node.height),
      ),
    ));
    const target = {
      zoom,
      x: size.width / 2 - (node.x + node.width / 2) * zoom,
      y: size.height / 2 - (node.y + node.height / 2) * zoom,
    };
    selectionChanged(new Set([nodeID]));
    animateCanvasViewport(target);
  }

  function focusAgentCanvasNode(nodeID: string) {
    const area = agentAreaRef.current;
    if (agentOpen && area && (canvasSize.width < 240 || area.clientWidth <= CANVAS_AGENT_WIDTH + 24)) {
      closeAgentPanel();
      focusCanvasNode(nodeID, { width: area.clientWidth, height: area.clientHeight });
      return;
    }
    focusCanvasNode(nodeID);
  }

  function animateCanvasViewport(target: CanvasDocument["viewport"]) {
    const from = viewportRef.current;
    const startedAt = performance.now();
    if (focusAnimationRef.current !== null) window.cancelAnimationFrame(focusAnimationRef.current);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      updateViewport(target, true);
      focusAnimationRef.current = null;
      return;
    }
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

  function focusReferencedNode(originID: string, targetID: string) {
    const target = nodesRef.current.find((node) => node.id === targetID);
    if (!target) return;
    setReferenceReturn({ nodeID: originID, viewport: { ...viewportRef.current }, panelNodeID, expiresAt: Date.now() + 10_000 });
    setCanvasTool("select");
    focusCanvasNode(targetID);
  }

  function returnToReferenceOrigin() {
    const destination = referenceReturn;
    setReferenceReturn(null);
    if (!destination || Date.now() >= destination.expiresAt || !nodesRef.current.some((node) => node.id === destination.nodeID)) return;
    if (focusAnimationRef.current !== null) window.cancelAnimationFrame(focusAnimationRef.current);
    focusAnimationRef.current = null;
    setCanvasTool("select");
    selectionChanged(new Set([destination.nodeID]));
    setPanelNodeID(destination.panelNodeID);
    updateViewport(destination.viewport, true);
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



  function addTextNodeAt(point: { x: number; y: number }, prompt = "", title = "文字") {
    const node: CanvasNode = { id: `text-${randomID()}`, type: "text", x: point.x, y: point.y, width: 340, height: 240, font_size: 14, scale_x: 1, scale_y: 1, title, prompt, created_at: createdAt() };
    addNode(node);
    setPanelNodeID(node.id);
  }



  function addBlankNodeAt(point: { x: number; y: number }) {
    const node = canvasEmptyMediaNodeFrame({ id: `image-${randomID()}`, type: "image" as const, x: point.x, y: point.y, width: 340, height: 240, scale_x: 1, scale_y: 1, title: "图片", prompt: "", ...preferredCanvasImageParameters(), created_at: createdAt() });
    addNode(node);
    setPanelNodeID(node.id);
  }

  function addBlankVideoNodeAt(point: { x: number; y: number }) {
    const node = buildVideoNode({}, point);
    addNode(node);
    setPanelNodeID(node.id);
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
    const currentVideoModel = storedCanvasAgentConfig(documentRef.current)?.videoModel || videoModel;
    const videoDefaults = canvasVideoParameters({
      generation_video_model: currentVideoModel,
      generation_video_audio: imageGenerationPreferences.workbench.video_generate_audio,
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
        autoGenerateMedia: normalizeCanvasAgentConfig(documentRef.current.agent_config).autoGenerateMedia === true,
        textModel,
        imageModel,
        videoModel: currentVideoModel,
        audioModel,
        imageQuality: preferredCanvasImageParameters().generation_quality || "",
        imageResolution: preferredCanvasImageParameters().generation_resolution || "",
        imageSize: preferredCanvasImageParameters().generation_size || "",
        videoQuality: videoDefaults.generation_video_resolution || "",
        videoSize: videoDefaults.generation_video_size || "",
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

  async function executeCanvasAgentAction(action: CanvasAgentAction, messageReferenceNodeIDs: string[], execution: { onProgress?: (result: CanvasAgentToolResult) => void; waitForMedia?: boolean; generateMedia?: boolean; attachments?: CanvasAssistantReference[]; signal?: AbortSignal } = {}): Promise<CanvasAgentToolResult> {
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


    const generateMediaNode = async (node: CanvasNode, created = false, connectionIDs: string[] = []): Promise<CanvasAgentToolResult> => {
      execution.onProgress?.({ ok: true, submitted: false, nodeId: node.id, createdNodeIds: created ? [node.id] : [], connectionIds: connectionIDs, ...summarizeCanvasAgentTask(getNode(node.id) || node) });
      const result = () => {
        const current = getNode(node.id);
        if (!current) return missingNode(node.id);
        const task = summarizeCanvasAgentTask(current);
        const createdNodeIDs = created ? [node.id, ...connectionsRef.current.filter((connection) => connection.from_node_id === node.id).map((connection) => connection.to_node_id)] : [];
        const details = { nodeId: node.id, createdNodeIds: [...new Set(createdNodeIDs)], connectionIds: connectionIDs, ...task };
        if (task.status === "error") return { ok: false, code: "generation_failed", message: current.generation_error || "生成失败", ...details };
        if (task.status === "success" && current.url) return { ok: true, submitted: true, ...details };
        if (task.status === "loading" && task.taskId) return { ok: execution.waitForMedia === false, submitted: true, code: "generation_pending", message: "任务仍在生成，请等待原任务，不要重复提交", ...details };
        return { ok: false, submitted: false, code: "generation_not_submitted", message: "未取得生成结果，请检查模型、密钥、节点参数和任务状态后继续", ...details };
      };
      const activeGeneration = activeGenerationsRef.current.get(node.id);
      if (activeGeneration) {
        if (execution.waitForMedia !== false) {
          await activeGeneration.settled;
          execution.signal?.throwIfAborted();
        } else if (!activeGeneration.submittedTaskIDs.size) {
          return { ok: false, submitted: false, code: "generation_pending", nodeId: node.id, status: "loading", message: "节点正在提交任务，请等待，不要重复生成" };
        }
        return result();
      }
      if (node.generation_status === "success" && node.url) return result();
      if (node.generation_status === "loading" || canvasGenerationNeedsRecovery(node)) {
        const taskID = node.task_id || node.audio_task_id;
        if (!taskID) return { ok: false, code: "generation_pending", nodeId: node.id, status: "loading", message: "节点正在提交任务，请等待，不要重复生成" };
        if (execution.waitForMedia !== false) {
          await recoverCanvasTasks(documentRef.current.id, canvasOperationEpochRef.current, [taskID], session.key, execution.signal || new AbortController().signal);
        }
        return result();
      }
      if (!(execution.generateMedia ?? normalizeCanvasAgentConfig(documentRef.current.agent_config).autoGenerateMedia)) {
        return { ok: true, submitted: false, nodeId: node.id, createdNodeIds: created ? [node.id] : [], connectionIds: connectionIDs, status: "idle", message: "节点与生成参数已保存，尚未生成。用户可选择立即生成，或暂不生成并继续无需成品的规划与提示词工作。" };
      }
      const options: CanvasGenerationOptions = node.type === "image"
        ? { resultTitle: node.title, resultCount: node.generation_count, selectResultNode: true, concurrent: true }
        : { concurrent: true };
      let submittedTaskID = "";
      let acknowledge: () => void = () => {};
      const submitted = new Promise<void>((resolve) => { acknowledge = resolve; });
      options.onSubmitted = (taskID) => { submittedTaskID = taskID; execution.onProgress?.({ ...result(), taskId: taskID, submitted: true }); acknowledge(); };
      const generation = runGeneration(node.id, node.prompt, node.generation_status === "error", options);
      if (execution.waitForMedia === false) {
        await Promise.race([generation, submitted]);
        void generation.catch((error) => toast.error(error instanceof Error ? error.message : "媒体生成失败"));
      } else await generation;
      const outcome = result();
      if (!submittedTaskID && outcome.ok) return { ...outcome, ok: false, submitted: false, code: "generation_not_submitted", message: "未提交生成任务，请检查节点参数后重试" };
      return outcome;
    };

    const agentWriteAction = action.name === "generate_node"
      || action.name === "generate_image"
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
      return { ok: true, project: { id: documentRef.current.id, title: titleRef.current }, selectedNodeIds: [...selectedNodeIDsRef.current], nodes: nodesRef.current.slice(0, 120).map((node) => summarizeCanvasAgentNode(node)), connections: connectionsRef.current.slice(0, 240) };
    }
    if (action.name === "query_canvas_nodes") {
      return queryCanvasAgentNodes(nodesRef.current, args);
    }
    if (action.name === "get_selected_nodes") {
      return { ok: true, nodes: nodesRef.current.filter((node) => selectedNodeIDsRef.current.has(node.id)).map((node) => summarizeCanvasAgentNode(node)) };
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
        capabilities: generation.capabilities,
        imageQuality: generation.imageQuality,
        imageResolution: generation.imageResolution,
        autoGenerateMedia: execution.generateMedia ?? generation.autoGenerateMedia === true,
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
      return node ? { ok: true, node: summarizeCanvasAgentNode(node, true) } : missingNode(nodeID);
    }
    if (action.name === "get_upstream_nodes" || action.name === "get_downstream_nodes" || action.name === "get_connected_nodes") {
      const nodeID = stringValue("nodeId");
      if (!getNode(nodeID)) return missingNode(nodeID);
      const upstreamIDs = connectionsRef.current.filter((connection) => connection.to_node_id === nodeID).map((connection) => connection.from_node_id);
      const downstreamIDs = connectionsRef.current.filter((connection) => connection.from_node_id === nodeID).map((connection) => connection.to_node_id);
      const upstream = nodesRef.current.filter((node) => upstreamIDs.includes(node.id)).map((node) => summarizeCanvasAgentNode(node));
      const downstream = nodesRef.current.filter((node) => downstreamIDs.includes(node.id)).map((node) => summarizeCanvasAgentNode(node));
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
    if (action.name === "create_text_node") {
      const sourceNodeIDs = stringValues("sourceNodeIds");
      const missing = missingNodeID(sourceNodeIDs);
      if (missing) return missingNode(missing);
      const sourceNodes = sourceNodeIDs.map((nodeID) => getNode(nodeID)!);
      const size = CANVAS_NODE_DEFAULT_SIZE.text;
      const point = sourcePosition(sourceNodes, size);
      const content = stringValue("content");
      const node: CanvasNode = { id: `text-${randomID()}`, type: "text", ...point, ...size, font_size: 14, scale_x: 1, scale_y: 1, title: stringValue("title") || content.slice(0, 32) || "文字", prompt: content, generation_status: "success", created_at: createdAt() };
      const createdConnections = sourceNodeIDs.map((sourceNodeID): CanvasConnection => ({ id: `connection-${randomID()}`, from_node_id: sourceNodeID, to_node_id: node.id }));
      replaceNodes([...nodesRef.current, node]);
      replaceConnections([...connectionsRef.current, ...createdConnections]);
      selectOnly(node.id);
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
      const nodeIDs = Array.isArray(action.arguments.nodeIds) ? action.arguments.nodeIds as string[] : [stringValue("nodeId")];
      for (const nodeID of nodeIDs) if (!getNode(nodeID)) return missingNode(nodeID);
      const before = nodesRef.current.map((node) => node.id);
      removeNodes(new Set(nodeIDs));
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
      if (!canCreateCanvasConnection(fromNodeID, toNodeID, connectionsRef.current, nodesRef.current)) {
        return { ok: false, code: "invalid_connection", message: "这些节点类型之间不能创建连线" };
      }
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
      replaceNodes(arranged.nodes); pushHistory(); fitCanvasContent();
      return { ok: true, arrangedNodeIds: arranged.arrangedNodeIDs };
    }
    if (action.name === "generate_node") {
      const node = getNode(stringValue("nodeId"));
      if (!node) return missingNode(stringValue("nodeId"));
      if (node.type !== "image" && node.type !== "video" && node.type !== "audio") return { ok: false, code: "invalid_media_node", message: "仅支持继续图片、视频或音频节点的生成" };
      return generateMediaNode(node);
    }
    if (action.name === "generate_image" || action.name === "edit_image" || action.name === "generate_video" || action.name === "generate_audio") {
      const attachmentIDs = stringValues("attachmentIds");
      const missingAttachment = attachmentIDs.find((id) => !execution.attachments?.some((item) => item.id === id));
      if (missingAttachment) return { ok: false, code: "attachment_not_found", message: `当前消息中找不到附件 ${missingAttachment}` };
      const attachments = attachmentIDs.flatMap((id) => execution.attachments?.filter((item) => item.id === id) || []);
      const attachmentImages = canvasAgentAttachmentURLs(attachments, "image");
      const sourceNodeIDs = canvasAgentSourceNodeIDs(args, messageReferenceNodeIDs);
      const missing = missingNodeID(sourceNodeIDs);
      if (missing) return missingNode(missing);
      const sourceNodes = sourceNodeIDs.map((nodeID) => getNode(nodeID)!);
      if (action.name === "edit_image" && !attachmentImages.length && !sourceNodes.some((node) => (node.type === "image" || node.type === "panorama") && Boolean(node.url))) return { ok: false, code: "image_reference_required", message: "图片编辑需要图片附件或已有内容的图片节点" };
      const type: "image" | "video" | "audio" = action.name === "generate_video" ? "video" : action.name === "generate_audio" ? "audio" : "image";
      const generationModel = type === "video"
        ? videoModel
        : type === "audio"
          ? audioModel
          : imageModel;
      const configuredModels = type === "video" ? videoModels : type === "audio" ? audioModels : imageModels;
      const relayTokenName = nextTokenNameForModel(type, generationModel);
      const autoGenerateMedia = normalizeCanvasAgentConfig(documentRef.current.agent_config).autoGenerateMedia === true;
      if (!configuredModels.includes(generationModel) || (autoGenerateMedia && !relayTokenName.trim())) return { ok: false, code: "model_not_configured", message: `请先在个人中心完成${type === "video" ? "视频" : type === "audio" ? "音频" : "图片"}模型${autoGenerateMedia ? "和密钥" : ""}配置` };
      const mediaSettings = type === "audio" ? { ok: true as const, parameters: {} as Partial<CanvasNode> }
        : resolveCanvasAgentMediaSettings(action, generationModel, preferredCanvasImageParameters());
      if (!mediaSettings.ok) return mediaSettings;
      let videoSeconds: number | undefined;
      let videoGenerateAudio: boolean | undefined;
      if (type === "video") {
        videoSeconds = args.seconds as number;
        const durationError = validateCanvasAgentVideoSeconds(generationModel, videoSeconds);
        if (durationError) return { ok: false, code: "unsupported_duration", message: durationError, supported: canvasAgentVideoDurationHint(generationModel) };
        videoGenerateAudio = args.generateAudio as boolean;
        if (videoGenerateAudio && !canvasAgentVideoSupportsAudio(generationModel)) return { ok: false, code: "video_audio_not_supported", message: "当前全局视频模型不支持视频原生声音" };
      }
      const videoSize = mediaSettings.parameters.generation_video_size || "";
      const size = type === "video"
        ? canvasNodeSizeFromRatio(videoSize, CANVAS_NODE_DEFAULT_SIZE.video.width, CANVAS_NODE_DEFAULT_SIZE.video.height) || CANVAS_NODE_DEFAULT_SIZE.video
        : type === "image" ? canvasNodeSizeFromRatio(mediaSettings.parameters.generation_size || "", CANVAS_NODE_DEFAULT_SIZE.image.width, CANVAS_NODE_DEFAULT_SIZE.image.height) || CANVAS_NODE_DEFAULT_SIZE.image : CANVAS_NODE_DEFAULT_SIZE[type];
      const layoutSourceNodes = canvasAgentMediaLayoutSources(type, nodesRef.current, sourceNodes);
      const point = sourcePosition(layoutSourceNodes, size);
      const prompt = stringValue("prompt");
      const titleValue = stringValue("title") || prompt.slice(0, 32) || canvasNodeFallbackTitle(type);
      let node: CanvasNode;
      if (type === "image") {
        node = { id: `image-${randomID()}`, type, ...point, ...size, scale_x: 1, scale_y: 1, title: titleValue, prompt, exclude_upstream_text: true, ...preferredCanvasImageParameters(), generation_model: generationModel, ...mediaSettings.parameters, generation_count: args.count as number, created_at: createdAt() };
      } else if (type === "video") {
        node = { ...buildVideoNode({ title: titleValue, prompt }, point), ...size, exclude_upstream_text: true, generation_video_model: generationModel, ...mediaSettings.parameters, generation_video_seconds: videoSeconds, generation_video_audio: videoGenerateAudio };
      } else {
        const cloneNodeID = sourceNodes.find((source) => source.type === "audio" && source.url)?.id || "";
        node = { id: `audio-${randomID()}`, type, ...point, ...size, scale_x: 1, scale_y: 1, title: titleValue, prompt, exclude_upstream_text: true, generation_audio_model: generationModel, ...canvasAgentAudioNodeParameters(generationModel, stringValue("voice") || imageGenerationPreferences.default_audio_voice, stringValue("instructions") || imageGenerationPreferences.audio_instructions, cloneNodeID, { format: imageGenerationPreferences.default_audio_format, speed: imageGenerationPreferences.default_audio_speed }), created_at: createdAt() };
      }
      if (type === "image" && attachmentImages.length) node = { ...node, generation_reference_urls: attachmentImages };
      if (type === "video" && attachments.length) node = { ...node, generation_video_reference_image_urls: attachmentImages, generation_video_reference_urls: canvasAgentAttachmentURLs(attachments, "video"), generation_video_reference_audio_urls: canvasAgentAttachmentURLs(attachments, "audio") };
      const createdConnections = sourceNodeIDs.map((sourceNodeID): CanvasConnection => ({ id: `connection-${randomID()}`, from_node_id: sourceNodeID, to_node_id: node.id }));
      const allNodes = [...nodesRef.current, node];
      replaceNodes(allNodes);
      replaceConnections([...connectionsRef.current, ...createdConnections]);
      selectOnly(node.id);
      pushHistory();
      return generateMediaNode(node, true, createdConnections.map((connection) => connection.id));
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
    const parameters = canvasVideoParameters(parent || ({ generation_video_model: videoModel, generation_video_audio: imageGenerationPreferences.workbench.video_generate_audio } as CanvasNode));
    const size = canvasNodeSizeFromRatio(parameters.generation_video_size, CANVAS_NODE_DEFAULT_SIZE.video.width, CANVAS_NODE_DEFAULT_SIZE.video.height) || CANVAS_NODE_DEFAULT_SIZE.video;
    return {
      id: `video-${randomID()}`,
      type: "video",
      x: point.x,
      y: point.y,
      ...size,
      scale_x: 1,
      scale_y: 1,
      url: video.url || "",
      title: video.title || "视频",
      prompt: video.prompt || "",
      task_id: video.taskID || "",
      ...parameters,
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
    temporaryUploadRef.current = false;
    if (imageInputRef.current) imageInputRef.current.multiple = false;
    uploadNodeIDRef.current = nodeID;
    uploadPositionRef.current = null;
    imageInputRef.current?.click();
  }

  function requestCanvasImageUpload(position?: { x: number; y: number }, temporary = false) {
    if (uploadingNodeID) return;
    const rect = hostRef.current?.getBoundingClientRect();
    temporaryUploadRef.current = temporary;
    if (imageInputRef.current) imageInputRef.current.multiple = true;
    uploadNodeIDRef.current = "";
    uploadPositionRef.current = position || {
      x: ((rect?.width || 640) / 2 - viewportRef.current.x) / viewportRef.current.zoom,
      y: ((rect?.height || 480) / 2 - viewportRef.current.y) / viewportRef.current.zoom,
    };
    imageInputRef.current?.click();
  }

  async function handleNodeImageUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    const nodeID = uploadNodeIDRef.current;
    const position = uploadPositionRef.current || canvasCenterPosition();
    const temporary = temporaryUploadRef.current;
    uploadNodeIDRef.current = "";
    uploadPositionRef.current = null;
    temporaryUploadRef.current = false;
    await uploadCanvasFiles(nodeID ? files.slice(0, 1) : files, position, nodeID, temporary);
  }

  async function uploadCanvasFiles(files: File[], position: { x: number; y: number }, nodeID = "", temporary = false) {
    if (batchUploadRef.current || uploadingNodeID) return;
    batchUploadRef.current = true;
    const projectID = documentRef.current.id;
    const epoch = canvasOperationEpochRef.current;
    try {
      for (const [index, file] of files.entries()) {
        if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== epoch) break;
        const point = { x: position.x + index % 3 * 440, y: position.y + Math.floor(index / 3) * 400 };
        if (isCanvasAudioFile(file)) await uploadAudioFile(file, nodeID, point, temporary);
        else if (file.type.startsWith("video/") || /\.(mp4|mov)$/i.test(file.name)) await uploadVideoFile(file, nodeID, point, temporary);
        else if (file.type.startsWith("image/")) await uploadImageFile(file, nodeID, point, temporary);
        else toast.error(`不支持的素材：${file.name}`);
      }
    } finally { batchUploadRef.current = false; }
  }

  async function uploadVideoFile(file: File, nodeID = "", position?: { x: number; y: number }, temporary = false) {
    if (uploadingNodeID) return toast.error("已有素材正在上传");
    const validationError = canvasVideoFileError(file);
    if (validationError) return toast.error(validationError);
    const initialTarget = nodeID ? nodesRef.current.find((node) => node.id === nodeID && node.type === "video") : null;
    if (nodeID && !initialTarget) return toast.error("只能在视频节点中替换视频文件");
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setUploadingNodeID(nodeID || "canvas-upload");
    try {
      const uploaded = temporary ? await uploadTemporaryMedia(file) : await uploadMediaBlob(file, file.name);
      if (documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch) return;
      const target = nodeID ? nodesRef.current.find((node) => node.id === nodeID && node.type === "video") : null;
      if (nodeID && !target) return;
      const sourceWidth = uploaded.width || 1280;
      const sourceHeight = uploaded.height || 720;
      const size = canvasVideoDisplaySize(sourceWidth, sourceHeight);
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
          natural_width: sourceWidth,
          natural_height: sourceHeight,
			bytes: uploaded.bytes || file.size,
          duration_ms: uploaded.durationMs,
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
          natural_width: sourceWidth,
          natural_height: sourceHeight,
			bytes: uploaded.bytes || file.size,
          duration_ms: uploaded.durationMs,
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

  async function uploadAudioFile(file: File, nodeID = "", position?: { x: number; y: number }, temporary = false) {
    if (uploadingNodeID) return toast.error("已有素材正在上传");
    if (!isCanvasAudioFile(file)) return toast.error("请选择音频文件");
    const initialTarget = nodeID ? nodesRef.current.find((node) => node.id === nodeID && node.type === "audio") : null;
    if (nodeID && !initialTarget) return toast.error("只能在音频节点中替换音频文件");
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setUploadingNodeID(nodeID || "canvas-upload");
    try {
      const uploaded = temporary ? await uploadTemporaryMedia(file) : await uploadMediaBlob(file, file.name);
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
          duration_ms: uploaded.durationMs,
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
          duration_ms: uploaded.durationMs,
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

  async function uploadImageFile(file: File, nodeID = "", position?: { x: number; y: number }, temporary = false) {
    if (uploadingNodeID) return toast.error("已有图片正在上传");
    if (!file.type.startsWith("image/")) return toast.error("请选择图片文件");
    const initialTarget = nodeID ? nodesRef.current.find((node) => node.id === nodeID && (node.type === "image" || node.type === "panorama")) : null;
    if (nodeID && !initialTarget) return;
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setUploadingNodeID(nodeID || "canvas-upload");
    try {
      const uploaded = temporary ? await uploadTemporaryMedia(file) : await uploadImage(file);
      const sourceSize = { width: uploaded.width || 1024, height: uploaded.height || 1024 };
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

  function createCanvasNode(type: CanvasCreatableNodeType, center?: { x: number; y: number }) {
    const size = type === "video"
      ? canvasNodeSizeFromRatio(canvasVideoParameters({ generation_video_model: videoModel, generation_video_audio: imageGenerationPreferences.workbench.video_generate_audio } as CanvasNode).generation_video_size, CANVAS_NODE_DEFAULT_SIZE.video.width, CANVAS_NODE_DEFAULT_SIZE.video.height) || CANVAS_NODE_DEFAULT_SIZE.video
      : CANVAS_NODE_DEFAULT_SIZE[type];
    const point = center ? { x: center.x - size.width / 2, y: center.y - size.height / 2 } : placement();
    if (type === "text") addTextNodeAt(point);
    else if (type === "image") addBlankNodeAt(point);
    else if (type === "audio") addAudioNodeAt(point);
    else if (type === "panorama") addPanoramaNodeAt(point);
    else if (type === "script") {
      const node: CanvasNode = { id: `script-${randomID()}`, type: "script", ...point, ...CANVAS_NODE_DEFAULT_SIZE.script, scale_x: 1, scale_y: 1, title: "脚本", prompt: "", generation_text_model: textModel, script_project: createScriptProject(), created_at: createdAt() };
      addNode(node);
      setPanelNodeID(node.id);
    }
    else if (type === "director") addDirectorNodeAt(point);
    else if (type === "config") addConfigNodeAt(point);
    else addBlankVideoNodeAt(point);
  }

  function createPendingNode(type: CanvasCreatableNodeType) {
    if (!pendingConnection) return;
    const size = type === "video"
      ? canvasNodeSizeFromRatio(canvasVideoParameters({ generation_video_model: videoModel, generation_video_audio: imageGenerationPreferences.workbench.video_generate_audio } as CanvasNode).generation_video_size, CANVAS_NODE_DEFAULT_SIZE.video.width, CANVAS_NODE_DEFAULT_SIZE.video.height) || CANVAS_NODE_DEFAULT_SIZE.video
      : CANVAS_NODE_DEFAULT_SIZE[type];
    const node: CanvasNode = canvasEmptyMediaNodeFrame({ id: `${type}-${randomID()}`, type, x: pendingConnection.position.x - size.width / 2, y: pendingConnection.position.y - size.height / 2, ...size, ...(type === "text" ? { font_size: 14 } : {}), ...(type === "script" ? { generation_text_model: textModel, script_project: createScriptProject() } : {}), scale_x: 1, scale_y: 1, title: canvasNodeFallbackTitle(type), prompt: "", ...(type === "image" || type === "panorama" || type === "config" ? preferredCanvasImageParameters() : type === "video" ? canvasVideoParameters({ generation_video_model: videoModel, generation_video_audio: imageGenerationPreferences.workbench.video_generate_audio } as CanvasNode) : type === "audio" ? preferredCanvasAudioParameters() : {}), ...(type === "config" ? { generation_mode: "image" as const, generation_model: imageModel } : {}), ...(type === "panorama" ? { generation_size: "2:1" } : {}), created_at: createdAt() });
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
    const removedIDs = expandCanvasRemovalNodeIDs(ids, nodesRef.current);
    removedIDs.forEach((id) => mediaOperationsRef.current.get(id)?.abort());
    if (removedIDs.has(audioTrimNodeID)) setAudioTrimNodeID("");
    setAgentSessions((current) => {
      const next = clearCanvasAgentSessionReferences(current, removedIDs);
      documentRef.current = { ...documentRef.current, agent_sessions: next };
      return next;
    });
    const removedGenerations = new Set([...removedIDs].flatMap((nodeID) => {
      const generation = activeGenerationsRef.current.get(nodeID);
      return generation ? [generation] : [];
    }));
    interruptGenerationRecords(removedGenerations);
    const generationHistoryBase = removedIDs.has(runningNodeID) || removedIDs.has(runningResultNodeID)
      ? interruptActiveGeneration()
      : null;
    replaceNodes(reconcileCanvasBatchesAfterRemoval(nodesRef.current, removedIDs));
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
      batch_child_ids: undefined,
      batch_root_id: undefined,
      batch_primary_id: undefined,
      batch_expanded: undefined,
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
    if (!text) return toast.error("请先在节点下方生成文字内容");
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
      await copyClipboardText(prompt);
      toast.success("提示词已复制");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "复制提示词失败");
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
      const assets = await fetchMyAssets(session.key);
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
      await upsertMyAsset(asset);
      toast.success("已保存到我的素材");
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
    const node = nodesRef.current.find((item) => item.id === nodeID);
    if (!node || (node.type === "text" ? !node.prompt?.trim() : !node.url)) return;
    try {
      await downloadCanvasNodeMedia(node);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "文件下载失败");
    }
  }

  function openCanvasImageTool(nodeID: string, kind: CanvasImageToolState["kind"]) {
    const node = nodesRef.current.find((item) => item.id === nodeID && (item.type === "image" || item.type === "panorama") && item.url);
    if (!node?.url || imageToolBusy) return;
    if (kind === "mask") setMaskEditModel(node.generation_model?.trim() || imageModel.trim());
    setImageTool({ kind, nodeID, sourceURL: node.url });
  }

  function closeCanvasImageTool() {
    if (imageToolBusy) return;
    setImageTool(null);
    setMaskEditModel("");
  }

  function closeAgentPanel() {
    setAgentOpen(false);
    documentRef.current = { ...documentRef.current, agent_panel: { open: false, width: CANVAS_AGENT_WIDTH, mode: agentDisplayMode } };
    scheduleSave();
  }

  function cancelCanvasMediaOperations() {
    mediaOperationsRef.current.forEach((controller) => controller.abort());
    mediaOperationsRef.current.clear();
    if (mountedRef.current) {
      setMediaBusyNodeIDs(new Set());
      setAudioTrimNodeID("");
    }
  }

  function handleCanvasMediaOperation(nodeID: string, operation: CanvasMediaOperation) {
    setContextMenu(null);
    if (mediaOperationsRef.current.has(nodeID)) return;
    if (operation === "trim-audio") setAudioTrimNodeID(nodeID);
    else void editCanvasMedia(nodeID, operation);
  }

  async function editCanvasMedia(nodeID: string, operation: CanvasMediaOperation, trim?: CanvasAudioTrim) {
    const source = nodesRef.current.find((node) => node.id === nodeID && node.url && (node.type === "video" || node.type === "audio"));
    if (!source || mediaOperationsRef.current.has(nodeID)) return;
    if (operation === "trim-audio" && !trim) return;
    const framePosition = operation.startsWith("frame-") ? operation.slice(6) as CanvasVideoFramePosition : null;
    if (framePosition && source.type !== "video") return;
    const video = hostRef.current?.querySelector<HTMLVideoElement>(`[data-node-id="${CSS.escape(nodeID)}"] video`);
    if (framePosition === "current" && !video) { toast.error("请先将视频节点移入画面，再截取当前帧"); return; }
    const currentTime = video?.currentTime || 0;
    const projectID = documentRef.current.id;
    const epoch = canvasOperationEpochRef.current;
    const expectedSessionKey = session.key;
    const controller = new AbortController();
    const sessionChanged = () => { if (getCachedAuthSession()?.key !== expectedSessionKey) controller.abort(); };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, sessionChanged);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (!mountedRef.current || getCachedAuthSession()?.key !== expectedSessionKey || documentRef.current.id !== projectID || canvasOperationEpochRef.current !== epoch || !nodesRef.current.some((node) => node.id === nodeID && node.url === source.url)) {
        controller.abort();
        controller.signal.throwIfAborted();
      }
    };
    mediaOperationsRef.current.set(nodeID, controller);
    setMediaBusyNodeIDs((current) => new Set(current).add(nodeID));
    const label = framePosition ? "截取画面" : trim ? "截取音频" : "分离音频";
    const toastID = toast.loading(`正在${label}…`);
    try {
      assertCurrent();
      const blob = await canvasMediaBlob(source, controller.signal);
      assertCurrent();
      const currentSource = () => nodesRef.current.find((node) => node.id === nodeID)!;
      let node: CanvasNode;
      if (framePosition) {
        const frame = await captureCanvasVideoFrame(blob, framePosition, currentTime, controller.signal);
        assertCurrent();
        const uploaded = await uploadImage(frame, controller.signal);
        assertCurrent();
        const title = `${source.title || "视频"} ${{ first: "首帧", last: "尾帧", current: "当前帧" }[framePosition]}`;
        node = buildImageNode({ url: uploaded.url, storageKey: uploaded.storageKey, title, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes }, { x: currentSource().x + currentSource().width + 96, y: getNextDirectorOutputY(currentSource(), nodesRef.current, connectionsRef.current) });
        node.mime_type = uploaded.mimeType;
      } else {
        const result = await extractCanvasAudio(blob, trim, controller.signal);
        assertCurrent();
        const fileName = `${source.title || (source.type === "video" ? "视频" : "音频")} ${trim ? "截取" : "音轨"}.wav`;
        const uploaded = await uploadMediaBlob(result.blob, fileName, controller.signal);
        assertCurrent();
        node = {
          id: `audio-${randomID()}`,
          type: "audio",
          ...CANVAS_NODE_DEFAULT_SIZE.audio,
          x: currentSource().x + currentSource().width + 96,
          y: getNextDirectorOutputY(currentSource(), nodesRef.current, connectionsRef.current),
          scale_x: 1,
          scale_y: 1,
          title: fileName,
          url: uploaded.url,
          storage_key: uploaded.storageKey,
          mime_type: uploaded.mimeType || "audio/wav",
          bytes: uploaded.bytes || result.blob.size,
          duration_ms: uploaded.durationMs || Math.round(result.duration * 1000),
          ...preferredCanvasAudioParameters(),
          generation_status: "success",
          created_at: createdAt(),
        };
      }
      assertCurrent();
      replaceNodes([...nodesRef.current, node]);
      replaceConnections([...connectionsRef.current, { id: `connection-${randomID()}`, from_node_id: nodeID, to_node_id: node.id }]);
      setSelectedNodeIDs(new Set([node.id]));
      setSelectedConnectionID("");
      setPanelNodeID(node.id);
      if (trim) setAudioTrimNodeID("");
      pushHistory();
      toast.success(`${label}完成，已创建${framePosition ? "图片" : "音频"}节点`);
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : `${label}失败`);
    } finally {
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, sessionChanged);
      toast.dismiss(toastID);
      if (mediaOperationsRef.current.get(nodeID) === controller) {
        mediaOperationsRef.current.delete(nodeID);
        if (mountedRef.current) setMediaBusyNodeIDs((current) => { const next = new Set(current); next.delete(nodeID); return next; });
      }
    }
  }

  async function uploadDerivedCanvasImage(dataURL: string, fileName: string) {
    const file = await canvasDataURLFile(dataURL, fileName);
    const uploaded = await uploadImage(file);
    const dimensions = uploaded;
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

  async function cropCanvasNode(crop: CanvasImageCropRect, sourceURL: string) {
    if (!imageTool || imageTool.kind !== "crop" || imageToolBusy) return;
    const source = nodesRef.current.find((node) => node.id === imageTool.nodeID && (node.type === "image" || node.type === "panorama"));
    if (!source) return closeCanvasImageTool();
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setImageToolBusy(true);
    try {
      const result = await uploadDerivedCanvasImage(await cropCanvasImage(sourceURL, crop), `canvas-crop-${source.id}.png`);
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

  async function splitCanvasNode(params: CanvasImageSplitParams, sourceURL: string) {
    if (!imageTool || imageTool.kind !== "split" || imageToolBusy) return;
    const source = nodesRef.current.find((node) => node.id === imageTool.nodeID && (node.type === "image" || node.type === "panorama"));
    if (!source) return closeCanvasImageTool();
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setImageToolBusy(true);
    try {
      const pieces = await splitCanvasImage(sourceURL, params);
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

  async function upscaleCanvasNode(params: CanvasImageUpscaleParams, sourceURL: string) {
    if (!imageTool || imageTool.kind !== "upscale" || imageToolBusy) return;
    const source = nodesRef.current.find((node) => node.id === imageTool.nodeID && (node.type === "image" || node.type === "panorama"));
    if (!source) return closeCanvasImageTool();
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    setImageToolBusy(true);
    try {
      const result = await uploadDerivedCanvasImage(await upscaleCanvasImage(sourceURL, params), `canvas-upscale-${source.id}.png`);
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
    const prompt = imageMaskEditPrompt(payload.prompt);
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
    const copiedIDs = expandCanvasBatchNodeIDs(expandCanvasGroupNodeIDs(selectedNodeIDs, nodesRef.current), nodesRef.current);
    const copiedNodes = nodesRef.current.filter((node) => copiedIDs.has(node.id)).map((node) => (
      node.group_id && !copiedIDs.has(node.group_id) ? { ...node, group_id: undefined } : node
    ));
    if (!copiedNodes.length) return;
    const ids = new Set(copiedNodes.map((node) => node.id));
    const copiedConnections = connectionsRef.current.filter((connection) => ids.has(connection.from_node_id) && ids.has(connection.to_node_id));
    clipboardRef.current = { nodes: copiedNodes, connections: copiedConnections };
    try {
      await copyClipboardText(JSON.stringify({ type: "yunmian-canvas-nodes", nodes: copiedNodes, connections: copiedConnections }));
      toast.success(`已复制 ${copiedNodes.length} 个节点`);
    } catch (error) {
      toast.info(`已复制 ${copiedNodes.length} 个节点，可在当前画布内粘贴`, { description: error instanceof Error ? error.message : "系统剪贴板不可用" });
    }
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

  function applyHistory(document: CanvasHistorySnapshot) {
    interruptActiveGeneration();
    canvasOperationEpochRef.current += 1;
    cancelCanvasMediaOperations();
    const next = restoreCanvasHistoryDocument(documentRef.current, createCanvasHistorySnapshot(document));
    documentRef.current = next;
    titleRef.current = next.title;
    replaceNodes(next.nodes);
    replaceConnections(next.connections);
    backgroundRef.current = next.background;
    showImageInfoRef.current = Boolean(next.show_image_info);
    setTitle(next.title);
    setBackground(next.background);
    setShowImageInfo(showImageInfoRef.current);
    selectionChanged(new Set());
    scheduleSave();
  }

  function undo() {
    if (expireCanvasHistoryLease()) return;
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
    if (expireCanvasHistoryLease()) return;
    const next = redoRef.current.pop();
    if (!next) return;
    historyRef.current.push(next);
    applyHistory(next);
    setHistoryVersion((value) => value + 1);
  }

  function expireCanvasHistoryLease() {
    if (!canvasHistoryLeaseExpired(documentRef.current)) return false;
    historyRef.current = [createCanvasHistorySnapshot(captureDocument())];
    redoRef.current = [];
    generationHistoryBaseRef.current = null;
    documentRef.current = { ...documentRef.current, retained_storage_object_ids: [], retained_storage_object_urls: [], retained_storage_objects_until: undefined };
    setHistoryVersion((value) => value + 1);
    scheduleSave();
    return true;
  }

  function fitCanvasContent(content: readonly CanvasNode[] = visibleCanvasNodes(nodesRef.current), size = canvasSize) {
    if (focusAnimationRef.current !== null) window.cancelAnimationFrame(focusAnimationRef.current);
    focusAnimationRef.current = null;
    if (!content.length) return resetViewport();
    const left = Math.min(...content.map((node) => node.x));
    const top = Math.min(...content.map((node) => node.y)) - 36;
    const right = Math.max(...content.map((node) => node.x + node.width));
    const bottom = Math.max(...content.map((node) => node.y + node.height));
    const availableHeight = Math.max(1, size.height - (size.width < 820 ? 212 : 164));
    const zoom = Math.min(1, Math.max(CANVAS_MIN_ZOOM, Math.min(Math.max(1, size.width - 80) / (right - left), availableHeight / (bottom - top))));
    updateViewport({ zoom, x: size.width / 2 - (left + right) * zoom / 2, y: 76 + availableHeight / 2 - (top + bottom) * zoom / 2 }, true);
  }

  function focusScriptProduction(scriptID: string) {
    const script = nodesRef.current.find(node => node.id === scriptID && node.script_project);
    if (!script) return;
    const content = canvasScriptProductionNodes(script, nodesRef.current);
    setOpenScriptNodeID("");
    selectionChanged(new Set([script.id]));
    const area = agentAreaRef.current;
    if (agentOpen && area && (canvasSize.width < 240 || area.clientWidth <= CANVAS_AGENT_WIDTH + 24)) {
      closeAgentPanel();
      fitCanvasContent(content, { width: area.clientWidth, height: area.clientHeight });
      return;
    }
    fitCanvasContent(content);
  }

  function resetViewport() {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    updateViewport(resetCanvasViewport(rect), true);
    setContextMenu(null);
  }

  function interruptActiveGeneration() {
    const activeRecords = new Set(activeGenerationsRef.current.values());
    if (!generationAbortControllerRef.current && !runningNodeID && !activeRecords.size) return null;
    const generationHistoryBase = generationHistoryBaseRef.current;
    generationHistoryBaseRef.current = null;
    interruptGenerationRecords(activeRecords);
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
    setStopTargetNodeID("");
    setRunningNodeID("");
    setRunningResultNodeID("");
    setRunningTaskID("");
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
    const projectID = documentRef.current.id;
    const targetProjectID = input.action === "activate" ? input.project_id : undefined;
    if (input.action === "activate" && (!targetProjectID || targetProjectID === projectID)) return;
    const documentEpoch = canvasDocumentEpochRef.current;
    let switchedDocumentEpoch: number | undefined;
    const changesActiveProject = input.action === "create"
      || input.action === "activate"
      || input.action === "delete" && (!input.project_id || input.project_id === documentRef.current.id);
    if (changesActiveProject) {
      canvasOperationEpochRef.current += 1;
      cancelCanvasMediaOperations();
      interruptGenerationForProjectChange();
      setProjectMenuOpen(false);
      if (switchRevealTimerRef.current !== null) window.clearTimeout(switchRevealTimerRef.current);
      switchRevealTimerRef.current = null;
      setSwitchLabel(input.action === "delete" ? "正在删除画布…" : input.action === "create" ? "正在创建画布…" : "正在切换画布…");
      setSwitchPhase("switching");
    }
    try {
      await enqueueWorkspaceMutation(async () => {
        if (!mountedRef.current || documentRef.current.id !== projectID || canvasDocumentEpochRef.current !== documentEpoch) return;
        if (!await flushCanvasSaves({
          save: persistCanvas,
          getChangeVersion: () => saveChangeVersionRef.current,
          getProjectID: () => documentRef.current.id,
        })) return;
        if (!mountedRef.current || documentRef.current.id !== projectID || canvasDocumentEpochRef.current !== documentEpoch) return;
        if (targetProjectID) {
          navigate(canvasProjectPath(targetProjectID));
          return;
        }
        const request = input.action === "rename" || input.action === "delete"
          ? { ...input, revision: documentRef.current.revision }
          : input;
        const response = await updateCanvasProject(request, "active");
        if (!mountedRef.current || documentRef.current.id !== projectID || canvasDocumentEpochRef.current !== documentEpoch) return;
        if (changesActiveProject) {
          applyWorkspace(response);
          switchedDocumentEpoch = canvasDocumentEpochRef.current;
        }
        else {
          applyBackendAgentDocument(response.document);
          setProjects(response.projects || []);
        }
        if (changesActiveProject && response.active_project_id) navigate(canvasProjectPath(response.active_project_id));
        setProjectMenuOpen(false);
      });
    } catch (error) {
      if (mountedRef.current && documentRef.current.id === projectID && canvasDocumentEpochRef.current === documentEpoch) toast.error(error instanceof Error ? error.message : "画布项目操作失败");
    } finally {
      if (changesActiveProject && mountedRef.current && canvasDocumentEpochRef.current === (switchedDocumentEpoch ?? documentEpoch)) {
        const revealEpoch = canvasDocumentEpochRef.current;
        setSwitchPhase("revealing");
        switchRevealTimerRef.current = window.setTimeout(() => {
          switchRevealTimerRef.current = null;
          if (mountedRef.current && canvasDocumentEpochRef.current === revealEpoch) setSwitchPhase(null);
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

  function waitForTask(taskID: string, onProgress?: (task: CreationTask) => void, signal?: AbortSignal) {
    return waitForCreationTask(taskID, { onProgress, signal, timeoutMs: null });
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
    let nextConnections = connectionsRef.current;
    const nextNodes = result.nodes.map((node, index): CanvasNode => {
      const previous = nodesRef.current[index];
      if (node.type !== "script" || node.generation_status !== "success" || !node.script_project || node.script_project === previous.script_project) return node;
      const edges = scriptAssetConnections(node.id, node.script_project, previous.script_project, nextConnections);
      if (edges.length > 2000) return { ...node, script_project: previous.script_project, generation_status: "error", generation_error: "画布容量不足，请清理节点和连线后重试" };
      nextConnections = edges;
      return node;
    });
    replaceNodes(nextNodes);
    if (nextConnections !== connectionsRef.current) replaceConnections(nextConnections);
    if (result.terminal || result.completedImageCount > 0) scheduleSave();
    return { terminal: result.terminal, completedImageCount: result.completedImageCount };
  }

  function markCanvasTaskRecoveryPending(taskID: string, projectID: string, operationEpoch: number, signal: AbortSignal) {
    if (!isCurrentCanvasRecovery(projectID, operationEpoch, signal)) return;
    replaceNodes(markCanvasGenerationRecoveryPending(nodesRef.current, taskID));
    scheduleSave();
  }

  async function recoverCanvasTasks(
    projectID: string,
    operationEpoch: number,
    taskIDs: string[],
    expectedSessionKey: string,
    signal: AbortSignal,
  ) {
    let response: Awaited<ReturnType<typeof fetchCreationTasks>>;
    try {
      response = await fetchCreationTasks(taskIDs, { signal });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        taskIDs.forEach((taskID) => markCanvasTaskRecoveryPending(taskID, projectID, operationEpoch, signal));
      }
      return;
    }
    if (!isCurrentCanvasRecovery(projectID, operationEpoch, signal)) return;
    const tasksByID = new Map(response.items.map((task) => [task.id, task]));
    await Promise.all(taskIDs.map(async (taskID) => {
      try {
        // A refresh can race the submission acknowledgement. Observe the original
        // task before deciding it is missing; never submit a replacement here.
        let task = tasksByID.get(taskID) || await waitForCreationTask(taskID, {
          signal,
          timeoutMs: 15_000,
          onProgress: (nextTask) => { applyRecoveredCanvasTask(nextTask, projectID, operationEpoch, signal); },
        });
        if (!isCurrentCanvasRecovery(projectID, operationEpoch, signal)) return;
        if (task.mode === "video" && task.status === "error" && task.can_recover_video) {
          task = await recoverVideoTask(taskID, { signal });
          if (!isCurrentCanvasRecovery(projectID, operationEpoch, signal)) return;
        }
        const recoveredTask = task.status === "success" || task.status === "error" || task.status === "cancelled"
          ? await persistCreationTaskOutputs(task, {
              assetContext: { source: "无限画布" },
              expectedSessionKey,
              signal,
            })
          : task;
        const progress = applyRecoveredCanvasTask(recoveredTask, projectID, operationEpoch, signal);
        if (progress.terminal) return;
        const completedTask = await waitForCreationTask(taskID, {
          signal, timeoutMs: null, minRevision: Number(task.revision) || 0,
          onProgress: (nextTask) => { applyRecoveredCanvasTask(nextTask, projectID, operationEpoch, signal); },
        });
        applyRecoveredCanvasTask(await persistCreationTaskOutputs(completedTask, {
          assetContext: { source: "无限画布" },
          expectedSessionKey,
          signal,
        }), projectID, operationEpoch, signal);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          markCanvasTaskRecoveryPending(taskID, projectID, operationEpoch, signal);
        }
      }
    }));
  }

  async function retryCanvasNode(nodeID: string) {
    const node = nodesRef.current.find((item) => item.id === nodeID);
    if (!node || activeGenerationsRef.current.has(nodeID)) return;
    if (!canvasGenerationNeedsRecovery(node)) return runGeneration(nodeID, undefined, true);
    const taskID = canvasGenerationRecoveryTaskID(node);
    if (!canvasRecoveryAbortControllerRef.current || canvasRecoveryAbortControllerRef.current.signal.aborted) canvasRecoveryAbortControllerRef.current = new AbortController();
    return recoverCanvasTasks(documentRef.current.id, canvasOperationEpochRef.current, [taskID], session.key, canvasRecoveryAbortControllerRef.current.signal);
  }

  async function stopGeneration(nodeID: string) {
    const generation = activeGenerationsRef.current.get(nodeID);
    if (!generation || cancellingGenerationNodeIDs.has(nodeID)) return;
    generation.taskIDs.forEach((taskID) => cancelledTaskIDsRef.current.add(taskID));
    setCancellingGenerationNodeIDs((current) => new Set([...current, ...generation.nodeIDs]));
    generation.controller.abort();
    try {
      await stopCreationTasks([...generation.submittedTaskIDs], undefined, generation.sessionKey);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        toast.error(error instanceof Error ? `本地已停止，服务端停止失败：${error.message}` : "本地已停止，服务端停止失败");
      }
    } finally {
      releaseActiveGeneration(generation);
    }
  }

  function requestStopGeneration(nodeID: string) {
    if (!activeGenerationsRef.current.has(nodeID) || cancellingGenerationNodeIDs.has(nodeID)) return;
    setStopTargetNodeID(nodeID);
  }

  function confirmStopGeneration() {
    const nodeID = stopTargetNodeID;
    setStopTargetNodeID("");
    if (nodesRef.current.some((node) => node.id === nodeID && node.type === "script")) void stopScriptTasks(nodeID);
    else if (nodeID) void stopGeneration(nodeID);
  }

  function scriptRelatedNodeIDs(nodeID: string) {
    const node = nodesRef.current.find((item) => item.id === nodeID);
    return new Set([nodeID, ...(node?.script_project?.assets.map((asset) => asset.image_node_id) || []), ...(node?.script_project?.shots.flatMap((shot) => [shot.image_node_id, shot.video_node_id]) || []), ...connectionsRef.current.filter((edge) => edge.from_node_id === nodeID || edge.to_node_id === nodeID).map((edge) => edge.from_node_id === nodeID ? edge.to_node_id : edge.from_node_id)].filter((id): id is string => Boolean(id)));
  }

  function scriptNodeRunning(nodeID: string) {
    const related = scriptRelatedNodeIDs(nodeID);
    return scriptMediaSubmissionsRef.current.has(nodeID) || related.has(uploadingNodeID) || nodesRef.current.some((node) => related.has(node.id) && (node.generation_status === "loading" || nodeGenerationRunning(node.id)));
  }

  function stopScriptGenerations(nodeID: string) {
    if (scriptNodeRunning(nodeID)) setStopTargetNodeID(nodeID);
  }

  async function stopScriptTasks(nodeID: string) {
    scriptMediaSubmissionsRef.current.get(nodeID)?.abort();
    scriptMediaSubmissionsRef.current.delete(nodeID);
    const projectID = documentRef.current.id;
    const epoch = canvasOperationEpochRef.current;
    const related = scriptRelatedNodeIDs(nodeID);
    const recovering = nodesRef.current.filter((node) => related.has(node.id) && node.generation_status === "loading" && !activeGenerationsRef.current.has(node.id));
    try {
      await Promise.all([...related].map((id) => stopGeneration(id)));
      const taskIDs = [...new Set(recovering.map((node) => node.task_id).filter((id): id is string => Boolean(id)))];
      if (taskIDs.length) await stopCreationTasks(taskIDs, undefined, session.key);
      if (!mountedRef.current || documentRef.current.id !== projectID || canvasOperationEpochRef.current !== epoch) return;
      const recoveringIDs = new Set(recovering.map((node) => node.id));
      replaceNodes(nodesRef.current.map((node) => recoveringIDs.has(node.id) && node.generation_status === "loading" ? { ...node, script_operation: undefined, generation_status: "idle", generation_error: "" } : node));
      pushHistory();
    } catch (error) { toast.error(error instanceof Error ? error.message : "停止脚本任务失败"); }
  }

  function downloadScript(node: CanvasNode) {
    const blob = new Blob([JSON.stringify({ title: node.title, story: node.prompt, ...node.script_project }, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `${node.title || "脚本"}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function concatenateScript(nodeID: string, ids: readonly string[]) {
    const node = nodesRef.current.find((item) => item.id === nodeID);
    const project = node?.script_project;
    if (!project || scriptNodeRunning(nodeID)) return;
    updateScriptProject(nodeID, { ...project, shots: project.shots.map((shot) => ids.includes(shot.id) ? { ...shot, ...concatenateScriptPrompts(shot, project.assets) } : shot) });
  }

  function requestScriptGeneration(nodeID: string) {
    const project = nodesRef.current.find((node) => node.id === nodeID)?.script_project;
    if (project?.assets.length || project?.shots.some((shot) => shot.description.trim())) setRegenerateScriptNodeID(nodeID);
    else void runScriptTextGeneration(nodeID, "script");
  }

  async function runScriptTextGeneration(nodeID: string, kind: "script" | "prompts", shotIDs: string[] = []) {
    const source = nodesRef.current.find((node) => node.id === nodeID && node.type === "script");
    if (!source || scriptNodeRunning(nodeID)) return;
    const model = source.generation_text_model || textModel;
    if (!textModels.includes(model)) return toast.error("请选择全局模型设置中已启用的文本模型");
    const relayTokenName = nextTokenNameForModel("text", model);
    if (!relayTokenName.trim()) { setRelayTokenDialogKind("text"); return; }
    const project = source.script_project || createScriptProject();
    const projectSnapshot = JSON.stringify(project);
    const context = buildCanvasGenerationContext(nodeID, nodesRef.current, connectionsRef.current, source.prompt || "");
    if (kind === "script" && !context.prompt.trim() && !context.referenceImageURLs.length) return toast.error("请描述故事或连接参考素材");
    if (kind === "prompts" && (!shotIDs.length || project.shots.filter((shot) => shotIDs.includes(shot.id)).some((shot) => !shot.description.trim()))) return toast.error("请先填写镜头画面描述");
    const contextSnapshot = JSON.stringify(context);
    const promptReferences = kind === "prompts" ? project.assets.flatMap(asset => {
      const image = scriptAssetImage(asset, nodesRef.current);
      return image?.url ? [{ assetID: asset.id, url: image.url }] : [];
    }) : [];
    const instruction = kind === "script" ? scriptGenerationInstruction(context.prompt, project) : scriptPromptInstruction(project, shotIDs, context.prompt, promptReferences.map(reference => reference.assetID));
    const projectID = documentRef.current.id;
    const epoch = canvasOperationEpochRef.current;
    const current = () => mountedRef.current && documentRef.current.id === projectID && canvasOperationEpochRef.current === epoch && nodesRef.current.some((node) => node.id === nodeID);
    const controller = new AbortController();
    const clientTaskID = `canvas-script-${randomID()}`;
    const active = registerActiveGeneration(controller, [nodeID], [clientTaskID]);
    replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? { ...node, script_project: project, script_operation: { kind, shot_ids: shotIDs }, generation_status: "loading", generation_started_at: Date.now(), generation_error: "", task_id: clientTaskID } : node));
    try {
      const referenceURLs = kind === "script" ? context.referenceImageURLs : promptReferences.map(reference => reference.url);
      const messages = await canvasTextGenerationMessages(instruction, referenceURLs, controller.signal);
      await persistGenerationCheckpoint();
      controller.signal.throwIfAborted();
      if (!current()) return;
      const task = await createChatGenerationTask({ clientTaskId: clientTaskID, prompt: instruction, model, messages, stream: true, relayTokenName, requestOptions: { signal: controller.signal } });
      addActiveGenerationTask(active, task.id || clientTaskID, clientTaskID);
      if (!current()) return;
      controller.signal.throwIfAborted();
      replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? { ...node, task_id: task.id || clientTaskID } : node));
      scheduleSave();
      const completed = await waitForTask(task.id || clientTaskID, undefined, controller.signal);
      if (!current()) return;
      controller.signal.throwIfAborted();
      if (completed.status !== "success") throw new Error(completed.error || "脚本生成失败");
      const latestProject = nodesRef.current.find((node) => node.id === nodeID)?.script_project;
      if (JSON.stringify(latestProject) !== projectSnapshot) throw new Error("脚本在生成期间已变更，请根据当前内容重新生成");
      const latestSource = nodesRef.current.find(node => node.id === nodeID)!;
      const latestContext = buildCanvasGenerationContext(nodeID, nodesRef.current, connectionsRef.current, latestSource.prompt || "");
      if (JSON.stringify(latestContext) !== contextSnapshot) throw new Error("故事或参考输入在生成期间已变更，已保留当前脚本，请核对后重新生成");
      const content = (completed.data || []).map((item) => item.text_response || "").join("\n");
      const nextProject = kind === "script" ? parseGeneratedScript(content, project) : parseScriptPrompts(content, project, shotIDs);
      replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? { ...node, script_operation: undefined, generation_status: "success", generation_progress: 100, generation_error: "" } : node));
      if (!updateScriptProject(nodeID, nextProject)) throw new Error("脚本关联保存失败");
      toast.success(kind === "script" ? "分镜脚本已生成" : "提示词已合成");
    } catch (error) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "脚本生成失败";
      replaceNodes(nodesRef.current.map((node) => node.id === nodeID ? { ...node, script_operation: undefined, generation_status: controller.signal.aborted ? "idle" : "error", generation_error: controller.signal.aborted ? "" : message } : node));
      pushHistory();
      if (!controller.signal.aborted) toast.error(message);
    } finally { completeActiveGeneration(active); }
  }

  function editScriptProject(nodeID: string, project: CanvasScriptProject) {
    if (scriptNodeRunning(nodeID)) return;
    updateScriptProject(nodeID, project);
  }

  function updateScriptProject(nodeID: string, project: CanvasScriptProject, addedNodes: CanvasNode[] = []) {
    const source = nodesRef.current.find((node) => node.id === nodeID);
    if (!source) return false;
    project = reconcileScriptProject(project, source.script_project);
    const edges = scriptAssetConnections(nodeID, project, source.script_project, connectionsRef.current);
    if (nodesRef.current.length + addedNodes.length > 500 || edges.length > 2000) {
      toast.error("画布容量不足，请清理节点和连线后重试");
      return false;
    }
    replaceNodes([...nodesRef.current.map((node) => node.id === nodeID ? { ...node, script_project: project } : node), ...addedNodes]);
    replaceConnections(edges);
    pushHistory();
    return true;
  }

  function createScriptAssetNodes(nodeID: string, assetIDs: string[], parameters: Partial<CanvasNode> = {}, prompt?: string) {
    const source = nodesRef.current.find((node) => node.id === nodeID);
    const project = source?.script_project;
    if (!source || !project) return [];
    const assets = project.assets.filter((asset) => assetIDs.includes(asset.id));
    const added: CanvasNode[] = [];
    for (const asset of assets) {
      const node: CanvasNode = canvasEmptyMediaNodeFrame({
        ...preferredCanvasImageParameters(), ...parameters,
        id: `image-${randomID()}`, type: "image", x: source.x, y: source.y,
        ...CANVAS_NODE_DEFAULT_SIZE.image, scale_x: 1, scale_y: 1,
        title: asset.name || "脚本素材", created_at: createdAt(), generation_count: 1,
        exclude_upstream_text: true,
        prompt: prompt?.trim() || `${asset.name}：${asset.description}。生成清晰的${asset.kind === "character" ? "角色" : asset.kind === "scene" ? "场景" : "道具"}设定图，保持视觉特征一致。`,
      });
      const scale=Math.min(1,240/node.width,240/node.height);
      node.width*=scale;node.height*=scale;
      added.push({ ...node, ...scriptAssetPosition(source, node, [...nodesRef.current, ...added]) });
    }
    const bindings = new Map(assets.map((asset, index) => [asset.id, added[index].id]));
    const next = { ...project, assets: project.assets.map((asset) => bindings.has(asset.id) ? { ...asset, image_node_id: bindings.get(asset.id)! } : asset) };
    return updateScriptProject(nodeID, next, added) ? added : [];
  }

  function insertScriptAsset(nodeID: string, assetID: string, payload: CanvasInsertAssetPayload) {
    const source = nodesRef.current.find((node) => node.id === nodeID);
    const project = source?.script_project;
    const asset = project?.assets.find((asset) => asset.id === assetID);
    if (!source || !project || !asset || scriptNodeRunning(nodeID)) return;
    const pending = createCanvasPendingAgentAsset(payload, payload.title);
    const node = canvasPendingAgentAssetNode(pending, 0, 1, { x: source.x, y: source.y });
    if (node.type !== "image" || !node.url) return;
    const scale=Math.min(1,240/node.width,240/node.height);node.width*=scale;node.height*=scale;
    updateScriptProject(nodeID, { ...project, assets: project.assets.map((item) => item.id === assetID ? { ...item, image_node_id: node.id } : item) }, [{ ...node, ...scriptAssetPosition(source, node, nodesRef.current) }]);
  }

  async function uploadScriptReference(nodeID: string, file: File) {
    const source = nodesRef.current.find((node) => node.id === nodeID);
    if (!source || scriptNodeRunning(nodeID) || uploadingNodeID) return;
    if (!file.type.startsWith("image/")) return toast.error("请选择图片文件");
    const projectID = documentRef.current.id;
    const epoch = canvasOperationEpochRef.current;
    const node: CanvasNode = { id: `image-${randomID()}`, type: "image", x: source.x - 440, y: source.y, ...CANVAS_NODE_DEFAULT_SIZE.image, scale_x: 1, scale_y: 1, title: file.name, created_at: createdAt() };
    replaceNodes([...nodesRef.current, node]);
    connectNodes(node.id, nodeID);
    await uploadImageFile(file, node.id);
    if (mountedRef.current && documentRef.current.id === projectID && canvasOperationEpochRef.current === epoch && nodesRef.current.some((node) => node.id === nodeID)) { setSelectedNodeIDs(new Set([nodeID])); setSelectedConnectionID(""); setPanelNodeID(nodeID); }
  }

  async function uploadScriptAsset(nodeID: string, assetID: string, file: File) {
    if (scriptNodeRunning(nodeID) || uploadingNodeID) return;
    if (!file.type.startsWith("image/")) return toast.error("请选择图片文件");
    const node = createScriptAssetNodes(nodeID, [assetID])[0];
    if (node) await uploadImageFile(file, node.id);
  }

  async function generateScriptAssets(nodeID: string, request: ScriptAssetGeneration) {
    const source = nodesRef.current.find((node) => node.id === nodeID);
    if (!source?.script_project || scriptNodeRunning(nodeID)) return;
    if (source.script_project.assets.some(asset => {
      if (!request.assetIDs.includes(asset.id)) return false;
      const image = scriptAssetImage(asset, nodesRef.current);
      return image && canvasGenerationNeedsRecovery(image);
    })) return toast.error("已有素材任务待同步，请先恢复原任务，勿重复生成");
    const model = request.parameters.generation_model || imageModel;
    if (!imageModels.includes(model)) return toast.error("请先配置图片模型");
    if (!nextTokenNameForModel("image", model).trim()) { setRelayTokenDialogKind("image"); return; }
    if (request.prompt !== undefined && !request.prompt.trim()) return toast.error("请填写图片生成提示词");
    const assets = request.prompt !== undefined
      ? source.script_project.assets.filter((asset) => request.assetIDs.includes(asset.id) && scriptAssetImage(asset, nodesRef.current)?.generation_status !== "loading")
      : scriptAssetsToGenerate(source.script_project, nodesRef.current, request.assetIDs);
    if (!assets.length) return toast.info("没有可生成的素材，已有图片或任务的素材不会重复提交");
    if (request.prompt === undefined && assets.some((asset) => !asset.name.trim() || !asset.description.trim())) return toast.error("请先填写素材名称和设定");
    const targets = createScriptAssetNodes(nodeID, assets.map((asset) => asset.id), { ...canvasImageParameters(request.parameters as CanvasNode), generation_model: model }, request.prompt);
    await Promise.all(targets.map((node) => runGeneration(node.id, undefined, false, { generationModel: model, resultTitle: node.title, selectResultNode: false })));
  }

  async function generateScriptMedia(nodeID: string, type: "image" | "video", shotIDs?: string[], regenerate = false) {
    const source = nodesRef.current.find((node) => node.id === nodeID);
    const originalProject = source?.script_project;
    if (!source || !originalProject || scriptNodeRunning(nodeID)) return;
    if (regenerate && originalProject.shots.some(shot => {
      if (shotIDs && !shotIDs.includes(shot.id)) return false;
      const node = nodesRef.current.find(item => item.id === shot[type === "image" ? "image_node_id" : "video_node_id"]);
      return node && canvasGenerationNeedsRecovery(node);
    })) return toast.error("已有任务待同步，请先恢复原任务，勿重复生成");
    const submission = new AbortController();
    scriptMediaSubmissionsRef.current.set(nodeID, submission);
    try {
      const field = type === "image" ? "image_node_id" : "video_node_id";
      const outdatedField = type === "image" ? "image_outdated" : "video_outdated";
      const project = scriptMediaSelection(originalProject, type, shotIDs, regenerate);
      let plan: ReturnType<typeof scriptMediaPlan>;
      try { plan = scriptMediaPlan(project, type, nodesRef.current); }
      catch (error) { return toast.error(error instanceof Error ? error.message : "无法读取镜头素材关联"); }
      if (!plan.missing.length && !plan.ready.length && !plan.tracked.length) return toast.info(plan.outdated.length ? `${plan.outdated.length} 个旧成品待更新，本次批量生成已跳过` : "已复用全部现有素材，未重复提交生成");
      if (plan.missing.length || plan.ready.length) {
        const issues = scriptMediaIssues(project, type, nodesRef.current, originalProject.shots);
        if (issues.length) return toast.error(issues.join("；"));
      }
      const size = CANVAS_NODE_DEFAULT_SIZE[type];
      if (nodesRef.current.length + plan.missing.length > 500) return toast.error("画布容量不足，请减少镜头或清理节点和连线");
      let created: CanvasNode[] = [];
      for (const shot of plan.missing) {
        const shotIndex = originalProject.shots.findIndex(item => item.id === shot.id);
        const originalShot = originalProject.shots[shotIndex];
        const parent = regenerate ? nodesRef.current.find(node => node.id === originalShot[field] && node.type === type) : undefined;
        const title = `${source.title || "脚本"} · 第 ${shotIndex + 1} 镜`;
        const node: CanvasNode = type === "image"
          ? { id: `image-${randomID()}`, type: "image", x: 0, y: 0, ...size, scale_x: 1, scale_y: 1, title, prompt: shot.image_prompt, exclude_upstream_text: true, ...(parent ? canvasImageParameters(parent) : preferredCanvasImageParameters()), generation_model: parent?.generation_model || imageModel, generation_reference_urls: parent?.generation_reference_urls, generation_count: 1, created_at: createdAt() }
          : { ...buildVideoNode({ title, prompt: shot.video_prompt }, { x: 0, y: 0 }, parent), generation_video_seconds: shot.seconds, exclude_upstream_text: true };
        created.push({ ...node, ...canvasScriptShotPosition(source, type, shotIndex, [...nodesRef.current, ...created], node) });
      }
      const edges: CanvasConnection[] = created.flatMap((node, index) => {
        const shot = plan.missing[index];
        const ids = new Set([source.id, ...(type === "video" && shot.image_node_id ? [shot.image_node_id] : []), ...scriptShotImageNodeIDs(shot, project.assets)]);
        return [...ids].map(id => ({ id: `connection-${randomID()}`, from_node_id: id, to_node_id: node.id }));
      });
      if (connectionsRef.current.length + edges.length > 2000) return toast.error("画布连线容量不足，请清理后重试");
      const bindings = new Map(plan.missing.map((shot, index) => [shot.id, created[index].id]));
      const nextProject = { ...originalProject, shots: originalProject.shots.map((shot) => bindings.has(shot.id) ? { ...shot, [field]: bindings.get(shot.id)!, [outdatedField]: false } : shot) };
      const plannedNodes = reconcileScriptMediaDependencies([...nodesRef.current.map(node => node.id === nodeID ? { ...node, script_project: nextProject } : node), ...created], nodesRef.current);
      created = created.map(node => plannedNodes.find(item => item.id === node.id)!);
      const pending = [...plan.ready, ...created].map((node) => {
          const context = buildCanvasGenerationContext(node.id, plannedNodes, [...connectionsRef.current, ...edges], node.prompt || "");
          if (type === "image") return { model: node.generation_model || imageModel, seconds: undefined, references: canvasGenerationReferenceImageURLs(node, context.referenceImageURLs, Number.POSITIVE_INFINITY).length, firstFrameURL: "" };
          const params = canvasVideoParameters(node);
          const framesEnabled = params.generation_video_reference_mode !== "reference" && supportsVideoFrameReferences(params.generation_video_model);
          const references = canvasVideoGenerationReferences(context, params.generation_video_reference_image_urls, framesEnabled);
          return { model: params.generation_video_model, seconds: params.generation_video_seconds, references: references.referenceImageURLs.length, firstFrameURL: references.firstFrameURL };
        });
      const promptField = type === "image" ? "image_prompt" : "video_prompt";
      for (const node of plan.ready) {
        if (node.prompt?.trim()) continue;
        const prompts = new Set(project.shots.filter((shot) => shot[field] === node.id).map((shot) => shot[promptField].trim()).filter(Boolean));
        if (prompts.size > 1) return toast.error("同一成品关联的多个镜头提示词不一致，请拆分成品关联或统一提示词");
      }
      for (const job of pending) {
        if (!(type === "image" ? imageModels : videoModels).includes(job.model)) return toast.error(`模型 ${job.model} 未启用，尚未提交本批任务`);
        if (!tokenNameForModel(type, job.model).trim()) { setRelayTokenDialogKind(type); return; }
        if (type === "video") {
          const error = validateCanvasAgentVideoSeconds(job.model, job.seconds || 0);
          if (error) return toast.error(error);
          if (videoRequiresReferenceImage(job.model) && !job.references && !job.firstFrameURL) return toast.error(`模型 ${job.model} 需要参考图片，尚未提交本批任务`);
          const referenceLimit = supportsVideoMultimodalReferences(job.model) ? videoMultimodalReferenceLimits(job.model).image : supportsVideoFrameReferences(job.model) ? 1 : 0;
          if (job.references > referenceLimit) return toast.error(`素材数量超过模型 ${job.model} 的参考图上限（${referenceLimit} 张），尚未提交本批任务`);
        } else {
          if (job.references && !supportsImageEditing(job.model)) return toast.error(`模型 ${job.model} 不支持参考图编辑，尚未提交本批任务`);
          if (job.references > imageReferenceImageLimit(job.model)) return toast.error(`素材数量超过模型 ${job.model} 的参考图上限，尚未提交本批任务`);
        }
      }
      const projectID = documentRef.current.id;
      const operationEpoch = canvasOperationEpochRef.current;
      if (created.length) {
        if (!updateScriptProject(nodeID, nextProject, created)) return;
      }
      try { await persistGenerationCheckpoint(); }
      catch (error) { return toast.error(error instanceof Error ? error.message : "镜头关联保存失败，未提交生成"); }
      if (submission.signal.aborted || !mountedRef.current || documentRef.current.id !== projectID || canvasOperationEpochRef.current !== operationEpoch) return;
      const taskIDs = plan.tracked.flatMap((node) => node.task_id ? [node.task_id] : []);
      const session = getCachedAuthSession();
      if (taskIDs.length && session) {
        if (!canvasRecoveryAbortControllerRef.current || canvasRecoveryAbortControllerRef.current.signal.aborted) canvasRecoveryAbortControllerRef.current = new AbortController();
        void recoverCanvasTasks(projectID, operationEpoch, taskIDs, session.key, canvasRecoveryAbortControllerRef.current.signal);
        toast.info("已有任务按原 ID 核对进度；失败任务可在原素材节点明确重试");
      }
      scriptMediaSubmissionsRef.current.delete(nodeID);
      await Promise.all([
        ...plan.ready.map((node) => {
          const field = type === "image" ? "image_node_id" : "video_node_id";
          const promptField = type === "image" ? "image_prompt" : "video_prompt";
          const shot = originalProject.shots.find((item) => item[field] === node.id);
          const prompt = node.prompt?.trim() ? undefined : shot?.[promptField];
          return runGeneration(node.id, prompt, node.generation_status === "error");
        }),
        ...created.map((node) => runGeneration(node.id)),
      ]);
    } finally {
      if (scriptMediaSubmissionsRef.current.get(nodeID) === submission) scriptMediaSubmissionsRef.current.delete(nodeID);
    }
  }

  async function runTextGeneration(nodeID: string, retry = false) {
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    const isCurrentProject = () => mountedRef.current && documentRef.current.id === projectID && canvasOperationEpochRef.current === operationEpoch;
    const requestedNode = nodesRef.current.find((node) => node.id === nodeID && (node.type === "text" || node.type === "config" && node.generation_mode === "text"));
    if (!requestedNode || activeGenerationsRef.current.has(nodeID)) return;
    const retrying = requestedNode.type === "text" && retry && requestedNode.generation_status === "error";
    const retryConfiguration = retrying ? findCanvasRetryConfigurationNode(requestedNode.id, nodesRef.current, connectionsRef.current) : null;
    const sourceNode = retryConfiguration || requestedNode;
    const plan = canvasTextGenerationPlan(requestedNode);
    const sourcePrompt = retrying
      ? retryConfiguration?.composer_content ?? retryConfiguration?.prompt ?? requestedNode.composer_content ?? requestedNode.prompt ?? ""
      : plan.requestPrompt;
    const context = buildCanvasGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourcePrompt);
    if (!context.prompt.trim() && !context.referenceImageURLs.length) return toast.error("请填写文本指令或连接有效输入");
    const model = sourceNode.generation_text_model?.trim() || textModel;
    if (!textModels.includes(model)) return toast.error("请选择全局模型设置中已启用的文本模型");
    const relayTokenName = nextTokenNameForModel("text", model);
    if (!relayTokenName.trim()) { setRelayTokenDialogKind("text"); return; }
    const resultIDs = retrying ? [requestedNode.id] : plan.createsChildNodes ? Array.from({ length: plan.count }, () => `text-${randomID()}`) : [requestedNode.id];
    const childIDs = retrying ? [] : plan.createsChildNodes ? resultIDs : [];
    const clientTaskIDs = new Map(resultIDs.map((resultID) => [resultID, `canvas-text-${randomID()}`]));
    const controller = new AbortController();
    const activeGeneration = registerActiveGeneration(controller, [requestedNode.id, sourceNode.id, ...resultIDs], clientTaskIDs.values());
    const generationStartedAt = Date.now();
    const historyBase = appendCanvasHistorySnapshot(historyRef.current, createCanvasHistorySnapshot(captureDocument()), MAX_HISTORY);
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
      composer_content: plan.instruction,
      generation_text_model: model,
      generation_status: "loading",
      generation_started_at: generationStartedAt,
      generation_progress: 0,
      task_id: clientTaskIDs.get(resultID),
      created_at: createdAt(),
    }));
    replaceNodes([
      ...nodesRef.current.map((node) => {
        if (retrying && node.id === requestedNode.id) return { ...node, generation_text_model: model, task_id: clientTaskIDs.get(requestedNode.id), generation_status: "loading" as const, generation_started_at: generationStartedAt, generation_progress: 0, generation_error: "" };
        if (node.id !== sourceNode.id) return node;
        if (sourceNode.type === "config") return { ...node, task_id: clientTaskIDs.get(resultIDs[0] || ""), generation_status: "loading" as const, generation_started_at: generationStartedAt, generation_progress: 0, generation_error: "" };
        if (!plan.createsChildNodes) return { ...node, generation_text_model: model, task_id: clientTaskIDs.get(sourceNode.id), generation_status: "loading" as const, generation_started_at: generationStartedAt, generation_progress: 0, generation_error: "" };
        return node;
      }),
      ...childNodes,
    ]);
    replaceConnections([
      ...connectionsRef.current,
      ...childIDs.map((resultID): CanvasConnection => ({ id: `connection-${randomID()}`, from_node_id: sourceNode.id, to_node_id: resultID })),
    ]);
    try {
      const messages = await canvasTextGenerationMessages(context.prompt.trim(), context.referenceImageURLs, controller.signal);
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      await persistGenerationCheckpoint();
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      const outcomes = await Promise.all(resultIDs.map(async (resultID) => {
        const clientTaskID = clientTaskIDs.get(resultID) || `canvas-text-${randomID()}`;
        try {
          const submitted = await createChatGenerationTask({ clientTaskId: clientTaskID, prompt: context.prompt.trim(), model, messages, stream: true, relayTokenName, requestOptions: { signal: controller.signal } });
          const serverTaskID = submitted.id || clientTaskID;
          addActiveGenerationTask(activeGeneration, serverTaskID, clientTaskID);
          if (!isCurrentProject()) return false;
          controller.signal.throwIfAborted();
          replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, task_id: serverTaskID } : node));
          if (!retrying && resultID === resultIDs[0] && sourceNode.type === "config") replaceNodes(nodesRef.current.map((node) => node.id === sourceNode.id ? { ...node, task_id: serverTaskID } : node));
          const completed = await waitForTask(serverTaskID, (task) => {
            if (!isCurrentProject() || controller.signal.aborted) return;
            const streamed = (task.data || []).map((item) => String(item.text_response || "")).join("\n").trim();
            if (streamed) replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, prompt: streamed } : node));
          }, controller.signal);
          if (!isCurrentProject()) return false;
          controller.signal.throwIfAborted();
          if (completed.status !== "success") throw new Error(completed.error || "文本生成失败");
          const content = (completed.data || []).map((item) => String(item.text_response || "")).join("\n").trim();
          if (!content) throw new Error(completed.error || "文本任务完成但没有返回内容");
          replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, prompt: content, generation_status: "success", generation_progress: 100, generation_error: "", task_id: completed.id || serverTaskID } : node));
          return true;
        } catch (error) {
          if (!isCurrentProject() || controller.signal.aborted) return false;
          const message = error instanceof Error ? error.message : "文本生成失败";
          replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, generation_status: "error", generation_error: message } : node));
          return false;
        }
      }));
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      const succeeded = outcomes.filter(Boolean).length;
      if (!retrying && sourceNode.type === "config") replaceNodes(nodesRef.current.map((node) => node.id === sourceNode.id ? { ...node, generation_status: succeeded ? "success" : "error", generation_error: succeeded ? "" : "全部文本任务生成失败" } : node));
      commitGenerationHistory(historyBase);
      if (!succeeded) toast.error("全部文本任务生成失败");
      else if (succeeded < outcomes.length) toast.error(`已生成 ${succeeded} 个文本，${outcomes.length - succeeded} 个失败`);
      else toast.success(childIDs.length ? `已生成 ${succeeded} 个文本节点` : "文字结果已更新");
    } catch (error) {
      if (!isCurrentProject()) return;
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
      completeActiveGeneration(activeGeneration);
    }
  }

  async function runAudioGeneration(nodeID: string, concurrent = true, retry = false, onSubmitted?: (taskID: string) => void) {
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    const isCurrentProject = () => mountedRef.current && documentRef.current.id === projectID && canvasOperationEpochRef.current === operationEpoch;
    const requestedNode = nodesRef.current.find((node) => node.id === nodeID && (node.type === "audio" || node.type === "config" && node.generation_mode === "audio"));
    if (!requestedNode || activeGenerationsRef.current.has(nodeID) || runningNodeID && !concurrent) return;
    if (canvasGenerationNeedsRecovery(requestedNode)) return toast.error("请先同步原任务结果，再开始新的生成");
    const retrying = requestedNode.type === "audio" && retry && requestedNode.generation_status === "error";
    const retryConfiguration = retrying ? findCanvasRetryConfigurationNode(requestedNode.id, nodesRef.current, connectionsRef.current) : null;
    const sourceNode = retryConfiguration || requestedNode;
    const contextPrompt = retryConfiguration?.composer_content ?? retryConfiguration?.prompt ?? requestedNode.composer_content ?? requestedNode.prompt ?? "";
    const generationContext = buildCanvasGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, contextPrompt);
    const text = generationContext.prompt.trim();
    if (!text) return toast.error("请填写音频内容或连接文本节点");
    const generationAudioModel = (sourceNode.generation_audio_model || audioModel).trim();
    if (!audioModels.includes(generationAudioModel)) return toast.error("请选择全局模型设置中已启用的音频模型");
    const relayTokenName = nextTokenNameForModel("audio", generationAudioModel);
    if (!relayTokenName.trim()) { setRelayTokenDialogKind("audio"); return; }
    const taskID = `canvas-audio-${randomID()}`;
    const controller = new AbortController();
    const expectedSessionKey = session.key;
    const generationStartedAt = Date.now();
    const createsResult = !retrying && (requestedNode.type === "config" || Boolean(requestedNode.url) && imageGenerationPreferences.node_regenerate_behavior !== "overwrite");
    const resultID = createsResult ? `audio-${randomID()}` : requestedNode.id;
    const activeGeneration = registerActiveGeneration(controller, [requestedNode.id, sourceNode.id, resultID], [taskID]);
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
    const historyBase = concurrent ? historyRef.current : appendCanvasHistorySnapshot(historyRef.current, createCanvasHistorySnapshot(captureDocument()), MAX_HISTORY);
    if (!concurrent) historyRef.current = historyBase;
    const finishHistory = () => concurrent ? scheduleSave() : commitGenerationHistory(historyBase);
    replaceNodes(createsResult
      ? [...nodesRef.current.map((node) => node.id === requestedNode.id && requestedNode.type === "config" ? { ...node, generation_status: "success" as const, generation_error: "" } : node), resultNode]
      : nodesRef.current.map((node) => node.id === requestedNode.id ? resultNode : node));
    if (createsResult) replaceConnections([...connectionsRef.current, { id: `connection-${randomID()}`, from_node_id: requestedNode.id, to_node_id: resultID }]);
    setPanelNodeID(resultID);
    if (!concurrent) {
      setRunningNodeID(requestedNode.id); setRunningResultNodeID(resultID); generationAbortControllerRef.current = controller;
      pendingTaskIDRef.current = taskID;
      submittedTaskIDRef.current = "";
    }
    let acceptedAudioTaskID = "";
    let terminalAudioTaskReceived = false;
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
        if (!isCurrentProject()) return;
        controller.signal.throwIfAborted();
        replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, generation_audio_mimo_voice_clone_node_id: selectedReference.nodeID } : node));
      }
      const autoDL = relayTokenName.startsWith("__custom_relay__:") && await isAutoDLRelay(relayTokenName, controller.signal);
      const request = autoDL ? {
        model: generationAudioModel,
        input: text,
        workflow_inputs: resultNode.generation_workflow_inputs,
        reference_audio_urls: await Promise.all(references.map((reference) => preparePublicVideoMediaReference(reference.url, "audio", controller.signal))),
      } : buildCanvasAudioGenerationRequest(resultNode, text, cloneDataURL);
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      await persistGenerationCheckpoint();
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      const submitted = await createAudioGenerationTask({ clientTaskId: taskID, request, relayTokenName, requestOptions: { signal: controller.signal } });
      const serverTaskID = submitted.id || taskID;
      acceptedAudioTaskID = serverTaskID;
      addActiveGenerationTask(activeGeneration, serverTaskID, taskID);
      onSubmitted?.(serverTaskID);
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      if (!concurrent) {
        pendingTaskIDRef.current = serverTaskID;
        submittedTaskIDRef.current = serverTaskID;
        submittedTaskIDsRef.current.add(serverTaskID);
        setRunningTaskID(serverTaskID);
      }
      replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, task_id: serverTaskID, audio_task_id: serverTaskID } : node));
      const completed = await persistCreationTaskOutputs(await waitForTask(serverTaskID, undefined, controller.signal), {
        assetContext: { source: "无限画布" },
        expectedSessionKey,
        signal: controller.signal,
      });
      terminalAudioTaskReceived = true;
      const item = completed.data?.find((entry) => entry.audio_url || entry.url);
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      const url = String(item?.audio_url || item?.url || "").trim();
      if (!url) throw new Error(completed.error || "音频任务完成但没有返回音频地址");
      replaceNodes(nodesRef.current.map((node) => node.id === resultID ? { ...node, url, storage_key: item?.storageKey || item?.storage_key, mime_type: item?.mime_type || `audio/${canvasAudioResponseFormat(resultNode) === "mp3" ? "mpeg" : canvasAudioResponseFormat(resultNode)}`, bytes: item?.bytes, duration_ms: Date.now() - generationStartedAt, generation_status: "success", generation_progress: 100, generation_error: "", task_id: completed.id || serverTaskID, audio_task_id: completed.id || serverTaskID, audio_task_result_id: completed.id || serverTaskID } : node));
      finishHistory(); toast.success("已添加音频到画布");
    } catch (error) {
      if (!isCurrentProject() || getCachedAuthSession()?.key !== expectedSessionKey) return;
      if (controller.signal.aborted) {
        replaceNodes(nodesRef.current.map((node) => node.id === resultID && node.generation_status === "loading" || node.id === requestedNode.id && requestedNode.type === "config" ? { ...node, duration_ms: node.id === resultID ? Date.now() - generationStartedAt : node.duration_ms, generation_status: "idle", generation_error: "" } : node));
        finishHistory();
      } else if (acceptedAudioTaskID && !terminalAudioTaskReceived) {
        replaceNodes(markCanvasGenerationRecoveryPending(nodesRef.current, acceptedAudioTaskID));
        finishHistory();
        toast.error("暂时无法同步后台任务，重新进入画布后将继续恢复");
      } else {
        const message = error instanceof Error ? error.message : "音频生成失败";
        replaceNodes(nodesRef.current.map((node) => node.id === resultID || node.id === requestedNode.id && requestedNode.type === "config" ? { ...node, duration_ms: node.id === resultID ? Date.now() - generationStartedAt : node.duration_ms, generation_status: "error", generation_error: message } : node));
        finishHistory(); toast.error(message);
      }
    } finally {
      completeActiveGeneration(activeGeneration);
      if (!concurrent && isCurrentProject() && generationAbortControllerRef.current === controller && getCachedAuthSession()?.key === expectedSessionKey) {
        if (generationAbortControllerRef.current === controller) generationAbortControllerRef.current = null;
        submittedTaskIDsRef.current.forEach((submittedID) => cancelledTaskIDsRef.current.delete(submittedID));
        submittedTaskIDsRef.current.clear();
        pendingTaskIDRef.current = "";
        submittedTaskIDRef.current = "";
        setRunningNodeID(""); setRunningResultNodeID(""); setRunningTaskID("");
      }
    }
  }

  async function runPanoramaGeneration(nodeID: string, retry = false) {
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    const isCurrentProject = () => mountedRef.current && documentRef.current.id === projectID && canvasOperationEpochRef.current === operationEpoch;
    const sourceNode = nodesRef.current.find((node) => node.id === nodeID && node.type === "panorama");
    if (!sourceNode || activeGenerationsRef.current.has(nodeID)) return;
    if (canvasGenerationNeedsRecovery(sourceNode)) return toast.error("请先同步原任务结果，再开始新的生成");
    const retrying = retry && sourceNode.generation_status === "error";
    const sourcePrompt = String(sourceNode.panorama_source_prompt || sourceNode.prompt || "").trim();
    const context = retrying ? null : buildCanvasGenerationContext(nodeID, nodesRef.current, connectionsRef.current, sourcePrompt);
    const effectivePrompt = context?.prompt.trim() || "";
    const generationModel = sourceNode.generation_model?.trim() || imageModel.trim();
    if (!imageModels.includes(generationModel)) return toast.error("请选择全局模型设置中已启用的图片模型");
    const relayTokenName = nextTokenNameForModel("image", generationModel);
    if (!relayTokenName.trim()) { setRelayTokenDialogKind("image"); return; }
    const referenceLimit = imageReferenceImageLimit(generationModel);
    const referenceImageURLs = (retrying
      ? panoramaRetryReferenceURLs(sourceNode.generation_type, sourceNode.generation_reference_urls)
      : canvasGenerationReferenceImageURLs(sourceNode, context?.referenceImageURLs || [], referenceLimit + 1)).slice(0, referenceLimit + 1);
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
    const sourceHasImage = !retrying && Boolean(sourceNode.url) && imageGenerationPreferences.node_regenerate_behavior !== "overwrite";
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
    const expectedSessionKey = session.key;
    const activeGeneration = registerActiveGeneration(controller, [sourceNode.id, rootID, ...targetIDs], taskIDs.values());
    const historyBase = appendCanvasHistorySnapshot(historyRef.current, createCanvasHistorySnapshot(captureDocument()), MAX_HISTORY);
    historyRef.current = historyBase;
    const replacedChildIDs = new Set(!sourceHasImage && !retrying ? sourceNode.batch_child_ids || [] : []);
    const startedNodes = nodesRef.current.filter((node) => !replacedChildIDs.has(node.id)).map((node) => {
      if (node.id !== nodeID) return node;
      return sourceHasImage ? { ...node, generation_status: "success" as const, generation_error: "" } : rootNode;
    });
    replaceNodes([...startedNodes, ...(sourceHasImage ? [rootNode] : []), ...childNodes]);
    if (!retrying && (sourceHasImage || childIDs.length || replacedChildIDs.size)) replaceConnections([
      ...connectionsRef.current.filter((connection) => !replacedChildIDs.has(connection.from_node_id) && !replacedChildIDs.has(connection.to_node_id)),
      ...(sourceHasImage ? [{ id: `connection-${randomID()}`, from_node_id: sourceNode.id, to_node_id: rootID }] : []),
      ...childIDs.map((childID): CanvasConnection => ({ id: `connection-${randomID()}`, from_node_id: rootID, to_node_id: childID })),
    ]);
    setSelectedNodeIDs(new Set([nodeID]));
    setSelectedConnectionID("");
    setPanelNodeID(nodeID);
    const pendingTargetIDs = new Set<string>();
    try {
      const referenceFiles = await prepareImageEditReferences(referenceImageURLs, imageGenerationPreferences.api_mode, controller.signal);
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      await persistGenerationCheckpoint();
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      const results = await Promise.all(targetIDs.map(async (targetID) => {
        const clientTaskID = taskIDs.get(targetID) || `canvas-panorama-${randomID()}`;
        let acceptedTaskID = "";
        let terminalTaskReceived = false;
        try {
          const submitted = referenceFiles.length
            ? await createImageEditTask(clientTaskID, referenceFiles, prompt, generationModel || undefined, PANORAMA_IMAGE_SIZE, PANORAMA_IMAGE_SIZE, quality, 1, "private", resolution, outputFormat, outputCompression, stream, partialImages, { apiMode: imageGenerationPreferences.api_mode, responseFormatB64JSON: sourceNode.generation_response_format_b64_json, generationSource: "canvas" }, undefined, relayTokenName, undefined, undefined, { signal: controller.signal })
            : await createImageGenerationTask(clientTaskID, prompt, generationModel || undefined, PANORAMA_IMAGE_SIZE, PANORAMA_IMAGE_SIZE, quality, 1, "private", resolution, outputFormat, outputCompression, stream, partialImages, { apiMode: imageGenerationPreferences.api_mode, responseFormatB64JSON: sourceNode.generation_response_format_b64_json, generationSource: "canvas" }, undefined, relayTokenName, undefined, undefined, { signal: controller.signal });
          const serverTaskID = submitted.id || clientTaskID;
          acceptedTaskID = serverTaskID;
          addActiveGenerationTask(activeGeneration, serverTaskID, clientTaskID);
          if (!isCurrentProject()) return false;
          controller.signal.throwIfAborted();
          replaceNodes(nodesRef.current.map((node) => node.id === targetID || node.id === rootID && !node.url && node.batch_primary_id === targetID ? { ...node, task_id: serverTaskID } : node));
          const completed = await persistCreationTaskOutputs(await waitForTask(serverTaskID, undefined, controller.signal), {
            assetContext: { source: "无限画布" },
            expectedSessionKey,
            signal: controller.signal,
          });
          terminalTaskReceived = true;
          const result = summarizeCanvasTaskResult(completed, 1);
          if (!isCurrentProject()) return false;
          controller.signal.throwIfAborted();
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
            if (node.id === rootID && targetID !== rootID && (node.batch_primary_id === targetID || !node.url)) return {
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
          if (sourceNode.batch_root_id && !sourceHasImage) nextNodes = syncCanvasBatchRootAfterRetry(nextNodes, sourceNode.id);
          replaceNodes(nextNodes);
          return true;
        } catch (error) {
          if (!isCurrentProject() || getCachedAuthSession()?.key !== expectedSessionKey) return false;
          if (controller.signal.aborted) return false;
          if (acceptedTaskID && !terminalTaskReceived) {
            pendingTargetIDs.add(targetID);
            replaceNodes(markCanvasGenerationRecoveryPending(nodesRef.current, acceptedTaskID));
            return false;
          }
          const message = error instanceof Error ? error.message : "全景图生成失败";
          replaceNodes(nodesRef.current.map((node) => node.id === targetID ? { ...node, duration_ms: Date.now() - generationStartedAt, generation_status: "error", generation_error: message } : node));
          return false;
        }
      }));
      if (!isCurrentProject() || getCachedAuthSession()?.key !== expectedSessionKey) return;
      if (controller.signal.aborted) {
        replaceNodes(nodesRef.current.map((node) => (node.id === rootID || targetIDs.includes(node.id)) && node.generation_status === "loading"
          ? { ...node, duration_ms: Date.now() - generationStartedAt, generation_status: "idle", generation_error: "" }
          : node));
        commitGenerationHistory(historyBase);
        return;
      }
      const successCount = results.filter(Boolean).length;
      if (!successCount && pendingTargetIDs.size) {
        const pending = nodesRef.current.find(node => pendingTargetIDs.has(node.id));
        if (pending) replaceNodes(nodesRef.current.map(node => node.id === rootID ? {
          ...node,
          task_id: pending.task_id,
          generation_status: pending.generation_status,
          generation_error: pending.generation_error,
          batch_primary_id: pending.id === rootID ? node.batch_primary_id : pending.id,
        } : node));
      }
      if (!successCount && !pendingTargetIDs.size) {
        replaceNodes(nodesRef.current.map((node) => node.id === rootID ? { ...node, duration_ms: Date.now() - generationStartedAt, generation_status: "error", generation_error: "全部全景图任务生成失败" } : node));
        throw new Error("全部全景图任务生成失败");
      }
      commitGenerationHistory(historyBase);
      const failedCount = results.length - successCount - pendingTargetIDs.size;
      if (failedCount) toast.error(`已生成 ${successCount} 张全景图，${failedCount} 张失败${pendingTargetIDs.size ? `，${pendingTargetIDs.size} 张待同步` : ""}`);
      else if (!pendingTargetIDs.size) toast.success(count > 1 ? `已生成 ${count} 张全景图` : "全景图已生成");
    } catch (error) {
      if (!isCurrentProject() || getCachedAuthSession()?.key !== expectedSessionKey) return;
      const cancelled = controller.signal.aborted;
      const message = cancelled ? "" : error instanceof Error ? error.message : "全景图生成失败";
      replaceNodes(nodesRef.current.map((node) => (node.id === rootID || targetIDs.includes(node.id)) && node.generation_status === "loading"
        ? { ...node, duration_ms: Date.now() - generationStartedAt, generation_status: cancelled ? "idle" : "error", generation_error: message }
        : node));
      commitGenerationHistory(historyBase);
      if (!cancelled) toast.error(message);
    } finally {
      completeActiveGeneration(activeGeneration);
    }
  }

  async function runVideoGeneration(nodeID: string, prompt?: string, concurrent = true, onSubmitted?: (taskID: string) => void, retry = false) {
    const projectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    const isCurrentProject = () => mountedRef.current && documentRef.current.id === projectID && canvasOperationEpochRef.current === operationEpoch;
    const sourceNode = nodesRef.current.find((node) => node.id === nodeID && (node.type === "video" || node.type === "config" && node.generation_mode === "video"));
    if (!sourceNode || activeGenerationsRef.current.has(nodeID) || runningNodeID && !concurrent) return;
    const originalTaskID = canvasGenerationRecoveryTaskID(sourceNode);
    if (originalTaskID && (retry || sourceNode.generation_status === "error" || canvasGenerationNeedsRecovery(sourceNode))) {
      try {
        const response = await fetchCreationTasks([originalTaskID]);
        if (!isCurrentProject()) return;
        const original = response.items.find((task) => task.id === originalTaskID);
        if (!original) return toast.error("原任务暂时不可用，请稍后同步，未重新生成");
        if (original.can_recover_video || original.status === "queued" || original.status === "running" || original.status === "success") {
          if (!canvasRecoveryAbortControllerRef.current || canvasRecoveryAbortControllerRef.current.signal.aborted) canvasRecoveryAbortControllerRef.current = new AbortController();
          const signal = canvasRecoveryAbortControllerRef.current.signal;
          if (original.status === "cancelled" && original.can_recover_video) await recoverVideoTask(originalTaskID, { signal });
          if (!isCurrentProject()) return;
          await recoverCanvasTasks(projectID, operationEpoch, [originalTaskID], session.key, signal);
          return;
        }
      } catch (error) {
        if (isCurrentProject()) toast.error(error instanceof Error ? error.message : "原任务同步失败，未重新生成");
        return;
      }
    }
    if (canvasGenerationNeedsRecovery(sourceNode)) return toast.error("请先同步原任务结果，再开始新的生成");
    const params = canvasVideoParameters(sourceNode);
    const selectedModel = params.generation_video_model.trim();
    if (!selectedModel || !videoModels.includes(selectedModel)) {
      return toast.error("请选择全局模型设置中已启用的视频模型");
    }
    const relayTokenName = nextTokenNameForModel("video", selectedModel);
    if (!relayTokenName.trim()) {
      setRelayTokenDialogKind("video");
      return;
    }
			const context = buildCanvasGenerationContext(nodeID, nodesRef.current, connectionsRef.current, prompt ?? sourceNode.composer_content ?? sourceNode.prompt ?? "");
    const text = context.prompt.trim();
		const requestPrompt = text;
    if (!text && !context.referenceImageURLs.length && !context.firstFrameURL && !context.lastFrameURL && !context.referenceVideoURLs.length && !context.referenceAudioURLs.length) return toast.error("请填写视频描述或连接参考素材");
				const configuredVideoReferenceURLs = params.generation_video_reference_urls.filter((url) => url.trim());
			const configuredImageReferenceURLs = params.generation_video_reference_image_urls.filter((url) => url.trim());
			const configuredAudioReferenceURLs = params.generation_video_reference_audio_urls.filter((url) => url.trim());
			const frameReferencesEnabled = params.generation_video_reference_mode !== "reference" && supportsVideoFrameReferences(params.generation_video_model);
			const videoImageReferences = canvasVideoGenerationReferences(context, configuredImageReferenceURLs, frameReferencesEnabled);
			const allImageReferenceURLs = videoImageReferences.referenceImageURLs;
			const referenceVideoURLs = Array.from(new Set(params.generation_video_reference_mode === "reference" ? [...configuredVideoReferenceURLs, ...context.referenceVideoURLs] : [])).slice(0, 3);
			const referenceAudioURLs = Array.from(new Set(params.generation_video_reference_mode === "reference" ? [...configuredAudioReferenceURLs, ...context.referenceAudioURLs] : [])).slice(0, 3);
			const firstFrameURL = frameReferencesEnabled ? videoImageReferences.firstFrameURL : "";
			const lastFrameURL = frameReferencesEnabled ? videoImageReferences.lastFrameURL : "";
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
			if (!configuredImageURLs.length && !firstFrameURL && !lastFrameURL && !referenceVideoURLs.length && !referenceAudioURLs.length) {
				referenceMode = "first-frame";
			}
			if ([...configuredImageURLs, firstFrameURL, lastFrameURL, ...referenceVideoURLs, ...referenceAudioURLs].filter(Boolean).some((url) => {
			return !isPublicReferenceURL(url) && !isCanvasAccessibleReferenceURL(url);
		})) {
			return toast.error("参考素材 URL 必须是公网可访问的 http(s) 地址，或当前站点已上传的素材地址");
		}
		if (videoModelRequiresHTTPSReferences(params.generation_video_model) && [...configuredImageURLs, firstFrameURL, lastFrameURL, ...referenceVideoURLs, ...referenceAudioURLs].filter(Boolean).some((url) => isPublicReferenceURL(url) && !isPublicHTTPSReferenceURL(url))) {
			return toast.error("该 MiniMax 模型的参考素材必须是公网 HTTPS 链接，请将 IMAGE_BASE_URL 配置为 https://... 后重新上传");
		}
			if (videoRequiresReferenceImage(params.generation_video_model) && configuredImageURLs.length === 0 && !firstFrameURL) {
			return toast.error(`模型 ${params.generation_video_model} 仅支持图生视频，请连接一张参考图片`);
		}
    const taskID = `canvas-video-${randomID()}`;
    const controller = new AbortController();
    const expectedSessionKey = session.key;
    const generationStartedAt = Date.now();
    const retrying = retry && sourceNode.type === "video" && sourceNode.generation_status === "error";
    const createsResult = !retrying && (sourceNode.type === "config" || Boolean(sourceNode.url) && imageGenerationPreferences.node_regenerate_behavior !== "overwrite");
    const resultNodeID = createsResult ? `video-${randomID()}` : sourceNode.id;
    const activeGeneration = registerActiveGeneration(controller, [sourceNode.id, resultNodeID], [taskID]);
    const videoNodeSize = canvasNodeSizeFromRatio(params.generation_video_size, CANVAS_NODE_DEFAULT_SIZE.video.width, CANVAS_NODE_DEFAULT_SIZE.video.height) || CANVAS_NODE_DEFAULT_SIZE.video;
    const resultNode = createsResult ? { ...buildVideoNode({ title: text.slice(0, 32) || "视频", prompt: text, taskID }, { x: sourceNode.x + sourceNode.width + 96, y: sourceNode.y + sourceNode.height / 2 - videoNodeSize.height / 2 }, sourceNode), ...videoNodeSize, id: resultNodeID, generation_status: "loading" as const, generation_started_at: generationStartedAt, generation_progress: undefined, generation_error: "", generation_model: params.generation_video_model, task_id: taskID, camera_control: sourceNode.camera_control } : { ...sourceNode, prompt: text, task_id: taskID, generation_status: "loading" as const, generation_started_at: generationStartedAt, generation_progress: undefined, generation_error: "", generation_model: params.generation_video_model };
    const historyBase = concurrent ? historyRef.current : appendCanvasHistorySnapshot(historyRef.current, createCanvasHistorySnapshot(captureDocument()), MAX_HISTORY);
    if (!concurrent) historyRef.current = historyBase;
    const finishHistory = () => concurrent ? scheduleSave() : commitGenerationHistory(historyBase);
    replaceNodes(createsResult
      ? [...nodesRef.current.map((node) => node.id === sourceNode.id && node.type === "config" ? { ...node, generation_status: "success" as const, generation_error: "" } : node), resultNode]
      : nodesRef.current.map((node) => node.id === nodeID ? resultNode : node));
    if (createsResult) replaceConnections([...connectionsRef.current, { id: `connection-${randomID()}`, from_node_id: sourceNode.id, to_node_id: resultNodeID }]);
    setPanelNodeID(resultNodeID); setSelectedNodeIDs(new Set([resultNodeID]));
    if (!concurrent) {
      setRunningNodeID(nodeID); setRunningResultNodeID(resultNodeID); generationAbortControllerRef.current = controller;
      pendingTaskIDRef.current = taskID;
      submittedTaskIDRef.current = "";
    }
    let acceptedVideoTaskID = "";
    let terminalVideoTaskReceived = false;
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
				if (videoModelRequiresHTTPSReferences(params.generation_video_model)) {
					const preparedURLs = [
						...referenceImageURLs,
						preparedFirstFrameURL,
						preparedLastFrameURL,
						...preparedReferenceVideoURLs,
						...preparedReferenceAudioURLs,
					].filter((url): url is string => Boolean(url));
					if (preparedURLs.some((url) => !isPublicHTTPSReferenceURL(url))) {
						throw new Error("该 MiniMax 模型的参考素材必须是公网 HTTPS 链接，请将 IMAGE_BASE_URL 配置为 https://... 后重新上传");
					}
				}
				const normalizedVideo = normalizeVideoRequest({
				model: params.generation_video_model,
				size: params.generation_video_size,
				seconds: params.generation_video_seconds,
        parameters: params.generation_video_parameters,
				resolution: params.generation_video_resolution,
				generateAudio: params.generation_video_audio,
				watermark: params.generation_video_watermark,
					referenceImageURLs,
					firstFrameURL: preparedFirstFrameURL,
					lastFrameURL: preparedLastFrameURL,
				referenceVideoURLs: preparedReferenceVideoURLs,
				referenceAudioURLs: preparedReferenceAudioURLs,
				referenceMode,
			});
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      await persistGenerationCheckpoint();
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      const submitted = await createVideoGenerationTask({
        workflowInputs: sourceNode.generation_workflow_inputs,
				clientTaskId: taskID,
					prompt: requestPrompt,
				model: params.generation_video_model,
				size: normalizedVideo.size || undefined,
				seconds: normalizedVideo.seconds,
        parameters: normalizedVideo.parameters,
				resolution: normalizedVideo.resolution || undefined,
				generateAudio: normalizedVideo.generateAudio,
				watermark: normalizedVideo.watermark,
					referenceImageURLs: normalizedVideo.referenceImageURLs,
					firstFrameURL: normalizedVideo.firstFrameURL,
					lastFrameURL: normalizedVideo.lastFrameURL,
				referenceVideoURLs: normalizedVideo.referenceVideoURLs,
				referenceAudioURLs: normalizedVideo.referenceAudioURLs,
				referenceMode: normalizedVideo.referenceMode,
					systemPrompt: imageGenerationPreferences.video_system_prompt || undefined,
				relayTokenName,
				requestOptions: { signal: controller.signal },
				});
      const serverTaskID = submitted.id || taskID;
      acceptedVideoTaskID = serverTaskID;
      addActiveGenerationTask(activeGeneration, serverTaskID, taskID);
      onSubmitted?.(serverTaskID);
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      if (!concurrent) {
        pendingTaskIDRef.current = serverTaskID;
        submittedTaskIDRef.current = serverTaskID;
        submittedTaskIDsRef.current.add(serverTaskID);
        setRunningTaskID(serverTaskID);
      }
      replaceNodes(nodesRef.current.map((node) => node.id === resultNodeID ? { ...node, task_id: serverTaskID } : node));
      const updateVideoProgress = (task: CreationTask) => {
        if (!isCurrentProject() || controller.signal.aborted) return;
        replaceNodes(applyCanvasVideoTaskProgressNodes(nodesRef.current, task));
      };
      updateVideoProgress(submitted);
      const completed = await persistCreationTaskOutputs(await waitForTask(serverTaskID, updateVideoProgress, controller.signal), {
        assetContext: { prompt, source: "无限画布", metadata: { projectId: documentRef.current.id, nodeId: resultNodeID } },
        expectedSessionKey,
        signal: controller.signal,
      });
      terminalVideoTaskReceived = true;
      const item = completed.data?.find((entry) => String(entry.type || "") === "video" || entry.video_url || entry.url);
      if (!isCurrentProject()) return;
      controller.signal.throwIfAborted();
      const url = String(item?.video_url || item?.url || "").trim();
      if (!url) throw new Error(completed.error || "视频任务完成但没有返回视频地址");
      replaceNodes(nodesRef.current.map((node) => node.id === resultNodeID ? { ...node, url, storage_key: item?.storageKey || item?.storage_key, mime_type: item?.mime_type || "video/mp4", bytes: item?.bytes || item?.size, duration_ms: Date.now() - generationStartedAt, generation_status: "success" as const, generation_progress: 100, generation_error: "", task_id: completed.id || serverTaskID } : node));
      finishHistory(); toast.success("已添加视频到画布");
    } catch (error) {
      if (!isCurrentProject() || getCachedAuthSession()?.key !== expectedSessionKey) return;
      if (controller.signal.aborted) {
        replaceNodes(nodesRef.current.map((node) => node.id === resultNodeID && node.generation_status === "loading" ? { ...node, generation_status: "idle" as const, generation_error: "" } : node));
        finishHistory();
        return;
      }
      if (acceptedVideoTaskID && !terminalVideoTaskReceived) {
        replaceNodes(markCanvasGenerationRecoveryPending(nodesRef.current, acceptedVideoTaskID));
        finishHistory();
        toast.error("暂时无法同步后台任务，重新进入画布后将继续恢复");
        return;
      }
      const message = error instanceof Error ? error.message : "视频生成失败";
      replaceNodes(nodesRef.current.map((node) => node.id === resultNodeID ? { ...node, duration_ms: Date.now() - generationStartedAt, generation_status: "error" as const, generation_error: message, task_id: acceptedVideoTaskID || taskID } : node));
      finishHistory(); toast.error(message);
    } finally {
      completeActiveGeneration(activeGeneration);
      if (!concurrent && isCurrentProject() && generationAbortControllerRef.current === controller && getCachedAuthSession()?.key === expectedSessionKey) {
        if (generationAbortControllerRef.current === controller) generationAbortControllerRef.current = null;
        submittedTaskIDsRef.current.forEach((submittedID) => cancelledTaskIDsRef.current.delete(submittedID));
        submittedTaskIDsRef.current.clear();
        pendingTaskIDRef.current = "";
        submittedTaskIDRef.current = "";
        setRunningNodeID(""); setRunningResultNodeID(""); setRunningTaskID("");
      }
    }
  }

  async function runGeneration(nodeID: string, prompt?: string, retry = false, options: CanvasGenerationOptions = {}) {
    const concurrent = options.concurrent !== false;
    const specialNode = nodesRef.current.find((node) => node.id === nodeID);
    if (specialNode?.type === "script") return requestScriptGeneration(nodeID);
    if (specialNode?.type === "text") return runTextGeneration(nodeID, retry);
    if (specialNode?.type === "config" && specialNode.generation_mode === "text") return runTextGeneration(nodeID, retry);
    if (specialNode?.type === "audio" || specialNode?.type === "config" && specialNode.generation_mode === "audio") return runAudioGeneration(nodeID, concurrent, retry, options.onSubmitted);
    if (specialNode?.type === "panorama" && !options.forceImageGeneration) return runPanoramaGeneration(nodeID, retry);
    if (specialNode?.type === "config" && specialNode.generation_mode === "video") return runVideoGeneration(nodeID, prompt, concurrent, options.onSubmitted, retry);
    const videoNode = nodesRef.current.find((node) => node.id === nodeID && node.type === "video");
    if (videoNode) return runVideoGeneration(nodeID, prompt, concurrent, options.onSubmitted, retry);
    const sourceNode = nodesRef.current.find((node) => node.id === nodeID && (node.type === "image" || node.type === "config" || options.forceImageGeneration && node.type === "panorama"));
    if (!sourceNode || activeGenerationsRef.current.has(nodeID)) return;
    if (canvasGenerationNeedsRecovery(sourceNode)) return toast.error("请先同步原任务结果，再开始新的生成");
    const retrying = sourceNode.type === "image" && retry && sourceNode.generation_status === "error";
    const retryConfiguration = retrying && !sourceNode.generation_type
      ? findCanvasRetryConfigurationNode(sourceNode.id, nodesRef.current, connectionsRef.current)
      : null;
    const contextNode = retryConfiguration || sourceNode;
    const generationModel = options.generationModel?.trim() || canvasGenerationModel(imageModel, sourceNode, retryConfiguration, retrying);
    if (!imageModels.includes(generationModel)) return toast.error("请选择全局模型设置中已启用的图片模型");
    const taskRelayTokenName = nextTokenNameForModel("image", generationModel).trim();
    if (!taskRelayTokenName) {
      setRelayTokenDialogKind("image");
      return;
    }
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
    const createsResultNode = !retrying && (sourceNode.type === "config" || Boolean(sourceNode.url) && (options.forceImageGeneration || imageGenerationPreferences.node_regenerate_behavior !== "overwrite"));
    if ((!text && !referenceImageURLs.length) || runningNodeID && !concurrent) return toast.error("请连接有效输入或填写画面描述");
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
    const count = outputFormat === "svg" ? 1 : canvasGenerationCount(generationModel, parameters.generation_count, options.resultCount, retrying);
    const stream = supportsImageStreaming(generationModel) && imageGenerationPreferences.stream;
    const partialImages = stream ? imageGenerationPreferences.partial_images : 0;
    const compatibilityOptions = {
      imageOptions: parameters.generation_image_options,
      apiMode: imageGenerationPreferences.api_mode,
      responseFormatB64JSON: parameters.generation_response_format_b64_json ?? false,
      codexCLICompatibility: parameters.generation_codex_cli_compatibility ?? false,
      generationSource: "canvas" as const,
    };
    const taskID = `canvas-${mode}-${randomID()}`;
    const controller = new AbortController();
    const expectedSessionKey = session.key;
    const generationEpoch = concurrent ? generationEpochRef.current : generationEpochRef.current + 1;
    if (!concurrent) generationEpochRef.current = generationEpoch;
    const generationProjectID = documentRef.current.id;
    const operationEpoch = canvasOperationEpochRef.current;
    const generationOwnsCanvas = () => mountedRef.current && canvasOperationEpochRef.current === operationEpoch
      && documentRef.current.id === generationProjectID
      && nodesRef.current.some((node) => node.id === sourceNode.id);
    const generationIsCurrent = () => generationOwnsCanvas()
      && !controller.signal.aborted
      && (concurrent || generationEpochRef.current === generationEpoch && generationAbortControllerRef.current === controller);
    if (!concurrent) {
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
    const activeGeneration = registerActiveGeneration(controller, [sourceNode.id, ...resultNodeIDs], [taskID]);
    const activeSelectionNodeID = canvasGenerationActiveNodeID(sourceNode.id, resultNode.id, createsResultNode, options.selectResultNode);
    const replacedBatchChildIDs = sourceNode.type === "image" && !createsResultNode && !retrying ? new Set(sourceNode.batch_child_ids || []) : new Set<string>();
    const resultConnections: CanvasConnection[] = [
      ...(createsResultNode ? [{ id: `connection-${randomID()}`, from_node_id: sourceNode.id, to_node_id: resultNode.id }] : []),
      ...batchChildren.map((node) => ({ id: `connection-${randomID()}`, from_node_id: resultNode.id, to_node_id: node.id })),
    ];
    const generationHistoryBase = concurrent ? historyRef.current : appendCanvasHistorySnapshot(historyRef.current, createCanvasHistorySnapshot(captureDocument()), MAX_HISTORY);
    if (!concurrent) historyRef.current = generationHistoryBase;
    const finishHistory = () => concurrent ? scheduleSave() : commitGenerationHistory(generationHistoryBase);
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
    if (!concurrent) {
      generationHistoryBaseRef.current = generationHistoryBase;
      setRunningNodeID(nodeID);
      setRunningResultNodeID(resultNodeID);
      setRunningTaskID("");
    }
    try {
      const referenceFiles = referenceImageURLs.length
        ? await prepareImageEditReferences(referenceImageURLs, compatibilityOptions.apiMode || "images", controller.signal)
        : [];
      await persistGenerationCheckpoint();
      if (!generationIsCurrent()) return;
      controller.signal.throwIfAborted();
      let submitted: CreationTask;
      if (referenceFiles.length) {
        taskSubmissionAttempted = true;
        submitted = await createImageEditTask(taskID, referenceFiles, buildCanvasImageReferencePrompt(requestPrompt, referenceFiles.length), generationModel || undefined, size, size, quality, count, "private", resolution, outputFormat, outputCompression, stream, partialImages, compatibilityOptions, undefined, taskRelayTokenName, undefined, undefined, { signal: controller.signal });
      } else {
        taskSubmissionAttempted = true;
        submitted = await createImageGenerationTask(taskID, requestPrompt, generationModel || undefined, size, size, quality, count, "private", resolution, outputFormat, outputCompression, stream, partialImages, compatibilityOptions, undefined, taskRelayTokenName, undefined, undefined, { signal: controller.signal });
      }
      activeTaskID = submitted.id || taskID;
      addActiveGenerationTask(activeGeneration, activeTaskID, taskID);
      if (!generationIsCurrent()) return;
      options.onSubmitted?.(activeTaskID);
      replaceNodes(setCanvasConfigGenerationStatus(nodesRef.current, sourceNode.id, "success", "", activeTaskID));
      if (!concurrent) {
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
      }, controller.signal), {
        assetContext: { source: "无限画布" },
        expectedSessionKey,
        signal: controller.signal,
      });
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
      if (!createsResultNode && sourceNode.batch_root_id) {
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
      if (getCachedAuthSession()?.key !== expectedSessionKey) return;
      if (!generationOwnsCanvas()) return;
      const cancelled = taskCancelled || controller.signal.aborted || cancelledTaskIDsRef.current.has(activeTaskID) || cancelledTaskIDsRef.current.has(taskID);
      const generationError = error instanceof Error ? error.message : "创作任务失败";
      const recoveryPending = !cancelled && taskSubmissionAttempted && !terminalTaskReceived && (
        error instanceof CreationTaskTimeoutError || isRetryableTaskPollError(error)
      );
      let cancelledTask: CreationTask | null = null;
      if (cancelled) {
        try {
          cancelledTask = await persistCreationTaskOutputs(await cancelCreationTask(activeTaskID), {
            assetContext: { source: "无限画布" },
            expectedSessionKey,
          });
        } catch { /* A request cancelled before submission has no server task. */ }
        if (getCachedAuthSession()?.key !== expectedSessionKey) return;
        if (!generationOwnsCanvas()) return;
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
      completeActiveGeneration(activeGeneration);
      if (!concurrent) {
        cancelledTaskIDsRef.current.delete(taskID);
        cancelledTaskIDsRef.current.delete(activeTaskID);
        if (generationEpochRef.current === generationEpoch && generationAbortControllerRef.current === controller) generationAbortControllerRef.current = null;
        if (generationEpochRef.current === generationEpoch && (pendingTaskIDRef.current === taskID || pendingTaskIDRef.current === activeTaskID)) pendingTaskIDRef.current = "";
        if (generationEpochRef.current === generationEpoch && submittedTaskIDRef.current === activeTaskID) submittedTaskIDRef.current = "";
        submittedTaskIDsRef.current.delete(activeTaskID);
      }
      if (!concurrent && mountedRef.current && generationEpochRef.current === generationEpoch) {
        setStopTargetNodeID("");
        setRunningNodeID("");
        setRunningResultNodeID("");
        setRunningTaskID("");
      }
    }
  }

  async function resetCanvas() {
    setClearConfirmationOpen(false);
    canvasOperationEpochRef.current += 1;
    cancelCanvasMediaOperations();
    interruptActiveGeneration();
    try {
      await enqueueWorkspaceMutation(async () => {
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        await saveQueueRef.current.catch(() => undefined);
        const projectID = documentRef.current.id;
        checkpointCanvasDraft();
        const writer = recoveryDraftWriterRef.current;
        const version = saveChangeVersionRef.current;
        const response = await clearCanvasDocument(projectID, documentRef.current.revision);
        if (writer) void clearCanvasRecoveryDraft(canvasRecoveryDraftScope(session.subjectId, projectID), writer, version).catch(() => undefined);
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
      const { toPng } = await import("html-to-image");
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
      const projectID = documentRef.current.id;
      if (!await flushCanvasSaves({ save: persistCanvas, getChangeVersion: () => saveChangeVersionRef.current, getProjectID: () => documentRef.current.id })) throw new Error("画布保存失败，请重试后导出");
      if (documentRef.current.id !== projectID) return;
      const complete = (await fetchCanvasDocument(projectID)).document;
      const blob = await createCanvasProjectArchive([complete]);
      downloadCanvasProjectArchive(blob, title || "无限画布");
      toast.success("画布已导出");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "画布导出失败");
    }
  }

  async function importProjectArchive(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const projectID = documentRef.current.id;
    const documentEpoch = canvasDocumentEpochRef.current;
    const isCurrentProject = () => mountedRef.current && documentRef.current.id === projectID && canvasDocumentEpochRef.current === documentEpoch;
    try {
      const projects = await readCanvasProjectArchive(file, 1);
      if (projects.length !== 1) throw new Error("请在画布库中导入包含多个项目的压缩包");
      const [parsed] = projects;
      await enqueueWorkspaceMutation(async () => {
        if (!isCurrentProject()) return;
        canvasOperationEpochRef.current += 1;
        cancelCanvasMediaOperations();
        interruptGenerationForProjectChange();
        if (!await flushCanvasSaves({ save: persistCanvas, getChangeVersion: () => saveChangeVersionRef.current, getProjectID: () => documentRef.current.id })) return;
        if (!isCurrentProject()) return;
        const response = await importCanvasProject({
          ...parsed,
          version: 1,
          title: String(parsed.title || file.name.replace(/\.zip$/i, "") || "导入画布"),
          background: parsed.background || "dots",
          connections: Array.isArray(parsed.connections) ? parsed.connections : [],
          viewport: parsed.viewport || DEFAULT_DOCUMENT.viewport,
        }, "active");
        if (!isCurrentProject()) return;
        setProjectMenuOpen(false);
        navigate(canvasProjectPath(response.document.id));
        toast.success("画布已作为新项目导入");
      });
    } catch (error) {
      if (isCurrentProject()) toast.error(error instanceof Error ? error.message : "画布导入失败");
    }
  }

  function openNodeContextMenu(_event: ReactMouseEvent, nodeID: string) {
    setContextMenu({ type: "node", nodeID });
  }

  function openConnectionContextMenu(_event: ReactMouseEvent<SVGPathElement>, connectionID: string) {
    setSelectedNodeIDs(new Set());
    setSelectedConnectionID(connectionID);
    setPanelNodeID("");
    setContextMenu({ type: "connection", connectionID });
  }

  function openCanvasContextMenu(_event: ReactMouseEvent, position: { x: number; y: number }) {
    setContextMenu({ type: "canvas", position });
  }

  function handleCanvasDrop(event: ReactDragEvent<HTMLDivElement>, position: { x: number; y: number }) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length) { void uploadCanvasFiles(files, position); return; }
    const raw = event.dataTransfer.getData("application/x-yunmian-image");
    if (!raw) return;
    try {
      const image = JSON.parse(raw) as ManagedImage;
      addImageNode({ url: image.url || image.path, thumbnailURL: image.thumbnail_url, title: canvasLibraryImageTitle(image), prompt: image.prompt, width: image.width, height: image.height, bytes: image.size }, { x: position.x, y: position.y, centered: true });
    } catch {
      toast.error("无法添加这张图片");
    }
  }

  function renderNodeQuickActions(node: CanvasNode) {
    if (node.type === "script") return <CanvasScriptActions running={scriptNodeRunning(node.id)} ready={{ image: Boolean(node.script_project && scriptCanGenerateMedia(node.script_project, "image", nodesRef.current)), video: Boolean(node.script_project && scriptCanGenerateMedia(node.script_project, "video", nodesRef.current)) }} onGenerate={() => requestScriptGeneration(node.id)} onImages={() => void generateScriptMedia(node.id, "image")} onVideos={() => void generateScriptMedia(node.id, "video")} onDownload={() => downloadScript(node)} />;
    const imageEditingModel = node.generation_model?.trim() || imageModel.trim();
    return (
      <CanvasNodeQuickActions
        node={node}
        uploading={uploadingNodeID === node.id}
        onUpload={() => requestNodeMediaUpload(node.id)}
        busy={nodeGenerationRunning(node.id) || imageToolBusy || mediaBusyNodeIDs.has(node.id)}
        imageEditingSupported={supportsImageEditing(imageEditingModel)}
        onImageOperation={(operation) => void openCanvasImageTool(node.id, operation)}
        onDownload={() => void downloadNodeImage(node.id)}
        onPreview={() => setPreviewNodeID(node.id)}
        onReversePrompt={() => createImageReversePromptNodes(node.id)}
        onSaveAsset={() => void saveCanvasNodeAsset(node.id)}
        onToggleFreeResize={() => toggleCanvasFreeResize(node.id)}
        onTextToImage={() => generateFromTextNode(node.id)}
        onOpenDirector={() => { setPanelNodeID(""); setOpenDirectorNodeID(node.id); }}
        onMediaOperation={(operation) => handleCanvasMediaOperation(node.id, operation)}
      />
    );
  }


  function removeNodeReference(targetID: string, sourceID: string) {
    const target = nodesRef.current.find((node) => node.id === targetID);
    if (!target) return;
    const previousInputs = canvasGenerationInputs(targetID, nodesRef.current, connectionsRef.current);
    const nextConnections = connectionsRef.current.filter((edge) => edge.from_node_id !== sourceID || edge.to_node_id !== targetID);
    const nextInputs = canvasGenerationInputs(targetID, nodesRef.current, nextConnections);
    const labels = (inputs: CanvasConfigInput[]) => inputs.map((input) => ({ nodeID: input.nodeID, label: canvasConfigInputLabel(input, inputs) }));
    const remap = (value: string) => remapCanvasResourceLabels(value, labels(previousInputs), labels(nextInputs));
    const patch: Partial<CanvasNode> = {};
    if (target.type === "text" || target.type === "config") {
      patch.composer_content = remap(target.composer_content ?? (target.type === "config" ? target.prompt || "" : ""));
    } else if (target.type !== "image" || !target.url) {
      patch.prompt = remap(target.prompt || "");
      if (target.type === "panorama") patch.panorama_source_prompt = remap(target.panorama_source_prompt || target.prompt || "");
    }
    if (target.type === "image") {
      setImagePromptDrafts((drafts) => ({ ...drafts, [targetID]: remap(drafts[targetID] ?? (target.url ? "" : target.prompt || "")) }));
    }
    replaceNodes(nodesRef.current.map((node) => node.id === targetID ? { ...node, ...patch } : node));
    replaceConnections(nextConnections);
    pushHistory();
  }

  function renderNodePanel(node: CanvasNode) {
    const inputs = canvasConfigInputs(node.id, nodesRef.current, connectionsRef.current);
    return <div className="flex h-full min-h-0 flex-col gap-2">
      <CanvasNodeReferences inputs={inputs} allInputs={canvasGenerationInputs(node.id, nodesRef.current, connectionsRef.current)} onFocus={(targetID) => focusReferencedNode(node.id, targetID)} onRemove={(sourceID) => removeNodeReference(node.id, sourceID)} />
      <div className="min-h-0 flex-1">{renderNodePanelContent(node)}</div>
    </div>;
  }

  function renderNodePanelContent(node: CanvasNode) {
    if (node.type === "script") return <CanvasScriptPromptPanel node={node} models={textModels} defaultModel={textModel} references={canvasNodeReferenceCandidates(node.id, nodesRef.current, connectionsRef.current)} running={scriptNodeRunning(node.id)} onChange={(patch) => updateNodeGenerationParameters(node.id, patch)} onReferenceSelect={(reference) => connectNodes(reference.nodeID, node.id)} onGenerate={() => requestScriptGeneration(node.id)} onStop={() => stopScriptGenerations(node.id)} onUploadReference={(file) => void uploadScriptReference(node.id, file)} />;
    const pendingRecovery = !nodeGenerationRunning(node.id) && canvasGenerationNeedsRecovery(node);
    if (node.type === "config") {
      const running = nodeGenerationRunning(node.id);
      const mode = node.generation_mode || "image";
      const inputs = canvasConfigInputs(node.id, nodesRef.current, connectionsRef.current);
      const canGenerate = canGenerateCanvasConfig(node, inputs);
      const nodeTextModel = node.generation_text_model || textModel;
      const nodeAudioModel = node.generation_audio_model || audioModel;
      const configVideoParams = canvasVideoParameters(node);
      const canGenerateWithModel = mode === "image"
        ? imageModels.includes(node.generation_model?.trim() || imageModel)
        : mode === "text"
          ? textModels.includes(nodeTextModel)
          : mode === "audio"
            ? audioModels.includes(nodeAudioModel)
            : videoModels.includes(configVideoParams.generation_video_model);
      const canGenerateWithParameters = mode !== "video" || videoSecondsIsValid(configVideoParams.generation_video_model, configVideoParams.generation_video_seconds);
      const configModel = mode === "image" ? node.generation_model?.trim() || imageModel : mode === "text" ? nodeTextModel : mode === "audio" ? nodeAudioModel : configVideoParams.generation_video_model;
      const configModels = mode === "image" ? imageModels : mode === "text" ? textModels : mode === "audio" ? audioModels : videoModels;
      const configPromptTools = <CanvasNodeInputToolbar action={<CanvasGenerationFooter
        running={running}
        disabled={!running && (pendingRecovery || !canGenerate || !canGenerateWithModel || !canGenerateWithParameters)}
        onGenerate={mode === "video" ? () => void runVideoGeneration(node.id, (node.composer_content ?? node.prompt ?? "").trim()) : () => void runGeneration(node.id)}
        onStop={() => requestStopGeneration(node.id)}
      />}>
        <CanvasInlineModelSelect value={configModel} models={configModels} label="生成模型" onChange={(value) => updateNodeGenerationParameters(node.id, mode === "image" ? { generation_model: value } : mode === "text" ? { generation_text_model: value } : mode === "audio" ? { generation_audio_model: value } : canvasVideoModelPatch(value))} />
        <CanvasParameterPopover icon={<SlidersHorizontal />} label="生成设置" summary={{ image: "图片", text: "文本", video: "视频", audio: "音频" }[mode]}>
          <div className="space-y-3">
            <LabeledField className="grid gap-1 text-xs" label={<span className="text-muted-foreground">生成模式</span>}>{(fieldId) => <><Select value={mode} onValueChange={(value: NonNullable<CanvasNode["generation_mode"]>) => updateNodeGenerationParameters(node.id, { generation_mode: value })}><SelectTrigger id={fieldId}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="image">图片</SelectItem><SelectItem value="text">文本</SelectItem><SelectItem value="video">视频</SelectItem><SelectItem value="audio">音频</SelectItem></SelectContent></Select></>}</LabeledField>
            {mode === "audio" ? <CanvasAudioSettingsFields node={node} models={audioModels} audioReferences={canvasAudioReferences(node.id, nodesRef.current, connectionsRef.current)} relayTokenName={tokenNameForModel("audio", nodeAudioModel)} onChange={(patch) => updateNodeGenerationParameters(node.id, patch)} showModel={false} /> : null}
          </div>
        </CanvasParameterPopover>
        {mode === "image" ? <><CanvasImageParameterPopover node={node} imageModel={node.generation_model || imageModel} imageModels={imageModels} onChange={(patch) => updateNodeGenerationParameters(node.id, patch)} showModel={false} /><CanvasCameraControl value={node.camera_control} onChange={(camera_control) => updateNodeGenerationParameters(node.id, { camera_control })} className="h-8 shrink-0 px-2.5" /></> : null}
        {mode === "video" ? <CanvasVideoPromptPanel relayTokenName={tokenNameForModel("video", configVideoParams.generation_video_model)} node={{ ...node, prompt: node.composer_content ?? node.prompt }} inputs={inputs} running={running} generationBusy={pendingRecovery} showPromptEditor={false} showGenerateFooter={false} videoModels={videoModels} onPromptChange={(value, commit) => updateNodeComposerContent(node.id, value, commit)} onParametersChange={(patch) => updateNodeGenerationParameters(node.id, patch)} onGenerate={(prompt) => void runVideoGeneration(node.id, prompt)} onStop={() => requestStopGeneration(node.id)} /> : null}
        <CanvasPromptLibrary onSelect={(value) => updateNodeComposerContent(node.id, value, true)} />
      </CanvasNodeInputToolbar>;
      return <CanvasConfigComposer
        node={node}
        inputs={inputs}
        referenceCandidates={canvasNodeReferenceCandidates(node.id, nodesRef.current, connectionsRef.current).map((reference) => ({ nodeID: reference.nodeID, type: reference.kind, title: reference.title, text: reference.text, url: reference.previewURL }))}
        onReferenceSelect={(sourceID) => connectNodes(sourceID, node.id)}
        promptTools={configPromptTools}
        onComposerChange={(value, commit) => updateNodeComposerContent(node.id, value, commit)}
      />;
    }
    if (node.type === "text") {
      const model = node.generation_text_model?.trim() || textModel;
      const context = buildCanvasGenerationContext(node.id, nodesRef.current, connectionsRef.current, node.composer_content || "");
      return (
        <CanvasTextPromptPanel
          node={node}
          mentionReferences={canvasNodeReferenceCandidates(node.id, nodesRef.current, connectionsRef.current)}
          onReferenceSelect={(reference) => connectNodes(reference.nodeID, node.id)}
          model={model}
          models={textModels}
          running={nodeGenerationRunning(node.id)}
          cancelling={cancellingGenerationNodeIDs.has(node.id)}
          canGenerate={textModels.includes(model) && Boolean(context.prompt.trim() || context.referenceImageURLs.length)}
          onPromptChange={(value, commit) => updateNodeComposerContent(node.id, value, commit)}
          onModelChange={(generation_text_model) => updateNodeGenerationParameters(node.id, { generation_text_model })}
          onGenerate={() => void runTextGeneration(node.id)}
          onStop={() => requestStopGeneration(node.id)}
        />
      );
    }
    if (node.type === "audio") {
      const context = buildCanvasGenerationContext(node.id, nodesRef.current, connectionsRef.current, node.prompt || "");
      const nodeAudioModel = node.generation_audio_model || audioModel;
      return <CanvasAudioPromptPanel mentionReferences={canvasNodeReferenceCandidates(node.id, nodesRef.current, connectionsRef.current)} onReferenceSelect={(reference) => connectNodes(reference.nodeID, node.id)} node={node} models={audioModels} audioReferences={canvasAudioReferences(node.id, nodesRef.current, connectionsRef.current)} relayTokenName={tokenNameForModel("audio", nodeAudioModel)} running={nodeGenerationRunning(node.id)} busy={pendingRecovery} uploading={uploadingNodeID === node.id} canGenerate={Boolean(context.prompt.trim()) && audioModels.includes(nodeAudioModel)} onChange={(patch) => updateNodeGenerationParameters(node.id, patch)} onPromptChange={(value, commit) => updateNodePrompt(node.id, value, commit)} onUpload={() => requestNodeMediaUpload(node.id)} onGenerate={() => void runAudioGeneration(node.id)} onStop={() => requestStopGeneration(node.id)} />;
    }
    if (node.type === "panorama") {
      const context = buildCanvasGenerationContext(node.id, nodesRef.current, connectionsRef.current, node.panorama_source_prompt || node.prompt || "");
      const nodeImageModel = node.generation_model?.trim() || imageModel;
      return <CanvasPanoramaPromptPanel mentionReferences={canvasNodeReferenceCandidates(node.id, nodesRef.current, connectionsRef.current)} onReferenceSelect={(reference) => connectNodes(reference.nodeID, node.id)} node={node} imageModel={nodeImageModel} imageModels={imageModels} running={nodeGenerationRunning(node.id)} busy={pendingRecovery} uploading={uploadingNodeID === node.id} canGenerate={Boolean(context.prompt.trim() || context.referenceImageURLs.length || node.url) && imageModels.includes(nodeImageModel)} onChange={(patch) => updateNodeGenerationParameters(node.id, { ...patch, generation_size: PANORAMA_IMAGE_SIZE })} onPromptChange={(value, commit) => { replaceNodes(nodesRef.current.map((item) => item.id === node.id ? { ...item, panorama_source_prompt: value, prompt: value } : item)); scheduleSave(); if (commit) pushHistory(); }} onUpload={() => requestNodeMediaUpload(node.id)} onGenerate={() => void runPanoramaGeneration(node.id)} onStop={() => requestStopGeneration(node.id)} />;
    }
    if (node.type === "director") return null;
    if (node.type === "video") {
      return <CanvasVideoPromptPanel mentionReferences={canvasNodeReferenceCandidates(node.id, nodesRef.current, connectionsRef.current)} onReferenceSelect={(reference) => connectNodes(reference.nodeID, node.id)} relayTokenName={tokenNameForModel("video", canvasVideoParameters(node).generation_video_model)} node={node} inputs={canvasGenerationInputs(node.id, nodesRef.current, connectionsRef.current)} running={nodeGenerationRunning(node.id)} generationBusy={pendingRecovery} uploading={uploadingNodeID === node.id} videoModels={videoModels} onPromptChange={(value, commit) => updateNodePrompt(node.id, value, commit)} onParametersChange={(patch) => updateNodeGenerationParameters(node.id, patch)} onGenerate={(prompt) => void runVideoGeneration(node.id, prompt)} onStop={() => requestStopGeneration(node.id)} onUpload={() => requestNodeMediaUpload(node.id)} />;
    }
    const running = nodeGenerationRunning(node.id);
    const connectedPromptAvailable = Boolean(buildCanvasGenerationContext(node.id, nodesRef.current, connectionsRef.current, node.prompt || "").prompt);
    return (
      <CanvasNodePromptPanel
        node={node}
        prompt={imagePromptDrafts[node.id] ?? (node.url ? "" : node.prompt || "")}
        onDraftChange={(value) => setImagePromptDrafts((drafts) => ({ ...drafts, [node.id]: value }))}
        mentionReferences={canvasNodeReferenceCandidates(node.id, nodesRef.current, connectionsRef.current)}
        onReferenceSelect={(reference) => connectNodes(reference.nodeID, node.id)}
        running={running}
        generationBusy={pendingRecovery}
        imageModel={imageModel}
        imageModels={imageModels}
        imageModelReady={imageModelReady}
        cancelling={cancellingGenerationNodeIDs.has(node.id)}
        canStop={running}
        connectedPromptAvailable={connectedPromptAvailable}
        onPromptChange={(value, commit) => updateNodePrompt(node.id, value, commit)}
        onParametersChange={(patch) => updateNodeGenerationParameters(node.id, patch)}
        onGenerate={(prompt) => void runGeneration(node.id, prompt)}
        onStop={() => requestStopGeneration(node.id)}
      />
    );
  }

  const renderedCanvasID = documentRef.current.id;
  useEffect(() => {
    if (!agentOpen || !agentHistoryMissing) return;
    const controller = new AbortController();
    void loadDeferredAgentHistory(controller.signal);
    // Start loading the panel while the transcript is pending. Lazy rendering handles import errors.
    void loadCanvasAgentPanel().catch(() => undefined);
    return () => controller.abort();
    // The load is scoped to the current document and uses refs for pending edits.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [agentOpen, agentHistoryMissing, agentHistoryReload, renderedCanvasID, activeAgentSessionID]);

  const navigationBlocker = useBlocker(useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => {
    const verifiedSession = getCachedAuthSession();
    return currentLocation.pathname !== nextLocation.pathname
      && loadedRef.current
      && verifiedSession?.key === session.key
      && canAccessPath(verifiedSession, "/canvas")
      && canvasSaveRequired(persistedChangeVersionRef.current, saveChangeVersionRef.current);
  }, [session.key]));

  useEffect(() => {
    if (navigationBlocker.state !== "blocked") return;
    const controller = new AbortController();
    void flushBlockedCanvasNavigation(navigationBlocker, controller.signal);
    return () => controller.abort();
    // The save operation reads the current canvas refs.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationBlocker, session.key]);

  useEffect(() => {
    const batchAnimationTimers = batchAnimationTimersRef.current;
    const activeGenerations = activeGenerationsRef.current;
    let active = true;
    const loadController = new AbortController();
    activateCanvasTaskQueueSession(session.key);
    mountedRef.current = true;
    setLoadError("");
    const loadWorkspace = async () => {
      // Applying a document normalizes video nodes from the active model contracts.
      // Load both in parallel so valid stored durations stay valid.
      const workspaceRequest = projectID
        ? updateCanvasProject({ action: "activate", project_id: projectID }, "editor", loadController.signal)
        : fetchCanvasDocument(undefined, "editor", [], loadController.signal);
      const [initialWorkspace] = await Promise.all([workspaceRequest, fetchModelConfig()]);
      let workspace = initialWorkspace;
      if (!active) return;
      if (!workspace.document?.id) {
        workspace = await updateCanvasProject({ action: "create", title: "我的画布" }, "active");
        if (!active) return;
      }
      applyWorkspace(workspace);
    };
    void loadWorkspace()
      .catch((error) => { if (active) setLoadError(error instanceof Error ? error.message : "画布加载失败"); })
      .finally(() => { loadController.abort(); if (active && mountedRef.current) setLoading(false); });
    const flushPendingSave = () => {
      checkpointCanvasDraft();
      if (saveTimerRef.current === null) return;
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      void persistCanvas();
    };
    const protectUnsavedCanvas = (event: BeforeUnloadEvent) => {
      if (!loadedRef.current || !canvasSaveRequired(persistedChangeVersionRef.current, saveChangeVersionRef.current)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsavedCanvas);
    window.addEventListener("pagehide", flushPendingSave);
    window.addEventListener("chatgpt2api:flush-before-leave", flushCanvasBeforeLeave);
    return () => {
      active = false;
      loadController.abort();
      mountedRef.current = false;
      canvasDocumentEpochRef.current += 1;
      canvasOperationEpochRef.current += 1;
    cancelCanvasMediaOperations();
      generationEpochRef.current += 1;
      generationAbortControllerRef.current?.abort();
      generationAbortControllerRef.current = null;
      new Set(activeGenerations.values()).forEach((generation) => generation.controller.abort());
      activeGenerations.clear();
      canvasRecoveryAbortControllerRef.current?.abort();
      canvasRecoveryAbortControllerRef.current = null;
      flushPendingSave();
      window.removeEventListener("pagehide", flushPendingSave);
      window.removeEventListener("beforeunload", protectUnsavedCanvas);
      window.removeEventListener("chatgpt2api:flush-before-leave", flushCanvasBeforeLeave);
      batchAnimationTimers.forEach((timer) => window.clearTimeout(timer));
      batchAnimationTimers.clear();
      if (switchRevealTimerRef.current !== null) window.clearTimeout(switchRevealTimerRef.current);
      if (focusAnimationRef.current !== null) window.cancelAnimationFrame(focusAnimationRef.current);
      clearCanvasTaskQueueForSession(session.key);
    };
    // Workspace loading is keyed by route and account; callbacks read the current canvas refs.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectID, session.key]);

  useEffect(() => {
    const renewHistoryLease = () => {
      if (!loadedRef.current || document.visibilityState !== "visible") return;
      expireCanvasHistoryLease();
      if (canvasHistoryStorageObjectIDs(historyRef.current, redoRef.current, generationHistoryBaseRef.current || []).length || canvasHistoryStorageObjectURLs(historyRef.current, redoRef.current, generationHistoryBaseRef.current || []).length) scheduleSave();
    };
    const timer = window.setInterval(renewHistoryLease, 30 * 60 * 1000);
    document.addEventListener("visibilitychange", renewHistoryLease);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", renewHistoryLease);
    };
    // Lease renewal reads the active project and history from refs.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [projectID, session.key]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      setCanvasSize({ width: host.clientWidth, height: host.clientHeight });
      setWorkspaceWidth(workspaceRef.current?.clientWidth || 0);
      setAgentAreaWidth(agentAreaRef.current?.clientWidth || 0);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    if (agentAreaRef.current) observer.observe(agentAreaRef.current);
    if (workspaceRef.current) observer.observe(workspaceRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!sidePanel.open || sidePanel.tab !== "assets") return;
    void refreshLibrary(true, true);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshLibrary();
    };
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshLibrary, sidePanel.open, sidePanel.tab]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDE_PANEL_STORAGE_KEY, JSON.stringify(sidePanel));
    } catch {
      // The panel preference is optional when browser storage is unavailable.
    }
  }, [sidePanel]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const command = event.ctrlKey || event.metaKey;
      // Selecting non-editable chat text does not necessarily move keyboard focus.
      if (command && !event.altKey && event.key.toLowerCase() === "c" && window.getSelection()?.toString()) return;
      if (documentRef.current.agent_run?.status === "running") return;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable) return;
      const toolShortcut = !command && !event.altKey && !event.shiftKey && ["v", "h"].includes(event.key.toLowerCase());
      const zoomShortcut = command && !event.altKey && ["+", "=", "-", "0"].includes(event.key);
      if (zoomShortcut && !target?.closest("[data-canvas-side-panel],[data-canvas-agent-panel],[data-slot='popover-content'],[data-slot='dropdown-menu-content'],[data-slot='context-menu-content'],[role='dialog'],[role='listbox']")) {
        event.preventDefault();
        if (event.key === "0") fitCanvasContent();
        else updateViewport(setCanvasViewportZoom(viewportRef.current, canvasSize, viewportRef.current.zoom * (event.key === "-" ? 1 / 1.2 : 1.2)), true);
        return;
      }
      if (
        target?.closest("[data-canvas-no-pan],[data-canvas-side-panel],[data-canvas-agent-panel],[data-slot='popover-content'],[data-slot='dropdown-menu-content'],[data-slot='context-menu-content'],[role='dialog'],[role='listbox'],[role='combobox']")
        || (!zoomShortcut && !toolShortcut && target?.closest("[data-canvas-controls]"))
      ) return;
      if (toolShortcut) { event.preventDefault(); setCanvasTool(event.key.toLowerCase() === "h" ? "pan" : "select"); }
      else if (command && !event.altKey && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
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

  const dockedAgentWidth = Math.min(CANVAS_AGENT_WIDTH, agentAreaWidth);
  const reservedAgentWidth = agentOpen && agentDisplayMode === "docked" ? dockedAgentWidth : 0;
  const controlsWidth = workspaceWidth;
  const viewControlsInset = Math.max(0, workspaceWidth - agentAreaWidth);
  const showWorkspaceControls = !loading && !switchPhase && reservedAgentWidth < agentAreaWidth
    && controlsWidth >= CANVAS_DOCK_MIN_WIDTH + 24;
  const dockClearance = showWorkspaceControls
    ? `calc(${canvasWorkspaceControlsStacked(controlsWidth, sidePanel.open, agentOpen, viewControlsInset) ? 116 : 60}px + max(1rem, env(safe-area-inset-bottom)))`
    : "12px";
  const dockWidth = Math.min(controlsWidth - 24, (controlsWidth < CANVAS_DOCK_BREAKPOINT ? CANVAS_DOCK_COMPACT_WIDTH : CANVAS_DOCK_WIDTH) - (agentOpen ? (controlsWidth < CANVAS_DOCK_BREAKPOINT ? 46 : 56) : 0));
  // Reserve dock height only when the right panel would overlap the centered toolbar.
  const agentBottom = !showWorkspaceControls || (controlsWidth - dockWidth) / 2 >= CANVAS_AGENT_WIDTH + 32
    ? "max(1rem, env(safe-area-inset-bottom))"
    : dockClearance;
  const dockedAgentBottom = showWorkspaceControls && (controlsWidth - dockWidth) / 2 < reservedAgentWidth + 12 ? dockClearance : "0px";
  const sidePanelBottom = showWorkspaceControls && (controlsWidth - dockWidth) / 2 < viewControlsInset + 12 ? dockClearance : "0px";

  const agentPanelPlaceholder = agentOpen ? (
    <Card role="complementary" aria-label="Agent 对话面板" aria-busy={!agentHistoryLoadError || undefined} className={cn("absolute z-40 flex min-h-0 flex-col overflow-hidden p-0 gap-0", agentDisplayMode === "docked" ? "top-0 bottom-[var(--canvas-agent-docked-bottom)] right-0" : "right-3 bottom-[var(--canvas-agent-bottom)] max-w-[calc(100%-1.5rem)] h-[min(880px,calc(100%-var(--canvas-agent-bottom)-1rem))] sm:right-4 sm:max-w-[calc(100%-2rem)] [@media(max-height:540px)]:fixed [@media(max-height:540px)]:h-[min(880px,calc(100dvh-var(--canvas-dock-clearance)-2rem))] [@media(max-height:540px)]:bottom-[calc(var(--canvas-dock-clearance)+1rem)] [@media(max-height:540px)]:z-[45]")} style={{ width: agentDisplayMode === "docked" ? dockedAgentWidth : `min(${CANVAS_AGENT_WIDTH}px, calc(100% - 12px))` }}>
      <header className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4 text-primary" />Agent</span>
        <Button type="button" variant="ghost" size="icon" aria-label="收起 Agent" onClick={closeAgentPanel}><X /></Button>
      </header>
      {agentHistoryMissing && agentHistoryLoadError ? <EmptyState role="alert" compact title="对话加载失败" description={agentHistoryLoadError} className="min-h-0 flex-1" action={<Button type="button" variant="outline" onClick={() => setAgentHistoryReload(value => value + 1)}>重试加载对话</Button>} /> : <LoadingState className="min-h-0 flex-1" label={agentHistoryMissing ? "正在加载对话" : "正在加载 Agent"} />}
    </Card>
  ) : null;

  if (loadError) return <EmptyState role="alert" title="画布加载失败" description={loadError} className="h-full" action={<Button type="button" variant="outline" onClick={() => window.location.reload()}>重新加载画布</Button>} />;

  return (
    <ContextMenu modal={false} open={Boolean(contextMenu)} onOpenChange={(open) => { if (!open) setContextMenu(null); }}>
    <section ref={workspaceRef} style={{ "--canvas-dock-clearance": dockClearance, "--canvas-agent-bottom": agentBottom, "--canvas-agent-docked-bottom": dockedAgentBottom, "--canvas-side-panel-bottom": sidePanelBottom, "--canvas-agent-width": `${dockedAgentWidth}px` } as CSSProperties} aria-label={`画布编辑器：${title}`} className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-card">
      <h1 className="sr-only">{title || "无限画布"}</h1>
      {recoveryDrafts.length && !canvasSaveError && !recoveryDialogOpen ? <Alert data-canvas-recovery-drafts className="absolute inset-x-3 top-16 z-50 mx-auto w-auto max-w-lg">
        <AlertTitle>此浏览器有未保存的画布草稿</AlertTitle>
        <AlertDescription>
          <Button type="button" variant="outline" size="sm" onClick={() => setRecoveryDialogOpen(true)}>查看草稿</Button>
        </AlertDescription>
      </Alert> : null}
      <Dialog open={recoveryDialogOpen} onOpenChange={(open) => { if (!processingRecoveryDraft) setRecoveryDialogOpen(open); }}>
        <DialogContent className="w-[min(92vw,480px)]">
          <DialogHeader>
            <DialogTitle>恢复本地草稿</DialogTitle>
            <DialogDescription>服务器版本发生变化时，草稿将保存为独立画布。</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1" contentClassName="grid gap-2">
            {recoveryDrafts.length ? recoveryDrafts.map(draft => <div key={draft.id} className="flex flex-wrap items-center gap-2">
              <time className="mr-auto text-sm" dateTime={new Date(draft.updatedAt).toISOString()}>{new Date(draft.updatedAt).toLocaleString()}</time>
              <Button type="button" size="sm" variant="ghost" disabled={processingRecoveryDraft} onClick={() => { setRecoveryDialogOpen(false); setDiscardRecoveryDraft(draft); }}>丢弃</Button>
              <Button type="button" size="sm" disabled={processingRecoveryDraft} onClick={() => void actOnCanvasDraft(draft, true)}>恢复草稿</Button>
            </div>) : <p className="text-sm text-muted-foreground">当前没有待恢复的草稿。</p>}
            {recoveryDraftError ? <p role="alert" className="text-sm text-destructive">{recoveryDraftError}</p> : null}
          </ScrollArea>
          <DialogFooter><Button type="button" variant="outline" disabled={processingRecoveryDraft} onClick={() => setRecoveryDialogOpen(false)}>关闭</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={Boolean(discardRecoveryDraft)} onOpenChange={(open) => { if (!open) { setDiscardRecoveryDraft(null); setRecoveryDialogOpen(true); } }} title="丢弃本地草稿" description="此草稿中的未保存修改将永久删除。" confirmLabel="丢弃草稿" destructive busy={processingRecoveryDraft} onConfirm={() => { if (discardRecoveryDraft) void actOnCanvasDraft(discardRecoveryDraft, false); }}>
        {recoveryDraftError ? <p role="alert" className="text-sm text-destructive">{recoveryDraftError}</p> : null}
      </ConfirmDialog>
      {canvasSaveError && !(agentOpen && (agentHistoryConflict || resolvingAgentHistory)) ? <Alert variant="destructive" data-canvas-save-error className="absolute inset-x-3 top-16 z-50 mx-auto w-auto max-w-lg">
        <AlertTitle>画布修改尚未保存</AlertTitle>
        <AlertDescription className="break-words">
          <p>{canvasSaveError}</p>
          <p>修改仍保留在当前页面，请保存成功后再刷新或关闭。</p>
          {recoveryDraftError ? <p>{recoveryDraftError}</p> : null}
          <Button type="button" variant="outline" size="sm" disabled={savingCanvas} onClick={() => void persistCanvas()}>{savingCanvas ? "正在保存" : "重试保存"}</Button>
        </AlertDescription>
      </Alert> : null}
      <div className="contents"><CanvasSidePanel
        sessionKey={session.key}
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
      </div>
      <div ref={agentAreaRef} className="relative flex min-w-0 flex-1 overflow-hidden">
      <div ref={hostRef} data-canvas-host style={{ marginRight: reservedAgentWidth }} className="relative min-w-0 flex-1 overflow-hidden bg-muted/50">
      <ContextMenuTrigger asChild><div id={contextMenuTriggerID} tabIndex={0} aria-label="画布操作区" className="absolute inset-0">
      <CanvasEngine
        tool={canvasTool}
        nodes={nodes}
        connections={connections}
        showConnections={showConnections}
        snapToGrid={snapToGrid}
        viewport={viewport}
        background={background}
        showImageInfo={showImageInfo}
        canvasSize={canvasSize}
        exporting={exportingCanvas}
        exportBounds={exportingCanvas ? canvasExportBounds(visibleCanvasNodes(nodes)) : undefined}
        selectedNodeIDs={selectedNodeIDs}
        selectedConnectionID={selectedConnectionID}
        panelNodeID={panelNodeID}
        loadingNodeID=""
        pendingConnectionActive={Boolean(pendingConnection)}
        collapsingBatchRootIDs={collapsingBatchRootIDs}
        openingBatchRootIDs={openingBatchRootIDs}
        onNodesChange={replaceNodes}
        onNodesCommit={pushHistory}
        onViewportChange={updateViewport}
        onSelectionChange={selectionChanged}
        onConnect={connectNodes}
        canConnect={canConnect}
        onConnectionDropEmpty={(origin, position, menu) => setPendingConnection({ ...origin, position, menu })}
        onTitleChange={updateNodeTitle}
        onNodePanelToggle={(nodeID) => setPanelNodeID((current) => current === nodeID ? "" : nodeID)}
        onNodeMediaLoad={handleNodeMediaLoad}
        onViewImage={(nodeID) => setPreviewNodeID(nodeID)}
        onFocusNode={focusCanvasNode}
        onScriptOpen={(nodeID) => {
          const project = nodesRef.current.find((node) => node.id === nodeID)?.script_project;
          if (project) {
            const edges = scriptAssetConnections(nodeID, project, project, connectionsRef.current);
            if (JSON.stringify(edges) !== JSON.stringify(connectionsRef.current)) updateScriptProject(nodeID, project);
          }
          setPanelNodeID(""); setOpenScriptNodeID(nodeID);
        }}
        onDirectorOpen={(nodeID) => { setPanelNodeID(""); setOpenDirectorNodeID(nodeID); }}
        onNodeRetry={(nodeID) => void retryCanvasNode(nodeID)}
        onNodeActivate={activateNode}
        onToggleBatch={toggleCanvasBatch}
        onSetBatchPrimary={makeCanvasBatchPrimary}
        onNodeContextMenu={openNodeContextMenu}
        onConnectionContextMenu={openConnectionContextMenu}
        onCanvasContextMenu={openCanvasContextMenu}
        onCanvasDoubleClick={(event, position) => {
          const rect = hostRef.current?.getBoundingClientRect();
          setNodeCreateMenu({ position, menu: { x: event.clientX - (rect?.left || 0), y: event.clientY - (rect?.top || 0) } });
        }}
        renderNodePanel={renderNodePanel}
        renderNodeQuickActions={renderNodeQuickActions}
        onDrop={handleCanvasDrop}
      />
      </div></ContextMenuTrigger>
      {referenceReturn && nodes.some((node) => node.id === referenceReturn.nodeID) ? <CanvasReferenceReturn expiresAt={referenceReturn.expiresAt} onReturn={returnToReferenceOrigin} onDismiss={() => setReferenceReturn(null)} /> : null}
      {audioTrimNodeID && nodes.some((node) => node.id === audioTrimNodeID && node.type === "audio") ? <CanvasAudioTrimDialog key={audioTrimNodeID} node={nodes.find((node) => node.id === audioTrimNodeID)!} busy={mediaBusyNodeIDs.has(audioTrimNodeID)} onClose={() => setAudioTrimNodeID("")} onTrim={(trim) => void editCanvasMedia(audioTrimNodeID, "trim-audio", trim)} /> : null}
      {!loading && !switchPhase && !nodes.length && !agentOpen && canvasSize.height > 360 ? <CanvasEmptyState onCreate={createCanvasNode} /> : null}
      {selectedNodeIDs.size > 1 && !agentOpen ? <Card className="absolute left-3 top-16 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-2 p-1.5 flex-row"><span className="px-2 text-xs tabular-nums text-muted-foreground">已选 {selectedNodeIDs.size} 个节点</span><Button size="sm" variant="secondary"  onClick={() => createGroupFromSelection()}><Grid2X2 />编组</Button></Card> : null}
      {openScriptNode?.script_project ? <Suspense fallback={<LoadingState label="正在加载脚本工作区" className="absolute inset-0 z-50 bg-background" />}><CanvasScriptWorkspace key={`${documentRef.current.id}:${openScriptNode.id}`} node={openScriptNode} nodes={nodes} project={openScriptNode.script_project} models={textModels} defaultModel={textModel} running={scriptNodeRunning(openScriptNode.id)} onClose={() => setOpenScriptNodeID("")} onChange={(script_project) => editScriptProject(openScriptNode.id, script_project)} onModelChange={(generation_text_model) => updateNodeGenerationParameters(openScriptNode.id, { generation_text_model })} onSynthesize={(ids, smart) => { if (smart) void runScriptTextGeneration(openScriptNode.id, "prompts", ids); else concatenateScript(openScriptNode.id, ids); }} scope={session.key} imageModels={imageModels} imageModel={imageModel} imageDefaults={{ ...openScriptNode, ...preferredCanvasImageParameters(), generation_model: imageModel, generation_count: 1 }} onInsertAsset={(assetID, payload) => insertScriptAsset(openScriptNode.id, assetID, payload)} onNavigateAsset={(nodeID) => { setOpenScriptNodeID(""); focusAgentCanvasNode(nodeID); }} onFocusProduction={() => focusScriptProduction(openScriptNode.id)} onSaveAsset={(nodeID) => void saveCanvasNodeAsset(nodeID)} onGenerateAssets={(request) => void generateScriptAssets(openScriptNode.id, request)} onUploadAsset={(assetID, file) => void uploadScriptAsset(openScriptNode.id, assetID, file)} onGenerateMedia={(type, shotIDs, regenerate) => void generateScriptMedia(openScriptNode.id, type, shotIDs, regenerate)} onRetryMedia={(nodeID) => void retryCanvasNode(nodeID)} onStop={() => stopScriptGenerations(openScriptNode.id)} /></Suspense> : null}
      <ConfirmDialog open={Boolean(regenerateScriptNodeID)} onOpenChange={(open) => { if (!open) setRegenerateScriptNodeID(""); }} title="更新分镜脚本" description="将重新整理现有分镜并保留素材、镜头与成品关联。修改过的镜头会标记为待更新，已有图片和视频继续保留。" confirmLabel="更新脚本" onConfirm={() => { const id = regenerateScriptNodeID; setRegenerateScriptNodeID(""); void runScriptTextGeneration(id, "script"); }} />
      {openDirectorNode ? <CanvasDirector nodeId={openDirectorNode.id} project={openDirectorNode.director_project} panoramas={directorPanoramas} theme={colorTheme} onClose={() => setOpenDirectorNodeID("")} onProjectChange={handleDirectorProjectChange} onPanoramaRemoved={handleDirectorPanoramaRemoved} onCapturesSent={handleDirectorCapturesSent} onVideoSent={handleDirectorVideoSent} /> : null}

      {pendingConnection ? <CanvasNodeCreatePalette point={pendingConnection.menu} viewport={canvasSize} connecting onCreate={createPendingNode} /> : null}
      {nodeCreateMenu ? <CanvasNodeCreatePalette point={nodeCreateMenu.menu} viewport={canvasSize} onCreate={(type) => { createCanvasNode(type, nodeCreateMenu.position); setNodeCreateMenu(null); }} /> : null}

      <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start gap-3">
        <Card data-canvas-menu className="pointer-events-auto relative flex h-10 min-w-0 max-w-full items-center p-1 gap-0 flex-row">
          <DropdownMenu modal={false} open={canvasMenuOpen} onOpenChange={(open) => { setCanvasMenuOpen(open); if (open) setProjectMenuOpen(false); }}>
            <TooltipHint content="画布菜单"><span className="inline-flex"><DropdownMenuTrigger asChild><Button type="button" aria-label="画布菜单" variant="ghost" size="icon"><Menu /></Button></DropdownMenuTrigger></span></TooltipHint>
            {canvasMenuOpen ? <DropdownMenuContent data-canvas-menu align="start" sideOffset={10} className="w-60 max-w-[calc(100vw-1.5rem)]">
              <DropdownMenuItem onSelect={() => navigate("/canvas")}><Images />回到主页</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setProjectDialog({ mode: "create", title: `无限画布 ${projects.length + 1}` })}><Plus />新建画布</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setProjectDialog({ mode: "rename", title })}><Pencil />重命名</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setProjectDialog({ mode: "delete", title })}><Trash2 />删除当前画布</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => requestCanvasImageUpload()}><Upload />导入素材</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void exportImage()}><Download />导出画布图片</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportProjectArchive()}><FileDown />导出画布</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => importRef.current?.click()}><FileUp />导入画布</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" disabled={!nodes.length} onSelect={() => setClearConfirmationOpen(true)}><Eraser />清空画布</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={historyRef.current.length <= 1} onSelect={undo}><Undo2 />撤销<Kbd className="ml-auto">⌘ Z</Kbd></DropdownMenuItem>
              <DropdownMenuItem disabled={!redoRef.current.length} onSelect={redo}><Redo2 />重做<Kbd className="ml-auto">⌘ ⇧ Z</Kbd></DropdownMenuItem>
            </DropdownMenuContent> : null}
          </DropdownMenu>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <Popover open={projectMenuOpen} onOpenChange={(open) => { setProjectMenuOpen(open); if (open) setCanvasMenuOpen(false); }}>
            <PopoverTrigger asChild><Button type="button" aria-label="画布项目" variant="ghost" size="sm" className="min-w-0 max-w-[30vw] flex-1 sm:max-w-56"><span className="truncate">{title}</span><ChevronDown /></Button></PopoverTrigger>
            {projectMenuOpen ? <PopoverContent data-canvas-project-menu align="start" sideOffset={10} className="w-80 max-w-[calc(100vw-1.5rem)] max-h-(--radix-popover-content-available-height) overflow-hidden">
              <PopoverHeader><PopoverTitle>画布项目</PopoverTitle><PopoverDescription>跨设备自动同步</PopoverDescription></PopoverHeader>
              <ScrollArea className="min-h-0 max-h-56 flex-1" contentClassName="py-1">
                <ToggleGroup type="single" orientation="vertical" value={documentRef.current.id} aria-label="选择画布项目" className="w-full flex-col items-stretch" onValueChange={(id) => { if (id && id !== documentRef.current.id) void runProject({ action: "activate", project_id: id }); }}>
                  {projects.map((project) => <ToggleGroupItem key={project.id} value={project.id} className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"><span className="min-w-0 flex-1 break-words">{project.title}</span><Badge variant="outline">{project.node_count}</Badge></ToggleGroupItem>)}
                </ToggleGroup>
              </ScrollArea>
              <Separator />
              <ToggleGroup type="single" value={background} aria-label="画布背景" className="w-full" onValueChange={(value) => { if (value !== "dots" && value !== "grid" && value !== "plain") return; backgroundRef.current = value; setBackground(value); setTimeout(pushHistory); }}>
                <ToggleGroupItem value="dots" className="min-w-0 flex-1"><CircleDot />点阵</ToggleGroupItem>
                <ToggleGroupItem value="grid" className="min-w-0 flex-1"><Grid2X2 />网格</ToggleGroupItem>
                <ToggleGroupItem value="plain" className="min-w-0 flex-1"><Square />空白</ToggleGroupItem>
              </ToggleGroup>
              <Label className="flex items-center justify-between gap-3 text-xs"><span className="flex min-w-0 items-center gap-1.5"><Info className="size-3.5" />图片信息</span><Switch checked={showImageInfo} aria-label="显示图片信息" onCheckedChange={(enabled) => { showImageInfoRef.current = enabled; setShowImageInfo(enabled); pushHistory(); }} /></Label>
            </PopoverContent> : null}
          </Popover>
          <CanvasShareButton key={`${session.key}:${documentRef.current.id}`} projectID={documentRef.current.id} disabled={loading || Boolean(switchPhase)} beforeShare={() => flushCanvasSaves({ save: persistCanvas, getChangeVersion: () => saveChangeVersionRef.current, getProjectID: () => documentRef.current.id })} onOpen={() => { setCanvasMenuOpen(false); setProjectMenuOpen(false); }} />
        </Card>
      </div>

      {assetPickerMounted ? <Suspense fallback={(
        <Dialog open={assetPickerOpen} onOpenChange={setAssetPickerOpen}>
          <DialogContent className={cn("sm:max-w-none", cn("h-[min(760px,92dvh)]", "flex w-[min(94vw,960px)] max-w-none flex-col overflow-hidden"))}>
            <DialogHeader className="shrink-0">
              <DialogTitle>选择素材</DialogTitle>
              <DialogDescription>选择文本、图片、视频或音频，点击即可插入画布。</DialogDescription>
            </DialogHeader>
            <LoadingState className="min-h-0 flex-1" label="正在加载素材选择器" />
          </DialogContent>
        </Dialog>
      )}><CanvasAssetPicker
        open={assetPickerOpen}
        session={session}
        onInsert={(payload) => {
          insertCanvasAsset(payload);
          setAssetPickerOpen(false);
        }}
        onClose={() => setAssetPickerOpen(false)}
      /></Suspense> : null}

      {miniMapOpen && showWorkspaceControls && nodes.length && canvasSize.width > 0 ? <CanvasMiniMap onClose={() => setMiniMapOpen(false)} nodes={nodes} viewport={viewport} viewportSize={canvasSize} onViewportChange={(next) => updateViewport(next, true)} /> : null}

      {contextMenu ? <CanvasRightClickMenu triggerID={contextMenuTriggerID} mediaNode={contextMenu.type === "node" ? nodes.find((node) => node.id === contextMenu.nodeID) : undefined} onInfo={() => { if (contextMenu.type === "node") setNodeInfoID(contextMenu.nodeID); setContextMenu(null); }} onCopyContent={() => { if (contextMenu.type === "node") void copyNodePrompt(contextMenu.nodeID); setContextMenu(null); }} menu={contextMenu} onClose={() => setContextMenu(null)} onDuplicate={() => { if (contextMenu.type === "node") duplicateNode(contextMenu.nodeID); setContextMenu(null); }} onDelete={() => { if (contextMenu.type === "node") removeNodes(new Set([contextMenu.nodeID])); else if (contextMenu.type === "connection") { replaceConnections(connectionsRef.current.filter((connection) => connection.id !== contextMenu.connectionID)); setSelectedConnectionID(""); pushHistory(); } setContextMenu(null); }} onAddText={() => { if (contextMenu.type === "canvas") addTextNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 120 }); setContextMenu(null); }} onAddImage={() => { if (contextMenu.type === "canvas") addBlankNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 120 }); setContextMenu(null); }} onAddVideo={() => { if (contextMenu.type === "canvas") createCanvasNode("video", contextMenu.position); setContextMenu(null); }} onAddConfig={() => { if (contextMenu.type === "canvas") addConfigNodeAt({ x: contextMenu.position.x - 170, y: contextMenu.position.y - 120 }); setContextMenu(null); }} onPaste={() => { void pasteSelected(); setContextMenu(null); }} onExportImage={() => { void exportImage(); setContextMenu(null); }} onExportJSON={() => { void exportProjectArchive(); setContextMenu(null); }} onImport={() => { importRef.current?.click(); setContextMenu(null); }} onClear={() => { setClearConfirmationOpen(true); setContextMenu(null); }} /> : null}
      <Dialog open={Boolean(nodeInfo)} onOpenChange={(open) => { if (!open) setNodeInfoID(""); }}>
        {nodeInfo ? <DialogContent className="w-[min(560px,calc(100vw-2rem))] sm:max-w-none">
          <DialogHeader><DialogTitle>节点详情</DialogTitle><DialogDescription>查看节点信息、生成记录和原始数据。</DialogDescription></DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          {nodeInfo ? <CanvasNodeInfoContent key={nodeInfo.id} node={nodeInfo} configInputs={nodeInfo.type === "config" ? canvasConfigInputs(nodeInfo.id, nodes, connections) : []} /> : null}
        </ScrollArea></DialogContent> : null}
      </Dialog>
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
        {shortcutsOpen ? <DialogContent className="w-[min(92vw,560px)] sm:max-w-none">
          <DialogHeader >
            <DialogTitle>画布快捷键</DialogTitle>
            <DialogDescription>使用键盘和鼠标快速操作画布。</DialogDescription>
          </DialogHeader>
          <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain" style={{maxHeight: "min(68dvh,560px)"}}><div className="min-w-0 grid gap-1 p-5 sm:p-6">
            <CanvasShortcut keys={["V"]} description="选择工具：选中、框选和移动节点" />
            <CanvasShortcut keys={["H"]} description="抓手工具：平移画布" />
            <CanvasShortcut keys={["Space", "拖动"]} description="临时移动画布" />
            <CanvasShortcut keys={["滚轮"]} description="缩放画布" />
            <CanvasShortcut keys={["Ctrl / Cmd", "+ / −"]} description="放大 / 缩小画布" />
            <CanvasShortcut keys={["Ctrl / Cmd", "0"]} description="适合屏幕" />
            <CanvasShortcut keys={["Shift / Ctrl / Cmd", "点击"]} description="追加选择节点" />
            <CanvasShortcut keys={["Ctrl / Cmd", "A"]} description="全选节点" />
            <CanvasShortcut keys={["Ctrl / Cmd", "G"]} description="创建组" />
            <CanvasShortcut keys={["Ctrl / Cmd", "C / V"]} description="复制 / 粘贴节点或剪贴板内容" />
            <CanvasShortcut keys={["Ctrl / Cmd", "Z"]} description="撤销" />
            <CanvasShortcut keys={["Ctrl / Cmd", "Shift", "Z"]} description="重做" />
            <CanvasShortcut keys={["Delete / Backspace"]} description="删除选中" />
            <CanvasShortcut keys={["Esc"]} description="取消选择并关闭浮层" />
          </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
        </DialogContent> : null}
      </Dialog>
      <Dialog open={Boolean(pendingPanoramaImport)} onOpenChange={(open) => { if (!open) setPendingPanoramaImport(null); }}>
        {pendingPanoramaImport ? <DialogContent className="w-[min(92vw,420px)] sm:max-w-none">
          <DialogHeader>
            <DialogTitle>导入 2:1 图片</DialogTitle>
            <DialogDescription>这张图片符合严格的 2:1 全景比例，请选择节点类型。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => finishPanoramaImport("image")}>作为普通图片导入</Button>
            <Button onClick={() => finishPanoramaImport("panorama")}>作为全景图导入</Button>
          </DialogFooter>
        </DialogContent> : null}
      </Dialog>
      <Dialog open={Boolean(stopTargetNodeID)} onOpenChange={(open) => { if (!open) setStopTargetNodeID(""); }}>
        {stopTargetNodeID ? <DialogContent className="w-[min(92vw,420px)] sm:max-w-none">
          <DialogHeader>
            <DialogTitle>停止生成？</DialogTitle>
            <DialogDescription>{nodesRef.current.some((node) => node.id === stopTargetNodeID && node.type === "script") ? "将停止此脚本及其素材、分镜和视频的生成任务，已完成的结果会保留。" : "当前节点的生成请求会被中断，其他节点的任务会继续运行，已经生成完成的结果会保留。"}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopTargetNodeID("")}>继续生成</Button>
            <Button variant="destructive" onClick={confirmStopGeneration}>停止</Button>
          </DialogFooter>
        </DialogContent> : null}
      </Dialog>
      <Dialog open={clearConfirmationOpen} onOpenChange={setClearConfirmationOpen}>
        {clearConfirmationOpen ? <DialogContent className="w-[min(92vw,420px)] sm:max-w-none">
          <DialogHeader>
            <DialogTitle>清空画布？</DialogTitle>
            <DialogDescription>这会删除当前画布上的所有节点和连线。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearConfirmationOpen(false)}>取消</Button>
            <Button variant="destructive" onClick={() => void resetCanvas()}>清空</Button>
          </DialogFooter>
        </DialogContent> : null}
      </Dialog>
      {imageToolsMounted ? <>
        <CanvasCropDialog sourceURL={imageTool?.kind === "crop" ? imageTool.sourceURL : ""} open={imageTool?.kind === "crop"} busy={imageToolBusy} onClose={closeCanvasImageTool} onConfirm={(crop, sourceURL) => void cropCanvasNode(crop, sourceURL)} />
        <CanvasSplitDialog sourceURL={imageTool?.kind === "split" ? imageTool.sourceURL : ""} open={imageTool?.kind === "split"} busy={imageToolBusy} onClose={closeCanvasImageTool} onConfirm={(params, sourceURL) => void splitCanvasNode(params, sourceURL)} />
        <CanvasUpscaleDialog sourceURL={imageTool?.kind === "upscale" ? imageTool.sourceURL : ""} open={imageTool?.kind === "upscale"} busy={imageToolBusy} onClose={closeCanvasImageTool} onConfirm={(params, sourceURL) => void upscaleCanvasNode(params, sourceURL)} />
        <CanvasMaskDialog sourceURL={imageTool?.kind === "mask" ? imageTool.sourceURL : ""} open={imageTool?.kind === "mask"} busy={imageToolBusy} model={maskEditModel || imageModel} models={imageModels} onModelChange={setMaskEditModel} onClose={closeCanvasImageTool} onConfirm={maskEditCanvasNode} />
        <CanvasAngleDialog sourceURL={imageTool?.kind === "angle" ? imageTool.sourceURL : ""} open={imageTool?.kind === "angle"} busy={imageToolBusy} onClose={closeCanvasImageTool} onConfirm={angleCanvasNode} />
      </> : null}
      {previewPanorama?.url ? (
        <Dialog open onOpenChange={(open) => { if (!open) setPreviewNodeID(""); }}>
          <DialogContent className="h-[85dvh] w-[85vw] gap-0 p-0 sm:max-w-[85vw]">
            <DialogTitle className="sr-only">{previewPanorama.title || "全景图"}</DialogTitle>
            <DialogDescription className="sr-only">拖动查看全景图，按 Escape 关闭预览。</DialogDescription>
            <CanvasPanoramaViewer src={previewPanorama.url} alt={previewPanorama.title || "全景图"} proxyGeneratedPanorama={Boolean(previewPanorama.task_id && !previewPanorama.storage_key)} immersive />
          </DialogContent>
        </Dialog>
      ) : null}
      {previewVideo?.url ? <CanvasVideoPreview src={previewVideo.url} title={previewVideo.title || "视频"} onDownload={() => void downloadNodeImage(previewVideo.id)} onClose={() => setPreviewNodeID("")} /> : null}
      {imageLightboxMounted ? <ImageLightbox images={previewImages} currentIndex={previewIndex} open={Boolean(previewNodeID && !previewPanorama && !previewVideo)} onOpenChange={(open) => { if (!open) setPreviewNodeID(""); }} onIndexChange={(index) => setPreviewNodeID(previewImages[index]?.id || "")} /> : null}
      <Input ref={importRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importProjectArchive(event)} />
      <Input ref={imageInputRef} type="file" accept="image/*,video/mp4,video/quicktime,.mp4,.mov,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={(event) => void handleNodeImageUpload(event)} />
      </div>
      {agentHistoryMissing ? agentPanelPlaceholder : agentPanelMounted ? <Suspense fallback={agentPanelPlaceholder}><CanvasAgentPanel
        key={renderedCanvasID}
        backendRun={backendAgentRun}
        syncError={agentSyncError}
        onSyncError={setAgentSyncError}
        onLocalObservationChange={setAgentLocallyObserving}
        onBackendDocument={applyBackendAgentDocument}
        open={agentOpen}
        nodes={nodes}
        selectedNodeIDs={agentSelectedNodeIDs}
        referenceNodeClick={agentReferenceNodeClick}
        model={textModel}
        models={textModels}
        onModelChange={(value) => { setTextModel(value); updateCanvasAgentConfig({ textModel: value }); }}
        mediaModels={{
          image: { value: imageModel, options: imageModels, onChange: (value) => { setImageModel(value); updateCanvasAgentConfig({ imageModel: value }); } },
          video: { value: videoModel, options: videoModels, onChange: (value) => { setVideoModel(value); updateCanvasAgentConfig({ videoModel: value }); } },
        }}
        configuredSystemPrompt={imageGenerationPreferences.system_prompt}
        initialSessions={agentSessions}
        sessionSummaries={agentSessionSummaries}
        onLoadSession={loadAgentHistorySession}
        initialActiveSessionID={activeAgentSessionID}
        initialRequest={initialAgentRequest}
        agentConfig={resolvedAgentConfig}
        displayMode={agentDisplayMode}
        onDisplayModeChange={(mode) => {
          setAgentDisplayMode(mode);
          documentRef.current = { ...documentRef.current, agent_panel: { open: true, width: CANVAS_AGENT_WIDTH, mode } };
          scheduleSave();
        }}
        getAgentContext={(state) => {
          if (documentRef.current.id !== renderedCanvasID) throw new DOMException("画布已切换", "AbortError");
          return getCanvasAgentContext(state);
        }}
        onPersist={persistGenerationCheckpoint}
        historyConflict={Boolean(agentHistoryConflict)}
        resolvingHistoryConflict={resolvingAgentHistory}
        onResolveHistoryConflict={() => void resolveAgentHistoryConflict()}
        onSessionsChange={(sessions, activeSessionID, deletedSessionIDs = []) => {
          if (documentRef.current.id !== renderedCanvasID) return;
          if (documentRef.current.agent_run?.status === "running") {
            const queued = mergeCanvasAgentMessageQueues([], sessions, documentRef.current.agent_sessions || []).filter(isCanvasAgentSession);
            setAgentSessions(queued);
            documentRef.current = { ...documentRef.current, agent_sessions: queued };
            scheduleSave();
            return;
          }
          setAgentSessions(sessions);
          setActiveAgentSessionID(activeSessionID);
          documentRef.current = {
            ...documentRef.current,
            agent_sessions: sessions,
            active_agent_session_id: activeSessionID,
            deleted_agent_session_ids: [...new Set([...(documentRef.current.deleted_agent_session_ids || []), ...deletedSessionIDs])],
          };
          setAgentSessionSummaries(canvasAgentHistorySummaries({ ...documentRef.current, agent_sessions: sessions }));
          scheduleSave();
        }}
        onAgentConfigChange={updateCanvasAgentConfig}
        onExecuteAction={(action, messageReferenceNodeIDs, execution) => documentRef.current.id === renderedCanvasID
          ? executeCanvasAgentAction(action, messageReferenceNodeIDs, execution)
          : Promise.resolve({ ok: false, code: "run_stale", message: "画布已切换，当前执行已停止" })}
        onFocusNode={focusAgentCanvasNode}
        onInitialRequestConsumed={() => {
          if (documentRef.current.id === renderedCanvasID) {
            documentRef.current = { ...documentRef.current, pending_agent_request: undefined };
            setInitialAgentRequest(null);
            scheduleSave();
          }
        }}
        onClose={closeAgentPanel}
      /></Suspense> : null}
      {!showWorkspaceControls && !agentOpen && !loading && !switchPhase ? <Button
        type="button"
        data-canvas-agent-trigger
        variant="secondary"
        size="icon"
        aria-label={backendAgentRun?.status === "running" ? "Agent 正在执行，打开对话" : "打开 Agent"}
        aria-expanded={false}
        onClick={() => {
          setPanelNodeID("");
          setAgentOpen(true);
          documentRef.current = { ...documentRef.current, agent_panel: { open: true, width: CANVAS_AGENT_WIDTH, mode: agentDisplayMode } };
          scheduleSave();
        }}
        className="pointer-events-auto absolute right-3 z-30 shadow-md"
        style={{ bottom: "var(--canvas-agent-bottom)" }}
      >
        <Bot />
        {backendAgentRun?.status === "running" ? <Spinner className="absolute -right-1 -top-1 size-3.5" /> : null}
      </Button> : null}
      {navigationBlocker.state === "blocked" ? <CanvasSwitchShell label="正在保存画布…" /> : null}
      {navigationBlocker.state !== "blocked" && (loading || switchPhase) ? <CanvasSwitchShell label={loading ? "正在加载画布…" : switchLabel} revealing={!loading && switchPhase === "revealing"} /> : null}
      </div>
      {showWorkspaceControls ? <div data-canvas-workspace-overlay className="pointer-events-none absolute inset-0 z-30"><CanvasWorkspaceControls
        width={controlsWidth}
        viewInset={viewControlsInset}
        zoom={viewport.zoom}
        selectedCount={selectedNodeIDs.size || (selectedConnectionID ? 1 : 0)}
        canUndo={historyRef.current.length > 1}
        canRedo={Boolean(redoRef.current.length)}
        uploading={Boolean(uploadingNodeID)}
        miniMapOpen={miniMapOpen}
        hasNodes={Boolean(nodes.length)}
        assetsOpen={assetPickerOpen}
        agentOpen={agentOpen}
        agentRunning={backendAgentRun?.status === "running"}
        onAgent={() => {
          if (window.matchMedia("(max-width: 767px), (max-height: 540px)").matches) {
            setSidePanel((current) => ({ ...current, open: false }));
          }
          setPanelNodeID("");
          setAgentOpen(true);
          documentRef.current = { ...documentRef.current, agent_panel: { open: true, width: CANVAS_AGENT_WIDTH, mode: agentDisplayMode } };
          scheduleSave();
        }}
        sidePanelOpen={sidePanel.open}
        historyOpen={sidePanel.open && sidePanel.tab === "assets"}
        showConnections={showConnections}
        snapToGrid={snapToGrid}
        onCreate={createCanvasNode}
        onUpload={() => requestCanvasImageUpload()}
        onTemporaryUpload={() => requestCanvasImageUpload(undefined, true)}
        onAssets={() => setAssetPickerOpen(true)}
        onManagement={() => setSidePanel((current) => ({ ...current, open: !(current.open && current.tab === "canvas"), tab: "canvas" }))}
        onHistory={() => setSidePanel((current) => ({ ...current, open: !(current.open && current.tab === "assets"), tab: "assets" }))}
        onArrange={() => { replaceNodes(arrangeCanvasAgentNodes(nodesRef.current, []).nodes); pushHistory(); fitCanvasContent(); }}
        onToggleConnections={() => { setShowConnections((value) => !value); setSelectedConnectionID(""); }}
        onToggleSnap={() => setSnapToGrid((value) => !value)}
        tool={canvasTool}
        onToolChange={setCanvasTool}
        onUndo={undo}
        onRedo={redo}
        onDelete={removeSelected}
        onZoom={(zoom) => updateViewport(setCanvasViewportZoom(viewportRef.current, canvasSize, zoom), true)}
        onFit={fitCanvasContent}
        scripts={nodes.filter(node => node.type === "script" && node.script_project)}
        nodes={nodes}
        onFocusNode={focusAgentCanvasNode}
        onFitScript={focusScriptProduction}
        onMiniMap={() => setMiniMapOpen((value) => !value)}
        onShortcuts={() => setShortcutsOpen(true)}
      /></div> : null}
    </section>
    </ContextMenu>
  );
}

function CanvasSwitchShell({ label, revealing = false }: { label: string; revealing?: boolean }) {
  return (
    <div
      className={cn("absolute inset-0 z-50 grid place-items-center overflow-hidden bg-background transition-opacity duration-150 motion-reduce:transition-none", revealing && "pointer-events-none opacity-0")}
      role="status"
      aria-live="polite"
      aria-label={label}
      aria-hidden={revealing}
    >
      <LoadingState className="h-auto" label={label} />
    </div>
  );
}

function CanvasShortcut({ keys, description }: { keys: string[]; description: string }) {
  return (
    <Item size="xs" className="grid min-h-11 grid-cols-[minmax(0,1fr)_minmax(120px,auto)] gap-4">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        {keys.map((key, index) => (
          <span key={`${key}-${index}`} className="flex items-center gap-1.5">
            {index ? <span className="text-xs text-muted-foreground">+</span> : null}
            <Kbd>{key}</Kbd>
          </span>
        ))}
      </span>
      <span className="text-right text-sm text-muted-foreground">{description}</span>
    </Item>
  );
}

function CanvasMiniMap({ nodes, viewport, viewportSize, onViewportChange, onClose }: { onClose: () => void; nodes: CanvasNode[]; viewport: CanvasDocument["viewport"]; viewportSize: { width: number; height: number }; onViewportChange: (viewport: CanvasDocument["viewport"]) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const width = Math.min(240, Math.max(80, viewportSize.width - 24));
  const height = Math.min(160, Math.max(60, viewportSize.height - 244));
  const map = useMemo(() => {
    const minX = Math.min(...nodes.map((node) => node.x)) - 500;
    const minY = Math.min(...nodes.map((node) => node.y)) - 500;
    const maxX = Math.max(...nodes.map((node) => node.x + node.width)) + 500;
    const maxY = Math.max(...nodes.map((node) => node.y + node.height)) + 500;
    const worldWidth = Math.max(1, maxX - minX);
    const worldHeight = Math.max(1, maxY - minY);
    const scale = Math.min(width / worldWidth, height / worldHeight);
    return { minX, minY, scale, offsetX: (width - worldWidth * scale) / 2, offsetY: (height - worldHeight * scale) / 2 };
  }, [height, nodes, width]);

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
    <Card data-canvas-minimap className="absolute left-3 z-30 overflow-hidden gap-0 p-0" style={{ width, bottom: "var(--canvas-dock-clearance)" }}>
      <div className="flex h-8 items-center justify-between border-b border-border/70 px-2.5 text-[11px] font-medium">画布导航<Button variant="ghost" size="icon-sm" type="button" className="grid place-items-center" aria-label="关闭小地图" onClick={onClose}><X  /></Button></div>
      <div ref={containerRef} aria-label="拖动小地图定位画布" className={cn("relative touch-none", dragging ? "cursor-grabbing" : "cursor-grab")} style={{ height }} onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); navigate(event); }} onPointerMove={(event) => { if (dragging) navigate(event); }} onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)} onLostPointerCapture={() => setDragging(false)}>
        {nodes.map((node) => { const point = toMap(node.x, node.y); return <span key={node.id} className={cn("pointer-events-none absolute rounded-sm", node.type === "image" ? "bg-primary" : node.type === "video" ? "bg-orange-500" : node.type === "config" ? "bg-emerald-500" : "bg-amber-500")} style={{ left: point.x, top: point.y, width: Math.max(2, node.width * map.scale), height: Math.max(2, node.height * map.scale), opacity: .82 }} />; })}
        <span className="pointer-events-none absolute border border-primary bg-muted" style={{ left: viewportStart.x, top: viewportStart.y, width: Math.max(4, viewportEnd.x - viewportStart.x), height: Math.max(4, viewportEnd.y - viewportStart.y) }} />
      </div>
    </Card>
  );
}

function CanvasRightClickMenu({ triggerID, mediaNode, onInfo, onCopyContent, menu, onClose, onDuplicate, onDelete, onAddText, onAddImage, onAddVideo, onAddConfig, onPaste, onExportImage, onExportJSON, onImport, onClear }: {
  triggerID: string;
  mediaNode?: CanvasNode;
  onInfo: () => void;
  onCopyContent: () => void;
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
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [onClose]);

  return (
    <ContextMenuContent
      data-canvas-context-menu
      data-canvas-no-pan
      aria-label="画布右键菜单"
      collisionPadding={8}
      className="w-52 max-w-[calc(100vw-1rem)]"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {menu.type === "canvas" ? (
        <>
          <ContextMenuItem onSelect={onAddText}><Type />添加文字节点</ContextMenuItem>
          <ContextMenuItem onSelect={onAddImage}><ImagePlus />添加图片节点</ContextMenuItem>
          <ContextMenuItem onSelect={onAddVideo}><Video />添加视频生成节点</ContextMenuItem>
          <ContextMenuItem onSelect={onAddConfig}><Settings2 />添加生成配置节点</ContextMenuItem>
          <ContextMenuItem onSelect={onPaste}><Clipboard />粘贴节点</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onExportImage}><Download />导出画布图片</ContextMenuItem>
          <ContextMenuItem onSelect={onExportJSON}><FileDown />导出画布</ContextMenuItem>
          <ContextMenuItem onSelect={onImport}><FileUp />导入画布</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => { document.getElementById(triggerID)?.focus({ preventScroll: true }); onClear(); }}><Trash2 />清空当前画布</ContextMenuItem>
        </>
      ) : (
        <>
          {menu.type === "node" ? <>
            <ContextMenuItem onSelect={() => { document.getElementById(triggerID)?.focus({ preventScroll: true }); onInfo(); }}><Info />节点详情</ContextMenuItem>
            {(mediaNode?.type === "panorama" ? mediaNode.panorama_source_prompt || mediaNode.prompt : mediaNode?.prompt)?.trim() ? <ContextMenuItem onSelect={onCopyContent}><Clipboard />{mediaNode?.type === "text" ? "复制文字" : "复制提示词"}</ContextMenuItem> : null}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onDuplicate}><Copy />复制节点</ContextMenuItem>
          </> : null}
          <ContextMenuItem variant="destructive" onSelect={onDelete}><Trash2 />删除</ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

function CanvasNodeInfoContent({ node, configInputs }: { node: CanvasNode; configInputs: ReturnType<typeof canvasConfigInputs> }) {
  const [view, setView] = useState<"info" | "json">("info");
  useEffect(() => setView("info"), [node.id]);
  const json = useMemo(() => canvasNodeInfoJSON(node), [node]);
  const typeLabel = node.type === "image" ? "图片" : node.type === "video" ? "视频" : node.type === "audio" ? "音频" : node.type === "panorama" ? "全景图" : node.type === "director" ? "导演台" : node.type === "script" ? "脚本" : node.type === "config" ? "生成配置" : node.type === "group" ? "组" : "文字";
  const nodeIcon = node.type === "image" ? <ImagePlus /> : node.type === "video" ? <Video /> : node.type === "audio" ? <Music /> : node.type === "panorama" ? <Compass /> : node.type === "director" ? <Camera /> : node.type === "config" ? <Settings2 /> : node.type === "group" ? <Grid2X2 /> : <Type />;
  const statusLabel = node.generation_status ? canvasGenerationStatusLabel(node.generation_status) : "普通节点";
  return (
    <div className="space-y-5 pb-2">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-3">
        <p className="text-xs font-semibold text-muted-foreground">节点数据</p>
        <div className="flex p-1">
          <Button variant="ghost" size="sm"  onClick={() => setView("info")}>信息</Button>
          <Button variant="ghost" size="sm"  onClick={() => setView("json")}>JSON</Button>
        </div>
      </div>
      {view === "info" ? (
          <div className="space-y-5 text-sm">
            <div className="flex min-w-0 items-center gap-3">
              <ItemMedia variant="icon" className="grid size-10 shrink-0 place-items-center [&>svg]:size-4.5">{nodeIcon}</ItemMedia>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-foreground">{node.title || canvasNodeFallbackTitle(node.type)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{typeLabel} · {statusLabel}</p>
              </div>
              {node.generation_status ? <Badge variant="secondary" className="shrink-0">{statusLabel}</Badge> : null}
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
          <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden max-h-[min(60dvh,32rem)]" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0 text-xs leading-5 p-4"><CodeBlock><CodeBlockContent wrap>{json}</CodeBlockContent></CodeBlock></div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
        )}
    </div>
  );
}

function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return <section><h3 className="mb-1.5 text-[11px] font-semibold uppercase text-muted-foreground">{title}</h3><div className="divide-y divide-border/65 border-y border-border/65">{children}</div></section>;
}

function InfoRow({ label, value, mono = false, copyable = false }: { label: string; value: string; mono?: boolean; copyable?: boolean }) {
  return <div className="grid min-h-10 grid-cols-[76px_minmax(0,1fr)] items-start gap-3 py-2.5"><span className="text-xs leading-5 text-muted-foreground">{label}</span><span className="flex min-w-0 items-start gap-1.5"><span className={cn("min-w-0 flex-1 break-words leading-5", mono && "font-mono text-xs")}>{value}</span>{copyable ? <Tooltip><TooltipTrigger asChild><CodeBlockCopyButton size="icon-sm" className="shrink-0" aria-label={`复制${label}`} value={value} /></TooltipTrigger><TooltipContent>复制{label}</TooltipContent></Tooltip> : null}</span></div>;
}

function formatCanvasFileBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
