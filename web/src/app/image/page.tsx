"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowDownToLine, ChevronDown, Globe2, History, ImagePlus, LoaderCircle, Minus, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  ImageAspectRatioOptionButton,
  ImageParameterLabel,
} from "@/app/image/components/image-parameter-ui";
import { imageParameterChoiceClass } from "@/app/image/components/image-parameter-styles";
import { ImagePromptMarket } from "@/app/image/components/image-prompt-market";
import {
  imageConversationHistoryGenerationChanged,
  maxImageConversationHistoryGeneration,
  shouldFallbackToImageConversationHistoryDetail,
  shouldResetImageConversationHistoryCursor,
} from "@/app/image/image-history-pagination";
import { ImageResults, type ImageLightboxItem } from "@/app/image/components/image-results";
import type { BananaPrompt } from "@/app/image/banana-prompts";
import {
  CUSTOM_IMAGE_ASPECT_RATIO,
  DEFAULT_IMAGE_CUSTOM_HEIGHT,
  DEFAULT_IMAGE_CUSTOM_RATIO,
  DEFAULT_IMAGE_CUSTOM_WIDTH,
  GEMINI_IMAGE_RESOLUTION_OPTIONS,
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  IMAGE_RESOLUTION_OPTIONS,
  XAI_IMAGE_RESOLUTION_OPTIONS,
  buildImageSize,
  formatImageSizeDisplay,
  getActiveImageAspectRatio,
  getImageSizeSelectionFromSize,
  getImageSizeRequirementLabel,
  isHighResolutionImageSize,
  isImageAspectRatio,
  isImageResolution,
  isImageSizeMode,
  parseImageSizeDimensions,
  parseImageRatio,
  type ImageAspectRatio,
  type ImageResolution,
  type ImageSizeMode,
  type ImageSizeSelection,
} from "@/app/image/image-options";
import { IMAGE_PROMPT_PRESETS, type ImagePromptPreset } from "@/app/image/image-presets";
import { consumeSimilarImageIntent } from "@/app/image/similar-image-intent";
import { ImageSidebar } from "@/app/image/components/image-sidebar";
import { ImageLightbox } from "@/components/image-lightbox";
import { AuthenticatedImage } from "@/components/authenticated-image";
import {
  RelayTokenRequiredDialog,
  type RelayTokenCreationKind,
} from "@/components/relay-token-required-dialog";
import {
  canStartImageConversationQueueRunner,
  canDispatchImageTurn,
  effectiveTaskSlotStatus,
  effectiveTaskOutputStatus,
  hasFinalTaskOutput,
  isTaskActive,
  mergeCreationTaskList,
  mergeCreationTaskSnapshot,
  mergeImageConversationLists,
  mergeImageConversationSnapshot,
  nextImageConversationRevision,
  taskImageHasPreview,
} from "@/app/image/image-task-state";
import { Button } from "@/components/ui/button";
import { supportsVideoMultimodalReferences, videoAudioControl, videoMultimodalReferenceLimits, videoReferenceImageLimit, videoRequiresReferenceImage, videoResolutionOptions, videoSecondsOptions, videoSizeOptions } from "@/lib/video-model-capabilities";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  cancelCreationTask,
  createImageEditTask,
  createImageGenerationTask,
  createVideoGenerationTask,
  uploadVideoReference,
  fetchProfileRelayKey,
  DEFAULT_IMAGE_MODEL,
  fetchCreationTasks,
  fetchModelConfig,
  imageOutputCountLimit,
  imageReferenceImageLimit,
  imageModelRoute,
  IMAGE_CREATION_MODEL_OPTIONS,
  IMAGE_OUTPUT_FORMAT_OPTIONS,
  PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT,
  isImageCreationModel,
  isImageModel,
  isImageOutputFormat,
  isImageQuality,
  modelOptionsFromNames,
  supportsImageEditing,
  supportsImageExactDimensions,
  supportsImageAspectRatio,
  supportsImageOutputCompression,
  supportsImageOutputControls,
  supportsImageQuality,
  supportsImageQualityValue,
  supportsImageResolution,
  supportsImageSize,
  supportsImageStreaming,
  supportsStructuredImageParameters,
  uploadImageConversationAssets,
  updateManagedImageVisibility,
  type ImageModel,
  type ImageModelOption,
  type ImageOutputFormat,
  type ImageQuality,
  type CreationTask,
  type CreationTaskRequestOptions,
  type CreationTaskMessage,
  type FallbackReferenceImage,
  type ImageQualityCheck,
  type ImageVisibility,
} from "@/lib/api";
import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";
import { imageSourceToFile } from "@/lib/image-source-file";
import {
  imageConversationReferenceLimitMessage,
  isImageConversationAssetURL,
} from "@/lib/image-conversation-assets";
import { clearImageManagerCache } from "@/lib/image-manager-cache";
import { getManagedImagePathFromUrl, getManagedImageUrlFromPath } from "@/lib/image-path";
import { isPublicReferenceURL } from "@/lib/public-reference-url";
import { clearStoredRelayApiKey } from "@/lib/relay-key";
import {
  getStoredRelayTokenName,
  relayTokenNameStorageKey,
  retainSelectedRelayTokenName,
  type RelayTokenKind,
} from "@/lib/relay-token-selection";
import { AUTH_SESSION_CHANGE_EVENT, getCachedAuthSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { hasAPIPermission, type StoredAuthSession } from "@/store/auth";
import { imageConversationOwnerScope } from "@/store/image-conversation-session-scope";
import {
  ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY,
  clearImageConversations,
  deleteImageConversation,
  discardFailedImageConversationSave,
  getEffectiveImageTurnStatus,
  getImageConversationStats,
  getImageTurnLoadingCounts,
  getImageConversation,
  isImageConversationHistorySummaryOnly,
  IMAGE_ACTIVE_CONVERSATION_REQUEST_EVENT,
  IMAGE_CONVERSATIONS_CHANGED_EVENT,
  listImageConversationPage,
  loadImageConversationHistoryWindow,
  mergeImageConversationItems,
  saveImageConversation,
  saveImageConversationCoalesced,
  flushImageConversationSaves,
  type ImageConversation,
  type ImageConversationMode,
  type ImageTurn,
  type ImageTurnStatus,
  type StoredImageSizeSelection,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";
import {
  clearImageTurnProgress,
  getImageTurnProgressSnapshot,
  imageTurnStartedAtTimestamp,
  imageTurnProgressKey,
  setImageTurnProgress,
  subscribeImageTurnProgress,
  type ImageTurnProgress,
} from "@/store/image-turn-progress";

const COMPOSER_MODE_STORAGE_KEY = "chatgpt2api:image_composer_mode";
const IMAGE_MODEL_STORAGE_KEY = "chatgpt2api:image_last_model";
const IMAGE_SIZE_STORAGE_KEY = "chatgpt2api:image_last_size";
const IMAGE_SIZE_MODE_STORAGE_KEY = "chatgpt2api:image_last_size_mode";
const IMAGE_ASPECT_RATIO_STORAGE_KEY = "chatgpt2api:image_last_aspect_ratio";
const IMAGE_RESOLUTION_STORAGE_KEY = "chatgpt2api:image_last_resolution";
const IMAGE_CUSTOM_RATIO_STORAGE_KEY = "chatgpt2api:image_last_custom_ratio";
const IMAGE_CUSTOM_WIDTH_STORAGE_KEY = "chatgpt2api:image_last_custom_width";
const IMAGE_CUSTOM_HEIGHT_STORAGE_KEY = "chatgpt2api:image_last_custom_height";
const IMAGE_QUALITY_STORAGE_KEY = "chatgpt2api:image_last_quality";
const IMAGE_OUTPUT_FORMAT_STORAGE_KEY = "chatgpt2api:image_last_output_format";
const IMAGE_OUTPUT_COMPRESSION_STORAGE_KEY = "chatgpt2api:image_last_output_compression";
const IMAGE_STREAM_STORAGE_KEY = "chatgpt2api:image_last_stream_v3";
const IMAGE_PARTIAL_IMAGES_STORAGE_KEY = "chatgpt2api:image_last_partial_images";
const VIDEO_MODEL_STORAGE_KEY = "chatgpt2api:video_last_model";
const VIDEO_SIZE_STORAGE_KEY = "chatgpt2api:video_last_size";
const VIDEO_SECONDS_STORAGE_KEY = "chatgpt2api:video_last_seconds";
const VIDEO_RESOLUTION_STORAGE_KEY = "chatgpt2api:video_last_resolution";
const VIDEO_AUDIO_STORAGE_KEY = "chatgpt2api:video_last_audio";
const VIDEO_WATERMARK_STORAGE_KEY = "chatgpt2api:video_last_watermark";
const NEWAPI_TOKEN_MISSING_MESSAGE = "请先在云棉为当前用户创建可用令牌";
const DEFAULT_IMAGE_OUTPUT_FORMAT: ImageOutputFormat = "png";
const MISSING_RECOVERABLE_TASK_ID_ERROR = "页面刷新或任务中断，未找到可恢复的任务 ID";
const RESULTS_BOTTOM_STICKY_THRESHOLD = 96;
const IMAGE_HISTORY_PAGE_SIZE = 24;
const CREATION_TASK_POLL_MAX_DURATION_MS = 8 * 60 * 1000;
const CREATION_TASK_POLL_MAX_ERROR_RETRIES = 8;
const CREATION_TASK_POLL_MAX_RETRY_DELAY_MS = 10_000;

class ImageTaskDispatchAbortedError extends Error {
  constructor() {
    super("图片任务提交已取消");
    this.name = "ImageTaskDispatchAbortedError";
  }
}

async function runExclusiveImageConversationMutation<T>(
  mutations: Map<string, Promise<void>>,
  conversationId: string,
  operation: () => Promise<T>,
) {
  const previous = mutations.get(conversationId);
  let releaseMutation: () => void = () => {};
  const mutation = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  mutations.set(conversationId, mutation);
  if (previous) {
    await previous;
  }
  try {
    return await operation();
  } finally {
    releaseMutation();
    if (mutations.get(conversationId) === mutation) {
      mutations.delete(conversationId);
    }
  }
}

type ComposerMode = "chat" | "image" | "video";

type VideoReferenceMode = "first-frame" | "reference";

function cleanReferenceURLs(values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean);
}

type EditingTurnDraft = {
  conversationId: string;
  turnId: string;
  prompt: string;
  model: ImageModel;
  mode: ImageConversationMode;
  count: string;
  sizeMode: ImageSizeMode;
  aspectRatio: ImageAspectRatio;
  resolution: ImageResolution;
  customRatio: string;
  customWidth: string;
  customHeight: string;
  quality: "" | ImageQuality;
  outputFormat: ImageOutputFormat;
  outputCompression: string;
  stream: boolean;
  partialImages: string;
  tokenGroup: string;
  tokenName: string;
  visibility: ImageVisibility;
  referenceImages: StoredReferenceImage[];
};

type PublishImageTarget = {
  conversationId: string;
  turnId: string;
  imageIndex: number;
};

type PublishRecipeOptions = {
  sharePromptParameters: boolean;
  shareReferenceImages: boolean;
};

type CreationTaskDataItem = NonNullable<CreationTask["data"]>[number];

function buildConversationTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 12)}...`;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isNearResultsBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= RESULTS_BOTTOM_STICKY_THRESHOLD;
}

async function dataUrlToFile(dataUrl: string, fileName: string, mimeType?: string) {
  return imageSourceToFile(dataUrl, fileName, mimeType, fetchAuthenticatedImageBlob);
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

function imageFileExtensionForOutputFormat(format?: ImageOutputFormat) {
  return format === "jpeg" ? "jpg" : format || "png";
}

function imageMimeTypeForOutputFormat(format?: ImageOutputFormat) {
  return format === "jpeg" ? "image/jpeg" : `image/${format || "png"}`;
}

async function fetchImageAsFile(url: string, fileName: string) {
  return dataUrlToFile(url, fileName);
}

async function uploadReferenceFiles(
  files: readonly File[],
  source: StoredReferenceImage["source"] = "upload",
): Promise<StoredReferenceImage[]> {
  const assets = await uploadImageConversationAssets(files);
  return assets.map((asset) => ({
    name: asset.name,
    type: asset.type,
    dataUrl: asset.dataUrl || asset.url,
    ...(asset.assetPath ? { assetPath: asset.assetPath } : {}),
    ...(asset.size === undefined ? {} : { size: asset.size }),
    ...(source ? { source } : {}),
  }));
}

function buildReferenceFileName(url: string, index: number, fallbackPrefix: string) {
  const path = url.split(/[?#]/, 1)[0] || "";
  const rawName = path.split("/").filter(Boolean).pop() || "";
  let name = rawName;
  try {
    name = rawName ? decodeURIComponent(rawName) : "";
  } catch {
    name = rawName;
  }
  if (name) {
    return name.includes(".") ? name : `${name}.png`;
  }
  return `${fallbackPrefix}-${index + 1}.png`;
}

async function buildReferenceImagesFromUrls(
  urls: readonly string[],
  fallbackPrefix: string,
): Promise<StoredReferenceImage[]> {
  const files = await Promise.all(
    urls.map((url, index) => fetchImageAsFile(url, buildReferenceFileName(url, index, fallbackPrefix))),
  );
  return uploadReferenceFiles(files);
}

function getPromptReferenceImageUrls(prompt: BananaPrompt) {
  const urls = prompt.referenceImageUrls.length > 0 ? prompt.referenceImageUrls : [prompt.preview];
  return Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)));
}

function reusableOutputCompressionValue(value: unknown, outputFormat: ImageOutputFormat) {
  if (!supportsImageOutputCompression(outputFormat)) {
    return "";
  }
  const compression = Number(value);
  if (!Number.isFinite(compression)) {
    return "";
  }
  return String(Math.min(100, Math.max(0, Math.round(compression))));
}

async function buildReferenceImageFromStoredImage(image: StoredImage, fileName: string) {
  const mimeType = imageMimeTypeForOutputFormat(image.outputFormat);
  const source = image.b64_json
    ? `data:${mimeType};base64,${image.b64_json}`
    : image.path
      ? getManagedImageUrlFromPath(image.path)
      : image.url;
  if (!source) {
    return null;
  }
  const file = await dataUrlToFile(source, fileName, mimeType);
  return (await uploadReferenceFiles([file], "conversation"))[0] || null;
}

async function ensureReferenceImageAsset(
  image: StoredReferenceImage,
  source: StoredReferenceImage["source"],
) {
  if (image.assetPath || isImageConversationAssetURL(image.dataUrl)) {
    return { ...image, source };
  }
  const file = await dataUrlToFile(image.dataUrl, image.name, image.type);
  return (await uploadReferenceFiles([file], source))[0] || null;
}

function normalizeRequestedImageCount(value: string | number, model: ImageModel) {
  return Math.max(1, Math.min(imageOutputCountLimit(model), Math.floor(Number(value) || 1)));
}

function isInvalidCustomRatioSelection(sizeMode: ImageSizeMode, aspectRatio: ImageAspectRatio, customRatio: string) {
  return sizeMode === "ratio" && aspectRatio === CUSTOM_IMAGE_ASPECT_RATIO && !parseImageRatio(customRatio);
}

function effectiveImageSizeSelection(model: ImageModel, selection: ImageSizeSelection): ImageSizeSelection {
  if (!supportsImageSize(model)) {
    return {
      ...selection,
      mode: "auto",
      aspectRatio: "",
      resolution: "auto",
    };
  }
  if (selection.mode === "ratio" && !supportsImageAspectRatio(model, selection.aspectRatio)) {
    return {
      ...selection,
      mode: "auto",
      aspectRatio: "",
      resolution: "auto",
    };
  }
  if (selection.mode === "custom" && !supportsImageExactDimensions(model)) {
    return {
      ...selection,
      mode: "auto",
      resolution: "auto",
    };
  }
  if (supportsStructuredImageParameters(model)) {
    return supportsImageResolution(model, selection.resolution)
      ? selection
      : { ...selection, resolution: "auto" };
  }
  if (selection.mode !== "ratio") {
    return {
      ...selection,
      mode: "auto",
      resolution: "auto",
    };
  }
  return {
    ...selection,
    resolution: "auto",
  };
}

function buildEffectiveImageSizeRequest(model: ImageModel, selection: ImageSizeSelection) {
  const effectiveSelection = effectiveImageSizeSelection(model, selection);
  const requestedSize = buildImageSize(effectiveSelection, {
    preserveAspectRatio: imageModelRoute(model) !== "openai-image",
  });
  return {
    selection: effectiveSelection,
    size: requestedSize,
    upstreamSize: requestedSize,
  };
}

function applyNormalizedCustomImageSize(selection: ImageSizeSelection, normalizedSize: string): ImageSizeSelection {
  if (selection.mode !== "custom") {
    return selection;
  }
  const dimensions = parseImageSizeDimensions(normalizedSize);
  if (!dimensions) {
    return selection;
  }
  return {
    ...selection,
    customWidth: dimensions.width,
    customHeight: dimensions.height,
  };
}

function customImageSizeChanged(selection: ImageSizeSelection, normalizedSize: string) {
  if (selection.mode !== "custom") {
    return false;
  }
  const dimensions = parseImageSizeDimensions(normalizedSize);
  return Boolean(
    dimensions &&
      (String(Number(selection.customWidth)) !== dimensions.width ||
        String(Number(selection.customHeight)) !== dimensions.height),
  );
}

function imageOutputFormatForModel(model: ImageModel, format: ImageOutputFormat) {
  return supportsImageOutputControls(model) ? format : undefined;
}

function imageOutputCompressionForModel(model: ImageModel, format: ImageOutputFormat, value: unknown) {
  if (!supportsImageOutputControls(model)) {
    return undefined;
  }
  return imageOutputCompressionForFormat(format, value);
}

function positiveDimension(value: unknown) {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? Math.round(dimension) : undefined;
}

function normalizeOutputCompressionValue(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }
  return Math.min(100, Math.round(numeric));
}

function imageOutputCompressionForFormat(format: ImageOutputFormat, value: unknown) {
  if (!supportsImageOutputCompression(format)) {
    return undefined;
  }
  return normalizeOutputCompressionValue(value);
}

function imageQualityForRequest(model: ImageModel, value: "" | ImageQuality): ImageQuality | undefined {
  return isImageQuality(value) && supportsImageQualityValue(model, value) ? value : undefined;
}

function normalizeImagePartialImages(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(3, Math.round(numeric)));
}

function formatHighResolutionHint() {
  return "高分辨率会作为目标尺寸记录，实际像素以生成结果为准。";
}

function imageTaskProgressMessage(turn: ImageTurn, elapsedSeconds = 0) {
  if (turn.status === "queued") {
    return {
      message: "等待任务开始",
      detail: "图片任务已入队，等待开始处理",
    };
  }

  const isHighResolution =
    supportsStructuredImageParameters(turn.model) && isHighResolutionImageSize(turn.size, turn.sizeSelection);
  void elapsedSeconds;
  if (isHighResolution) {
    return {
      message: "高分辨率生成中",
      detail: `${getImageSizeRequirementLabel(turn.size, turn.sizeSelection)}目标已记录，正在等待生成结果`,
    };
  }
  return {
    message: "正在生成图片",
    detail: "后端正在轮询任务状态",
  };
}

function imageTaskLoadingDetail(turn: ImageTurn, fallbackDetail: string) {
  const counts = getImageTurnLoadingCounts(turn);
  if (counts.running > 0) {
    return `${fallbackDetail}；还有 ${counts.running} 张图片处理中`;
  }
  if (counts.queued > 0) {
    return `${fallbackDetail}；还有 ${counts.queued} 张图片排队中`;
  }
  return "图片结果已返回，正在确认任务状态";
}

function imageTaskBatchId(turnId: string, imageIndex: number, model: ImageModel) {
  return `${turnId}-task-${Math.floor(imageIndex / imageOutputCountLimit(model))}`;
}

function imageTaskIdForImage(turnId: string, model: ImageModel, images: StoredImage[], imageIndex: number) {
  return images[imageIndex]?.taskId || imageTaskBatchId(turnId, imageIndex, model);
}

function imageDataIndexForTask(images: StoredImage[], imageIndex: number) {
  const taskId = images[imageIndex]?.taskId || images[imageIndex]?.id;
  if (!taskId) {
    return 0;
  }
  return images.slice(0, imageIndex + 1).filter((image) => (image.taskId || image.id) === taskId).length - 1;
}

const STORED_IMAGE_FIELDS: Array<keyof StoredImage> = [
  "id",
  "taskId",
  "taskRevision",
  "taskStatus",
  "status",
  "path",
  "visibility",
  "b64_json",
  "url",
  "mediaType",
  "videoUrl",
  "mimeType",
  "width",
  "height",
  "resolution",
  "outputFormat",
  "qualityCheck",
  "taskCreatedAt",
  "taskUpdatedAt",
  "generationDurationMs",
  "revised_prompt",
  "error",
  "text_response",
];

function updateStoredImage(image: StoredImage, updates: Partial<StoredImage>): StoredImage {
  const next = { ...image, ...updates };
  return STORED_IMAGE_FIELDS.every((field) => image[field] === next[field]) ? image : next;
}

function normalizeImageQualityCheck(value: unknown): ImageQualityCheck | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const warnings = Array.isArray(source.warnings)
    ? source.warnings.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const normalized = {
    requested_size: typeof source.requested_size === "string" ? source.requested_size : undefined,
    actual_size: typeof source.actual_size === "string" ? source.actual_size : undefined,
    size_matched: typeof source.size_matched === "boolean" ? source.size_matched : undefined,
    requested_output_format: typeof source.requested_output_format === "string" ? source.requested_output_format : undefined,
    actual_output_format: typeof source.actual_output_format === "string" ? source.actual_output_format : undefined,
    output_format_matched: typeof source.output_format_matched === "boolean" ? source.output_format_matched : undefined,
    warnings,
  };
  if (
    !normalized.requested_size &&
    !normalized.actual_size &&
    normalized.size_matched === undefined &&
    !normalized.requested_output_format &&
    !normalized.actual_output_format &&
    normalized.output_format_matched === undefined &&
    warnings.length === 0
  ) {
    return undefined;
  }
  return normalized;
}

function storedImageVisibilityPath(image: StoredImage) {
  if (image.path?.trim()) {
    return image.path.trim();
  }
  if (image.url?.trim()) {
    const managedPath = getManagedImagePathFromUrl(image.url);
    if (managedPath) {
      return managedPath;
    }
    const url = image.url.trim();
    if (/^https?:\/\//i.test(url) || /^data:image\/[^,]+;base64,/i.test(url)) {
      return url;
    }
  }
  if (image.b64_json?.trim()) {
    const format = image.outputFormat === "jpeg" || image.outputFormat === "webp" ? image.outputFormat : "png";
    return `data:image/${format};base64,${image.b64_json.trim()}`;
  }
  return "";
}

function creationTaskImageStatus(task: CreationTask, dataIndex = 0): "queued" | "running" | "success" | "error" | "cancelled" | undefined {
  const outputStatus = task.output_statuses?.[dataIndex];
  if (task.status === "queued" || task.status === "running" || task.status === "success" || task.status === "error" || task.status === "cancelled") {
    const outputCount = task.output_statuses?.length;
    return effectiveTaskOutputStatus(task.status, outputStatus, outputCount);
  }
  return undefined;
}

function parseCreationTaskTime(value: string | undefined) {
  const text = String(value || "").trim();
  if (!text) {
    return Number.NaN;
  }
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) {
    return direct;
  }
  return Date.parse(text.replace(" ", "T"));
}

function creationTaskTimingUpdates(task: CreationTask, completed: boolean): Partial<StoredImage> {
  const updates: Partial<StoredImage> = {
    taskCreatedAt: task.created_at,
    taskUpdatedAt: task.updated_at,
  };
  if (!completed) {
    updates.generationDurationMs = undefined;
    return updates;
  }
  const started = parseCreationTaskTime(task.created_at);
  const ended = parseCreationTaskTime(task.updated_at);
  updates.generationDurationMs =
    Number.isFinite(started) && Number.isFinite(ended) && ended >= started
      ? ended - started
      : undefined;
  return updates;
}

function taskDataToStoredImage(image: StoredImage, task: CreationTask, dataIndex = 0, fallbackVisibility?: ImageVisibility): StoredImage {
  const taskVisibility = task.visibility || fallbackVisibility || image.visibility || "private";
  const activeTiming = creationTaskTimingUpdates(task, false);
  const finalTiming = creationTaskTimingUpdates(task, true);
  const taskRevision = Number(task.revision);
  const normalizedTaskRevision = Number.isSafeInteger(taskRevision) && taskRevision > 0 ? taskRevision : image.taskRevision;
  const sameTask = image.taskId === task.id;
  const imageIsTerminal = image.status === "success" || image.status === "error" || image.status === "cancelled" || image.status === "message";
  if (
    sameTask &&
    isTaskActive(task.status) &&
    imageIsTerminal
  ) {
    return image;
  }
  if (
    sameTask &&
    isTaskActive(task.status) &&
    image.taskRevision !== undefined &&
    normalizedTaskRevision !== undefined &&
    image.taskRevision > normalizedTaskRevision
  ) {
    return image;
  }
  const successUpdates = (item: CreationTaskDataItem) => {
    const width = positiveDimension(item.width);
    const height = positiveDimension(item.height);
    const videoUrl = String(item.video_url || (item.type === "video" ? item.url || "" : "")).trim() || undefined;
    const isVideo = task.mode === "video" || item.type === "video" || Boolean(videoUrl) || item.mime_type?.startsWith("video/");
    return {
      taskId: task.id,
      taskRevision: normalizedTaskRevision,
      ...finalTiming,
      taskStatus: "success" as const,
      status: "success" as const,
      b64_json: item.b64_json,
      url: isVideo ? videoUrl || item.url : item.url,
      mediaType: isVideo ? "video" as const : "image" as const,
      videoUrl: isVideo ? videoUrl || item.url : undefined,
      mimeType: isVideo ? item.mime_type || "video/mp4" : undefined,
      path: !isVideo && item.url ? getManagedImagePathFromUrl(item.url) || image.path : image.path,
      visibility: taskVisibility,
      width,
      height,
      resolution: item.resolution || (width && height ? `${width}x${height}` : image.resolution),
      outputFormat: item.output_format || task.output_format || image.outputFormat,
      qualityCheck: normalizeImageQualityCheck(item.quality_check),
      revised_prompt: item.revised_prompt,
      text_response: undefined,
      error: undefined,
    };
  };
  if (task.status === "success") {
    if (task.output_type === "text") {
      return updateStoredImage(image, {
        taskId: task.id,
        taskRevision: normalizedTaskRevision,
        ...finalTiming,
        taskStatus: "success",
        status: "message",
        text_response: task.data?.[dataIndex]?.text_response || task.error || "",
        b64_json: undefined,
        url: undefined,
        path: undefined,
        visibility: undefined,
        revised_prompt: undefined,
        error: undefined,
      });
    }
    const item = task.data?.[dataIndex];
    if (!hasFinalTaskOutput(item)) {
      const slotStatus = creationTaskImageStatus(task, dataIndex);
      if (slotStatus === "error" || slotStatus === "cancelled") {
        return updateStoredImage(image, {
          taskId: task.id,
          taskRevision: normalizedTaskRevision,
          ...finalTiming,
          taskStatus: slotStatus,
          status: slotStatus === "cancelled" ? "cancelled" : "error",
          error: slotStatus === "cancelled" ? task.error || "任务已终止" : task.error || "生成失败",
        });
      }
      if (dataIndex > 0 && image.taskId !== image.id) {
        return updateStoredImage(image, {
          taskId: task.id,
          taskRevision: normalizedTaskRevision,
          ...finalTiming,
          taskStatus: "success",
          status: "error",
          error: `未返回第 ${dataIndex + 1} 张图片数据`,
        });
      }
      return updateStoredImage(image, {
        taskId: task.id,
        taskRevision: normalizedTaskRevision,
        ...finalTiming,
        taskStatus: "success",
        status: "error",
        error: `未返回第 ${dataIndex + 1} 张图片数据`,
      });
    }
    return updateStoredImage(image, successUpdates(item));
  }

  if (task.status === "queued" || task.status === "running") {
    const item = task.data?.[dataIndex];
    const slotStatus = effectiveTaskSlotStatus(
      task.status,
      task.output_statuses?.[dataIndex],
      item,
      task.output_statuses?.length,
    );
    if (slotStatus === "error" || slotStatus === "cancelled") {
      const error = slotStatus === "cancelled"
        ? task.error || "任务已终止"
        : task.error || "生成失败";
      return updateStoredImage(image, {
        ...(item && (item.b64_json || item.url || item.video_url) ? successUpdates(item) : {}),
        taskId: task.id,
        taskRevision: normalizedTaskRevision,
        ...finalTiming,
        taskStatus: slotStatus,
        status: slotStatus,
        text_response: undefined,
        error,
      });
    }
    if (slotStatus === "success" && hasFinalTaskOutput(item)) {
      if (task.output_type === "text") {
        return updateStoredImage(image, {
          taskId: task.id,
          taskRevision: normalizedTaskRevision,
          ...finalTiming,
          taskStatus: "success",
          status: "message",
          text_response: item?.text_response || "",
          b64_json: undefined,
          url: undefined,
          path: undefined,
          visibility: undefined,
          revised_prompt: undefined,
          error: undefined,
        });
      }
      return updateStoredImage(image, successUpdates(item));
    }
    const activeTaskStatus = slotStatus === "queued" ? "queued" : "running";
    if (task.output_type === "text" && item?.text_response) {
      return updateStoredImage(image, {
        taskId: task.id,
        taskRevision: normalizedTaskRevision,
        ...activeTiming,
        taskStatus: activeTaskStatus,
        status: "loading",
        text_response: item.text_response,
        b64_json: undefined,
        url: undefined,
        path: undefined,
        visibility: undefined,
        revised_prompt: undefined,
        error: undefined,
      });
    }
    if (item?.b64_json || item?.url || item?.video_url) {
      return updateStoredImage(image, {
        ...successUpdates(item),
        ...activeTiming,
        taskRevision: normalizedTaskRevision,
        taskStatus: activeTaskStatus,
        status: "loading",
      });
    }
    const preview = taskImageHasPreview(image);
    return updateStoredImage(image, {
      taskId: task.id,
      taskRevision: normalizedTaskRevision,
      ...activeTiming,
      taskStatus: activeTaskStatus,
      status: "loading",
      ...(preview ? {} : { b64_json: undefined, url: undefined, path: undefined }),
      text_response: undefined,
      error: undefined,
    });
  }

  if (task.status === "error") {
    if (task.output_type === "text") {
      return updateStoredImage(image, {
        taskId: task.id,
        taskRevision: normalizedTaskRevision,
        ...finalTiming,
        taskStatus: "success",
        status: "message",
        text_response: task.error || "",
        b64_json: undefined,
        url: undefined,
        path: undefined,
        visibility: undefined,
        revised_prompt: undefined,
        error: undefined,
      });
    }
    const item = task.data?.[dataIndex];
    const slotStatus = creationTaskImageStatus(task, dataIndex);
    const error = task.error || "生成失败";
    if (hasFinalTaskOutput(item)) {
      return updateStoredImage(image, {
        ...successUpdates(item),
        ...(slotStatus === "success"
          ? {}
          : { taskStatus: "error" as const, status: "error" as const, error }),
      });
    }
    if (taskImageHasPreview(image)) {
      return updateStoredImage(image, {
        ...image,
        taskId: task.id,
        taskRevision: normalizedTaskRevision,
        ...finalTiming,
        taskStatus: "error",
        status: "error",
        error,
      });
    }
    return updateStoredImage(image, {
      taskId: task.id,
      taskRevision: normalizedTaskRevision,
      ...finalTiming,
      taskStatus: "error",
      status: "error",
      text_response: undefined,
      error,
    });
  }

  if (task.status === "cancelled") {
    const item = task.data?.[dataIndex];
    const slotStatus = creationTaskImageStatus(task, dataIndex);
    if (hasFinalTaskOutput(item)) {
      return updateStoredImage(image, {
        ...successUpdates(item),
        ...(slotStatus === "success"
          ? {}
          : {
              taskStatus: "cancelled" as const,
              status: "cancelled" as const,
              error: task.error || "任务已终止",
            }),
      });
    }
    if (taskImageHasPreview(image)) {
      return updateStoredImage(image, {
        ...image,
        taskId: task.id,
        taskRevision: normalizedTaskRevision,
        ...finalTiming,
        taskStatus: "cancelled",
        status: "cancelled",
        error: task.error || "任务已终止",
      });
    }
    return updateStoredImage(image, {
      taskId: task.id,
      taskRevision: normalizedTaskRevision,
      ...finalTiming,
      taskStatus: "cancelled",
      status: "cancelled",
      error: task.error || "任务已终止",
    });
  }

  return updateStoredImage(image, {
    taskId: task.id,
    taskRevision: normalizedTaskRevision,
    ...activeTiming,
    taskStatus: creationTaskImageStatus(task, dataIndex) || "queued",
    status: "loading",
    text_response: undefined,
    error: undefined,
  });
}

function isActiveCreationTask(task: CreationTask) {
  return task.status === "queued" || task.status === "running";
}

function isRetryableTaskPollError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
  if (!Number.isFinite(status)) {
    return true;
  }
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function pickFallbackConversationId(conversations: ImageConversation[]) {
  const activeConversation = conversations.find((conversation) => {
    const stats = getImageConversationStats(conversation);
    return stats.queued > 0 || stats.running > 0;
  });
  return activeConversation?.id ?? conversations[0]?.id ?? null;
}

function sortImageConversations(conversations: ImageConversation[]) {
  return [...conversations].sort((a, b) => {
    const updated = b.updatedAt.localeCompare(a.updatedAt);
    return updated !== 0 ? updated : b.id.localeCompare(a.id);
  });
}

function getStoredImageModel(): ImageModel {
  if (typeof window === "undefined") {
    return DEFAULT_IMAGE_MODEL;
  }
  const storedModel = window.localStorage.getItem(IMAGE_MODEL_STORAGE_KEY);
  if (storedModel === "auto") {
    return DEFAULT_IMAGE_MODEL;
  }
  return isImageModel(storedModel) ? storedModel : DEFAULT_IMAGE_MODEL;
}

function getStoredComposerMode(): ComposerMode {
  if (typeof window === "undefined") {
    return "image";
  }
  return window.localStorage.getItem(COMPOSER_MODE_STORAGE_KEY) === "video" ? "video" : "image";
}

function getStoredVideoSetting(key: string, fallback: string) {
  if (typeof window === "undefined") {
    return fallback;
  }
  return window.localStorage.getItem(key) || fallback;
}

function getStoredImageSizeSelection(): ImageSizeSelection {
  if (typeof window === "undefined") {
    return getImageSizeSelectionFromSize("");
  }
  const fallbackSelection = getImageSizeSelectionFromSize(window.localStorage.getItem(IMAGE_SIZE_STORAGE_KEY) || "");
  const storedSizeMode = window.localStorage.getItem(IMAGE_SIZE_MODE_STORAGE_KEY);
  const storedAspectRatio = window.localStorage.getItem(IMAGE_ASPECT_RATIO_STORAGE_KEY) || "";
  const storedResolution = window.localStorage.getItem(IMAGE_RESOLUTION_STORAGE_KEY);
  const customRatio = window.localStorage.getItem(IMAGE_CUSTOM_RATIO_STORAGE_KEY) || fallbackSelection.customRatio;
  const customWidth = window.localStorage.getItem(IMAGE_CUSTOM_WIDTH_STORAGE_KEY) || fallbackSelection.customWidth;
  const customHeight = window.localStorage.getItem(IMAGE_CUSTOM_HEIGHT_STORAGE_KEY) || fallbackSelection.customHeight;
  if (isImageSizeMode(storedSizeMode) && isImageAspectRatio(storedAspectRatio) && isImageResolution(storedResolution)) {
    return {
      mode: storedSizeMode,
      aspectRatio: storedAspectRatio,
      resolution: storedResolution,
      customRatio,
      customWidth,
      customHeight,
    };
  }
  return fallbackSelection;
}

function getStoredImageOutputFormat(): ImageOutputFormat {
  if (typeof window === "undefined") {
    return DEFAULT_IMAGE_OUTPUT_FORMAT;
  }
  const storedFormat = window.localStorage.getItem(IMAGE_OUTPUT_FORMAT_STORAGE_KEY);
  return isImageOutputFormat(storedFormat) ? storedFormat : DEFAULT_IMAGE_OUTPUT_FORMAT;
}

function getStoredImageQuality(): "" | ImageQuality {
  if (typeof window === "undefined") {
    return "";
  }
  const storedQuality = window.localStorage.getItem(IMAGE_QUALITY_STORAGE_KEY);
  return isImageQuality(storedQuality) ? storedQuality : "";
}

function getStoredImageOutputCompression(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const normalized = normalizeOutputCompressionValue(window.localStorage.getItem(IMAGE_OUTPUT_COMPRESSION_STORAGE_KEY));
  return normalized === undefined ? "" : String(normalized);
}

function getStoredImageStreamEnabled() {
  if (typeof window === "undefined") {
    return false;
  }
  const stored = window.localStorage.getItem(IMAGE_STREAM_STORAGE_KEY);
  return stored === "true";
}

function getStoredImagePartialImages() {
  if (typeof window === "undefined") {
    return "0";
  }
  return String(normalizeImagePartialImages(window.localStorage.getItem(IMAGE_PARTIAL_IMAGES_STORAGE_KEY)));
}

function normalizeRelayTokenNames(values: unknown) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((name) => String(name || "").trim()).filter(Boolean)))
    : [];
}

function ensureModelOption(options: ReadonlyArray<ImageModelOption>, model: ImageModel): ImageModelOption[] {
  if (!model || options.some((option) => option.value === model)) {
    return [...options];
  }
  return [{ value: model, label: model }, ...options];
}

function ensureDefaultImageModelOption(
  options: ReadonlyArray<ImageModelOption>,
  defaultModel = DEFAULT_IMAGE_MODEL,
): ImageModelOption[] {
  return [
    { value: defaultModel, label: defaultModel },
    ...options.filter((option) => option.value !== defaultModel),
  ];
}

function serializeImageSizeSelection(selection: ImageSizeSelection): StoredImageSizeSelection {
  return {
    mode: selection.mode,
    aspectRatio: selection.aspectRatio,
    resolution: selection.resolution,
    customRatio: selection.customRatio,
    customWidth: selection.customWidth,
    customHeight: selection.customHeight,
  };
}

function restoreImageSizeSelection(stored: StoredImageSizeSelection | undefined, fallbackSize: string): ImageSizeSelection {
  const fallbackSelection = getImageSizeSelectionFromSize(fallbackSize);
  if (!stored) {
    return fallbackSelection;
  }
  return {
    mode: isImageSizeMode(stored.mode) ? stored.mode : fallbackSelection.mode,
    aspectRatio: isImageAspectRatio(stored.aspectRatio) ? stored.aspectRatio : fallbackSelection.aspectRatio,
    resolution: isImageResolution(stored.resolution) ? stored.resolution : fallbackSelection.resolution,
    customRatio: stored.customRatio || fallbackSelection.customRatio,
    customWidth: stored.customWidth || fallbackSelection.customWidth,
    customHeight: stored.customHeight || fallbackSelection.customHeight,
  };
}

function buildTurnOutcomeMessage(successCount: number, failedCount: number, cancelledCount: number) {
  const parts = [`成功 ${successCount} 张`];
  if (failedCount > 0) {
    parts.push(`失败 ${failedCount} 张`);
  }
  if (cancelledCount > 0) {
    parts.push(`终止 ${cancelledCount} 张`);
  }
  return parts.join("，");
}

function formatCreationTaskError(error: unknown, fallback = "生成图片失败") {
  return error instanceof Error ? error.message : String(error || fallback);
}

function deriveTurnStatus(turn: ImageTurn): Pick<ImageTurn, "status" | "error"> {
  const loadingCounts = getImageTurnLoadingCounts(turn);
  const failedCount = turn.images.filter((image) => image.status === "error").length;
  const successCount = turn.images.filter((image) => image.status === "success").length;
  const cancelledCount = turn.images.filter((image) => image.status === "cancelled").length;
  const messageCount = turn.images.filter((image) => image.status === "message").length;
  if (loadingCounts.running > 0) {
    return { status: "generating", error: undefined };
  }
  if (loadingCounts.queued > 0) {
    return { status: "queued", error: undefined };
  }
  if (failedCount > 0) {
    const upstreamError = turn.images.find((image) => image.status === "error" && image.error)?.error;
    return { status: "error", error: upstreamError || buildTurnOutcomeMessage(successCount, failedCount, cancelledCount) };
  }
  if (cancelledCount > 0) {
    return { status: "cancelled", error: buildTurnOutcomeMessage(successCount, failedCount, cancelledCount) };
  }
  if (successCount > 0) {
    return { status: "success", error: undefined };
  }
  if (messageCount > 0) {
    return { status: "message", error: undefined };
  }
  return { status: "queued", error: undefined };
}

function deriveTurnStatusFromTaskMap(turn: ImageTurn, images: StoredImage[]): Pick<ImageTurn, "status" | "error"> {
  return deriveTurnStatus({ ...turn, images });
}

function isTurnInProgress(turn: ImageTurn) {
  return (
    turn.status === "queued" ||
    turn.status === "generating" ||
    turn.images.some((image) => image.status === "loading")
  );
}

function usesReferenceImages(mode: ImageConversationMode) {
  return mode === "image" || mode === "edit";
}

function isMissingBatchImageDataError(error?: string) {
  return typeof error === "string" && error.startsWith("未返回第 ") && error.endsWith(" 张图片数据");
}

function isMissingRecoverableTaskIdError(error?: string) {
  return error === MISSING_RECOVERABLE_TASK_ID_ERROR;
}

function getComposerConversationMode(composerMode: ComposerMode, referenceImages: StoredReferenceImage[]): ImageConversationMode {
  if (composerMode === "video") {
    return "video";
  }
  if (referenceImages.length === 0) {
    return "generate";
  }
  return referenceImages.some((image) => image.source === "conversation") ? "edit" : "image";
}

function buildCreationTaskMessages(conversation: ImageConversation, activeTurnId: string): CreationTaskMessage[] {
  const messages: CreationTaskMessage[] = [];
  for (const turn of conversation.turns) {
    const prompt = turn.prompt.trim();
    if (prompt) {
      messages.push({ role: "user", content: prompt });
    }
    if (turn.id === activeTurnId) {
      break;
    }

    const assistantParts = turn.images.flatMap((image) => {
      if (image.status === "message" && image.text_response?.trim()) {
        return [image.text_response.trim()];
      }
      if (image.status === "success" && image.revised_prompt?.trim()) {
        return [`Generated image: ${image.revised_prompt.trim()}`];
      }
      return [];
    });
    if (assistantParts.length > 0) {
      messages.push({ role: "assistant", content: assistantParts.join("\n\n") });
    }
  }
  return messages;
}

function getFallbackReferenceImage(conversation: ImageConversation, activeTurnId: string): FallbackReferenceImage | undefined {
  const previousTurns: ImageTurn[] = [];
  for (const turn of conversation.turns) {
    if (turn.id === activeTurnId) {
      break;
    }
    previousTurns.push(turn);
  }
  for (let turnIndex = previousTurns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const images = previousTurns[turnIndex].images;
    for (let imageIndex = images.length - 1; imageIndex >= 0; imageIndex -= 1) {
      const image = images[imageIndex];
      if (image.status !== "success" || image.mediaType === "video" || image.videoUrl) {
        continue;
      }
      if (image.path || image.url || image.b64_json) {
        return {
          ...(image.path ? { path: image.path } : {}),
          ...(image.url ? { url: image.url } : {}),
          ...(image.b64_json ? { b64_json: image.b64_json } : {}),
          ...(image.outputFormat ? { outputFormat: image.outputFormat } : {}),
        };
      }
    }
  }
  return undefined;
}

async function syncConversationCreationTasks(
  items: ImageConversation[],
  requestOptions: CreationTaskRequestOptions,
) {
  const taskIds = Array.from(
    new Set(
      items.flatMap((conversation) =>
        conversation.turns.flatMap((turn) =>
          turn.images.flatMap((image) => (image.status === "loading" && image.taskId ? [image.taskId] : [])),
        ),
      ),
    ),
  );
  if (taskIds.length === 0) {
    return items;
  }

  let taskList: Awaited<ReturnType<typeof fetchCreationTasks>>;
  try {
    taskList = await fetchCreationTasks(taskIds, requestOptions);
  } catch {
    return items;
  }
  const taskMap = new Map(mergeCreationTaskList(taskList.items).map((task) => [task.id, task]));
  const normalized = items.map((conversation) => {
    // Cursor pages can contain metadata-only rows. They are completed by the
    // selected-conversation detail request and must not enter task recovery.
    if (isImageConversationHistorySummaryOnly(conversation)) {
      return conversation;
    }
    let completedActiveTurn = false;
    const turns = conversation.turns.map((turn) => {
      let turnChanged = false;
      const images = turn.images.map((image, imageIndex) => {
        if (image.status !== "loading" || !image.taskId) {
          return image;
        }
        const task = taskMap.get(image.taskId);
        if (!task) {
          return image;
        }
        const nextImage = taskDataToStoredImage(image, task, imageDataIndexForTask(turn.images, imageIndex), turn.visibility);
        if (nextImage !== image) {
          turnChanged = true;
        }
        return nextImage;
      });
      if (!turnChanged) {
        return turn;
      }
      const derived = deriveTurnStatusFromTaskMap(turn, images);
      const nextTurn = {
        ...turn,
        ...derived,
        images,
      };
      if (isTurnInProgress(turn) && !isTurnInProgress(nextTurn)) {
        completedActiveTurn = true;
      }
      return nextTurn;
    });
    if (turns === conversation.turns || !turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }
    const nextConversation = {
      ...conversation,
      turns,
    };
    return completedActiveTurn
      ? {
          ...nextConversation,
          updatedAt: new Date().toISOString(),
        }
      : nextConversation;
  });

  return normalized;
}

async function recoverConversationHistory(
  items: ImageConversation[],
  requestOptions: CreationTaskRequestOptions,
) {
  const changedConversationIds = new Set<string>();
  const normalized = items.map((conversation) => {
    if (isImageConversationHistorySummaryOnly(conversation)) {
      return conversation;
    }
    const turns = conversation.turns.map((turn) => {
      let turnChanged = false;
      const recoveredImages = turn.images.map((image, imageIndex) => {
        if (image.status === "error" && isMissingBatchImageDataError(image.error)) {
          turnChanged = true;
          return {
            ...image,
            taskId: image.id,
            taskRevision: undefined,
            taskStatus: "queued" as const,
            taskCreatedAt: undefined,
            taskUpdatedAt: undefined,
            generationDurationMs: undefined,
            status: "loading" as const,
            error: undefined,
          };
        }
        if (turn.mode === "chat" && image.status === "error" && isMissingRecoverableTaskIdError(image.error)) {
          turnChanged = true;
          return {
            ...image,
            taskId: imageTaskIdForImage(turn.id, turn.model, turn.images, imageIndex),
            taskRevision: undefined,
            taskStatus: "queued" as const,
            taskCreatedAt: undefined,
            taskUpdatedAt: undefined,
            generationDurationMs: undefined,
            status: "loading" as const,
            error: undefined,
          };
        }
        if (turn.mode === "chat" && image.status === "loading" && !image.taskId) {
          turnChanged = true;
          return {
            ...image,
            taskId: imageTaskIdForImage(turn.id, turn.model, turn.images, imageIndex),
          };
        }
        return image;
      });

      if (turn.status !== "queued" && turn.status !== "generating") {
        if (!turnChanged) {
          return turn;
        }
        const derived = deriveTurnStatus({ ...turn, status: "queued", images: recoveredImages });
        return {
          ...turn,
          ...derived,
          images: recoveredImages,
        };
      }

      const images = recoveredImages.map((image) => {
        if (image.status !== "loading" || image.taskId) {
          return image;
        }
        turnChanged = true;
        return {
          ...image,
          status: "error" as const,
          error: MISSING_RECOVERABLE_TASK_ID_ERROR,
        };
      });
      const derived = deriveTurnStatus({ ...turn, images });
      if (!turnChanged && derived.status === turn.status && derived.error === turn.error) {
        return turn;
      }
      return {
        ...turn,
        ...derived,
        images,
      };
    });

    if (!turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }

    changedConversationIds.add(conversation.id);

    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  const synced = await syncConversationCreationTasks(normalized, requestOptions);
  const originalById = new Map(items.map((conversation) => [conversation.id, conversation]));
  for (const conversation of synced) {
    const original = originalById.get(conversation.id);
    if (!original) {
      continue;
    }
    const originalTurns = new Map(original.turns.map((turn) => [turn.id, turn]));
    if (conversation.turns.some((turn) => {
      const previous = originalTurns.get(turn.id);
      return previous && getEffectiveImageTurnStatus(previous) !== getEffectiveImageTurnStatus(turn);
    })) {
      changedConversationIds.add(conversation.id);
    }
  }

  const saves: ImageConversation[] = [];
  const recovered = synced.map((conversation) => {
    if (!changedConversationIds.has(conversation.id)) {
      return conversation;
    }
    const next = {
      ...conversation,
      revision: Number(conversation.revision || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    saves.push({
      ...next,
      turns: next.turns.map((turn) => ({
        ...turn,
        images: turn.images.map((image) =>
          image.status === "loading"
            ? { ...image, b64_json: undefined, url: undefined, path: undefined }
            : image,
        ),
      })),
    });
    return next;
  });
  return { items: recovered, saves };
}

function ImagePageContent({ session }: { session: StoredAuthSession }) {
  const pageActiveRef = useRef(true);
  const pageSessionEpochRef = useRef(0);
  const activeConversationQueueIdsRef = useRef(new Set<string>());
  const isSubmitDispatchingRef = useRef(false);
  const retryingImageIdsRef = useRef(new Set<string>());
  const queueingTurnIdsRef = useRef(new Set<string>());
  const cancelledTurnIdsRef = useRef(new Set<string>());
  const deletedConversationIdsRef = useRef(new Set<string>());
  const taskSnapshotsRef = useRef(new Map<string, CreationTask>());
  const conversationsRef = useRef<ImageConversation[]>([]);
  const conversationMutationChainsRef = useRef(new Map<string, Promise<void>>());
  const conversationRevisionReservationsRef = useRef(new Map<string, number>());
  const conversationMutationRevisionRef = useRef(0);
  const conversationDestructiveEpochRef = useRef(0);
  const conversationRefreshRequestRef = useRef(0);
  const conversationHistoryReadyRef = useRef(false);
  const conversationPendingWritesRef = useRef(0);
  const conversationRefreshNeededRef = useRef(false);
  const conversationHistoryNextCursorRef = useRef<string | null>(null);
  const conversationHistoryGenerationRef = useRef<string | null>(null);
  const conversationHistoryHasMoreRef = useRef(false);
  const conversationHistoryLoadMoreRef = useRef(false);
  const conversationHistoryDetailRecoveryRef = useRef(new Set<string>());
  const historySyncErrorShownAtRef = useRef(0);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const resultsContentRef = useRef<HTMLDivElement>(null);
  const shouldStickToResultsBottomRef = useRef(true);
  const referenceImagesRef = useRef<StoredReferenceImage[]>([]);
  const referenceUploadEpochRef = useRef(0);
  const referenceUploadPendingCountRef = useRef(0);
  const editReferenceUploadPendingCountRef = useRef(0);
  const lastResultsScrollTargetRef = useRef<{ conversationId: string | null; turnCount: number }>({
    conversationId: null,
    turnCount: 0,
  });
  const composerDockRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const promptApplyRequestIdRef = useRef(0);
  const similarIntentAppliedRef = useRef(false);
  const creationTaskRequestOptions = useMemo<CreationTaskRequestOptions>(() => ({
    redirectOnUnauthorized: false,
  }), []);

  const [imagePrompt, setImagePrompt] = useState("");
  const [composerMode, setComposerMode] = useState<ComposerMode>(getStoredComposerMode);
  const [imageModel, setImageModel] = useState<ImageModel>(getStoredImageModel);
  const [imageCount, setImageCount] = useState("1");
  const [imageSizeMode, setImageSizeMode] = useState<ImageSizeMode>(() => getStoredImageSizeSelection().mode);
  const [imageAspectRatio, setImageAspectRatio] = useState<ImageAspectRatio>(() => getStoredImageSizeSelection().aspectRatio);
  const [imageResolution, setImageResolution] = useState<ImageResolution>(() => getStoredImageSizeSelection().resolution);
  const [imageCustomRatio, setImageCustomRatio] = useState(() => getStoredImageSizeSelection().customRatio);
  const [imageCustomWidth, setImageCustomWidth] = useState(() => getStoredImageSizeSelection().customWidth);
  const [imageCustomHeight, setImageCustomHeight] = useState(() => getStoredImageSizeSelection().customHeight);
  const [imageQuality, setImageQuality] = useState<"" | ImageQuality>(getStoredImageQuality);
  const [imageOutputFormat, setImageOutputFormat] = useState<ImageOutputFormat>(getStoredImageOutputFormat);
  const [imageOutputCompression, setImageOutputCompression] = useState(getStoredImageOutputCompression);
  const [imageStreamEnabled, setImageStreamEnabled] = useState(getStoredImageStreamEnabled);
  const [imagePartialImages, setImagePartialImages] = useState(getStoredImagePartialImages);
  const [videoModel, setVideoModel] = useState(() => getStoredVideoSetting(VIDEO_MODEL_STORAGE_KEY, "sora-2"));
  const [videoModelOptions, setVideoModelOptions] = useState<Array<{ value: string; label: string }>>([
    { value: "sora-2", label: "sora-2" },
  ]);
  const [videoSize, setVideoSize] = useState(() => getStoredVideoSetting(VIDEO_SIZE_STORAGE_KEY, "1280x720"));
  const [videoSeconds, setVideoSeconds] = useState(() => getStoredVideoSetting(VIDEO_SECONDS_STORAGE_KEY, "4"));
  const [videoResolution, setVideoResolution] = useState(() => getStoredVideoSetting(VIDEO_RESOLUTION_STORAGE_KEY, "720p"));
  const [videoGenerateAudio, setVideoGenerateAudio] = useState(() => getStoredVideoSetting(VIDEO_AUDIO_STORAGE_KEY, "true") === "true");
  const [videoWatermark, setVideoWatermark] = useState(() => getStoredVideoSetting(VIDEO_WATERMARK_STORAGE_KEY, "false") === "true");
  const [videoReferenceMode, setVideoReferenceMode] = useState<VideoReferenceMode>("first-frame");
  const [videoReferenceImageURLs, setVideoReferenceImageURLs] = useState<string[]>([]);
  const [videoReferenceVideoURLs, setVideoReferenceVideoURLs] = useState<string[]>([]);
  const [videoReferenceUploading, setVideoReferenceUploading] = useState(false);
  const handleVideoReferenceFileChange = useCallback(async (file: File) => {
    const mime = file.type.toLowerCase().split(";", 1)[0];
    if (!(mime === "video/mp4" || mime === "video/quicktime" || /\.(mp4|mov)$/i.test(file.name))) {
      toast.error("参考视频仅支持 MP4 或 MOV 格式");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      toast.error("参考视频不能超过 50 MiB");
      return;
    }
    setVideoReferenceUploading(true);
    try {
      const uploaded = await uploadVideoReference(file);
      setVideoReferenceVideoURLs([uploaded.url]);
      setVideoReferenceImageURLs([]);
      setVideoReferenceAudioURLs([]);
      setVideoReferenceMode("reference");
      toast.success("参考视频已上传");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "参考视频上传失败");
    } finally {
      setVideoReferenceUploading(false);
    }
  }, []);
  const [videoReferenceAudioURLs, setVideoReferenceAudioURLs] = useState<string[]>([]);
  const handleVideoModelChange = useCallback((model: string) => {
    const nextSeconds = videoSecondsOptions(model).find((value) => value > 0) || 4;
    setVideoModel(model);
    setVideoSize(videoSizeOptions(model)[0] || "");
    setVideoSeconds(String(nextSeconds));
    setVideoResolution(videoResolutionOptions(model, nextSeconds)[0] || "");
    setVideoGenerateAudio(videoAudioControl(model) === "toggle" || videoAudioControl(model) === "always");
    if (!supportsVideoMultimodalReferences(model)) {
      setVideoReferenceMode("first-frame");
    }
  }, []);
  useEffect(() => {
    const sizes = videoSizeOptions(videoModel);
    const seconds = videoSecondsOptions(videoModel);
    const resolutions = videoResolutionOptions(videoModel, Number(videoSeconds));
    setVideoSize((current) => sizes.includes(current) ? current : sizes[0] || "");
    setVideoSeconds((current) => seconds.includes(Number(current)) ? current : String(seconds.find((value) => value > 0) || 4));
    setVideoResolution((current) => resolutions.includes(current) ? current : resolutions[0] || "");
    const audioControl = videoAudioControl(videoModel);
    if (audioControl !== "toggle") setVideoGenerateAudio(audioControl === "always");
  }, [videoModel, videoSeconds]);
  const [relayKeyConfigured, setRelayKeyConfigured] = useState<Record<RelayTokenKind, boolean>>({
    image: false,
    video: false,
  });
  const [relayKeyStatusMessage, setRelayKeyStatusMessage] = useState<Record<RelayTokenKind, string>>({
    image: NEWAPI_TOKEN_MISSING_MESSAGE,
    video: NEWAPI_TOKEN_MISSING_MESSAGE,
  });
  const imageRelayTokenStorageKey = relayTokenNameStorageKey(session, "image");
  const videoRelayTokenStorageKey = relayTokenNameStorageKey(session, "video");
  const [imageRelayTokenName, setImageRelayTokenName] = useState(() => getStoredRelayTokenName(session, "image"));
  const [videoRelayTokenName, setVideoRelayTokenName] = useState(() => getStoredRelayTokenName(session, "video"));
  const [relayTokenDialogKind, setRelayTokenDialogKind] = useState<RelayTokenCreationKind | null>(null);
  const [relayImageModelOptions, setRelayImageModelOptions] = useState<ImageModelOption[]>(() =>
    ensureDefaultImageModelOption(IMAGE_CREATION_MODEL_OPTIONS),
  );
  const [defaultImageVisibility, setDefaultImageVisibility] = useState<ImageVisibility>("private");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isPromptMarketOpen, setIsPromptMarketOpen] = useState(false);
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "one"; id: string } | { type: "all" } | null>(null);
  const [editingTurnDraft, setEditingTurnDraft] = useState<EditingTurnDraft | null>(null);
  const [editReferenceUploadPendingCount, setEditReferenceUploadPendingCount] = useState(0);
  const [progressByTurnKey, setProgressByTurnKey] = useState<Record<string, ImageTurnProgress>>(
    getImageTurnProgressSnapshot,
  );
  const [progressNow, setProgressNow] = useState(Date.now());
  const [composerDockHeight, setComposerDockHeight] = useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [visibilityMutatingImageKey, setVisibilityMutatingImageKey] = useState("");
  const [publishImageTarget, setPublishImageTarget] = useState<PublishImageTarget | null>(null);
  const [publishRecipeOptions, setPublishRecipeOptions] = useState<PublishRecipeOptions>({
    sharePromptParameters: false,
    shareReferenceImages: false,
  });

  const replaceReferenceImages = useCallback((items: StoredReferenceImage[]) => {
    referenceUploadEpochRef.current += 1;
    referenceImagesRef.current = items;
    setReferenceImages(items);
  }, []);

  useEffect(() => {
    pageActiveRef.current = true;
    const activeQueueIds = activeConversationQueueIdsRef.current;
    const sessionKey = session.key;
    const deactivatePage = () => {
      pageSessionEpochRef.current += 1;
      pageActiveRef.current = false;
      promptApplyRequestIdRef.current += 1;
      referenceUploadEpochRef.current += 1;
      activeQueueIds.clear();
      conversationRevisionReservationsRef.current.clear();
      conversationMutationRevisionRef.current += 1;
      conversationDestructiveEpochRef.current += 1;
      conversationRefreshRequestRef.current += 1;
      conversationHistoryNextCursorRef.current = null;
      conversationHistoryGenerationRef.current = null;
      conversationHistoryHasMoreRef.current = false;
      conversationHistoryLoadMoreRef.current = false;
      conversationHistoryDetailRecoveryRef.current.clear();
      setHasMoreHistory(false);
      setIsLoadingMoreHistory(false);
    };
    const handleAuthSessionChange = () => {
      if (getCachedAuthSession()?.key !== sessionKey) {
        deactivatePage();
      }
    };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, handleAuthSessionChange);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, handleAuthSessionChange);
      deactivatePage();
    };
  }, [session.key]);

  const imageSize = useMemo(
    () => {
      const request = buildEffectiveImageSizeRequest(imageModel, {
        mode: imageSizeMode,
        aspectRatio: imageAspectRatio,
        resolution: imageResolution,
        customRatio: imageCustomRatio,
        customWidth: imageCustomWidth,
        customHeight: imageCustomHeight,
      });
      return request.size;
    },
    [imageAspectRatio, imageCustomHeight, imageCustomRatio, imageCustomWidth, imageModel, imageResolution, imageSizeMode],
  );
  const editingDraftSizeRequest = useMemo(() => {
    if (!editingTurnDraft || editingTurnDraft.mode === "chat") {
      return null;
    }
    return buildEffectiveImageSizeRequest(editingTurnDraft.model, {
      mode: editingTurnDraft.sizeMode,
      aspectRatio: editingTurnDraft.aspectRatio,
      resolution: editingTurnDraft.resolution,
      customRatio: editingTurnDraft.customRatio,
      customWidth: editingTurnDraft.customWidth,
      customHeight: editingTurnDraft.customHeight,
    });
  }, [editingTurnDraft]);
  const editingDraftEffectiveSizeSelection = editingDraftSizeRequest?.selection;
  const editingDraftImageSize = useMemo(() => {
    return editingDraftSizeRequest?.size ?? "";
  }, [editingDraftSizeRequest]);
  const editingDraftStructuredParameters = editingTurnDraft
    ? supportsStructuredImageParameters(editingTurnDraft.model)
    : false;
  const editingDraftSizeSupported = editingTurnDraft
    ? supportsImageSize(editingTurnDraft.model)
    : false;
  const editingDraftExactDimensionsSupported = editingTurnDraft
    ? supportsImageExactDimensions(editingTurnDraft.model)
    : false;
  const editingDraftGoogleGeminiParameters = editingTurnDraft
    ? imageModelRoute(editingTurnDraft.model) === "google-gemini-image"
    : false;
  const editingDraftXAIParameters = editingTurnDraft
    ? imageModelRoute(editingTurnDraft.model) === "xai-image"
    : false;
  const editingDraftAspectRatioOptions = editingTurnDraft
    ? IMAGE_ASPECT_RATIO_OPTIONS.filter((option) => supportsImageAspectRatio(editingTurnDraft.model, option.value))
    : [];
  const editingDraftResolutionOptions = editingTurnDraft
    ? (editingDraftGoogleGeminiParameters
        ? GEMINI_IMAGE_RESOLUTION_OPTIONS
        : editingDraftXAIParameters
          ? XAI_IMAGE_RESOLUTION_OPTIONS
          : IMAGE_RESOLUTION_OPTIONS).filter((option) =>
        supportsImageResolution(editingTurnDraft.model, option.value),
      )
    : [];
  const editingDraftQualityOptions = editingTurnDraft
    ? [{ value: "", label: "自动" }, ...IMAGE_QUALITY_OPTIONS]
        .filter((option) => supportsImageQualityValue(editingTurnDraft.model, option.value))
    : [];
  const editingDraftOutputControls = editingTurnDraft
    ? supportsImageOutputControls(editingTurnDraft.model)
    : false;
  const editingDraftQualitySupported = editingTurnDraft
    ? supportsImageQuality(editingTurnDraft.model)
    : false;
  const editingDraftStreamingSupported = editingTurnDraft
    ? supportsImageStreaming(editingTurnDraft.model)
    : false;
  const editingDraftCustomRatioInvalid = editingTurnDraft && editingDraftEffectiveSizeSelection
    ? isInvalidCustomRatioSelection(
        editingDraftEffectiveSizeSelection.mode,
        editingDraftEffectiveSizeSelection.aspectRatio,
        editingDraftEffectiveSizeSelection.customRatio,
      )
    : false;
  const editingDraftSizePreviewLabel =
    editingTurnDraft && editingTurnDraft.mode !== "chat" && editingDraftEffectiveSizeSelection
      ? editingDraftImageSize
        ? formatImageSizeDisplay(editingDraftImageSize)
          : editingDraftEffectiveSizeSelection.mode === "auto" ||
            (editingDraftEffectiveSizeSelection.mode === "ratio" &&
              editingDraftEffectiveSizeSelection.resolution === "auto" &&
              !editingDraftCustomRatioInvalid)
          ? "自动"
          : "尺寸无效"
      : "";
  const editingDraftSizeIsHighResolution = Boolean(
    editingDraftStructuredParameters &&
      editingDraftImageSize &&
      isHighResolutionImageSize(editingDraftImageSize, editingDraftEffectiveSizeSelection),
  );
  const editingDraftDimensions = parseImageSizeDimensions(editingDraftImageSize);
  const editingDraftDisplayedWidth =
    editingDraftEffectiveSizeSelection?.mode === "custom"
      ? editingTurnDraft?.customWidth || editingDraftDimensions?.width || ""
      : editingDraftDimensions?.width || editingTurnDraft?.customWidth || "";
  const editingDraftDisplayedHeight =
    editingDraftEffectiveSizeSelection?.mode === "custom"
      ? editingTurnDraft?.customHeight || editingDraftDimensions?.height || ""
      : editingDraftDimensions?.height || editingTurnDraft?.customHeight || "";
  const editingDraftCount = editingTurnDraft
    ? normalizeRequestedImageCount(editingTurnDraft.count, editingTurnDraft.model)
    : 1;
  const editingDraftCountLimit = editingTurnDraft ? imageOutputCountLimit(editingTurnDraft.model) : 4;
  const imageCreationModelOptions = useMemo(
    () => (relayImageModelOptions.length > 0 ? relayImageModelOptions : IMAGE_CREATION_MODEL_OPTIONS),
    [relayImageModelOptions],
  );
  const defaultImageModel = imageCreationModelOptions[0]?.value ?? DEFAULT_IMAGE_MODEL;
  const composerModelOptions = useMemo(
    () => ensureModelOption(imageCreationModelOptions, imageModel),
    [imageCreationModelOptions, imageModel],
  );
  const editingTurnModelOptions = useMemo(() => {
    if (!editingTurnDraft) {
      return [];
    }
    return ensureModelOption(imageCreationModelOptions, editingTurnDraft.model);
  }, [editingTurnDraft, imageCreationModelOptions]);
  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const activeRelayTokenKind: RelayTokenKind = composerMode === "video" ? "video" : "image";
  const activeRelayTokenName = (activeRelayTokenKind === "video" ? videoRelayTokenName : imageRelayTokenName).trim();
  const activeRelayKeyConfigured = relayKeyConfigured[activeRelayTokenKind];
  const activeRelayKeyMissingMessage = relayKeyStatusMessage[activeRelayTokenKind] || NEWAPI_TOKEN_MISSING_MESSAGE;
  const relayTokenNameForKind = useCallback((kind: RelayTokenKind) => (
    kind === "video" ? videoRelayTokenName : imageRelayTokenName
  ).trim(), [imageRelayTokenName, videoRelayTokenName]);
  const requireRelayToken = useCallback((kind: RelayTokenCreationKind) => {
    if (relayTokenNameForKind(kind) && relayKeyConfigured[kind]) {
      return true;
    }
    setRelayTokenDialogKind(kind);
    return false;
  }, [relayKeyConfigured, relayTokenNameForKind]);
  const activeTaskCount = useMemo(
    () =>
      conversations.reduce((sum, conversation) => {
        const stats = getImageConversationStats(conversation);
        return sum + stats.queued + stats.running;
      }, 0),
    [conversations],
  );
  const deleteConfirmTitle = deleteConfirm?.type === "all" ? "清空历史记录" : deleteConfirm?.type === "one" ? "删除记录" : "";
  const deleteConfirmDescription =
    deleteConfirm?.type === "all"
      ? "确认删除全部图片历史记录吗？删除后无法恢复。"
      : deleteConfirm?.type === "one"
        ? "确认删除这条图片记录吗？删除后无法恢复。"
        : "";
  const highResolutionHint = useMemo(() => formatHighResolutionHint(), []);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    referenceImagesRef.current = referenceImages;
  }, [referenceImages]);

  useEffect(() => {
    const node = composerDockRef.current;
    if (!node) {
      return;
    }

    const updateComposerHeight = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      setComposerDockHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
    };

    updateComposerHeight();
    const observer = new ResizeObserver(updateComposerHeight);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  const scrollResultsToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const viewport = resultsViewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
    shouldStickToResultsBottomRef.current = true;
    setShowScrollToBottom(false);
  }, []);

  const handleResultsViewportScroll = useCallback(() => {
    const viewport = resultsViewportRef.current;
    if (!viewport) {
      return;
    }
    const nearBottom = isNearResultsBottom(viewport);
    shouldStickToResultsBottomRef.current = nearBottom;
    setShowScrollToBottom(!nearBottom && viewport.scrollHeight > viewport.clientHeight + RESULTS_BOTTOM_STICKY_THRESHOLD);
  }, []);

  useEffect(() => {
    const content = resultsContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") {
      return;
    }

    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!shouldStickToResultsBottomRef.current) {
        return;
      }
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => scrollResultsToBottom("auto"));
    });

    observer.observe(content);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [scrollResultsToBottom, selectedConversationId]);

  useEffect(() => {
    let cancelled = false;
    let refreshInFlight: Promise<void> | null = null;

    const refreshConversations = () => {
      if (!pageActiveRef.current || !conversationHistoryReadyRef.current) {
        return Promise.resolve();
      }
      if (conversationPendingWritesRef.current > 0) {
        conversationRefreshNeededRef.current = true;
        return Promise.resolve();
      }
      if (refreshInFlight) {
        conversationRefreshNeededRef.current = true;
        return refreshInFlight;
      }
      const requestId = ++conversationRefreshRequestRef.current;
      const mutationRevision = conversationMutationRevisionRef.current;
      refreshInFlight = (async () => {
        try {
          const {
            firstPage,
            activePage,
            generation: windowGeneration,
          } = await loadImageConversationHistoryWindow(IMAGE_HISTORY_PAGE_SIZE);
          if (
            cancelled ||
            !pageActiveRef.current ||
            requestId !== conversationRefreshRequestRef.current ||
            mutationRevision !== conversationMutationRevisionRef.current ||
            conversationPendingWritesRef.current > 0
          ) {
            if (!cancelled) {
              conversationRefreshNeededRef.current = true;
            }
            return;
          }
          const incomingItems = mergeImageConversationItems(firstPage.items, activePage.items);
          const previousGeneration = conversationHistoryGenerationRef.current;
          const nextGeneration = maxImageConversationHistoryGeneration(
            previousGeneration,
            windowGeneration,
          );
          const generationChanged = imageConversationHistoryGenerationChanged(previousGeneration, nextGeneration);
          if (nextGeneration) {
            conversationHistoryGenerationRef.current = nextGeneration;
          }
          if (generationChanged) {
            conversationHistoryNextCursorRef.current = firstPage.nextCursor;
            conversationHistoryHasMoreRef.current = firstPage.hasMore;
            setHasMoreHistory(firstPage.hasMore);
          }
          const mergedItems = generationChanged
            ? incomingItems
            : mergeImageConversationItems(conversationsRef.current, incomingItems);
          conversationsRef.current = mergedItems;
          setConversations(mergedItems);
        } catch {
          // Background updates should not surface noisy toasts while the user is on another workflow.
        }
      })().finally(() => {
        refreshInFlight = null;
        if (
          !cancelled &&
          pageActiveRef.current &&
          conversationHistoryReadyRef.current &&
          conversationPendingWritesRef.current === 0 &&
          conversationRefreshNeededRef.current
        ) {
          conversationRefreshNeededRef.current = false;
          void refreshConversations();
        }
      });
      return refreshInFlight;
    };

    const handleConversationsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string; requiresRefresh?: boolean }>).detail;
      if (detail?.source === "server-write") {
        if (!detail.requiresRefresh) {
          return;
        }
        if (conversationPendingWritesRef.current > 0) {
          conversationRefreshNeededRef.current = true;
          return;
        }
      }
      void refreshConversations();
    };

    const handleWindowFocus = () => {
      void refreshConversations();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshConversations();
      }
    };

    window.addEventListener(IMAGE_CONVERSATIONS_CHANGED_EVENT, handleConversationsChanged);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const refreshTimer = window.setInterval(() => void refreshConversations(), 30_000);
    return () => {
      cancelled = true;
      conversationRefreshRequestRef.current += 1;
      window.removeEventListener(IMAGE_CONVERSATIONS_CHANGED_EVENT, handleConversationsChanged);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(refreshTimer);
    };
  }, []);

  useEffect(
    () =>
      subscribeImageTurnProgress(() => {
        setProgressByTurnKey(getImageTurnProgressSnapshot());
      }),
    [],
  );

  useEffect(() => {
    if (activeTaskCount === 0 && Object.keys(progressByTurnKey).length === 0) {
      return;
    }

    setProgressNow(Date.now());
    const timer = window.setInterval(() => {
      setProgressNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [activeTaskCount, progressByTurnKey]);

  useEffect(() => {
    let cancelled = false;

    const loadHistory = async () => {
      const mutationRevision = conversationMutationRevisionRef.current;
      const applyLoadedItems = (items: ImageConversation[]) => {
        conversationsRef.current = items;
        setConversations(items);
        const storedConversationId =
          typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY) : null;
        setSelectedConversationId((current) => {
          if (current && items.some((conversation) => conversation.id === current)) {
            return current;
          }
          return (
            (storedConversationId && items.some((conversation) => conversation.id === storedConversationId)
              ? storedConversationId
              : null) ?? pickFallbackConversationId(items)
          );
        });
      };
      const recoverLoadedItems = (items: ImageConversation[]) => {
        const recoveryMutationRevision = conversationMutationRevisionRef.current;
        void recoverConversationHistory(items, creationTaskRequestOptions)
          .then(async ({ items: recoveredItems, saves }) => {
            if (
              cancelled ||
              !pageActiveRef.current ||
              recoveryMutationRevision !== conversationMutationRevisionRef.current
            ) {
              return;
            }
            if (!recoveredItems.some((conversation, index) => conversation !== items[index])) {
              return;
            }
            try {
              for (const conversation of saves) {
                await saveImageConversation(conversation);
              }
            } catch (error) {
              for (const conversation of saves) {
                discardFailedImageConversationSave(conversation.id, error);
              }
              if (!cancelled && pageActiveRef.current) {
                toast.error("历史任务恢复失败，未提交新的生成请求");
              }
              return;
            }
            if (
              cancelled ||
              !pageActiveRef.current ||
              recoveryMutationRevision !== conversationMutationRevisionRef.current
            ) {
              return;
            }
            conversationMutationRevisionRef.current += 1;
            conversationsRef.current = recoveredItems;
            setConversations(recoveredItems);
          })
          .catch(() => undefined);
      };
      try {
        const storedConversationId =
          typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY) : null;
        let storedSelectionDetailTransientFailure = false;
        const storedSelection = getStoredImageSizeSelection();
        setImageSizeMode(storedSelection.mode);
        setImageAspectRatio(storedSelection.aspectRatio);
        setImageResolution(storedSelection.resolution);
        setImageCustomRatio(storedSelection.customRatio);
        setImageCustomWidth(storedSelection.customWidth);
        setImageCustomHeight(storedSelection.customHeight);
        setImageOutputFormat(getStoredImageOutputFormat());
        setImageOutputCompression(getStoredImageOutputCompression());

        const {
          firstPage,
          activePage,
          generation: windowGeneration,
        } = await loadImageConversationHistoryWindow(IMAGE_HISTORY_PAGE_SIZE);
        if (cancelled || !pageActiveRef.current) {
          return;
        }
        if (mutationRevision !== conversationMutationRevisionRef.current) {
          conversationRefreshNeededRef.current = true;
          return;
        }

        conversationHistoryNextCursorRef.current = firstPage.nextCursor;
        conversationHistoryHasMoreRef.current = firstPage.hasMore;
        conversationHistoryGenerationRef.current = windowGeneration;
        setHasMoreHistory(firstPage.hasMore);
        setIsLoadingMoreHistory(false);

        let items = mergeImageConversationItems(firstPage.items, activePage.items);
        if (storedConversationId && !items.some((conversation) => conversation.id === storedConversationId)) {
          try {
            const storedConversation = await getImageConversation(storedConversationId);
            if (storedConversation && !cancelled && pageActiveRef.current) {
              items = mergeImageConversationItems(items, [storedConversation]);
            }
          } catch (error) {
            const status = typeof error === "object" && error !== null && "status" in error
              ? Number((error as { status?: unknown }).status)
              : Number.NaN;
            storedSelectionDetailTransientFailure = !shouldFallbackToImageConversationHistoryDetail(status);
          }
        }
        if (cancelled || !pageActiveRef.current) {
          return;
        }
        applyLoadedItems(items);
        if (storedSelectionDetailTransientFailure && storedConversationId && !items.some((item) => item.id === storedConversationId)) {
          setSelectedConversationId(storedConversationId);
        }
        recoverLoadedItems(items);
      } catch (error) {
        if (mutationRevision !== conversationMutationRevisionRef.current) {
          conversationRefreshNeededRef.current = true;
        } else {
          const message = error instanceof Error ? error.message : "读取会话记录失败";
          toast.error(message);
        }
      } finally {
        if (!cancelled && pageActiveRef.current) {
          conversationHistoryReadyRef.current = true;
          setIsLoadingHistory(false);
          if (conversationPendingWritesRef.current === 0 && conversationRefreshNeededRef.current) {
            conversationRefreshNeededRef.current = false;
            window.dispatchEvent(new Event(IMAGE_CONVERSATIONS_CHANGED_EVENT));
          }
        }
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, [creationTaskRequestOptions]);

  useEffect(() => {
    if (isLoadingHistory || similarIntentAppliedRef.current) {
      return;
    }
    similarIntentAppliedRef.current = true;

    const intent = consumeSimilarImageIntent();
    if (!intent) {
      return;
    }

    const requestId = promptApplyRequestIdRef.current + 1;
    promptApplyRequestIdRef.current = requestId;
    const prompt = intent.prompt.trim() || "参考这张图，生成一张风格、主体和构图相近的新图片。";
    const sizeSelection = getImageSizeSelectionFromSize(intent.requestedSize || intent.resolutionPreset || "");
    const outputFormat = isImageOutputFormat(intent.outputFormat) ? intent.outputFormat : DEFAULT_IMAGE_OUTPUT_FORMAT;
    const intentModel = isImageCreationModel(intent.model) ? intent.model : defaultImageModel;

    const sourceImageUrls = intent.sourceImageUrls.length > 0 ? intent.sourceImageUrls : [intent.sourceImageUrl];
    const usesPublicImageFallback = intent.sourceKind !== "original_references";
    if (sourceImageUrls.length > 0 && !supportsImageEditing(intentModel)) {
      toast.error(`模型 ${intentModel} 暂不支持参考图编辑`);
      return;
    }
    const referenceLimitMessage = imageConversationReferenceLimitMessage(
      0,
      sourceImageUrls.length,
      imageReferenceImageLimit(intentModel),
    );
    if (referenceLimitMessage) {
      toast.error(referenceLimitMessage);
      return;
    }
    const toastId = toast.loading(
      usesPublicImageFallback
        ? "正在读取公开图作为参考图"
        : sourceImageUrls.length > 1
          ? "正在读取公开的原始参考图"
          : "正在读取公开的原始参考图",
    );
    void buildReferenceImagesFromUrls(sourceImageUrls, "public-gallery-reference")
      .then((loadedReferences) => {
        if (promptApplyRequestIdRef.current !== requestId) {
          toast.dismiss(toastId);
          return;
        }
        if (loadedReferences.length === 0) {
          toast.error("参考图读取失败，未修改创作台", { id: toastId });
          return;
        }
        setSelectedConversationId(null);
        setComposerMode("image");
        setImagePrompt(prompt);
        setImageCount("1");
        setImageModel(intentModel);
        setImageSizeMode(sizeSelection.mode);
        setImageAspectRatio(sizeSelection.aspectRatio);
        setImageResolution(isImageResolution(intent.resolutionPreset) ? intent.resolutionPreset : sizeSelection.resolution);
        setImageCustomRatio(sizeSelection.customRatio);
        setImageCustomWidth(sizeSelection.customWidth);
        setImageCustomHeight(sizeSelection.customHeight);
        setImageOutputFormat(outputFormat);
        setImageOutputCompression(reusableOutputCompressionValue(intent.outputCompression, outputFormat));
        setDefaultImageVisibility("private");
        replaceReferenceImages(loadedReferences);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        textareaRef.current?.focus();
        toast.success(
          usesPublicImageFallback
            ? "未公开原始参考图，已使用公开图和可用参数"
            : `已带入原始提示词、${loadedReferences.length} 张原始参考图和生成参数`,
          { id: toastId },
        );
      })
      .catch(() => {
        if (promptApplyRequestIdRef.current !== requestId) {
          toast.dismiss(toastId);
          return;
        }
        toast.error("参考图读取失败，未修改创作台", { id: toastId });
      });
  }, [defaultImageModel, isLoadingHistory, replaceReferenceImages]);

  useLayoutEffect(() => {
    const turnCount = selectedConversation?.turns.length ?? 0;
    const previousTarget = lastResultsScrollTargetRef.current;
    const conversationChanged = previousTarget.conversationId !== selectedConversationId;
    const turnAdded = !conversationChanged && turnCount > previousTarget.turnCount;

    lastResultsScrollTargetRef.current = {
      conversationId: selectedConversationId,
      turnCount,
    };

    if (!selectedConversationId) {
      shouldStickToResultsBottomRef.current = true;
      setShowScrollToBottom(false);
      return;
    }
    if (!conversationChanged && !turnAdded) {
      return;
    }

    shouldStickToResultsBottomRef.current = true;
    setShowScrollToBottom(false);
    const frame = window.requestAnimationFrame(() => scrollResultsToBottom(conversationChanged ? "auto" : "smooth"));
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [scrollResultsToBottom, selectedConversation?.turns.length, selectedConversationId]);

  useLayoutEffect(() => {
    if (!selectedConversationId || !shouldStickToResultsBottomRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => scrollResultsToBottom("auto"));
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [composerDockHeight, progressByTurnKey, scrollResultsToBottom, selectedConversation, selectedConversationId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (selectedConversationId) {
      window.localStorage.setItem(ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY, selectedConversationId);
    } else {
      window.localStorage.removeItem(ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY);
    }
  }, [selectedConversationId]);

  useEffect(() => {
    const handleOpenConversation = (event: Event) => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (conversationId) {
        setSelectedConversationId(conversationId);
        if (!conversationsRef.current.some((conversation) => conversation.id === conversationId)) {
          void getImageConversation(conversationId)
            .then((conversation) => {
              if (!conversation || !pageActiveRef.current) {
                return;
              }
              const mergedItems = mergeImageConversationItems(conversationsRef.current, [conversation]);
              conversationsRef.current = mergedItems;
              setConversations(mergedItems);
            })
            .catch(() => undefined);
        }
      }
    };

    window.addEventListener(IMAGE_ACTIVE_CONVERSATION_REQUEST_EVENT, handleOpenConversation);
    return () => {
      window.removeEventListener(IMAGE_ACTIVE_CONVERSATION_REQUEST_EVENT, handleOpenConversation);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(COMPOSER_MODE_STORAGE_KEY, composerMode);
  }, [composerMode]);

  useEffect(() => {
    if (!imageCreationModelOptions.some((option) => option.value === imageModel)) {
      const nextModel = referenceImagesRef.current.length > 0
        ? imageCreationModelOptions.find((option) => supportsImageEditing(option.value))?.value || defaultImageModel
        : defaultImageModel;
      setImageModel(nextModel);
    }
  }, [defaultImageModel, imageCreationModelOptions, imageModel]);

  useEffect(() => {
    let ignore = false;
    void fetchModelConfig()
      .then((result) => {
        if (ignore) {
          return;
        }
        const imageOptions = modelOptionsFromNames(result.config.image_models);
        const nextImageDefault = result.config.default_image_model || imageOptions[0]?.value || DEFAULT_IMAGE_MODEL;
        setRelayImageModelOptions(ensureDefaultImageModelOption(imageOptions, nextImageDefault));
        const nextVideoModels = result.config.video_models?.length ? result.config.video_models : ["sora-2"];
        const nextVideoDefault = result.config.default_video_model || nextVideoModels[0] || "sora-2";
        setVideoModelOptions(nextVideoModels.map((model) => ({ value: model, label: model })));
        setVideoModel((current) => nextVideoModels.includes(current) ? current : nextVideoDefault);
      })
      .catch((error) => {
        if (ignore) {
          return;
        }
        void error;
        setRelayImageModelOptions(ensureDefaultImageModelOption(IMAGE_CREATION_MODEL_OPTIONS));
      });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIDEO_MODEL_STORAGE_KEY, videoModel);
    window.localStorage.setItem(VIDEO_SIZE_STORAGE_KEY, videoSize);
    window.localStorage.setItem(VIDEO_SECONDS_STORAGE_KEY, videoSeconds);
    window.localStorage.setItem(VIDEO_RESOLUTION_STORAGE_KEY, videoResolution);
    window.localStorage.setItem(VIDEO_AUDIO_STORAGE_KEY, String(videoGenerateAudio));
    window.localStorage.setItem(VIDEO_WATERMARK_STORAGE_KEY, String(videoWatermark));
  }, [videoGenerateAudio, videoModel, videoResolution, videoSeconds, videoSize, videoWatermark]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(IMAGE_MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (isImageQuality(imageQuality)) {
      window.localStorage.setItem(IMAGE_QUALITY_STORAGE_KEY, imageQuality);
    } else {
      window.localStorage.removeItem(IMAGE_QUALITY_STORAGE_KEY);
    }
  }, [imageQuality]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(IMAGE_STREAM_STORAGE_KEY, imageStreamEnabled ? "true" : "false");
  }, [imageStreamEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(IMAGE_PARTIAL_IMAGES_STORAGE_KEY, String(normalizeImagePartialImages(imagePartialImages)));
  }, [imagePartialImages]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleTokenNameChange = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key === imageRelayTokenStorageKey) {
          setImageRelayTokenName(getStoredRelayTokenName(session, "image"));
        } else if (event.key === videoRelayTokenStorageKey) {
          setVideoRelayTokenName(getStoredRelayTokenName(session, "video"));
        }
        return;
      }
      const detail = (event as CustomEvent<{ kind?: RelayTokenKind; tokenName?: string }>).detail;
      if (detail?.kind === "image") {
        setImageRelayTokenName(String(detail.tokenName ?? getStoredRelayTokenName(session, "image")));
      } else if (detail?.kind === "video") {
        setVideoRelayTokenName(String(detail.tokenName ?? getStoredRelayTokenName(session, "video")));
      }
    };
    window.addEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
    window.addEventListener("storage", handleTokenNameChange);
    return () => {
      window.removeEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
      window.removeEventListener("storage", handleTokenNameChange);
    };
  }, [imageRelayTokenStorageKey, videoRelayTokenStorageKey, session]);

  useEffect(() => {
    setImageRelayTokenName(getStoredRelayTokenName(session, "image"));
    setVideoRelayTokenName(getStoredRelayTokenName(session, "video"));
  }, [imageRelayTokenStorageKey, videoRelayTokenStorageKey, session]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let ignore = false;
    clearStoredRelayApiKey();
    void Promise.all([
      fetchProfileRelayKey(undefined, imageRelayTokenName.trim()),
      fetchProfileRelayKey(undefined, videoRelayTokenName.trim()),
    ])
      .then(([imageStatus, videoStatus]) => {
        if (ignore) return;
        const imageName = retainSelectedRelayTokenName(
          imageRelayTokenName,
          normalizeRelayTokenNames(imageStatus.token_names),
        );
        const videoName = retainSelectedRelayTokenName(
          videoRelayTokenName,
          normalizeRelayTokenNames(videoStatus.token_names),
        );
        const imageConfigured = Boolean(imageName && imageStatus.has_key);
        const videoConfigured = Boolean(videoName && videoStatus.has_key);
        setImageRelayTokenName(imageName);
        setVideoRelayTokenName(videoName);
        setRelayKeyConfigured({ image: imageConfigured, video: videoConfigured });
        setRelayKeyStatusMessage({
          image: imageConfigured ? "" : imageName ? imageStatus.message || NEWAPI_TOKEN_MISSING_MESSAGE : "请先选择用于生图的密钥",
          video: videoConfigured ? "" : videoName ? videoStatus.message || NEWAPI_TOKEN_MISSING_MESSAGE : "请先选择用于生视频的密钥",
        });
      })
      .catch(() => {
        if (ignore) return;
        setRelayKeyConfigured({ image: false, video: false });
        setRelayKeyStatusMessage({
          image: "无法读取云棉令牌状态，请稍后重试",
          video: "无法读取云棉令牌状态，请稍后重试",
        });
      });
    return () => {
      ignore = true;
    };
  }, [imageRelayTokenName, session, videoRelayTokenName]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(IMAGE_SIZE_MODE_STORAGE_KEY, imageSizeMode);
    if (imageAspectRatio) {
      window.localStorage.setItem(IMAGE_ASPECT_RATIO_STORAGE_KEY, imageAspectRatio);
    } else {
      window.localStorage.removeItem(IMAGE_ASPECT_RATIO_STORAGE_KEY);
    }
    window.localStorage.setItem(IMAGE_RESOLUTION_STORAGE_KEY, imageResolution);
    window.localStorage.setItem(IMAGE_CUSTOM_RATIO_STORAGE_KEY, imageCustomRatio);
    window.localStorage.setItem(IMAGE_CUSTOM_WIDTH_STORAGE_KEY, imageCustomWidth);
    window.localStorage.setItem(IMAGE_CUSTOM_HEIGHT_STORAGE_KEY, imageCustomHeight);
    if (imageSize) {
      window.localStorage.setItem(IMAGE_SIZE_STORAGE_KEY, imageSize);
      return;
    }
    window.localStorage.removeItem(IMAGE_SIZE_STORAGE_KEY);
  }, [imageAspectRatio, imageCustomHeight, imageCustomRatio, imageCustomWidth, imageResolution, imageSize, imageSizeMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(IMAGE_OUTPUT_FORMAT_STORAGE_KEY, imageOutputFormat);
    const normalizedCompression = normalizeOutputCompressionValue(imageOutputCompression);
    if (normalizedCompression === undefined || !supportsImageOutputCompression(imageOutputFormat)) {
      window.localStorage.removeItem(IMAGE_OUTPUT_COMPRESSION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(IMAGE_OUTPUT_COMPRESSION_STORAGE_KEY, String(normalizedCompression));
  }, [imageOutputCompression, imageOutputFormat]);

  useEffect(() => {
    const selectedConversation = selectedConversationId
      ? conversations.find((conversation) => conversation.id === selectedConversationId) ?? null
      : null;
    const needsSelectedConversationDetail = isImageConversationHistorySummaryOnly(selectedConversation);
    if (
      !selectedConversationId ||
      isLoadingHistory ||
      (selectedConversation && !needsSelectedConversationDetail) ||
      deletedConversationIdsRef.current.has(selectedConversationId) ||
      conversationHistoryDetailRecoveryRef.current.has(selectedConversationId)
    ) {
      return;
    }
    const conversationID = selectedConversationId;
    conversationHistoryDetailRecoveryRef.current.add(conversationID);
    let cancelled = false;
    void getImageConversation(conversationID)
      .then((conversation) => {
        if (cancelled || !pageActiveRef.current || selectedConversationId !== conversationID) {
          return;
        }
        if (conversation) {
          const mergedItems = mergeImageConversationItems(conversationsRef.current, [conversation]);
          conversationsRef.current = mergedItems;
          setConversations(mergedItems);
          return;
        }
        setSelectedConversationId(pickFallbackConversationId(conversationsRef.current));
      })
      .catch((error) => {
        const status = typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status?: unknown }).status)
          : Number.NaN;
        if (
          !cancelled &&
          pageActiveRef.current &&
          selectedConversationId === conversationID &&
            shouldFallbackToImageConversationHistoryDetail(status)
        ) {
          setSelectedConversationId(pickFallbackConversationId(conversationsRef.current));
        }
      })
      .finally(() => {
        conversationHistoryDetailRecoveryRef.current.delete(conversationID);
      });
    return () => {
      cancelled = true;
    };
  }, [conversations, isLoadingHistory, selectedConversationId]);

  const finishConversationWrite = useCallback(() => {
    conversationPendingWritesRef.current = Math.max(0, conversationPendingWritesRef.current - 1);
    if (
      pageActiveRef.current &&
      conversationPendingWritesRef.current === 0 &&
      conversationHistoryReadyRef.current &&
      conversationRefreshNeededRef.current
    ) {
      conversationRefreshNeededRef.current = false;
      window.dispatchEvent(new Event(IMAGE_CONVERSATIONS_CHANGED_EVENT));
    }
  }, []);

  const reportHistorySyncError = useCallback(() => {
    if (!pageActiveRef.current) {
      return;
    }
    const now = Date.now();
    if (now - historySyncErrorShownAtRef.current < 15_000) {
      return;
    }
    historySyncErrorShownAtRef.current = now;
    toast.error("历史记录同步失败，当前更改尚未写入数据库，请检查网络后重试");
  }, []);

  const handleLoadMoreHistory = useCallback(async () => {
    if (
      !pageActiveRef.current ||
      isLoadingHistory ||
      conversationHistoryLoadMoreRef.current ||
      !conversationHistoryHasMoreRef.current
    ) {
      return;
    }
    const cursor = conversationHistoryNextCursorRef.current;
    if (!cursor) {
      conversationHistoryHasMoreRef.current = false;
      setHasMoreHistory(false);
      return;
    }
    conversationHistoryLoadMoreRef.current = true;
    setIsLoadingMoreHistory(true);
    const mutationRevision = conversationMutationRevisionRef.current;
    const previousCursor = cursor;
    try {
      const page = await listImageConversationPage({
        limit: IMAGE_HISTORY_PAGE_SIZE,
        cursor,
      });
      if (
        !pageActiveRef.current ||
        mutationRevision !== conversationMutationRevisionRef.current
      ) {
        return;
      }
      const expectedGeneration = conversationHistoryGenerationRef.current;
      if (expectedGeneration && page.generation && expectedGeneration !== page.generation) {
        // A cursor from an older generation is no longer safe to append. The
        // next foreground refresh starts from page one and active tasks.
        conversationHistoryNextCursorRef.current = null;
        conversationHistoryHasMoreRef.current = false;
        setHasMoreHistory(false);
        conversationRefreshNeededRef.current = true;
        window.dispatchEvent(new Event(IMAGE_CONVERSATIONS_CHANGED_EVENT));
        return;
      }
      if (page.generation) {
        conversationHistoryGenerationRef.current = page.generation;
      }
      const mergedItems = mergeImageConversationItems(conversationsRef.current, page.items);
      conversationMutationRevisionRef.current += 1;
      conversationsRef.current = mergedItems;
      setConversations(mergedItems);
      const nextCursor = page.nextCursor && page.nextCursor !== previousCursor ? page.nextCursor : null;
      conversationHistoryNextCursorRef.current = nextCursor;
      conversationHistoryHasMoreRef.current = page.hasMore && nextCursor !== null;
      setHasMoreHistory(conversationHistoryHasMoreRef.current);
    } catch (error) {
      if (!pageActiveRef.current) {
        return;
      }
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : Number.NaN;
      if (shouldResetImageConversationHistoryCursor(status)) {
        conversationHistoryNextCursorRef.current = null;
        conversationHistoryHasMoreRef.current = false;
        setHasMoreHistory(false);
        conversationRefreshNeededRef.current = true;
        window.dispatchEvent(new Event(IMAGE_CONVERSATIONS_CHANGED_EVENT));
      } else {
        toast.error(error instanceof Error ? error.message : "读取更多历史记录失败");
      }
    } finally {
      conversationHistoryLoadMoreRef.current = false;
      if (pageActiveRef.current) {
        setIsLoadingMoreHistory(false);
      }
    }
  }, [isLoadingHistory]);

  const updateConversation = useCallback(
    async (
      conversationId: string,
      updater: (current: ImageConversation | null) => ImageConversation,
      options: { persist?: boolean | "coalesced" | "durable" } = {},
    ) => runExclusiveImageConversationMutation(
      conversationMutationChainsRef.current,
      conversationId,
      async () => {
        if (!pageActiveRef.current) {
          return null;
        }
        const current = conversationsRef.current.find((item) => item.id === conversationId) ?? null;
        if (!current && deletedConversationIdsRef.current.has(conversationId)) {
          return null;
        }
        const candidate = updater(current);
        if (current && candidate === current) {
          return current;
        }
        const persistence = options.persist ?? true;
        const baseRevision = Math.max(Number(current?.revision || 0), Number(candidate.revision || 0)) || 0;
        const nextRevision = persistence === false
          ? baseRevision
          : nextImageConversationRevision(
              current?.revision,
              candidate.revision,
              conversationRevisionReservationsRef.current.get(conversationId),
            );
        if (persistence !== false) {
          conversationRevisionReservationsRef.current.set(conversationId, nextRevision);
        }
        const nextConversation = {
          ...candidate,
          revision: nextRevision,
          updatedAt: new Date().toISOString(),
        };
        const nextConversations = sortImageConversations([
          nextConversation,
          ...conversationsRef.current.filter((item) => item.id !== conversationId),
        ]);

        if (persistence === "durable") {
          const destructiveEpoch = conversationDestructiveEpochRef.current;
          conversationPendingWritesRef.current += 1;
          try {
            const persistedConversation = await saveImageConversation(nextConversation);
            if (
              !pageActiveRef.current ||
              destructiveEpoch !== conversationDestructiveEpochRef.current
            ) {
              return null;
            }
            if (deletedConversationIdsRef.current.has(conversationId)) {
              return null;
            }
            const latestConversation = conversationsRef.current.find((item) => item.id === conversationId);
            const committedConversation = latestConversation
              ? mergeImageConversationSnapshot(latestConversation, persistedConversation)
              : persistedConversation;
            conversationRevisionReservationsRef.current.set(
              conversationId,
              Math.max(
                Number(conversationRevisionReservationsRef.current.get(conversationId) || 0),
                Number(committedConversation.revision || 0),
              ),
            );
            const durableConversations = sortImageConversations([
              committedConversation,
              ...conversationsRef.current.filter((item) => item.id !== conversationId),
            ]);
            conversationMutationRevisionRef.current += 1;
            conversationsRef.current = durableConversations;
            setConversations(durableConversations);
            return committedConversation;
          } catch (error) {
            discardFailedImageConversationSave(conversationId, error);
            if (pageActiveRef.current && !deletedConversationIdsRef.current.has(conversationId)) {
              reportHistorySyncError();
            }
            throw error;
          } finally {
            finishConversationWrite();
          }
        }

        if (persistence !== false) {
          conversationPendingWritesRef.current += 1;
        }
        conversationMutationRevisionRef.current += 1;
        conversationsRef.current = nextConversations;
        setConversations(nextConversations);
        if (persistence === "coalesced") {
          try {
            await saveImageConversationCoalesced(nextConversation);
          } catch {
            reportHistorySyncError();
          } finally {
            finishConversationWrite();
          }
        } else if (persistence) {
          try {
            await saveImageConversation(nextConversation);
          } finally {
            finishConversationWrite();
          }
        }
        return nextConversation;
      },
    ),
    [finishConversationWrite, reportHistorySyncError],
  );

  const updateTurnProgress = useCallback(
    (conversationId: string, turnId: string, updates: Omit<ImageTurnProgress, "startedAt"> & { startedAt?: number }) => {
      setImageTurnProgress(conversationId, turnId, updates);
    },
    [],
  );

  const clearTurnProgress = useCallback((conversationId: string, turnId: string) => {
    clearImageTurnProgress(conversationId, turnId);
  }, []);

  const clearComposerInputs = useCallback(() => {
    promptApplyRequestIdRef.current += 1;
    setImagePrompt("");
    setImageCount("1");
    setImageOutputFormat(DEFAULT_IMAGE_OUTPUT_FORMAT);
    setImageOutputCompression("");
    setDefaultImageVisibility("private");
    setVideoReferenceImageURLs([]);
    setVideoReferenceVideoURLs([]);
    setVideoReferenceAudioURLs([]);
    replaceReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [replaceReferenceImages]);

  const resetComposer = useCallback(() => {
    clearComposerInputs();
  }, [clearComposerInputs]);

  const handleCreateDraft = () => {
    setSelectedConversationId(null);
    resetComposer();
    textareaRef.current?.focus();
  };

  const handleApplyPromptPreset = useCallback(async (preset: ImagePromptPreset) => {
    if (!supportsImageEditing(imageModel)) {
      toast.error(`模型 ${imageModel} 暂不支持参考图编辑`);
      return;
    }
    const requestId = promptApplyRequestIdRef.current + 1;
    promptApplyRequestIdRef.current = requestId;
    const presetSizeSelection = getImageSizeSelectionFromSize(preset.size);

    const toastId = toast.loading("正在读取参考图");
    try {
      const [referenceImage] = await buildReferenceImagesFromUrls([preset.imageSrc], "preset-reference");
      if (promptApplyRequestIdRef.current !== requestId) {
        toast.dismiss(toastId);
        return;
      }
      if (!referenceImage) {
        throw new Error("参考图上传响应为空");
      }
      setSelectedConversationId(null);
      setComposerMode("image");
      setImagePrompt(preset.prompt);
      setImageCount(String(preset.count));
      setImageSizeMode(presetSizeSelection.mode);
      setImageAspectRatio(presetSizeSelection.aspectRatio);
      setImageResolution(presetSizeSelection.resolution);
      setImageCustomRatio(presetSizeSelection.customRatio);
      setImageCustomWidth(presetSizeSelection.customWidth);
      setImageCustomHeight(presetSizeSelection.customHeight);
      setImageOutputFormat(DEFAULT_IMAGE_OUTPUT_FORMAT);
      setImageOutputCompression("");
      setDefaultImageVisibility("private");
      replaceReferenceImages([referenceImage]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      textareaRef.current?.focus();
      toast.success("已套用提示词和参考图", { id: toastId });
    } catch {
      if (promptApplyRequestIdRef.current !== requestId) {
        toast.dismiss(toastId);
        return;
      }
      toast.error("参考图读取失败，未修改创作台", { id: toastId });
    }
  }, [imageModel, replaceReferenceImages]);

  const handleApplyMarketPrompt = useCallback(async (prompt: BananaPrompt) => {
    const referenceImageUrls = getPromptReferenceImageUrls(prompt);
    const requestId = promptApplyRequestIdRef.current + 1;
    promptApplyRequestIdRef.current = requestId;

    const applyPrompt = (loadedReferences: StoredReferenceImage[]) => {
      setSelectedConversationId(null);
      setComposerMode("image");
      setImagePrompt(prompt.prompt);
      setImageCount("1");
      setImageSizeMode("auto");
      setImageAspectRatio("");
      setImageResolution("auto");
      setImageCustomRatio(DEFAULT_IMAGE_CUSTOM_RATIO);
      setImageCustomWidth(DEFAULT_IMAGE_CUSTOM_WIDTH);
      setImageCustomHeight(DEFAULT_IMAGE_CUSTOM_HEIGHT);
      setImageQuality("");
      setImageOutputFormat(DEFAULT_IMAGE_OUTPUT_FORMAT);
      setImageOutputCompression("");
      setImageStreamEnabled(true);
      setImagePartialImages("0");
      setDefaultImageVisibility("private");
      replaceReferenceImages(loadedReferences);
      setIsPromptMarketOpen(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      textareaRef.current?.focus();
    };

    if (referenceImageUrls.length === 0) {
      applyPrompt([]);
      toast.success("已套用提示词");
      return;
    }

    if (!supportsImageEditing(imageModel)) {
      toast.error(`模型 ${imageModel} 暂不支持参考图编辑`);
      return;
    }
    const referenceLimitMessage = imageConversationReferenceLimitMessage(
      0,
      referenceImageUrls.length,
      imageReferenceImageLimit(imageModel),
    );
    if (referenceLimitMessage) {
      toast.error(referenceLimitMessage);
      return;
    }

    const toastId = toast.loading(`正在读取 ${referenceImageUrls.length} 张参考图`);
    try {
      const loadedReferences = await buildReferenceImagesFromUrls(referenceImageUrls, "prompt-reference");
      if (promptApplyRequestIdRef.current !== requestId) {
        toast.dismiss(toastId);
        return;
      }
      applyPrompt(loadedReferences);
      toast.success("已套用提示词和参考图", { id: toastId });
    } catch {
      if (promptApplyRequestIdRef.current !== requestId) {
        toast.dismiss(toastId);
        return;
      }
      toast.error("参考图读取失败，未修改创作台", { id: toastId });
    }
  }, [imageModel, replaceReferenceImages]);

  const handleDeleteConversation = async (id: string) => {
    const targetConversation = conversationsRef.current.find((item) => item.id === id);
    const nextConversations = conversationsRef.current.filter((item) => item.id !== id);
    deletedConversationIdsRef.current.add(id);
    for (const turn of targetConversation?.turns || []) {
      if (isTurnInProgress(turn)) {
        cancelledTurnIdsRef.current.add(imageTurnProgressKey(id, turn.id));
      }
    }
    const taskIds = Array.from(new Set(
      targetConversation?.turns.flatMap((turn) =>
        turn.images.flatMap((image) => image.status === "loading" && image.taskId ? [image.taskId] : []),
      ) || [],
    ));
    if (taskIds.length > 0) {
      void Promise.allSettled(taskIds.map((taskId) => cancelCreationTask(taskId, creationTaskRequestOptions)));
    }
    conversationPendingWritesRef.current += 1;
    conversationMutationRevisionRef.current += 1;
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    if (selectedConversationId === id) {
      setSelectedConversationId(pickFallbackConversationId(nextConversations));
      resetComposer();
    }

    try {
      await deleteImageConversation(id);
      conversationRevisionReservationsRef.current.delete(id);
    } catch (error) {
      deletedConversationIdsRef.current.delete(id);
      if (!pageActiveRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      const {
        firstPage,
        activePage,
        generation: windowGeneration,
      } = await loadImageConversationHistoryWindow(IMAGE_HISTORY_PAGE_SIZE);
      const items = mergeImageConversationItems(firstPage.items, activePage.items);
      conversationHistoryNextCursorRef.current = firstPage.nextCursor;
      conversationHistoryHasMoreRef.current = firstPage.hasMore;
      conversationHistoryGenerationRef.current = windowGeneration;
      setHasMoreHistory(firstPage.hasMore);
      conversationsRef.current = items;
      setConversations(items);
    } finally {
      finishConversationWrite();
    }
  };

  const handleClearHistory = async () => {
    const clearingConversations = conversationsRef.current;
    conversationDestructiveEpochRef.current += 1;
    conversationMutationRevisionRef.current += 1;
    for (const conversation of clearingConversations) {
      deletedConversationIdsRef.current.add(conversation.id);
      for (const turn of conversation.turns) {
        if (isTurnInProgress(turn)) {
          cancelledTurnIdsRef.current.add(imageTurnProgressKey(conversation.id, turn.id));
        }
      }
    }
    const taskIds = Array.from(new Set(clearingConversations.flatMap((conversation) =>
      conversation.turns.flatMap((turn) =>
        turn.images.flatMap((image) => image.status === "loading" && image.taskId ? [image.taskId] : []),
      ),
    )));
    if (taskIds.length > 0) {
      void Promise.allSettled(taskIds.map((taskId) => cancelCreationTask(taskId, creationTaskRequestOptions)));
    }
    conversationPendingWritesRef.current += 1;
    try {
      await clearImageConversations();
      if (!pageActiveRef.current) {
        return;
      }
      conversationRevisionReservationsRef.current.clear();
      conversationHistoryNextCursorRef.current = null;
      conversationHistoryGenerationRef.current = null;
      conversationHistoryHasMoreRef.current = false;
      conversationHistoryDetailRecoveryRef.current.clear();
      setHasMoreHistory(false);
      conversationsRef.current = [];
      setConversations([]);
      setSelectedConversationId(null);
      resetComposer();
      toast.success("已清空历史记录");
    } catch (error) {
      for (const conversation of clearingConversations) {
        deletedConversationIdsRef.current.delete(conversation.id);
      }
      if (!pageActiveRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
      try {
        const {
          firstPage,
          activePage,
          generation: windowGeneration,
        } = await loadImageConversationHistoryWindow(IMAGE_HISTORY_PAGE_SIZE);
        const items = mergeImageConversationItems(firstPage.items, activePage.items);
        conversationHistoryNextCursorRef.current = firstPage.nextCursor;
        conversationHistoryHasMoreRef.current = firstPage.hasMore;
        conversationHistoryGenerationRef.current = windowGeneration;
        setHasMoreHistory(firstPage.hasMore);
        conversationsRef.current = items;
        setConversations(items);
      } catch {
        conversationRefreshNeededRef.current = true;
      }
    } finally {
      finishConversationWrite();
    }
  };

  const openDeleteConversationConfirm = (id: string) => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "one", id });
  };

  const openClearHistoryConfirm = () => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "all" });
  };

  const handleConfirmDelete = async () => {
    const target = deleteConfirm;
    setDeleteConfirm(null);
    if (!target) {
      return;
    }
    if (target.type === "all") {
      await handleClearHistory();
      return;
    }
    await handleDeleteConversation(target.id);
  };

  const appendReferenceImages = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    promptApplyRequestIdRef.current += 1;
    if (composerMode !== "video" && !supportsImageEditing(imageModel)) {
      toast.error(`模型 ${imageModel} 暂不支持参考图编辑`);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }
    const limitMessage = imageConversationReferenceLimitMessage(
      referenceImagesRef.current.length + referenceUploadPendingCountRef.current,
      files.length,
      composerMode === "video" ? videoReferenceImageLimit(videoModel) : imageReferenceImageLimit(imageModel),
    );
    if (limitMessage) {
      toast.error(limitMessage);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }
    const uploadEpoch = referenceUploadEpochRef.current;
    referenceUploadPendingCountRef.current += files.length;

    try {
      const uploaded = await uploadReferenceFiles(files);
      if (uploadEpoch !== referenceUploadEpochRef.current) {
        return;
      }
      setReferenceImages((previous) => {
        const next = [...previous, ...uploaded];
        referenceImagesRef.current = next;
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "上传参考图失败";
      toast.error(message);
    } finally {
      referenceUploadPendingCountRef.current = Math.max(0, referenceUploadPendingCountRef.current - files.length);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [composerMode, imageModel, videoModel]);

  const handleReferenceImageChange = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }
      if (composerMode === "video") {
        setVideoReferenceMode("first-frame");
        setVideoReferenceVideoURLs([]);
        setVideoReferenceAudioURLs([]);
      }
      await appendReferenceImages(files);
    },
    [appendReferenceImages, composerMode],
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    setReferenceImages((prev) => {
      const next = prev.filter((_, currentIndex) => currentIndex !== index);
      referenceImagesRef.current = next;
      if (next.length === 0 && fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return next;
    });
  }, []);

  const handleImageModelChange = useCallback((model: ImageModel) => {
    if (referenceUploadPendingCountRef.current > 0) {
      toast.error("参考图正在上传，请稍候再切换模型");
      return;
    }
    if (referenceImagesRef.current.length > 0 && !supportsImageEditing(model)) {
      toast.error(`模型 ${model} 暂不支持参考图编辑，请先移除参考图`);
      return;
    }
    setImageModel(model);
  }, []);

  const handleComposerModeChange = useCallback((mode: "image" | "video") => {
    if (referenceUploadPendingCountRef.current > 0) {
      toast.error("参考图正在上传，请稍候再切换类型");
      return;
    }
    if (mode === "image" && referenceImagesRef.current.length > 0 && !supportsImageEditing(imageModel)) {
      toast.error(`模型 ${imageModel} 暂不支持参考图编辑，请先移除参考图`);
      return;
    }
    setComposerMode(mode);
  }, [imageModel]);

  const handleContinueEdit = useCallback(
    async (conversationId: string, image: StoredImage | StoredReferenceImage) => {
      if (!supportsImageEditing(imageModel)) {
        toast.error(`模型 ${imageModel} 暂不支持参考图编辑`);
        return;
      }
      const limitMessage = imageConversationReferenceLimitMessage(
        referenceImagesRef.current.length + referenceUploadPendingCountRef.current,
        1,
        imageReferenceImageLimit(imageModel),
      );
      if (limitMessage) {
        toast.error(limitMessage);
        return;
      }
      const uploadEpoch = referenceUploadEpochRef.current;
      referenceUploadPendingCountRef.current += 1;
      const toastId = toast.loading("正在加入编辑");
      try {
        const nextReference =
          "dataUrl" in image
            ? await ensureReferenceImageAsset(image, "conversation")
            : await buildReferenceImageFromStoredImage(
                image,
                `conversation-${conversationId}-${Date.now()}.${imageFileExtensionForOutputFormat(image.outputFormat)}`,
              );
        if (!nextReference || uploadEpoch !== referenceUploadEpochRef.current) {
          if (!nextReference) {
            toast.error("未找到可用的结果图，无法加入编辑", { id: toastId });
          } else {
            toast.dismiss(toastId);
          }
          return;
        }

        setSelectedConversationId(conversationId);
        setComposerMode("image");
        setReferenceImages((prev) => {
          const next = [...prev, nextReference];
          referenceImagesRef.current = next;
          return next;
        });
        setImagePrompt("");
        textareaRef.current?.focus();
        toast.success("已加入当前参考图，继续输入描述即可编辑", { id: toastId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取结果图失败";
        toast.error(message, { id: toastId });
      } finally {
        referenceUploadPendingCountRef.current = Math.max(0, referenceUploadPendingCountRef.current - 1);
      }
    },
    [imageModel],
  );

  const openLightbox = useCallback((images: ImageLightboxItem[], index: number) => {
    if (images.length === 0) {
      return;
    }

    setLightboxImages(images);
    setLightboxIndex(Math.max(0, Math.min(index, images.length - 1)));
    setLightboxOpen(true);
  }, []);

  const handleImageVisibilityChange = useCallback(
    async (
      conversationId: string,
      turnId: string,
      imageIndex: number,
      visibility: ImageVisibility,
      options: PublishRecipeOptions = { sharePromptParameters: false, shareReferenceImages: false },
    ) => {
      const targetConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const targetTurn = targetConversation?.turns.find((turn) => turn.id === turnId);
      const targetImage = targetTurn?.images[imageIndex];
      if (!targetConversation || !targetTurn || !targetImage) {
        toast.error("未找到对应的图片记录");
        return;
      }
      if (targetImage.status !== "success") {
        toast.error("图片生成成功后才能修改公开状态");
        return;
      }
      const path = storedImageVisibilityPath(targetImage);
      if (!path) {
        toast.error("未找到可同步到图库的图片路径");
        return;
      }
      const currentVisibility = targetImage.visibility || targetTurn.visibility || "private";
      if (visibility === "public" && currentVisibility !== "public" && !publishImageTarget) {
        setPublishRecipeOptions({ sharePromptParameters: false, shareReferenceImages: false });
        setPublishImageTarget({ conversationId, turnId, imageIndex });
        return;
      }

      const mutatingKey = `${conversationId}:${turnId}:${targetImage.id}`;
      if (visibilityMutatingImageKey === mutatingKey) {
        return;
      }
      if (visibilityMutatingImageKey) {
        return;
      }
      setVisibilityMutatingImageKey(mutatingKey);
      try {
        const data = await updateManagedImageVisibility(path, visibility, options);
        const updatedVisibility = data.item.visibility || visibility;
        const updatedPath = data.item.path || path;
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? targetConversation;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === turnId
                ? {
                    ...turn,
                    images: turn.images.map((image, index) =>
                      index === imageIndex
                        ? {
                            ...image,
                            path: updatedPath,
                            visibility: updatedVisibility,
                          }
                        : image,
                    ),
                  }
                : turn,
            ),
          };
        });
        clearImageManagerCache();
        toast.success(updatedVisibility === "public" ? "已公开到公开图库" : "已取消公开");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "更新公开状态失败");
      } finally {
        setVisibilityMutatingImageKey("");
      }
    },
    [publishImageTarget, updateConversation, visibilityMutatingImageKey],
  );

  const handleConfirmPublishImage = useCallback(async () => {
    if (!publishImageTarget || visibilityMutatingImageKey) {
      return;
    }
    const target = publishImageTarget;
    const options = {
      sharePromptParameters: publishRecipeOptions.sharePromptParameters,
      shareReferenceImages: publishRecipeOptions.sharePromptParameters && publishRecipeOptions.shareReferenceImages,
    };
    try {
      await handleImageVisibilityChange(target.conversationId, target.turnId, target.imageIndex, "public", options);
    } finally {
      setPublishImageTarget(null);
    }
  }, [handleImageVisibilityChange, publishImageTarget, publishRecipeOptions, visibilityMutatingImageKey]);

  const openEditTurnDialog = useCallback((conversationId: string, turnId: string) => {
    const targetConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
    const targetTurn = targetConversation?.turns.find((turn) => turn.id === turnId);
    if (!targetConversation || !targetTurn) {
      toast.error("未找到对应的生成记录");
      return;
    }
    if (targetTurn.mode === "chat") {
      toast.error("当前站点只支持图片生成");
      return;
    }
    if (isTurnInProgress(targetTurn)) {
      toast.error("当前轮次正在处理，稍后再编辑");
      return;
    }
    if (targetTurn.mode === "video") {
      setSelectedConversationId(conversationId);
      setComposerMode("video");
      setImagePrompt(targetTurn.prompt);
      setVideoModel(targetTurn.model);
      setVideoSize(targetTurn.size || "1280x720");
      setVideoSeconds(String(targetTurn.videoSeconds || 4));
      setVideoResolution(targetTurn.videoResolution || "720p");
      setVideoGenerateAudio(targetTurn.videoGenerateAudio ?? true);
      setVideoWatermark(targetTurn.videoWatermark ?? false);
      setVideoReferenceMode(targetTurn.videoReferenceMode === "reference" ? "reference" : "first-frame");
      setVideoReferenceImageURLs(targetTurn.videoReferenceImageURLs || []);
      setVideoReferenceVideoURLs(targetTurn.videoReferenceVideoURLs || []);
      setVideoReferenceAudioURLs(targetTurn.videoReferenceAudioURLs || []);
      replaceReferenceImages(targetTurn.referenceImages);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
      toast.message("已载入视频提示词和参数");
      return;
    }
    const sizeSelection = restoreImageSizeSelection(targetTurn.sizeSelection, targetTurn.size);
    setEditingTurnDraft({
      conversationId,
      turnId,
      prompt: targetTurn.prompt,
      model: imageCreationModelOptions.some((option) => option.value === targetTurn.model)
        ? targetTurn.model
        : defaultImageModel,
      mode: targetTurn.mode,
      count: String(normalizeRequestedImageCount(targetTurn.count || targetTurn.images.length || 1, targetTurn.model)),
      sizeMode: sizeSelection.mode,
      aspectRatio: sizeSelection.aspectRatio,
      resolution: sizeSelection.resolution,
      customRatio: sizeSelection.customRatio,
      customWidth: sizeSelection.customWidth,
      customHeight: sizeSelection.customHeight,
      quality: !isImageQuality(targetTurn.quality) ? "" : targetTurn.quality,
      outputFormat: targetTurn.outputFormat || DEFAULT_IMAGE_OUTPUT_FORMAT,
      outputCompression:
        targetTurn.outputCompression === undefined || targetTurn.outputCompression === null
          ? ""
          : String(targetTurn.outputCompression),
      stream: Boolean(targetTurn.stream),
      partialImages: String(normalizeImagePartialImages(targetTurn.partialImages)),
      tokenGroup: targetTurn.tokenGroup || "",
      tokenName: targetTurn.tokenName || "",
      visibility: targetTurn.visibility || "private",
      referenceImages: targetTurn.referenceImages,
    });
  }, [defaultImageModel, imageCreationModelOptions, replaceReferenceImages]);

  const handleEditReferenceImageChange = useCallback(async (files: File[]) => {
    const draft = editingTurnDraft;
    if (!draft || files.length === 0) {
      return;
    }
    if (!supportsImageEditing(draft.model)) {
      toast.error(`模型 ${draft.model} 暂不支持参考图编辑`);
      if (editFileInputRef.current) {
        editFileInputRef.current.value = "";
      }
      return;
    }
    const limitMessage = imageConversationReferenceLimitMessage(
      draft.referenceImages.length + editReferenceUploadPendingCountRef.current,
      files.length,
      imageReferenceImageLimit(draft.model),
    );
    if (limitMessage) {
      toast.error(limitMessage);
      if (editFileInputRef.current) {
        editFileInputRef.current.value = "";
      }
      return;
    }
    editReferenceUploadPendingCountRef.current += files.length;
    setEditReferenceUploadPendingCount(editReferenceUploadPendingCountRef.current);
    try {
      const uploaded = await uploadReferenceFiles(files);
      setEditingTurnDraft((current) =>
        current?.conversationId === draft.conversationId && current.turnId === draft.turnId
          ? {
              ...current,
              referenceImages: [...current.referenceImages, ...uploaded],
            }
          : current,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "上传参考图失败";
      toast.error(message);
    } finally {
      editReferenceUploadPendingCountRef.current = Math.max(0, editReferenceUploadPendingCountRef.current - files.length);
      setEditReferenceUploadPendingCount(editReferenceUploadPendingCountRef.current);
      if (editFileInputRef.current) {
        editFileInputRef.current.value = "";
      }
    }
  }, [editingTurnDraft]);

  const handleRemoveEditReferenceImage = useCallback((index: number) => {
    setEditingTurnDraft((current) =>
      current
        ? {
            ...current,
            referenceImages: current.referenceImages.filter((_, currentIndex) => currentIndex !== index),
          }
        : current,
    );
  }, []);

  const closeEditingTurnDialog = useCallback(() => {
    if (editReferenceUploadPendingCountRef.current > 0) {
      toast.message("参考图正在上传，请稍候");
      return;
    }
    setEditingTurnDraft(null);
  }, []);

  const runConversationQueue = useCallback(
    async (conversationId: string) => {
      const runnerSessionEpoch = pageSessionEpochRef.current;
      if (
        !pageActiveRef.current ||
        !canStartImageConversationQueueRunner(activeConversationQueueIdsRef.current, conversationId)
      ) {
        return;
      }

      const snapshot = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const activeTurn = snapshot?.turns.find(
        (turn) =>
          (turn.status === "queued" || turn.status === "generating") &&
          turn.images.some((image) => image.status === "loading"),
      );
      if (!snapshot || !activeTurn) {
        return;
      }

      activeConversationQueueIdsRef.current.add(conversationId);
      const observedTaskIds = new Set<string>();
      const activeTurnKey = imageTurnProgressKey(conversationId, activeTurn.id);
      const activeTurnStartedAt = imageTurnStartedAtTimestamp(activeTurn.processingStartedAt, activeTurn.createdAt);
      const taskDispatchIsAllowed = (taskIds: string[] = []) => canDispatchImageTurn({
        pageActive: pageActiveRef.current,
        sessionCurrent: runnerSessionEpoch === pageSessionEpochRef.current,
        conversationDeleted: deletedConversationIdsRef.current.has(conversationId),
        turnCancelled: cancelledTurnIdsRef.current.has(activeTurnKey),
        conversation: conversationsRef.current.find((conversation) => conversation.id === conversationId),
        turnId: activeTurn.id,
        taskIds,
      });
      const assertTaskDispatchAllowed = (taskIds: string[] = []) => {
        if (!taskDispatchIsAllowed(taskIds)) {
          throw new ImageTaskDispatchAbortedError();
        }
      };
      if (activeTurn.mode === "chat") {
        const message = "当前站点只支持图片生成";
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "error" as const,
                    error: message,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, status: "error" as const, error: message } : image,
                    ),
                  }
                : turn,
            ),
          };
        });
        clearTurnProgress(conversationId, activeTurn.id);
        activeConversationQueueIdsRef.current.delete(conversationId);
        return;
      }
      updateTurnProgress(conversationId, activeTurn.id, {
        message: "正在准备生成任务",
        detail: activeTurn.mode === "video"
          ? "正在准备视频生成参数"
          : `准备处理 ${activeTurn.images.filter((image) => image.status === "loading").length || activeTurn.count} 张图片`,
        startedAt: activeTurnStartedAt,
      });
      const applyTasks = async (tasks: CreationTask[]) => {
        const taskMap = new Map<string, CreationTask>();
        for (const task of mergeCreationTaskList(tasks)) {
          observedTaskIds.add(task.id);
          const previous = taskSnapshotsRef.current.get(task.id);
          const merged = mergeCreationTaskSnapshot(previous, task);
          taskSnapshotsRef.current.set(task.id, merged);
          taskMap.set(task.id, merged);
        }
        const currentTurn = conversationsRef.current
          .find((conversation) => conversation.id === conversationId)
          ?.turns.find((turn) => turn.id === activeTurn.id);
        const shouldPersistTaskSnapshot = tasks.some((task) => !isTaskActive(task.status)) || tasks.some(
          (task) =>
            task.status === "running" &&
            currentTurn?.images.some(
              (image) =>
                image.status === "loading" &&
                (image.taskId || image.id) === task.id &&
                image.taskStatus !== "running",
            ),
        ) || Boolean(currentTurn?.images.some((image, imageIndex) => {
          if (image.status !== "loading") {
            return false;
          }
          const task = taskMap.get(image.taskId || image.id);
          if (!task || !isTaskActive(task.status)) {
            return false;
          }
          const dataIndex = imageDataIndexForTask(currentTurn.images, imageIndex);
          const slotStatus = effectiveTaskSlotStatus(
            task.status,
            task.output_statuses?.[dataIndex],
            task.data?.[dataIndex],
            task.output_statuses?.length,
          );
          return slotStatus === "success" || slotStatus === "error" || slotStatus === "cancelled";
        }));
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          let completedActiveTurn = false;
          let conversationChanged = false;
          const turns = conversation.turns.map((turn) => {
            if (turn.id !== activeTurn.id) {
              return turn;
            }
            let turnChanged = false;
            const images = turn.images.map((image, imageIndex) => {
              const taskId = image.taskId || image.id;
              const task = taskMap.get(taskId);
              if (!task) {
                return image;
              }
              const taskImage = image.taskId === taskId ? image : { ...image, taskId };
              const nextImage = taskDataToStoredImage(taskImage, task, imageDataIndexForTask(turn.images, imageIndex), turn.visibility);
              if (nextImage !== image) {
                turnChanged = true;
              }
              return nextImage;
            });
            const derived = deriveTurnStatusFromTaskMap(turn, images);
            const currentCounts = getImageTurnLoadingCounts(turn);
            const nextCounts = getImageTurnLoadingCounts({ images });
            const nextProcessingStartedAt =
              nextCounts.running > 0 && currentCounts.running === 0
                ? new Date().toISOString()
                : turn.processingStartedAt;
            if (
              !turnChanged &&
              derived.status === turn.status &&
              derived.error === turn.error &&
              nextProcessingStartedAt === turn.processingStartedAt
            ) {
              return turn;
            }
            const nextTurn = {
              ...turn,
              ...derived,
              processingStartedAt: nextProcessingStartedAt,
              images,
            };
            if (isTurnInProgress(turn) && !isTurnInProgress(nextTurn)) {
              completedActiveTurn = true;
            }
            conversationChanged = true;
            return nextTurn;
          });
          if (!conversationChanged) {
            return conversation;
          }
          const nextConversation = {
            ...conversation,
            turns,
          };
          return completedActiveTurn
            ? {
                ...nextConversation,
                updatedAt: new Date().toISOString(),
              }
            : nextConversation;
        }, { persist: shouldPersistTaskSnapshot ? "coalesced" : false });
      };

      let pollingUnavailable = false;
      try {
        if (activeTurn.images.some((image) => image.status === "loading" && !image.taskId)) {
          await updateConversation(conversationId, (current) => {
            const conversation = current ?? snapshot;
            return {
              ...conversation,
              turns: conversation.turns.map((turn) =>
                turn.id === activeTurn.id
                  ? {
                      ...turn,
                      error: undefined,
                      images: turn.images.map((image, imageIndex) =>
                        image.status === "loading" && !image.taskId
                          ? {
                              ...image,
                              taskId: imageTaskIdForImage(turn.id, turn.model, turn.images, imageIndex),
                            }
                          : image,
                      ),
                    }
                  : turn,
              ),
            };
          });
        }

        updateTurnProgress(conversationId, activeTurn.id, {
          message: usesReferenceImages(activeTurn.mode) ? "正在整理参考图" : "正在准备生成请求",
          detail: usesReferenceImages(activeTurn.mode)
            ? "正在读取参考图并准备上传"
            : activeTurn.mode === "video" ? "正在创建视频生成任务" : "正在创建图片生成任务",
        });
        if (activeTurn.mode !== "video" && usesReferenceImages(activeTurn.mode) && !supportsImageEditing(activeTurn.model)) {
          throw new Error(`模型 ${activeTurn.model} 暂不支持参考图编辑`);
        }
        if (activeTurn.mode !== "video") {
          const referenceLimitMessage = imageConversationReferenceLimitMessage(
            0,
            activeTurn.referenceImages.length,
            imageReferenceImageLimit(activeTurn.model),
          );
          if (referenceLimitMessage) {
            throw new Error(referenceLimitMessage);
          }
        }
        const referenceFiles = await Promise.all(
          activeTurn.referenceImages.map((image, index) =>
            dataUrlToFile(image.dataUrl, image.name || `${activeTurn.id}-${index + 1}.png`, image.type),
          ),
        );
        if (usesReferenceImages(activeTurn.mode) && referenceFiles.length === 0) {
          throw new Error("未找到可用的参考图");
        }
        const activeTurnRelayTokenGroup = activeTurn.tokenGroup?.trim() || undefined;
        const activeTurnRelayTokenName = activeTurn.tokenName?.trim() || undefined;
        const videoReferenceUrls = activeTurn.mode === "video" && activeTurn.videoReferenceMode !== "reference"
          ? await Promise.all(referenceFiles.slice(0, 1).map(fileToDataUrl))
          : activeTurn.mode === "video" ? activeTurn.videoReferenceImageURLs || [] : [];
        const taskMessages = buildCreationTaskMessages(snapshot, activeTurn.id);
        const activeTurnSizeRequest = buildEffectiveImageSizeRequest(
          activeTurn.model,
          restoreImageSizeSelection(activeTurn.sizeSelection, activeTurn.size),
        );
        const taskOutputFormat = imageOutputFormatForModel(
          activeTurn.model,
          activeTurn.outputFormat || DEFAULT_IMAGE_OUTPUT_FORMAT,
        );
        const taskOutputCompression =
          taskOutputFormat === undefined
            ? undefined
            : imageOutputCompressionForModel(activeTurn.model, taskOutputFormat, activeTurn.outputCompression);
        const taskImageResolution =
          supportsStructuredImageParameters(activeTurn.model) && activeTurnSizeRequest.selection?.resolution !== "auto"
            ? activeTurnSizeRequest.selection?.resolution
            : undefined;
        const taskQuality = imageQualityForRequest(activeTurn.model, activeTurn.quality || "");
        const taskStream = supportsImageStreaming(activeTurn.model) && Boolean(activeTurn.stream);
        const taskPartialImages = taskStream ? normalizeImagePartialImages(activeTurn.partialImages) : 0;
        const pendingTaskGroups = activeTurn.images.reduce<Array<{ taskId: string; count: number }>>(
          (groups, image, imageIndex) => {
            if (image.status !== "loading") {
              return groups;
            }
            const taskId = imageTaskIdForImage(activeTurn.id, activeTurn.model, activeTurn.images, imageIndex);
            const existing = groups.find((group) => group.taskId === taskId);
            if (existing) {
              existing.count += 1;
            } else {
              groups.push({ taskId, count: 1 });
            }
            return groups;
          },
          [],
        );
        const submitTaskGroup = (group: { taskId: string; count: number }) => {
          if (activeTurn.mode === "video") {
            return createVideoGenerationTask(
              group.taskId,
              activeTurn.prompt,
              activeTurn.model,
              activeTurn.size || undefined,
              activeTurn.videoSeconds ?? 4,
              activeTurn.videoResolution || undefined,
              activeTurn.videoGenerateAudio ?? true,
              activeTurn.videoWatermark ?? false,
              videoReferenceUrls,
              activeTurn.videoReferenceVideoURLs,
              activeTurn.videoReferenceAudioURLs,
              activeTurn.videoReferenceMode || "first-frame",
              activeTurnRelayTokenName,
              creationTaskRequestOptions,
            );
          }
          if (usesReferenceImages(activeTurn.mode)) {
            return createImageEditTask(
              group.taskId,
              referenceFiles,
              activeTurn.prompt,
              activeTurn.model,
              activeTurnSizeRequest.upstreamSize,
              activeTurnSizeRequest.size,
              taskQuality,
              group.count,
              taskMessages,
              activeTurn.visibility || "private",
              taskImageResolution,
              taskOutputFormat,
              taskOutputCompression,
              taskStream,
              taskPartialImages,
              undefined,
              activeTurnRelayTokenGroup,
              activeTurnRelayTokenName,
              undefined,
              undefined,
              creationTaskRequestOptions,
            );
          }
          return createImageGenerationTask(
            group.taskId,
            activeTurn.prompt,
            activeTurn.model,
            activeTurnSizeRequest.upstreamSize,
            activeTurnSizeRequest.size,
            taskQuality,
            group.count,
            taskMessages,
            activeTurn.visibility || "private",
            taskImageResolution,
            taskOutputFormat,
            taskOutputCompression,
            taskStream,
            taskPartialImages,
            undefined,
            activeTurnRelayTokenGroup,
            activeTurnRelayTokenName,
            undefined,
            undefined,
            creationTaskRequestOptions,
          );
        };
        const submitTaskGroupWithRetry = async (group: { taskId: string; count: number }) => {
          assertTaskDispatchAllowed([group.taskId]);
          try {
            return await submitTaskGroup(group);
          } catch (error) {
            if (!isRetryableTaskPollError(error)) {
              throw error;
            }
            await sleep(750);
            assertTaskDispatchAllowed([group.taskId]);
            return submitTaskGroup(group);
          }
        };
        const cancelTaskGroupsAfterSameSessionAbort = async (taskIds: string[]) => {
          const uniqueTaskIds = Array.from(new Set(taskIds));
          const cancelAll = () => Promise.allSettled(
            uniqueTaskIds.map((taskId) => cancelCreationTask(taskId, creationTaskRequestOptions)),
          );
          await cancelAll();
          await sleep(500);
          await cancelAll();
        };
        const submitTaskGroups = async <T extends { taskId: string; count: number }>(groups: T[]) => {
          assertTaskDispatchAllowed(groups.map((group) => group.taskId));
          const results = await Promise.allSettled(groups.map(submitTaskGroupWithRetry));
          const submitted = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
          const failed = results.flatMap((result, index) =>
            result.status === "rejected" ? [{ group: groups[index], error: result.reason }] : [],
          );
          const dispatchAborted = failed.find(({ error }) => error instanceof ImageTaskDispatchAbortedError);
          if (dispatchAborted || !taskDispatchIsAllowed(groups.map((group) => group.taskId))) {
            if (pageActiveRef.current && runnerSessionEpoch === pageSessionEpochRef.current) {
              await cancelTaskGroupsAfterSameSessionAbort(groups.map((group) => group.taskId));
            }
            throw dispatchAborted?.error || new ImageTaskDispatchAbortedError();
          }
          return { submitted, failed };
        };
        const applyTaskSubmissionFailures = async (
          failures: Array<{ group: { taskId: string; count: number }; error: unknown }>,
        ) => {
          if (failures.length === 0) {
            return;
          }
          const errorsByTaskId = new Map(
            failures.map(({ group, error }) => [group.taskId, formatCreationTaskError(error, "提交图片任务失败")]),
          );
          await updateConversation(conversationId, (current) => {
            const conversation = current ?? snapshot;
            return {
              ...conversation,
              turns: conversation.turns.map((turn) => {
                if (turn.id !== activeTurn.id) {
                  return turn;
                }
                const images = turn.images.map((image) => {
                  const message = image.taskId ? errorsByTaskId.get(image.taskId) : undefined;
                  return image.status === "loading" && message
                    ? {
                        ...image,
                        taskStatus: "error" as const,
                        status: "error" as const,
                        error: message,
                      }
                    : image;
                });
                return { ...turn, ...deriveTurnStatus({ ...turn, images }), images };
              }),
            };
          }, { persist: "coalesced" });
          toast.error(`${failures.length} 个图片批次提交失败`);
        };
        updateTurnProgress(conversationId, activeTurn.id, {
          message: "正在提交生成请求",
          detail: `${pendingTaskGroups.length} 个图片任务正在入队`,
        });
        assertTaskDispatchAllowed(pendingTaskGroups.map((group) => group.taskId));
        const initialSubmission = await submitTaskGroups(pendingTaskGroups);
        const submitted = initialSubmission.submitted;
        let activeTaskIds = new Set(submitted.filter(isActiveCreationTask).map((task) => task.id));
        if (submitted.length > 0) {
          await applyTasks(submitted);
        }
        await applyTaskSubmissionFailures(initialSubmission.failed);
        if (submitted.length > 0) {
          const submittedStatus = submitted.every((task) => task.status === "queued") ? "queued" : "generating";
          updateTurnProgress(conversationId, activeTurn.id, imageTaskProgressMessage({ ...activeTurn, status: submittedStatus }));
        }

        let pollDelayMs = 1000;
        let pollErrorCount = 0;
        const pollDeadline = Date.now() + CREATION_TASK_POLL_MAX_DURATION_MS;
        while (true) {
          if (!pageActiveRef.current || runnerSessionEpoch !== pageSessionEpochRef.current) {
            break;
          }
          if (Date.now() >= pollDeadline) {
            pollingUnavailable = true;
            updateTurnProgress(conversationId, activeTurn.id, {
              message: "任务仍在处理中",
              detail: "暂时无法同步任务状态，稍后会自动重试",
            });
            break;
          }
          const latestConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
          const latestTurn = latestConversation?.turns.find((turn) => turn.id === activeTurn.id);
          const loadingTaskIds = Array.from(
            new Set(
              latestTurn?.images.flatMap((image) =>
                image.status === "loading" && image.taskId ? [image.taskId] : [],
              ) || [],
            ),
          );
          const pollingTaskIds = Array.from(new Set([...loadingTaskIds, ...activeTaskIds]));
          if (pollingTaskIds.length === 0) {
            break;
          }

          const progressSnapshot = getImageTurnProgressSnapshot()[activeTurnKey];
          const elapsedSeconds =
            progressSnapshot && Number.isFinite(progressSnapshot.startedAt)
              ? Math.max(0, Math.floor((Date.now() - progressSnapshot.startedAt) / 1000))
              : Math.max(0, Math.floor((Date.now() - activeTurnStartedAt) / 1000));
          const progressTurn = latestTurn ?? activeTurn;
          const progressCopy = imageTaskProgressMessage(progressTurn, elapsedSeconds);
          updateTurnProgress(conversationId, activeTurn.id, {
            message: progressCopy.message,
            detail: imageTaskLoadingDetail(progressTurn, progressCopy.detail),
          });
          await sleep(pollDelayMs);
          if (!pageActiveRef.current || runnerSessionEpoch !== pageSessionEpochRef.current) {
            break;
          }
          let taskList: Awaited<ReturnType<typeof fetchCreationTasks>>;
          try {
            taskList = await fetchCreationTasks(pollingTaskIds, creationTaskRequestOptions);
            pollErrorCount = 0;
          } catch (error) {
            if (!isRetryableTaskPollError(error)) {
              throw error;
            }
            if (pollErrorCount >= CREATION_TASK_POLL_MAX_ERROR_RETRIES || Date.now() >= pollDeadline) {
              pollingUnavailable = true;
              updateTurnProgress(conversationId, activeTurn.id, {
                message: "任务仍在处理中",
                detail: "暂时无法同步任务状态，稍后会自动重试",
              });
              break;
            }
            pollErrorCount += 1;
            const retryDelay = Math.min(
              CREATION_TASK_POLL_MAX_RETRY_DELAY_MS,
              1000 * 2 ** (pollErrorCount - 1),
            );
            updateTurnProgress(conversationId, activeTurn.id, {
              message: "正在等待生成任务",
              detail: `任务状态读取失败，${Math.ceil(retryDelay / 1000)} 秒后重试（第 ${pollErrorCount} 次）`,
            });
            await sleep(retryDelay);
            continue;
          }
          pollDelayMs = Math.min(2500, Math.round(pollDelayMs * 1.5));
          if (taskList.items.length > 0) {
            const mergedTasks = mergeCreationTaskList(taskList.items).map((task) => {
              const previous = taskSnapshotsRef.current.get(task.id);
              const merged = mergeCreationTaskSnapshot(previous, task);
              taskSnapshotsRef.current.set(task.id, merged);
              observedTaskIds.add(task.id);
              return merged;
            });
            activeTaskIds = new Set(mergedTasks.filter(isActiveCreationTask).map((task) => task.id));
            await applyTasks(mergedTasks);
          }
          for (const missingTaskId of taskList.missing_ids) {
            activeTaskIds.delete(missingTaskId);
          }
          const latestAfterApply = conversationsRef.current.find((conversation) => conversation.id === conversationId);
          const latestTurnAfterApply = latestAfterApply?.turns.find((turn) => turn.id === activeTurn.id);
          if (taskList.missing_ids.length > 0 && latestTurnAfterApply) {
            updateTurnProgress(conversationId, activeTurn.id, {
              message: "正在恢复生成任务",
              detail: `${taskList.missing_ids.length} 个任务状态丢失，正在重新提交`,
            });
            const missingTaskGroups = taskList.missing_ids.flatMap((taskId) => {
              const count = latestTurnAfterApply.images.filter((image) => image.status === "loading" && image.taskId === taskId).length;
              return count > 0
                ? [{ previousTaskId: taskId, taskId: `${taskId}-recovery-${createId()}`, count }]
                : [];
            });
            if (missingTaskGroups.length > 0) {
              const recoveryTaskIds = new Map(
                missingTaskGroups.map((group) => [group.previousTaskId, group.taskId]),
              );
              for (const group of missingTaskGroups) {
                taskSnapshotsRef.current.delete(group.previousTaskId);
                taskSnapshotsRef.current.delete(group.taskId);
              }
              const recoveryPersisted = await updateConversation(conversationId, (current) => {
                const conversation = current ?? latestAfterApply ?? snapshot;
                return {
                  ...conversation,
                  turns: conversation.turns.map((turn) =>
                    turn.id === activeTurn.id
                      ? {
                          ...turn,
                          status: "queued" as const,
                          images: turn.images.map((image) => {
                            const recoveryTaskId = image.taskId ? recoveryTaskIds.get(image.taskId) : undefined;
                            return image.status === "loading" && recoveryTaskId
                              ? {
                                  ...image,
                                  taskId: recoveryTaskId,
                                  taskRevision: undefined,
                                  taskStatus: "queued" as const,
                                  b64_json: undefined,
                                  url: undefined,
                                  path: undefined,
                                  width: undefined,
                                  height: undefined,
                                  resolution: undefined,
                                  qualityCheck: undefined,
                                  taskCreatedAt: undefined,
                                  taskUpdatedAt: undefined,
                                  generationDurationMs: undefined,
                                }
                              : image;
                          }),
                        }
                      : turn,
                  ),
                };
              }, { persist: "durable" });
              if (!recoveryPersisted) {
                throw new ImageTaskDispatchAbortedError();
              }
            }
            assertTaskDispatchAllowed(missingTaskGroups.map((group) => group.taskId));
            const recoverySubmission = await submitTaskGroups(missingTaskGroups);
            if (recoverySubmission.submitted.length > 0) {
              await applyTasks(recoverySubmission.submitted);
              for (const task of recoverySubmission.submitted) {
                if (isActiveCreationTask(task)) {
                  activeTaskIds.add(task.id);
                }
              }
            }
            await applyTaskSubmissionFailures(recoverySubmission.failed);
          }
        }

        await flushImageConversationSaves().catch(reportHistorySyncError);
        const completedConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
        const completedTurn = completedConversation?.turns.find((turn) => turn.id === activeTurn.id);
        const completedStatus = completedTurn ? getEffectiveImageTurnStatus(completedTurn) : undefined;
        if (!pollingUnavailable && (completedStatus === "success" || completedStatus === "message")) {
          updateTurnProgress(conversationId, activeTurn.id, {
            message: "生成完成",
            detail: "正在刷新会话",
          });
        }
      } catch (error) {
        if (error instanceof ImageTaskDispatchAbortedError) {
          return;
        }
        if (!pageActiveRef.current) {
          return;
        }
        if (cancelledTurnIdsRef.current.has(activeTurnKey)) {
          return;
        }
        const message = formatCreationTaskError(error, "生成图片失败");
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "error",
                    error: message,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, status: "error", error: message } : image,
                    ),
                  }
                : turn,
            ),
          };
        });
        toast.error(message);
      } finally {
        if (pageActiveRef.current) {
          await flushImageConversationSaves().catch(reportHistorySyncError);
        }
        const turnWasCancelled = cancelledTurnIdsRef.current.has(activeTurnKey);
        clearTurnProgress(conversationId, activeTurn.id);
        cancelledTurnIdsRef.current.delete(activeTurnKey);
        activeConversationQueueIdsRef.current.delete(conversationId);
        if (
          pageActiveRef.current &&
          pollingUnavailable &&
          !turnWasCancelled &&
          !deletedConversationIdsRef.current.has(conversationId)
        ) {
          window.setTimeout(() => {
            if (
              pageActiveRef.current &&
              runnerSessionEpoch === pageSessionEpochRef.current &&
              !cancelledTurnIdsRef.current.has(activeTurnKey) &&
              !deletedConversationIdsRef.current.has(conversationId)
            ) {
              void runConversationQueue(conversationId);
            }
          }, 5000);
        }
        for (const taskId of observedTaskIds) {
          taskSnapshotsRef.current.delete(taskId);
        }
        for (const conversation of pageActiveRef.current ? conversationsRef.current : []) {
          if (pollingUnavailable && conversation.id === conversationId) {
            continue;
          }
          if (
            !activeConversationQueueIdsRef.current.has(conversation.id) &&
            conversation.turns.some(
              (turn) =>
                (turn.status === "queued" || turn.status === "generating") &&
                turn.images.some((image) => image.status === "loading"),
            )
          ) {
            void runConversationQueue(conversation.id);
          }
        }
      }
    },
    [
      clearTurnProgress,
      creationTaskRequestOptions,
      reportHistorySyncError,
      updateConversation,
      updateTurnProgress,
    ],
  );
  useEffect(() => {
    for (const conversation of conversations) {
      if (
        !activeConversationQueueIdsRef.current.has(conversation.id) &&
        conversation.turns.some(
          (turn) =>
            (turn.status === "queued" || turn.status === "generating") &&
            turn.images.some((image) => image.status === "loading"),
        )
      ) {
        void runConversationQueue(conversation.id);
      }
    }
  }, [conversations, runConversationQueue]);

  const handleCancelTurn = useCallback(
    async (conversationId: string, turnId: string) => {
      const targetConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const targetTurn = targetConversation?.turns.find((turn) => turn.id === turnId);
      if (!targetConversation || !targetTurn) {
        toast.error("未找到对应的生成记录");
        return;
      }
      const turnKey = imageTurnProgressKey(conversationId, turnId);
      cancelledTurnIdsRef.current.add(turnKey);
      clearTurnProgress(conversationId, turnId);
      if (targetTurn.mode === "chat") {
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? targetConversation;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) => {
              if (turn.id !== turnId) {
                return turn;
              }
              const images = turn.images.map((image) =>
                image.status === "loading"
                  ? {
                      ...image,
                      status: "cancelled" as const,
                      error: "请求已终止",
                    }
                  : image,
              );
              return {
                ...turn,
                ...deriveTurnStatus({ ...turn, images }),
                images,
              };
            }),
          };
        });
        toast.success("已终止生成请求");
        return;
      }
      const taskIds = Array.from(
        new Set(targetTurn.images.flatMap((image) => (image.status === "loading" && image.taskId ? [image.taskId] : []))),
      );
      if (taskIds.length === 0) {
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? targetConversation;
          return {
            ...conversation,
            turns: conversation.turns.map((turn) => {
              if (turn.id !== turnId) {
                return turn;
              }
              const images = turn.images.map((image) =>
                image.status === "loading"
                  ? { ...image, status: "cancelled" as const, error: "请求已终止" }
                  : image,
              );
              return { ...turn, ...deriveTurnStatus({ ...turn, images }), images };
            }),
          };
        });
        toast.success("已终止生成请求");
        return;
      }

      const results = await Promise.allSettled(
        taskIds.map((taskId) => cancelCreationTask(taskId, creationTaskRequestOptions)),
      );
      if (!pageActiveRef.current) {
        return;
      }
      const taskMap = new Map(
        results.flatMap((result) => (result.status === "fulfilled" ? [[result.value.id, result.value] as const] : [])),
      );
      const failedRequests = results.filter((result) => result.status === "rejected").length;

      await updateConversation(conversationId, (current) => {
        const conversation = current ?? targetConversation;
        return {
          ...conversation,
          updatedAt: new Date().toISOString(),
          turns: conversation.turns.map((turn) => {
            if (turn.id !== turnId) {
              return turn;
            }
            const images = turn.images.map((image, imageIndex) => {
              if (image.status !== "loading") {
                return image;
              }
              const taskId = image.taskId || image.id;
              const task = taskMap.get(taskId);
              if (task) {
                return taskDataToStoredImage({ ...image, taskId }, task, imageDataIndexForTask(turn.images, imageIndex), turn.visibility);
              }
              return {
                ...image,
                taskId,
                status: "cancelled" as const,
                error: failedRequests > 0 ? "终止请求失败，已在本地停止等待" : "任务已终止",
              };
            });
            const derived = deriveTurnStatus({ ...turn, images });
            return {
              ...turn,
              ...derived,
              images,
            };
          }),
        };
      });

      if (failedRequests > 0) {
        toast.error(`部分终止请求失败：${failedRequests}/${taskIds.length}`);
      } else {
        toast.success("已终止生成任务");
      }
    },
    [clearTurnProgress, creationTaskRequestOptions, updateConversation],
  );

  const handleRetryImage = useCallback(
    async (conversationId: string, turnId: string, imageIndex: number) => {
      const retryKey = `${conversationId}:${turnId}:${imageIndex}`;
      if (retryingImageIdsRef.current.has(retryKey)) {
        return;
      }

      const targetConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const targetTurn = targetConversation?.turns.find((turn) => turn.id === turnId);
      const targetImage = targetTurn?.images[imageIndex];
      if (!targetConversation || !targetTurn || !targetImage) {
        toast.error("未找到对应的图片记录");
        return;
      }
      if (targetTurn.mode === "chat" || targetImage.status === "message") {
        toast.error("当前站点只支持图片生成");
        return;
      }
      if (isTurnInProgress(targetTurn)) {
        toast.error("当前轮次正在处理，稍后再重试");
        return;
      }
      if (!targetTurn.prompt.trim()) {
        toast.error("请输入提示词");
        return;
      }
      if (targetImage.status !== "error") {
        toast.error("只有失败图片可以单独重试");
        return;
      }
      if (usesReferenceImages(targetTurn.mode) && targetTurn.referenceImages.length === 0) {
        toast.error("未找到可用的参考图");
        return;
      }
      if (usesReferenceImages(targetTurn.mode) && !supportsImageEditing(targetTurn.model)) {
        toast.error(`模型 ${targetTurn.model} 暂不支持参考图编辑`);
        return;
      }
      const referenceLimitMessage = imageConversationReferenceLimitMessage(
        0,
        targetTurn.referenceImages.length,
        imageReferenceImageLimit(targetTurn.model),
      );
      if (referenceLimitMessage) {
        toast.error(referenceLimitMessage);
        return;
      }
      if (!requireRelayToken(targetTurn.mode === "video" ? "video" : "image")) {
        return;
      }

      const turnQueueKey = imageTurnProgressKey(conversationId, turnId);
      if (queueingTurnIdsRef.current.has(turnQueueKey)) {
        return;
      }
      queueingTurnIdsRef.current.add(turnQueueKey);
      retryingImageIdsRef.current.add(retryKey);
      const now = new Date().toISOString();
      const retryTaskId = imageTaskBatchId(`${targetTurn.id}-${createId()}`, imageIndex, targetTurn.model);
      try {
        const retryPersisted = await updateConversation(conversationId, (current) => {
          const conversation = current ?? targetConversation;
          return {
            ...conversation,
            updatedAt: now,
            turns: conversation.turns.map((turn) => {
              if (turn.id !== turnId) {
                return turn;
              }
              const images: StoredImage[] = turn.images.map((image, index) =>
                index === imageIndex
                  ? {
                      ...image,
                      taskId: retryTaskId,
                      taskRevision: undefined,
                      taskStatus: "queued" as const,
                      status: "loading" as const,
                      b64_json: undefined,
                      url: undefined,
                      videoUrl: undefined,
                      mimeType: turn.mode === "video" ? "video/mp4" : undefined,
                      mediaType: turn.mode === "video" ? "video" as const : "image" as const,
                      path: undefined,
                      width: undefined,
                      height: undefined,
                      resolution: undefined,
                      qualityCheck: undefined,
                      taskCreatedAt: undefined,
                      taskUpdatedAt: undefined,
                      generationDurationMs: undefined,
                      visibility: targetTurn.visibility || "private",
                      revised_prompt: undefined,
                      text_response: undefined,
                      error: undefined,
                    }
                  : image,
              );
              const derived = deriveTurnStatus({ ...turn, status: "queued", images });
              return {
                ...turn,
                ...derived,
                processingStartedAt: undefined,
                tokenGroup: undefined,
                tokenName: relayTokenNameForKind(targetTurn.mode === "video" ? "video" : "image") || undefined,
                images,
              };
            }),
          };
        }, { persist: "durable" });
        if (!retryPersisted) {
          return;
        }
        void runConversationQueue(conversationId);
        toast.success("已加入重试队列");
      } catch (error) {
        if (pageActiveRef.current) {
          toast.error(formatCreationTaskError(error, "提交重试失败"));
        }
      } finally {
        retryingImageIdsRef.current.delete(retryKey);
        queueingTurnIdsRef.current.delete(turnQueueKey);
      }
    },
    [
      relayTokenNameForKind,
      requireRelayToken,
      runConversationQueue,
      updateConversation,
    ],
  );

  const handleRegenerateTurn = useCallback(
    async (conversationId: string, turnId: string) => {
      const targetConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const targetTurn = targetConversation?.turns.find((turn) => turn.id === turnId);
      if (!targetConversation || !targetTurn) {
        toast.error("未找到对应的生成记录");
        return;
      }
      if (targetTurn.mode === "chat") {
        toast.error("当前站点只支持图片生成");
        return;
      }
      if (!targetTurn.prompt.trim()) {
        toast.error("请输入提示词");
        return;
      }
      if (isTurnInProgress(targetTurn)) {
        toast.error("当前轮次正在处理，稍后再重新生成");
        return;
      }
      if (usesReferenceImages(targetTurn.mode) && targetTurn.referenceImages.length === 0) {
        toast.error("未找到可用的参考图");
        return;
      }
      if (usesReferenceImages(targetTurn.mode) && !supportsImageEditing(targetTurn.model)) {
        toast.error(`模型 ${targetTurn.model} 暂不支持参考图编辑`);
        return;
      }
      const referenceLimitMessage = imageConversationReferenceLimitMessage(
        0,
        targetTurn.referenceImages.length,
        imageReferenceImageLimit(targetTurn.model),
      );
      if (referenceLimitMessage) {
        toast.error(referenceLimitMessage);
        return;
      }
      if (!requireRelayToken(targetTurn.mode === "video" ? "video" : "image")) {
        return;
      }

      const turnQueueKey = imageTurnProgressKey(conversationId, turnId);
      if (queueingTurnIdsRef.current.has(turnQueueKey)) {
        return;
      }
      queueingTurnIdsRef.current.add(turnQueueKey);
      const now = new Date().toISOString();
      const regenerationId = createId();
      try {
        const regenerationPersisted = await updateConversation(conversationId, (current) => {
          const conversation = current ?? targetConversation;
          const isFirstTurn = conversation.turns[0]?.id === turnId;
          return {
            ...conversation,
            title: isFirstTurn ? buildConversationTitle(targetTurn.prompt) : conversation.title,
            updatedAt: now,
            turns: conversation.turns.map((turn) => {
              if (turn.id !== turnId) {
                return turn;
              }

              const imageCount = turn.mode === "video" ? 1 : normalizeRequestedImageCount(turn.count || turn.images.length || 1, turn.model);
              const visibility = turn.visibility || "private";
              return {
                ...turn,
                count: imageCount,
                status: "queued",
                error: undefined,
                processingStartedAt: undefined,
                tokenGroup: undefined,
                tokenName: relayTokenNameForKind(targetTurn.mode === "video" ? "video" : "image") || undefined,
                images: Array.from({ length: imageCount }, (_, index): StoredImage => {
                  const imageId = `${turn.id}-${regenerationId}-${index}`;
                  return {
                    id: imageId,
                    taskId: imageTaskBatchId(`${turn.id}-${regenerationId}`, index, turn.model),
                    taskStatus: "queued" as const,
                    status: "loading" as const,
                    mediaType: turn.mode === "video" ? "video" as const : "image" as const,
                    visibility,
                  };
                }),
              };
            }),
          };
        }, { persist: "durable" });
        if (!regenerationPersisted) {
          return;
        }
      } catch {
        return;
      } finally {
        queueingTurnIdsRef.current.delete(turnQueueKey);
      }
      void runConversationQueue(conversationId);
      toast.success("已加入重新生成队列");
    },
    [
      relayTokenNameForKind,
      requireRelayToken,
      runConversationQueue,
      updateConversation,
    ],
  );

  const handleSaveEditingTurn = useCallback(
    async (regenerate: boolean) => {
      const draft = editingTurnDraft;
      if (!draft) {
        return;
      }
      if (editReferenceUploadPendingCountRef.current > 0) {
        toast.error("参考图正在上传，请稍候");
        return;
      }
      const prompt = draft.prompt.trim();
      if (!prompt) {
        toast.error("请输入提示词");
        return;
      }

      const targetConversation = conversationsRef.current.find((conversation) => conversation.id === draft.conversationId);
      const targetTurn = targetConversation?.turns.find((turn) => turn.id === draft.turnId);
      if (!targetConversation || !targetTurn) {
        toast.error("未找到对应的生成记录");
        return;
      }
      if (draft.mode === "chat" || targetTurn.mode === "chat") {
        toast.error("当前站点只支持图片生成");
        return;
      }
      if (isTurnInProgress(targetTurn)) {
        toast.error("当前轮次正在处理，稍后再编辑");
        return;
      }
      if (regenerate && !requireRelayToken(targetTurn.mode === "video" ? "video" : "image")) {
        return;
      }
      const mode = getComposerConversationMode("image", draft.referenceImages);
      if (usesReferenceImages(mode) && !supportsImageEditing(draft.model)) {
        toast.error(`模型 ${draft.model} 暂不支持参考图编辑`);
        return;
      }
      const referenceLimitMessage = imageConversationReferenceLimitMessage(
        0,
        draft.referenceImages.length,
        imageReferenceImageLimit(draft.model),
      );
      if (referenceLimitMessage) {
        toast.error(referenceLimitMessage);
        return;
      }

      const imageCount = normalizeRequestedImageCount(draft.count, draft.model);
      const referenceImages = usesReferenceImages(mode) ? draft.referenceImages : [];
      const rawDraftSizeSelection = {
        mode: draft.sizeMode,
        aspectRatio: draft.aspectRatio,
        resolution: draft.resolution,
        customRatio: draft.customRatio,
        customWidth: draft.customWidth,
        customHeight: draft.customHeight,
      };
      const draftSizeRequest =
        buildEffectiveImageSizeRequest(draft.model, rawDraftSizeSelection);
      if (
        draftSizeRequest &&
        isInvalidCustomRatioSelection(
          draftSizeRequest.selection.mode,
          draftSizeRequest.selection.aspectRatio,
          draftSizeRequest.selection.customRatio,
        )
      ) {
        toast.error("请输入有效的自定义比例，例如 5:4 或 2.39:1");
        return;
      }
      const draftImageSize = draftSizeRequest?.size ?? "";
      const draftSelectionChanged = draftSizeRequest
        ? customImageSizeChanged(rawDraftSizeSelection, draftImageSize)
        : false;
      const draftSelection = draftSizeRequest
        ? applyNormalizedCustomImageSize(draftSizeRequest.selection, draftImageSize)
        : undefined;
      const draftStoredSizeSelection = draftSelection ? serializeImageSizeSelection(draftSelection) : undefined;
      if (
        draftSizeRequest?.selection.mode === "custom" &&
        !draftImageSize
      ) {
        toast.error("请填写有效的宽度和高度");
        return;
      }
      const draftOutputFormat =
        imageOutputFormatForModel(draft.model, draft.outputFormat);
      const draftOutputCompression =
        draftOutputFormat === undefined
          ? undefined
          : imageOutputCompressionForModel(draft.model, draftOutputFormat, draft.outputCompression);
      const draftQuality = imageQualityForRequest(draft.model, draft.quality);
      const draftStream = supportsImageStreaming(draft.model) && draft.stream;
      if (
        supportsStructuredImageParameters(draft.model) &&
        isHighResolutionImageSize(draftImageSize, draftSizeRequest?.selection)
      ) {
        const sizeLabel = formatImageSizeDisplay(draftImageSize);
        if (regenerate) {
          toast.message(`${sizeLabel} 属于高分辨率目标，实际像素以生成结果为准。`);
        }
      }
      const turnQueueKey = imageTurnProgressKey(draft.conversationId, draft.turnId);
      if (queueingTurnIdsRef.current.has(turnQueueKey)) {
        return;
      }
      queueingTurnIdsRef.current.add(turnQueueKey);
      const now = new Date().toISOString();
      const regenerationId = createId();
      try {
        const editPersisted = await updateConversation(draft.conversationId, (current) => {
          const conversation = current ?? targetConversation;
          const isFirstTurn = conversation.turns[0]?.id === draft.turnId;
          return {
            ...conversation,
            title: isFirstTurn ? buildConversationTitle(prompt) : conversation.title,
            updatedAt: now,
            turns: conversation.turns.map((turn) => {
              if (turn.id !== draft.turnId) {
                return turn;
              }

              const baseTurn = {
                ...turn,
                prompt,
                model: draft.model,
                mode,
                referenceImages,
                count: imageCount,
                size: draftImageSize,
                sizeSelection: draftStoredSizeSelection,
                quality: draftQuality,
                outputFormat: draftOutputFormat,
                outputCompression: draftOutputCompression,
                stream: draftStream,
                partialImages: draftStream ? normalizeImagePartialImages(draft.partialImages) : 0,
                tokenGroup: regenerate ? undefined : draft.tokenGroup || undefined,
                tokenName: regenerate
                  ? relayTokenNameForKind(targetTurn.mode === "video" ? "video" : "image") || undefined
                  : draft.tokenName || undefined,
                visibility: draft.visibility,
              };
              if (!regenerate) {
                return baseTurn;
              }
              return {
                ...baseTurn,
                status: "queued" as const,
                error: undefined,
                processingStartedAt: undefined,
                images: Array.from({ length: imageCount }, (_, index): StoredImage => {
                  const imageId = `${turn.id}-${regenerationId}-${index}`;
                  return {
                    id: imageId,
                    taskId: imageTaskBatchId(`${turn.id}-${regenerationId}`, index, draft.model),
                    taskStatus: "queued" as const,
                    status: "loading" as const,
                    visibility: baseTurn.visibility,
                  };
                }),
              };
            }),
          };
        }, { persist: regenerate ? "durable" : true });
        if (!editPersisted) {
          return;
        }
      } catch {
        return;
      } finally {
        queueingTurnIdsRef.current.delete(turnQueueKey);
      }

      setEditingTurnDraft(null);
      if (editFileInputRef.current) {
        editFileInputRef.current.value = "";
      }
      if (draftSelectionChanged && draftSelection) {
        toast.message(`宽高已自动校正为 ${formatImageSizeDisplay(draftImageSize)}`);
      }
      if (regenerate) {
        void runConversationQueue(draft.conversationId);
        toast.success("已保存并加入重新生成队列");
      } else {
        toast.success("已保存编辑设置");
      }
    },
    [
      editingTurnDraft,
      relayTokenNameForKind,
      requireRelayToken,
      runConversationQueue,
      updateConversation,
    ],
  );

  const handleSubmit = async () => {
    if (isSubmitDispatchingRef.current) {
      return;
    }
    if (referenceUploadPendingCountRef.current > 0) {
      toast.error("参考图正在上传，请稍候");
      return;
    }

    const videoMode = composerMode === "video";
    if (!requireRelayToken(videoMode ? "video" : "image")) {
      return;
    }

    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }
    const effectiveModel = videoMode
      ? (videoModelOptions.some((option) => option.value === videoModel) ? videoModel : videoModelOptions[0]?.value || "sora-2")
      : imageCreationModelOptions.some((option) => option.value === imageModel) ? imageModel : defaultImageModel;
    const selectedVideoSeconds = Number(videoSeconds);
    if (videoMode && !videoSecondsOptions(effectiveModel).includes(selectedVideoSeconds)) {
      toast.error("请输入当前视频模型支持的时长");
      return;
    }
    if (videoMode && videoRequiresReferenceImage(effectiveModel) && referenceImages.length === 0) {
      toast.error(`模型 ${effectiveModel} 仅支持图生视频，请上传一张首帧参考图`);
      return;
    }
    const normalizedVideoReferenceImages = cleanReferenceURLs(videoReferenceImageURLs);
    const normalizedVideoReferenceVideos = cleanReferenceURLs(videoReferenceVideoURLs);
    const normalizedVideoReferenceAudios = cleanReferenceURLs(videoReferenceAudioURLs);
    if (videoMode && videoReferenceMode === "reference") {
      if (!supportsVideoMultimodalReferences(effectiveModel)) {
        toast.error(`模型 ${effectiveModel} 尚未接入多模态参考生视频`);
        return;
      }
      const limits = videoMultimodalReferenceLimits(effectiveModel);
      if (normalizedVideoReferenceImages.length + normalizedVideoReferenceVideos.length + normalizedVideoReferenceAudios.length === 0) {
        toast.error("请至少填写一个参考图片、视频或音频 URL");
        return;
      }
      if (normalizedVideoReferenceImages.length > limits.image || normalizedVideoReferenceVideos.length > limits.video || normalizedVideoReferenceAudios.length > limits.audio) {
        toast.error(`当前模型最多支持 ${limits.image} 张参考图片、${limits.video} 个参考视频和 ${limits.audio} 个参考音频`);
        return;
      }
      if (![...normalizedVideoReferenceImages, ...normalizedVideoReferenceVideos, ...normalizedVideoReferenceAudios].every(isPublicReferenceURL)) {
        toast.error("多模态参考必须使用公网可访问的 http:// 或 https:// URL");
        return;
      }
    }
    if (!videoMode && referenceImages.length > 0 && !supportsImageEditing(effectiveModel)) {
      toast.error(`模型 ${effectiveModel} 暂不支持参考图编辑`);
      return;
    }
    const referenceLimitMessage = imageConversationReferenceLimitMessage(
      0,
      videoMode && videoReferenceMode === "reference" ? 0 : referenceImages.length,
      videoMode ? videoReferenceImageLimit(effectiveModel) : imageReferenceImageLimit(effectiveModel),
    );
    if (referenceLimitMessage) {
      toast.error(referenceLimitMessage);
      return;
    }
    isSubmitDispatchingRef.current = true;
    let draftProgressTarget: { conversationId: string; turnId: string } | null = null;

    try {
      const effectiveImageMode = getComposerConversationMode(composerMode, referenceImages);
      const requestedCount = videoMode ? 1 : normalizeRequestedImageCount(imageCount, effectiveModel);
      const rawImageSizeSelection = {
        mode: imageSizeMode,
        aspectRatio: imageAspectRatio,
        resolution: imageResolution,
        customRatio: imageCustomRatio,
        customWidth: imageCustomWidth,
        customHeight: imageCustomHeight,
      };
      const currentImageSizeRequest = videoMode ? null : buildEffectiveImageSizeRequest(effectiveModel, rawImageSizeSelection);
      if (
        currentImageSizeRequest?.selection.mode === "custom" &&
        !currentImageSizeRequest.size
      ) {
        toast.error("请填写有效的宽度和高度");
        return;
      }
      if (
        currentImageSizeRequest &&
        isInvalidCustomRatioSelection(
          currentImageSizeRequest.selection.mode,
          currentImageSizeRequest.selection.aspectRatio,
          currentImageSizeRequest.selection.customRatio,
        )
      ) {
        toast.error("请输入有效的自定义比例，例如 5:4 或 2.39:1");
        return;
      }
      const currentImageSize = videoMode ? videoSize : currentImageSizeRequest?.size ?? "";
      const currentSelectionChanged = currentImageSizeRequest
        ? customImageSizeChanged(rawImageSizeSelection, currentImageSize)
        : false;
      const currentSelection = currentImageSizeRequest
        ? applyNormalizedCustomImageSize(currentImageSizeRequest.selection, currentImageSize)
        : undefined;
      const currentImageSizeSelection = currentSelection
        ? serializeImageSizeSelection(currentSelection)
        : undefined;
      const effectiveOutputFormat = videoMode ? undefined : imageOutputFormatForModel(effectiveModel, imageOutputFormat);
      const effectiveOutputCompression =
        effectiveOutputFormat === undefined
          ? undefined
          : imageOutputCompressionForModel(effectiveModel, effectiveOutputFormat, imageOutputCompression);
      const effectiveImageQuality = videoMode ? undefined : imageQualityForRequest(effectiveModel, imageQuality);
      const effectiveImageStream = !videoMode && supportsImageStreaming(effectiveModel) && imageStreamEnabled;
      const isHighResolutionRequest =
        supportsStructuredImageParameters(effectiveModel) &&
        isHighResolutionImageSize(currentImageSize, currentImageSizeRequest?.selection);
      if (isHighResolutionRequest) {
        const sizeLabel = formatImageSizeDisplay(currentImageSize);
        toast.message(`${sizeLabel} 属于高分辨率目标，实际像素以生成结果为准。`);
      }
      const targetConversation = selectedConversationId
        ? conversationsRef.current.find((conversation) => conversation.id === selectedConversationId) ?? null
        : null;
      const now = new Date().toISOString();
      const conversationId = targetConversation?.id ?? createId();
      const turnId = createId();
      const draftTurn: ImageTurn = {
        id: turnId,
        prompt,
        model: effectiveModel,
        mode: effectiveImageMode,
        referenceImages: videoMode || usesReferenceImages(effectiveImageMode) ? referenceImages : [],
        count: requestedCount,
        size: currentImageSize,
        sizeSelection: currentImageSizeSelection,
        quality: effectiveImageQuality,
        outputFormat: effectiveOutputFormat,
        outputCompression: effectiveOutputCompression,
        stream: effectiveImageStream,
        partialImages: effectiveImageStream ? normalizeImagePartialImages(imagePartialImages) : 0,
        videoSeconds: videoMode ? selectedVideoSeconds : undefined,
        videoResolution: videoMode ? videoResolution : undefined,
        videoGenerateAudio: videoMode ? videoGenerateAudio : undefined,
        videoWatermark: videoMode ? videoWatermark : undefined,
        videoReferenceMode: videoMode ? videoReferenceMode : undefined,
        videoReferenceImageURLs: videoMode && videoReferenceMode === "reference" ? normalizedVideoReferenceImages : undefined,
        videoReferenceVideoURLs: videoMode && videoReferenceMode === "reference" ? normalizedVideoReferenceVideos : undefined,
        videoReferenceAudioURLs: videoMode && videoReferenceMode === "reference" ? normalizedVideoReferenceAudios : undefined,
        tokenGroup: undefined,
        tokenName: activeRelayTokenName || undefined,
        visibility: defaultImageVisibility,
        images: Array.from({ length: requestedCount }, (_, index): StoredImage => {
          const imageId = `${turnId}-${index}`;
          return {
            id: imageId,
            taskId: imageTaskBatchId(turnId, index, effectiveModel),
            taskStatus: "queued" as const,
            status: "loading" as const,
            mediaType: videoMode ? "video" as const : "image" as const,
            visibility: defaultImageVisibility,
          };
        }),
        createdAt: now,
        status: "queued",
      };

      const baseConversation: ImageConversation = targetConversation
        ? {
            ...targetConversation,
            updatedAt: now,
            turns: [...targetConversation.turns, draftTurn],
          }
        : {
            id: conversationId,
            title: buildConversationTitle(prompt),
            createdAt: now,
            updatedAt: now,
            turns: [draftTurn],
          };

      draftProgressTarget = { conversationId, turnId };
      updateTurnProgress(conversationId, turnId, {
        message: "正在创建本地记录",
        detail: "正在保存提示词和生成参数",
        startedAt: Date.parse(now),
      });
      const draftPersisted = await updateConversation(conversationId, () => baseConversation, { persist: "durable" });
      if (!draftPersisted) {
        clearTurnProgress(conversationId, turnId);
        return;
      }
      setSelectedConversationId(conversationId);
      if (currentSelectionChanged && currentSelection) {
        setImageCustomWidth(currentSelection.customWidth);
        setImageCustomHeight(currentSelection.customHeight);
        toast.message(`宽高已自动校正为 ${formatImageSizeDisplay(currentImageSize)}`);
      }
      clearComposerInputs();
      void runConversationQueue(conversationId);

      const targetStats = getImageConversationStats(baseConversation);
      if (targetStats.running > 0 || targetStats.queued > 1) {
        toast.success(videoMode ? "已加入当前视频队列" : "已加入当前图片队列");
      } else if (!targetConversation) {
        toast.success(videoMode ? "已创建新视频任务并开始处理" : "已创建新图片任务并开始处理");
      } else {
        toast.success(videoMode ? "已发送到当前创作记录" : "已发送到当前图片记录");
      }
    } catch (error) {
      if (draftProgressTarget) {
        clearTurnProgress(draftProgressTarget.conversationId, draftProgressTarget.turnId);
      }
      if (pageActiveRef.current) {
        toast.error(formatCreationTaskError(error, "提交任务失败"));
      }
    } finally {
      isSubmitDispatchingRef.current = false;
    }
  };

  return (
    <>
      <section className="mx-auto grid h-full min-h-0 w-full max-w-[1380px] grid-cols-1 gap-2 px-0 pb-[env(safe-area-inset-bottom)] sm:gap-3 sm:px-3 sm:pb-0 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="hidden h-full min-h-0 border-r border-[#f2f3f5] pr-3 lg:block">
          <ImageSidebar
            conversations={conversations}
            isLoadingHistory={isLoadingHistory}
            isLoadingMoreHistory={isLoadingMoreHistory}
            hasMoreHistory={hasMoreHistory}
            selectedConversationId={selectedConversationId}
            onCreateDraft={handleCreateDraft}
            onClearHistory={openClearHistoryConfirm}
            onSelectConversation={setSelectedConversationId}
            onDeleteConversation={openDeleteConversationConfirm}
            onLoadMore={handleLoadMoreHistory}
            formatConversationTime={formatConversationTime}
          />
        </div>

        <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
          <DialogContent className="flex h-[min(82dvh,760px)] w-[92vw] max-w-[460px] flex-col overflow-hidden rounded-[32px] border-white/80 bg-white p-0 shadow-[0_32px_110px_-38px_rgba(15,23,42,0.45)] sm:rounded-[36px]">
            <DialogHeader className="px-6 pt-7 pb-4 sm:px-8">
              <DialogTitle className="flex items-center gap-2 text-xl font-bold tracking-tight">
                <History className="size-5" />
                历史记录
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
              <ImageSidebar
                conversations={conversations}
                isLoadingHistory={isLoadingHistory}
                isLoadingMoreHistory={isLoadingMoreHistory}
                hasMoreHistory={hasMoreHistory}
                selectedConversationId={selectedConversationId}
                onCreateDraft={() => {
                  handleCreateDraft();
                  setIsHistoryOpen(false);
                }}
                onClearHistory={openClearHistoryConfirm}
                onSelectConversation={(id) => {
                  setSelectedConversationId(id);
                  setIsHistoryOpen(false);
                }}
                onDeleteConversation={openDeleteConversationConfirm}
                onLoadMore={handleLoadMoreHistory}
                formatConversationTime={formatConversationTime}
                hideActionButtons
              />
            </div>
          </DialogContent>
        </Dialog>

        {editingTurnDraft ? (
          <Dialog open onOpenChange={(open) => (!open ? closeEditingTurnDialog() : null)}>
            <DialogContent
              showCloseButton={editReferenceUploadPendingCount === 0}
              aria-busy={editReferenceUploadPendingCount > 0}
              onEscapeKeyDown={(event) => {
                if (editReferenceUploadPendingCount > 0) {
                  event.preventDefault();
                }
              }}
              onPointerDownOutside={(event) => {
                if (editReferenceUploadPendingCount > 0) {
                  event.preventDefault();
                }
              }}
              className="flex max-h-[88dvh] w-[min(92vw,640px)] flex-col overflow-hidden rounded-[28px] p-0"
            >
              <DialogHeader className="px-6 pt-6 pb-2">
                <DialogTitle>编辑生成设置</DialogTitle>
                <DialogDescription>
                  修改本轮提示词、参考图和生成参数。
                </DialogDescription>
              </DialogHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                <div className="flex flex-col gap-5">
                  <label className="flex flex-col gap-2 text-sm font-medium text-stone-700">
                    提示词
                    <Textarea
                      value={editingTurnDraft.prompt}
                      onChange={(event) =>
                        setEditingTurnDraft((current) =>
                          current ? { ...current, prompt: event.target.value } : current,
                        )
                      }
                      className="min-h-[128px] resize-y rounded-2xl border-stone-200 bg-white text-sm leading-6 shadow-none"
                    />
                  </label>

                  {editingTurnDraft.mode !== "chat" ? (
                  <div className="flex flex-col gap-3">
                    <input
                      ref={editFileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      disabled={editReferenceUploadPendingCount > 0}
                      className="hidden"
                      onChange={(event) => {
                        void handleEditReferenceImageChange(Array.from(event.target.files || []));
                      }}
                    />
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-stone-700">参考图</div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={editReferenceUploadPendingCount > 0}
                        className="rounded-full border-stone-200 bg-white"
                        onClick={() => editFileInputRef.current?.click()}
                      >
                        {editReferenceUploadPendingCount > 0 ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <ImagePlus className="size-4" />
                        )}
                        {editReferenceUploadPendingCount > 0 ? "上传中" : "上传图片"}
                      </Button>
                    </div>
                    {editingTurnDraft.referenceImages.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {editingTurnDraft.referenceImages.map((image, index) => (
                          <div key={`${image.name}-${index}`} className="relative size-20 shrink-0">
                            <button
                              type="button"
                              className="size-20 overflow-hidden rounded-2xl border border-stone-200 bg-stone-100"
                              onClick={() =>
                                openLightbox(
                                  editingTurnDraft.referenceImages.map((item, itemIndex) => ({
                                    id: `${item.name}-${itemIndex}`,
                                    src: item.dataUrl,
                                  })),
                                  index,
                                )
                              }
                              aria-label={`预览参考图 ${image.name || index + 1}`}
                            >
                              <AuthenticatedImage
                                src={image.dataUrl}
                                alt={image.name || `参考图 ${index + 1}`}
                                className="h-full w-full object-cover"
                                placeholderClassName="min-h-0"
                              />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveEditReferenceImage(index)}
                              disabled={editReferenceUploadPendingCount > 0}
                              className="absolute -top-1 -right-1 z-10 inline-flex size-6 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 shadow-sm transition hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-45"
                              aria-label={`移除参考图 ${image.name || index + 1}`}
                            >
                              <X className="size-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  ) : null}

                  <label className="flex max-w-[15rem] flex-col gap-1.5">
                    <ImageParameterLabel>模型</ImageParameterLabel>
                    <Select
                      value={editingTurnDraft.model}
                      disabled={editReferenceUploadPendingCount > 0}
                      onValueChange={(value) =>
                        setEditingTurnDraft((current) =>
                          current && isImageModel(value) ? { ...current, model: value } : current,
                        )
                      }
                    >
                      <SelectTrigger className="h-9 rounded-lg text-xs shadow-none">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {editingTurnModelOptions.map((option) => (
                            <SelectItem
                              key={option.value}
                              value={option.value}
                              disabled={editingTurnDraft.referenceImages.length > 0 && !supportsImageEditing(option.value)}
                            >
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </label>

                  {editingTurnDraft.mode !== "chat" && editingDraftEffectiveSizeSelection && editingDraftSizeSupported ? (
                    <div className="space-y-3.5 rounded-xl border border-[#dedfe3] bg-white p-3.5 dark:border-border dark:bg-card">
                      <section className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <ImageParameterLabel help="选择常用画幅比例，系统会自动换算为合法像素尺寸。">
                            画幅比例
                          </ImageParameterLabel>
                          <span
                            className={cn(
                              "rounded-md bg-[#f3f4f6] px-2 py-0.5 font-mono text-[11px] text-[#686b73] dark:bg-muted dark:text-muted-foreground",
                              editingDraftSizeIsHighResolution && "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
                            )}
                          >
                            {editingDraftSizePreviewLabel}
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="编辑图片画幅比例">
                          {editingDraftAspectRatioOptions.map((option) => {
                            const isAuto = option.value === "";
                            const isCustom = option.value === CUSTOM_IMAGE_ASPECT_RATIO;
                            const active = isAuto
                              ? editingDraftEffectiveSizeSelection.mode === "auto"
                              : editingDraftEffectiveSizeSelection.mode === "ratio" &&
                                editingTurnDraft.aspectRatio === option.value;
                            return (
                              <ImageAspectRatioOptionButton
                                key={option.value || "auto"}
                                active={active}
                                label={isAuto ? "自动" : isCustom ? "自定义" : option.value}
                                ratio={isAuto || isCustom ? undefined : option.value}
                                onClick={() =>
                                  setEditingTurnDraft((current) =>
                                    current
                                      ? {
                                          ...current,
                                          aspectRatio: option.value,
                                          sizeMode: isAuto ? "auto" : "ratio",
                                        }
                                      : current,
                                  )
                                }
                              />
                            );
                          })}
                        </div>
                        {editingTurnDraft.aspectRatio === CUSTOM_IMAGE_ASPECT_RATIO &&
                        editingDraftEffectiveSizeSelection.mode === "ratio" ? (
                          <Input
                            value={editingTurnDraft.customRatio}
                            onChange={(event) =>
                              setEditingTurnDraft((current) =>
                                current ? { ...current, customRatio: event.target.value } : current,
                              )
                            }
                            placeholder="例如 5:4 或 2.39:1"
                            aria-invalid={editingDraftCustomRatioInvalid}
                            className={cn(
                              "h-8 rounded-lg text-xs shadow-none",
                              editingDraftCustomRatioInvalid && "border-red-300 focus-visible:border-red-400",
                            )}
                          />
                        ) : null}
                      </section>

                      {editingDraftQualitySupported ? (
                        <section className="space-y-1.5">
                          <ImageParameterLabel help={editingDraftXAIParameters ? "Grok Imagine Image 2.0 官方支持低、中两个质量档位，默认使用中等质量。" : "质量越高，生成时间和费用通常越高。"}>
                            质量
                          </ImageParameterLabel>
                          <div className={cn("grid gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70", editingDraftQualityOptions.length === 3 ? "grid-cols-3" : "grid-cols-4")} role="group" aria-label="编辑图片质量">
                            {editingDraftQualityOptions.map((option) => (
                              <button
                                key={option.value || "auto"}
                                type="button"
                                aria-pressed={editingTurnDraft.quality === option.value}
                                className={imageParameterChoiceClass(editingTurnDraft.quality === option.value, "h-7")}
                                onClick={() =>
                                  setEditingTurnDraft((current) =>
                                    current
                                      ? { ...current, quality: option.value as "" | ImageQuality }
                                      : current,
                                  )
                                }
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </section>
                      ) : null}

                      {editingDraftStructuredParameters && editingDraftResolutionOptions.length > 1 ? (
                        <section className="space-y-1.5">
                          <ImageParameterLabel help={editingDraftGoogleGeminiParameters ? "Gemini 使用官方 512、1K、2K、4K 档位；不同模型可用档位不同。" : editingDraftXAIParameters ? "Grok 官方支持 1K、2K 分辨率。" : "自动比例使用常规像素；1080P、2K、4K 会结合宽高比计算，并校正为允许的尺寸。"}>
                            分辨率
                          </ImageParameterLabel>
                          <div className={cn("grid gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70", editingDraftResolutionOptions.length === 5 ? "grid-cols-5" : editingDraftResolutionOptions.length === 3 ? "grid-cols-3" : "grid-cols-4")} role="group" aria-label="编辑图片分辨率">
                            {editingDraftResolutionOptions.map((option) => {
                              const active =
                                editingDraftEffectiveSizeSelection.resolution === option.value &&
                                (editingDraftEffectiveSizeSelection.mode !== "auto" || option.value === "auto");
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  aria-pressed={active}
                                  className={imageParameterChoiceClass(active, "h-7")}
                                  onClick={() =>
                                    setEditingTurnDraft((current) => {
                                      if (!current) return current;
                                      if (current.sizeMode === "auto" && option.value !== "auto") {
                                        return { ...current, resolution: option.value, aspectRatio: "1:1", sizeMode: "ratio" };
                                      }
                                      return { ...current, resolution: option.value };
                                    })
                                  }
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                          {editingDraftSizeIsHighResolution ? (
                            <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">{highResolutionHint}</p>
                          ) : null}
                        </section>
                      ) : null}

                      <section className="flex items-center justify-between gap-3 border-t border-[#ececef] pt-3 dark:border-border">
                        <ImageParameterLabel help={`当前模型单次请求支持 1-${editingDraftCountLimit} 张图片。`}>
                          生成数量
                        </ImageParameterLabel>
                        <div className="grid h-8 grid-cols-[2rem_3.25rem_2rem] overflow-hidden rounded-lg border border-[#dedfe3] bg-white dark:border-border dark:bg-background/70" role="group" aria-label="编辑生成数量">
                          <button
                            type="button"
                            disabled={editingDraftCount <= 1}
                            className="inline-flex items-center justify-center text-[#686b73] transition hover:bg-[#f4f4f5] hover:text-[#18181b] disabled:cursor-not-allowed disabled:opacity-35 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground"
                            onClick={() =>
                              setEditingTurnDraft((current) =>
                                current ? { ...current, count: String(editingDraftCount - 1) } : current,
                              )
                            }
                            aria-label="减少编辑生成数量"
                          >
                            <Minus className="size-3.5" />
                          </button>
                          <span className="inline-flex items-center justify-center border-x border-[#ececef] text-xs font-semibold text-[#18181b] dark:border-border dark:text-foreground">
                            {editingDraftCount} 张
                          </span>
                          <button
                            type="button"
                            disabled={editingDraftCount >= editingDraftCountLimit}
                            className="inline-flex items-center justify-center text-[#686b73] transition hover:bg-[#f4f4f5] hover:text-[#18181b] disabled:cursor-not-allowed disabled:opacity-35 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground"
                            onClick={() =>
                              setEditingTurnDraft((current) =>
                                current ? { ...current, count: String(editingDraftCount + 1) } : current,
                              )
                            }
                            aria-label="增加编辑生成数量"
                          >
                            <Plus className="size-3.5" />
                          </button>
                        </div>
                      </section>

                      {editingDraftExactDimensionsSupported || editingDraftStreamingSupported || editingDraftOutputControls ? <div className="border-t border-[#ececef] pt-2.5 dark:border-border">
                        <div className="space-y-3">
                          {editingDraftExactDimensionsSupported ? <section className="space-y-1.5">
                            <ImageParameterLabel help="手动输入像素尺寸后会覆盖上方画幅比例；边长不超过 3840，必须为 16 的倍数。">
                              精确尺寸
                            </ImageParameterLabel>
                            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
                              <label className="grid h-8 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-[#e3e4e7] bg-white px-2.5 dark:border-border dark:bg-background/70">
                                <span className="text-[11px] text-[#777a82] dark:text-muted-foreground">W</span>
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  min="1"
                                  step="1"
                                  value={editingDraftDisplayedWidth}
                                  placeholder="自动"
                                  onFocus={() =>
                                    setEditingTurnDraft((current) =>
                                      current && current.sizeMode !== "custom"
                                        ? {
                                            ...current,
                                            customWidth: editingDraftDimensions?.width || current.customWidth || "1024",
                                            customHeight: editingDraftDimensions?.height || current.customHeight || "1024",
                                            sizeMode: "custom",
                                          }
                                        : current,
                                    )
                                  }
                                  onChange={(event) =>
                                    setEditingTurnDraft((current) =>
                                      current ? { ...current, customWidth: event.target.value, sizeMode: "custom" } : current,
                                    )
                                  }
                                  className="h-7 border-0 bg-transparent px-0 text-xs font-medium shadow-none focus-visible:ring-0"
                                />
                              </label>
                              <X className="size-3.5 text-[#9a9ca2]" aria-hidden="true" />
                              <label className="grid h-8 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-[#e3e4e7] bg-white px-2.5 dark:border-border dark:bg-background/70">
                                <span className="text-[11px] text-[#777a82] dark:text-muted-foreground">H</span>
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  min="1"
                                  step="1"
                                  value={editingDraftDisplayedHeight}
                                  placeholder="自动"
                                  onFocus={() =>
                                    setEditingTurnDraft((current) =>
                                      current && current.sizeMode !== "custom"
                                        ? {
                                            ...current,
                                            customWidth: editingDraftDimensions?.width || current.customWidth || "1024",
                                            customHeight: editingDraftDimensions?.height || current.customHeight || "1024",
                                            sizeMode: "custom",
                                          }
                                        : current,
                                    )
                                  }
                                  onChange={(event) =>
                                    setEditingTurnDraft((current) =>
                                      current ? { ...current, customHeight: event.target.value, sizeMode: "custom" } : current,
                                    )
                                  }
                                  className="h-7 border-0 bg-transparent px-0 text-xs font-medium shadow-none focus-visible:ring-0"
                                />
                              </label>
                            </div>
                          </section> : null}

                          {editingDraftStreamingSupported ? <div className="flex h-9 items-center justify-between rounded-lg bg-[#f4f4f5] px-2.5 dark:bg-muted/70">
                            <ImageParameterLabel help="开启后会使用流式返回，需要图片服务支持流式响应。">
                              流式返回
                            </ImageParameterLabel>
                            <Switch checked={editingTurnDraft.stream} aria-label="编辑图片流式返回" onCheckedChange={(enabled) => setEditingTurnDraft((current) => current ? { ...current, stream: enabled, partialImages: enabled ? current.partialImages : "0" } : current)} />
                          </div> : null}

                          {editingDraftStreamingSupported && editingTurnDraft.stream ? (
                            <div className="space-y-1.5">
                              <ImageParameterLabel help="可返回 0-3 张生成过程中的中间图；每张中间图会产生额外输出费用。">
                                中间图数量
                              </ImageParameterLabel>
                              <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70">
                                {["0", "1", "2", "3"].map((count) => (
                                  <button
                                    key={count}
                                    type="button"
                                    aria-pressed={editingTurnDraft.partialImages === count}
                                    className={imageParameterChoiceClass(editingTurnDraft.partialImages === count, "h-7")}
                                    onClick={() =>
                                      setEditingTurnDraft((current) =>
                                        current ? { ...current, partialImages: count } : current,
                                      )
                                    }
                                  >
                                    {count} 张
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {editingDraftOutputControls ? (
                            <>
                              <div className="space-y-1.5">
                                <ImageParameterLabel help="支持 PNG、JPEG、WebP；PNG 保留无损质量，JPEG 和 WebP 支持压缩。">
                                  输出格式
                                </ImageParameterLabel>
                                <div className="grid grid-cols-3 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70">
                                  {IMAGE_OUTPUT_FORMAT_OPTIONS.map((option) => (
                                    <button
                                      key={option.value}
                                      type="button"
                                      aria-pressed={editingTurnDraft.outputFormat === option.value}
                                      className={imageParameterChoiceClass(editingTurnDraft.outputFormat === option.value, "h-7 uppercase")}
                                      onClick={() =>
                                        setEditingTurnDraft((current) =>
                                          current
                                            ? {
                                                ...current,
                                                outputFormat: option.value,
                                                outputCompression: supportsImageOutputCompression(option.value)
                                                  ? current.outputCompression
                                                  : "",
                                              }
                                            : current,
                                        )
                                      }
                                    >
                                      {option.label}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {supportsImageOutputCompression(editingTurnDraft.outputFormat) ? (
                                <div className="space-y-1.5">
                                  <div className="flex items-center justify-between gap-3">
                                    <ImageParameterLabel help="仅适用于 JPEG 和 WebP，范围为 0-100；数值越低，文件通常越小。">
                                      压缩率
                                    </ImageParameterLabel>
                                    <span className="text-xs text-[#777a82] dark:text-muted-foreground">
                                      {editingTurnDraft.outputCompression
                                        ? `${editingTurnDraft.outputCompression}%`
                                        : "默认"}
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-2.5">
                                    <Slider
                                      min="0"
                                      max="100"
                                      step="1"
                                      value={editingTurnDraft.outputCompression || "100"}
                                      onChange={(event) =>
                                        setEditingTurnDraft((current) =>
                                          current ? { ...current, outputCompression: event.target.value } : current,
                                        )
                                      }
                                      className="w-full"
                                      aria-label="编辑图片输出压缩率"
                                    />
                                    <Input
                                      type="number"
                                      inputMode="numeric"
                                      min="0"
                                      max="100"
                                      step="1"
                                      value={editingTurnDraft.outputCompression}
                                      placeholder="默认"
                                      onChange={(event) =>
                                        setEditingTurnDraft((current) =>
                                          current ? { ...current, outputCompression: event.target.value } : current,
                                        )
                                      }
                                      className="h-8 rounded-lg text-center text-xs shadow-none"
                                    />
                                  </div>
                                </div>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </div> : null}
                    </div>
                  ) : null}
                </div>
              </div>
              <DialogFooter className="border-t border-stone-100 px-6 py-4">
                <Button
                  variant="outline"
                  disabled={editReferenceUploadPendingCount > 0}
                  onClick={closeEditingTurnDialog}
                >
                  取消
                </Button>
                <Button
                  variant="outline"
                  disabled={editReferenceUploadPendingCount > 0}
                  onClick={() => void handleSaveEditingTurn(false)}
                >
                  保存
                </Button>
                <Button
                  disabled={editReferenceUploadPendingCount > 0}
                  onClick={() => void handleSaveEditingTurn(true)}
                >
                  保存并重新生成
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}

        <div className="relative flex min-h-0 flex-col gap-2 sm:gap-4">
          <div className="flex items-center justify-between gap-2 px-1 sm:px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2 lg:hidden">
              <Button
                variant="outline"
                className="h-10 min-w-0 flex-1 shrink rounded-full border-[#e5e7eb] bg-white text-[#45515e] shadow-sm"
                onClick={() => setIsHistoryOpen(true)}
              >
                <History className="size-4" />
                <span className="truncate">历史记录 ({conversations.length})</span>
              </Button>
              <Button
                className="h-10 rounded-full shadow-sm"
                onClick={handleCreateDraft}
              >
                <Plus className="size-4" />
                新建对话
              </Button>
              <Button
                variant="outline"
                className="h-10 rounded-full border-[#e5e7eb] bg-white px-3 text-[#45515e] shadow-sm"
                onClick={openClearHistoryConfirm}
                disabled={conversations.length === 0}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>

          <div
            ref={resultsViewportRef}
            className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-1 pt-2 pb-[14rem] sm:px-4 sm:pt-4 sm:pb-[15rem]"
            style={composerDockHeight > 0 ? { paddingBottom: composerDockHeight + 24 } : undefined}
            onScroll={handleResultsViewportScroll}
          >
            <div ref={resultsContentRef} className="min-h-full">
              <ImageResults
                selectedConversation={selectedConversation}
                isLoadingHistory={isLoadingHistory}
                progressByTurnKey={progressByTurnKey}
                progressNow={progressNow}
                promptPresets={IMAGE_PROMPT_PRESETS}
                onOpenLightbox={openLightbox}
                onApplyPromptPreset={handleApplyPromptPreset}
                onContinueEdit={handleContinueEdit}
                onEditTurn={openEditTurnDialog}
                onCancelTurn={handleCancelTurn}
                onRegenerateTurn={handleRegenerateTurn}
                onRetryImage={handleRetryImage}
                onImageVisibilityChange={handleImageVisibilityChange}
                visibilityMutatingImageKey={visibilityMutatingImageKey}
                formatConversationTime={formatConversationTime}
              />
            </div>
          </div>

          {showScrollToBottom ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="absolute left-1/2 z-40 size-9 -translate-x-1/2 rounded-full border-[#dbe7ff] bg-white/95 text-[#1456f0] shadow-[0_14px_34px_-20px_rgba(20,86,240,0.65)] backdrop-blur hover:bg-[#edf4ff] dark:bg-card/95 dark:text-sky-300 dark:hover:bg-sky-950/30"
              style={{ bottom: composerDockHeight > 0 ? composerDockHeight + 20 : 160 }}
              onClick={() => scrollResultsToBottom("smooth")}
              aria-label="滚动到底部"
              title="滚动到底部"
            >
              <ArrowDownToLine className="size-4" />
            </Button>
          ) : null}

          <div
            ref={composerDockRef}
            className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-1 pb-[env(safe-area-inset-bottom)] sm:px-4 sm:pb-0"
            style={
              {
                "--image-composer-dock-height": `${composerDockHeight}px`,
              } as CSSProperties
            }
          >
            <div className="pointer-events-auto mx-auto w-full max-w-[900px]">
              <ImageComposer
                composerMode={composerMode}
                prompt={imagePrompt}
                imageCount={imageCount}
                imageModel={imageModel}
                imageModelOptions={composerModelOptions}
                imageSizeMode={imageSizeMode}
                imageAspectRatio={imageAspectRatio}
                imageResolution={imageResolution}
                imageCustomRatio={imageCustomRatio}
                imageCustomWidth={imageCustomWidth}
                imageCustomHeight={imageCustomHeight}
                imageQuality={imageQuality}
                imageOutputFormat={imageOutputFormat}
                imageOutputCompression={imageOutputCompression}
                imageStreamEnabled={imageStreamEnabled}
                imagePartialImages={imagePartialImages}
                videoModel={videoModel}
                videoModelOptions={videoModelOptions}
                videoSize={videoSize}
                videoSeconds={videoSeconds}
                videoResolution={videoResolution}
                videoGenerateAudio={videoGenerateAudio}
                videoWatermark={videoWatermark}
                videoReferenceMode={videoReferenceMode}
                videoReferenceImageURLs={videoReferenceImageURLs}
                videoReferenceVideoURLs={videoReferenceVideoURLs}
                videoReferenceAudioURLs={videoReferenceAudioURLs}
                relayKeyConfigured={activeRelayKeyConfigured}
                relayKeyStatusMessage={activeRelayKeyMissingMessage}
                highResolutionHint={highResolutionHint}
                referenceImages={referenceImages}
                textareaRef={textareaRef}
                fileInputRef={fileInputRef}
                onPromptChange={setImagePrompt}
                onImageCountChange={setImageCount}
                onImageModelChange={handleImageModelChange}
                onImageSizeModeChange={setImageSizeMode}
                onImageAspectRatioChange={setImageAspectRatio}
                onImageResolutionChange={setImageResolution}
                onImageCustomRatioChange={setImageCustomRatio}
                onImageCustomWidthChange={setImageCustomWidth}
                onImageCustomHeightChange={setImageCustomHeight}
                onImageQualityChange={setImageQuality}
                onImageOutputFormatChange={setImageOutputFormat}
                onImageOutputCompressionChange={setImageOutputCompression}
                onImageStreamEnabledChange={setImageStreamEnabled}
                onImagePartialImagesChange={setImagePartialImages}
                onComposerModeChange={handleComposerModeChange}
                onVideoModelChange={handleVideoModelChange}
                onVideoSizeChange={setVideoSize}
                onVideoSecondsChange={setVideoSeconds}
                onVideoResolutionChange={setVideoResolution}
                onVideoGenerateAudioChange={setVideoGenerateAudio}
                onVideoWatermarkChange={setVideoWatermark}
                onVideoReferenceModeChange={(mode) => {
                  setVideoReferenceMode(mode);
                  if (mode === "reference") replaceReferenceImages([]);
                }}
                onVideoReferenceImageURLsChange={(value) => {
                  setVideoReferenceImageURLs(value);
                  if (value.some((item) => item.trim())) {
                    setVideoReferenceMode("reference");
                    setVideoReferenceVideoURLs([]);
                    setVideoReferenceAudioURLs([]);
                  }
                }}
                onVideoReferenceVideoURLsChange={(value) => {
                  setVideoReferenceVideoURLs(value);
                  if (value.some((item) => item.trim())) {
                    setVideoReferenceMode("reference");
                    setVideoReferenceImageURLs([]);
                    setVideoReferenceAudioURLs([]);
                  }
                }}
                onVideoReferenceAudioURLsChange={(value) => {
                  setVideoReferenceAudioURLs(value);
                  if (value.some((item) => item.trim())) setVideoReferenceMode("reference");
                }}
                videoReferenceUploading={videoReferenceUploading}
                onVideoReferenceFileChange={handleVideoReferenceFileChange}
                onSubmit={handleSubmit}
                onOpenPromptMarket={() => setIsPromptMarketOpen(true)}
                onReferenceImageChange={handleReferenceImageChange}
                onRemoveReferenceImage={handleRemoveReferenceImage}
              />
            </div>
          </div>
        </div>
      </section>

      <ImagePromptMarket
        open={isPromptMarketOpen}
        canViewAdultContent={hasAPIPermission(session, "GET", "/api/prompt-market/adult-content")}
        onOpenChange={setIsPromptMarketOpen}
        onApplyPrompt={handleApplyMarketPrompt}
      />

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />

      <RelayTokenRequiredDialog
        kind={relayTokenDialogKind || "image"}
        open={relayTokenDialogKind !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRelayTokenDialogKind(null);
          }
        }}
      />

      {publishImageTarget ? (
        <Dialog open onOpenChange={(open) => (!open && !visibilityMutatingImageKey ? setPublishImageTarget(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>公开图片</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                将这张图片加入公开图库。
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-1">
              <label className="flex items-start gap-3 rounded-xl border border-stone-200 bg-white px-3 py-3 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={publishRecipeOptions.sharePromptParameters}
                  onCheckedChange={(checked) =>
                    setPublishRecipeOptions({
                      sharePromptParameters: checked === true,
                      shareReferenceImages: checked === true ? publishRecipeOptions.shareReferenceImages : false,
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="block font-medium text-stone-900">公开原始提示词和生成参数</span>
                  <span className="mt-0.5 block text-xs leading-5 text-stone-500">公开图库会展示可复用的 prompt、模型、尺寸和输出设置。</span>
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-xl border border-stone-200 bg-white px-3 py-3 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={publishRecipeOptions.shareReferenceImages}
                  disabled={!publishRecipeOptions.sharePromptParameters}
                  onCheckedChange={(checked) =>
                    setPublishRecipeOptions((current) => ({
                      ...current,
                      shareReferenceImages: checked === true,
                    }))
                  }
                />
                <span className="min-w-0">
                  <span className="block font-medium text-stone-900">公开原始参考图用于同款生成</span>
                  <span className="mt-0.5 block text-xs leading-5 text-stone-500">其他用户复用时可以读取这些参考图；不勾选时会改用公开成品图。</span>
                </span>
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPublishImageTarget(null)} disabled={visibilityMutatingImageKey !== ""}>
                取消
              </Button>
              <Button onClick={() => void handleConfirmPublishImage()} disabled={visibilityMutatingImageKey !== ""}>
                {visibilityMutatingImageKey ? <LoaderCircle className="size-4 animate-spin" /> : <Globe2 className="size-4" />}
                公开
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {deleteConfirm ? (
        <Dialog open onOpenChange={(open) => (!open ? setDeleteConfirm(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>{deleteConfirmTitle}</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                {deleteConfirmDescription}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                取消
              </Button>
              <Button className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => void handleConfirmDelete()}>
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export default function ImagePage() {
  const { isCheckingAuth, session } = useAuthGuard(undefined, "/image");

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <ImagePageContent key={imageConversationOwnerScope(session)} session={session} />;
}
