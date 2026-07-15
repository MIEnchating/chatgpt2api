"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowDownToLine, ChevronDown, Globe2, History, ImagePlus, LoaderCircle, Minus, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import {
  ImageAspectRatioGlyph,
  ImageParameterLabel,
} from "@/app/image/components/image-parameter-ui";
import { imageParameterChoiceClass } from "@/app/image/components/image-parameter-styles";
import { ImagePromptMarket } from "@/app/image/components/image-prompt-market";
import { ImageResults, type ImageLightboxItem } from "@/app/image/components/image-results";
import type { BananaPrompt } from "@/app/image/banana-prompts";
import {
  CUSTOM_IMAGE_ASPECT_RATIO,
  DEFAULT_IMAGE_CUSTOM_HEIGHT,
  DEFAULT_IMAGE_CUSTOM_RATIO,
  DEFAULT_IMAGE_CUSTOM_WIDTH,
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_QUALITY_OPTIONS,
  IMAGE_RESOLUTION_OPTIONS,
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
import { Button } from "@/components/ui/button";
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
  fetchProfileRelayKey,
  DEFAULT_IMAGE_MODEL,
  fetchCreationTasks,
  fetchModelConfig,
  IMAGE_CREATION_MODEL_OPTIONS,
  IMAGE_OUTPUT_FORMAT_OPTIONS,
  PROFILE_RELAY_TOKEN_GROUP_CHANGED_EVENT,
  PROFILE_RELAY_TOKEN_GROUP_STORAGE_KEY,
  PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT,
  PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY,
  isImageCreationModel,
  isImageModel,
  isImageOutputFormat,
  isImageQuality,
  modelOptionsFromNames,
  supportsImageOutputCompression,
  supportsImageOutputControls,
  supportsStructuredImageParameters,
  updateManagedImageVisibility,
  type ImageModel,
  type ImageModelOption,
  type ImageOutputFormat,
  type ImageQuality,
  type CreationTask,
  type CreationTaskMessage,
  type FallbackReferenceImage,
  type ImageQualityCheck,
  type ImageVisibility,
} from "@/lib/api";
import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";
import { clearImageManagerCache } from "@/lib/image-manager-cache";
import { getManagedImagePathFromUrl } from "@/lib/image-path";
import { clearStoredRelayApiKey } from "@/lib/relay-key";
import { cn } from "@/lib/utils";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { hasAPIPermission, type StoredAuthSession } from "@/store/auth";
import {
  ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY,
  clearImageConversations,
  deleteImageConversation,
  getImageConversationStats,
  getImageTurnLoadingCounts,
  IMAGE_ACTIVE_CONVERSATION_REQUEST_EVENT,
  IMAGE_CONVERSATIONS_CHANGED_EVENT,
  listImageConversations,
  saveImageConversation,
  saveImageConversations,
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
const IMAGE_STREAM_STORAGE_KEY = "chatgpt2api:image_last_stream";
const IMAGE_PARTIAL_IMAGES_STORAGE_KEY = "chatgpt2api:image_last_partial_images";
const NEWAPI_TOKEN_MISSING_MESSAGE = "请先在云棉为当前用户创建可用令牌";
const DEFAULT_IMAGE_OUTPUT_FORMAT: ImageOutputFormat = "png";
const activeConversationQueueIds = new Set<string>();
const MISSING_RECOVERABLE_TASK_ID_ERROR = "页面刷新或任务中断，未找到可恢复的任务 ID";
const RESULTS_BOTTOM_STICKY_THRESHOLD = 96;

type ComposerMode = "chat" | "image";

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

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, fileName: string, mimeType?: string) {
  const [header, content] = dataUrl.split(",", 2);
  const matchedMimeType = header.match(/data:(.*?);base64/)?.[1];
  const binary = atob(content || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: mimeType || matchedMimeType || "image/png" });
}

function imageFileExtensionForOutputFormat(format?: ImageOutputFormat) {
  return format === "jpeg" ? "jpg" : format || "png";
}

function imageMimeTypeForOutputFormat(format?: ImageOutputFormat) {
  return format === "jpeg" ? "image/jpeg" : `image/${format || "png"}`;
}

function buildReferenceImageFromResult(image: StoredImage, fileName: string): StoredReferenceImage | null {
  if (!image.b64_json) {
    return null;
  }
  const mimeType = imageMimeTypeForOutputFormat(image.outputFormat);

  return {
    name: fileName,
    type: mimeType,
    dataUrl: `data:${mimeType};base64,${image.b64_json}`,
  };
}

async function fetchImageAsFile(url: string, fileName: string) {
  const blob = await fetchAuthenticatedImageBlob(url);
  return new File([blob], fileName, { type: blob.type || "image/png" });
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

async function buildReferenceImageFromUrl(
  url: string,
  index: number,
  fallbackPrefix: string,
): Promise<StoredReferenceImage> {
  const file = await fetchImageAsFile(url, buildReferenceFileName(url, index, fallbackPrefix));
  return {
    name: file.name,
    type: file.type || "image/png",
    dataUrl: await readFileAsDataUrl(file),
    source: "upload",
  };
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
  const direct = buildReferenceImageFromResult(image, fileName);
  if (direct) {
    return {
      referenceImage: direct,
      file: dataUrlToFile(direct.dataUrl, direct.name, direct.type),
    };
  }

  if (!image.url) {
    return null;
  }
  const file = await fetchImageAsFile(image.url, fileName);
  return {
    referenceImage: {
      name: file.name,
      type: file.type || "image/png",
      dataUrl: await readFileAsDataUrl(file),
    },
    file,
  };
}

const IMAGE_TASK_IMAGE_COUNT = 4;

function normalizeRequestedImageCount(value: string | number) {
  return Math.max(1, Math.min(10, Number(value) || 1));
}

function isInvalidCustomRatioSelection(sizeMode: ImageSizeMode, aspectRatio: ImageAspectRatio, customRatio: string) {
  return sizeMode === "ratio" && aspectRatio === CUSTOM_IMAGE_ASPECT_RATIO && !parseImageRatio(customRatio);
}

function effectiveImageSizeSelection(model: ImageModel, selection: ImageSizeSelection): ImageSizeSelection {
  if (supportsStructuredImageParameters(model)) {
    return selection;
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
  const requestedSize = buildImageSize(effectiveSelection);
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

function imageQualityForRequest(value: "" | ImageQuality): ImageQuality | undefined {
  return isImageQuality(value) ? value : undefined;
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

  const isHighResolution = supportsStructuredImageParameters(turn.model) && isHighResolutionImageSize(turn.size);
  void elapsedSeconds;
  if (isHighResolution) {
    return {
      message: "高分辨率生成中",
      detail: `${getImageSizeRequirementLabel(turn.size)}目标已记录，正在等待生成结果`,
    };
  }
  return {
    message: "正在生成图片",
    detail: "后端正在轮询任务状态",
  };
}

function imageTaskLoadingDetail(turn: ImageTurn, fallbackDetail: string) {
  const counts = getImageTurnLoadingCounts(turn);
  if (counts.queued > 0) {
    return `${fallbackDetail}；还有 ${counts.queued} 张图片排队中`;
  }
  if (counts.running > 0) {
    return `${fallbackDetail}；还有 ${counts.running} 张图片处理中`;
  }
  return "图片结果已返回，正在确认任务状态";
}

function imageTaskBatchId(turnId: string, imageIndex: number) {
  return `${turnId}-task-${Math.floor(imageIndex / IMAGE_TASK_IMAGE_COUNT)}`;
}

function imageTaskIdForImage(turnId: string, images: StoredImage[], imageIndex: number) {
  return images[imageIndex]?.taskId || imageTaskBatchId(turnId, imageIndex);
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
  "taskStatus",
  "status",
  "path",
  "visibility",
  "b64_json",
  "url",
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
  if (outputStatus === "queued" || outputStatus === "running" || outputStatus === "success" || outputStatus === "error" || outputStatus === "cancelled") {
    return outputStatus;
  }
  if (task.status === "queued" || task.status === "running" || task.status === "success" || task.status === "error" || task.status === "cancelled") {
    return task.status;
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
  const successUpdates = (item: CreationTaskDataItem) => {
    const width = positiveDimension(item.width);
    const height = positiveDimension(item.height);
    return {
      taskId: task.id,
      ...finalTiming,
      taskStatus: "success" as const,
      status: "success" as const,
      b64_json: item.b64_json,
      url: item.url,
      path: item.url ? getManagedImagePathFromUrl(item.url) || image.path : image.path,
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
    if (!item?.b64_json && !item?.url) {
      if (dataIndex > 0 && image.taskId !== image.id) {
        const slotStatus = creationTaskImageStatus(task, dataIndex);
        if (slotStatus === "error" || slotStatus === "cancelled") {
          return updateStoredImage(image, {
            taskId: task.id,
            ...finalTiming,
            taskStatus: slotStatus,
            status: slotStatus === "cancelled" ? "cancelled" : "error",
            error: slotStatus === "cancelled" ? task.error || "任务已终止" : formatCreationTaskErrorMessage(task.error || "生成失败"),
          });
        }
        return updateStoredImage(image, {
          taskId: image.id,
          ...activeTiming,
          taskStatus: "queued",
          status: "loading",
          error: undefined,
        });
      }
      return updateStoredImage(image, {
        taskId: task.id,
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
    if (task.output_type === "text" && item?.text_response) {
      return updateStoredImage(image, {
        taskId: task.id,
        ...activeTiming,
        taskStatus: task.status === "queued" ? "queued" : "running",
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
    if (item?.b64_json || item?.url) {
      return updateStoredImage(image, successUpdates(item));
    }
    return updateStoredImage(image, {
      taskId: task.id,
      ...activeTiming,
      taskStatus: creationTaskImageStatus(task, dataIndex) || (task.status === "queued" ? "queued" : "running"),
      status: "loading",
      text_response: undefined,
      error: undefined,
    });
  }

  if (task.status === "error") {
    if (task.output_type === "text") {
      return updateStoredImage(image, {
        taskId: task.id,
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
    if (item?.b64_json || item?.url) {
      return updateStoredImage(image, successUpdates(item));
    }
    return updateStoredImage(image, {
      taskId: task.id,
      ...finalTiming,
      taskStatus: undefined,
      status: "error",
      text_response: undefined,
      error: formatCreationTaskErrorMessage(task.error || "生成失败"),
    });
  }

  if (task.status === "cancelled") {
    const item = task.data?.[dataIndex];
    if (item?.b64_json || item?.url) {
      return updateStoredImage(image, successUpdates(item));
    }
    return updateStoredImage(image, {
      taskId: task.id,
      ...finalTiming,
      taskStatus: undefined,
      status: "cancelled",
      error: task.error || "任务已终止",
    });
  }

  return updateStoredImage(image, {
    taskId: task.id,
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

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function pickFallbackConversationId(conversations: ImageConversation[]) {
  const activeConversation = conversations.find((conversation) =>
    conversation.turns.some((turn) => turn.status === "queued" || turn.status === "generating"),
  );
  return activeConversation?.id ?? conversations[0]?.id ?? null;
}

function sortImageConversations(conversations: ImageConversation[]) {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
  return "image";
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
  return window.localStorage.getItem(IMAGE_STREAM_STORAGE_KEY) === "true";
}

function getStoredImagePartialImages() {
  if (typeof window === "undefined") {
    return "0";
  }
  return String(normalizeImagePartialImages(window.localStorage.getItem(IMAGE_PARTIAL_IMAGES_STORAGE_KEY)));
}

function getStoredRelayTokenName() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY) || "";
}

function getStoredRelayTokenGroup() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(PROFILE_RELAY_TOKEN_GROUP_STORAGE_KEY) || "";
}

function normalizeRelayTokenNames(values: unknown) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((name) => String(name || "").trim()).filter(Boolean)))
    : [];
}

function normalizeRelayTokenGroups(values: unknown) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((group) => String(group || "").trim()).filter(Boolean)))
    : [];
}

function nextRelayTokenName(current: string, options: string[], fallback?: string) {
  const normalizedCurrent = current.trim();
  if (normalizedCurrent && options.some((name) => name === normalizedCurrent)) {
    return normalizedCurrent;
  }
  const normalizedFallback = String(fallback || "").trim();
  if (normalizedFallback && options.some((name) => name === normalizedFallback)) {
    return normalizedFallback;
  }
  return options[0] || normalizedFallback || "";
}

function nextRelayTokenGroup(current: string, options: string[], fallback?: string) {
  const normalizedCurrent = current.trim();
  if (normalizedCurrent && options.some((group) => group === normalizedCurrent)) {
    return normalizedCurrent;
  }
  const normalizedFallback = String(fallback || "").trim();
  if (normalizedFallback && options.some((group) => group === normalizedFallback)) {
    return normalizedFallback;
  }
  return options[0] || normalizedFallback || "";
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

function formatCreationTaskErrorMessage(message: string) {
  const trimmed = String(message || "").trim();
  if (!trimmed) {
    return "生成图片失败";
  }

  const normalized = trimmed.toLowerCase();
  const isImageEdit = normalized.includes("/v1/images/edits");
  const taskLabel = isImageEdit ? "图片编辑" : "图片生成";
  if (
    normalized.includes("image data you provided does not represent a valid image") ||
    normalized.includes("supported image formats") ||
    normalized.includes("unsupported image file") ||
    normalized.includes("image data url is invalid") ||
    normalized.includes("image data url is not an image") ||
    normalized.includes("image data url must be base64") ||
    normalized.includes("image data is empty")
  ) {
    return "参考图不是有效图片。请重新上传 JPEG、PNG、GIF 或 WebP 格式的图片，不要使用损坏文件、空文件、SVG/HEIC/AVIF，或复制出来的无效图片数据。";
  }
  if (normalized.includes("user balance insufficient")) {
    return "当前账号额度不足，生成服务拒绝了这次请求。请切换可用令牌、补充额度，或稍后再试。";
  }
  if (normalized.includes("user quota exceeded")) {
    return "当前账号额度已用完，生成服务拒绝了这次请求。请切换可用令牌、补充额度，或稍后再试。";
  }
  if (normalized.includes("context deadline exceeded") || normalized.includes("client.timeout exceeded") || normalized.includes("awaiting headers") || normalized.includes("awaiting response headers")) {
    return `${taskLabel}请求已发出，但生成服务长时间没有响应。请稍后重试；如果连续出现，建议降低分辨率、减少参考图，或检查生成服务和代理是否正常。`;
  }
  if (normalized.includes("i/o timeout") || normalized.includes("tls handshake timeout") || normalized.includes("timeout awaiting response headers")) {
    return `${taskLabel}请求连接超时。通常是代理、网络或生成服务繁忙导致，请稍后重试；如果频繁出现，先检查代理和服务连通性。`;
  }
  if (
    normalized.includes("stream disconnected before completion") ||
    normalized.includes("stream closed before") ||
    normalized.includes("response.completed")
  ) {
    return "图片结果还没传完，服务连接就断开了。通常是网络波动、服务繁忙，或提示词/参考图触发安全限制导致；请稍后重试，或调整内容、降低分辨率、减少参考图。";
  }
  if (normalized.includes("an error occurred while processing your request")) {
    const requestId = trimmed.match(/request id\s+([a-z0-9-]+)/i)?.[1];
    return [
      "生成服务处理图片请求失败，可能是提示词内容过多、模型能力限制或当前图片链路繁忙。",
      "建议减少提示词内容，或稍后重试；高分辨率请求可降低尺寸后再试。",
      requestId ? `请求 ID：${requestId}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (normalized.includes("no images generated") && normalized.includes("model may have refused")) {
    return "没有生成图片，模型可能检测到敏感内容并拒绝了这次请求，请调整提示词后重试。";
  }
  if (normalized.includes("timed out waiting for async image generation")) {
    return `${taskLabel}等待超时。请稍后重试；如果使用高分辨率、较多参考图或复杂提示词，建议先降低尺寸或简化内容。`;
  }
  if (normalized.includes("no available image quota")) {
    return "当前云棉令牌暂不可用，请检查指定分组令牌或稍后重试。";
  }
  if (
    normalized.includes("task returned no output data") ||
    normalized.includes("任务没有返回图片数据") ||
    normalized.includes("图片任务没有返回图片数据")
  ) {
    return "图片任务没有返回图片数据。通常是生成服务没有产出图片、模型参数不匹配、提示词被拒绝或服务链路异常导致；请调整提示词或参数后重试，并检查服务日志。";
  }
  if (normalized.includes("upstream connection failed before tls handshake") || normalized.includes("tls connect error")) {
    return "连接生成服务失败，代理或网络可能没有连通到 ChatGPT。请检查代理后重试。";
  }
  if (normalized.includes("connection refused") || normalized.includes("connect: refused")) {
    return "连接生成服务失败：目标服务拒绝连接。请确认服务正在运行，地址和端口配置正确。";
  }
  if (normalized.includes("no such host") || normalized.includes("server misbehaving")) {
    return "无法解析生成服务地址。请检查服务域名、Docker 网络或 DNS 配置。";
  }
  if (normalized.includes("bad gateway") || normalized.includes("service unavailable") || normalized.includes("gateway timeout")) {
    return "生成服务暂时不可用。请稍后重试；如果持续出现，请检查服务状态。";
  }

  return trimmed;
}

function formatCreationTaskErrorDetail(error: unknown) {
  if (!error || typeof error !== "object") {
    return null;
  }
  const item = error as { message?: unknown; code?: unknown; errorType?: unknown; status?: unknown };
  const code = typeof item.code === "string" ? item.code.trim() : "";
  const errorType = typeof item.errorType === "string" ? item.errorType.trim() : "";
  const status = typeof item.status === "number" && Number.isFinite(item.status) ? item.status : undefined;
  if (!code && !errorType && !status) {
    return null;
  }
  const meta: string[] = [];
  if (code) meta.push(`错误码：${code}`);
  if (errorType && errorType !== code) meta.push(`类型：${errorType}`);
  if (typeof status === "number") meta.push(`HTTP：${status}`);
  return meta.join("，");
}

function formatCreationTaskError(error: unknown, fallback = "生成图片失败") {
  const message = formatCreationTaskErrorMessage(error instanceof Error ? error.message : String(error || fallback));
  const detail = formatCreationTaskErrorDetail(error);
  return detail ? `${message}\n${detail}` : message;
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
    return { status: "error", error: buildTurnOutcomeMessage(successCount, failedCount, cancelledCount) };
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
  void composerMode;
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
      if (image.status !== "success") {
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

async function syncConversationCreationTasks(items: ImageConversation[]) {
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
    taskList = await fetchCreationTasks(taskIds);
  } catch {
    return items;
  }
  const taskMap = new Map(taskList.items.map((task) => [task.id, task]));
  let changed = false;
  const normalized = items.map((conversation) => {
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
      changed = true;
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

  if (changed) {
    await saveImageConversations(normalized);
  }
  return normalized;
}

async function recoverConversationHistory(items: ImageConversation[]) {
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      let turnChanged = false;
      const recoveredImages = turn.images.map((image, imageIndex) => {
        if (image.status === "error" && isMissingBatchImageDataError(image.error)) {
          turnChanged = true;
          return {
            ...image,
            taskId: image.id,
            status: "loading" as const,
            error: undefined,
          };
        }
        if (turn.mode === "chat" && image.status === "error" && isMissingRecoverableTaskIdError(image.error)) {
          turnChanged = true;
          return {
            ...image,
            taskId: imageTaskIdForImage(turn.id, turn.images, imageIndex),
            status: "loading" as const,
            error: undefined,
          };
        }
        if (turn.mode === "chat" && image.status === "loading" && !image.taskId) {
          turnChanged = true;
          return {
            ...image,
            taskId: imageTaskIdForImage(turn.id, turn.images, imageIndex),
          };
        }
        return image;
      });

      if (turn.status !== "queued" && turn.status !== "generating") {
        if (!turnChanged) {
          return turn;
        }
        changed = true;
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
      changed = true;
      return {
        ...turn,
        ...derived,
        images,
      };
    });

    if (!turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }

    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(normalized);
  }

  return syncConversationCreationTasks(normalized);
}


function ImagePageContent({ session }: { session: StoredAuthSession }) {
  const isSubmitDispatchingRef = useRef(false);
  const retryingImageIdsRef = useRef(new Set<string>());
  const cancelledTurnIdsRef = useRef(new Set<string>());
  const conversationsRef = useRef<ImageConversation[]>([]);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const resultsContentRef = useRef<HTMLDivElement>(null);
  const shouldStickToResultsBottomRef = useRef(true);
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
  const [relayKeyConfigured, setRelayKeyConfigured] = useState(false);
  const [relayKeyStatusMessage, setRelayKeyStatusMessage] = useState(NEWAPI_TOKEN_MISSING_MESSAGE);
  const [relayTokenGroup, setRelayTokenGroup] = useState(getStoredRelayTokenGroup);
  const [relayTokenName, setRelayTokenName] = useState(getStoredRelayTokenName);
  const [relayTokenNameOptions, setRelayTokenNameOptions] = useState<string[]>([]);
  const relayKeyMissingMessage = relayKeyStatusMessage || NEWAPI_TOKEN_MISSING_MESSAGE;
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
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "one"; id: string } | { type: "all" } | null>(null);
  const [editingTurnDraft, setEditingTurnDraft] = useState<EditingTurnDraft | null>(null);
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
  const parsedCount = useMemo(() => normalizeRequestedImageCount(imageCount), [imageCount]);
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
  const editingDraftOutputControls = editingTurnDraft
    ? supportsImageOutputControls(editingTurnDraft.model)
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
    editingDraftStructuredParameters && editingDraftImageSize && isHighResolutionImageSize(editingDraftImageSize),
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
  const editingDraftCount = editingTurnDraft ? normalizeRequestedImageCount(editingTurnDraft.count) : 1;
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
  const activeRelayTokenGroup = relayTokenGroup.trim();
  const activeRelayTokenName = relayTokenName.trim();
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

    const refreshConversations = async () => {
      try {
        const items = await listImageConversations();
        if (cancelled) {
          return;
        }
        conversationsRef.current = items;
        setConversations(items);
      } catch {
        // Background updates should not surface noisy toasts while the user is on another workflow.
      }
    };

    const handleConversationsChanged = () => {
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
      try {
        const storedSelection = getStoredImageSizeSelection();
        setImageSizeMode(storedSelection.mode);
        setImageAspectRatio(storedSelection.aspectRatio);
        setImageResolution(storedSelection.resolution);
        setImageCustomRatio(storedSelection.customRatio);
        setImageCustomWidth(storedSelection.customWidth);
        setImageCustomHeight(storedSelection.customHeight);
        setImageOutputFormat(getStoredImageOutputFormat());
        setImageOutputCompression(getStoredImageOutputCompression());

        const items = await listImageConversations();
        const normalizedItems = await recoverConversationHistory(items);
        if (cancelled) {
          return;
        }

        conversationsRef.current = normalizedItems;
        setConversations(normalizedItems);
        const storedConversationId =
          typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY) : null;
        const nextSelectedConversationId =
          (storedConversationId && normalizedItems.some((conversation) => conversation.id === storedConversationId)
            ? storedConversationId
            : null) ?? pickFallbackConversationId(normalizedItems);
        setSelectedConversationId(nextSelectedConversationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取会话记录失败";
        toast.error(message);
      } finally {
        if (!cancelled) {
          setIsLoadingHistory(false);
        }
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

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

    setSelectedConversationId(null);
    setComposerMode("image");
    setImagePrompt(prompt);
    setImageCount("1");
    setImageModel(isImageCreationModel(intent.model) ? intent.model : defaultImageModel);
    setImageSizeMode(sizeSelection.mode);
    setImageAspectRatio(sizeSelection.aspectRatio);
    setImageResolution(isImageResolution(intent.resolutionPreset) ? intent.resolutionPreset : sizeSelection.resolution);
    setImageCustomRatio(sizeSelection.customRatio);
    setImageCustomWidth(sizeSelection.customWidth);
    setImageCustomHeight(sizeSelection.customHeight);
    setImageOutputFormat(outputFormat);
    setImageOutputCompression(reusableOutputCompressionValue(intent.outputCompression, outputFormat));
    setDefaultImageVisibility("private");
    setReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    textareaRef.current?.focus();

    const sourceImageUrls = intent.sourceImageUrls.length > 0 ? intent.sourceImageUrls : [intent.sourceImageUrl];
    const usesPublicImageFallback = intent.sourceKind !== "original_references";
    const toastId = toast.loading(
      usesPublicImageFallback
        ? "正在读取公开图作为参考图"
        : sourceImageUrls.length > 1
          ? "正在读取公开的原始参考图"
          : "正在读取公开的原始参考图",
    );
    void Promise.allSettled(
      sourceImageUrls.map((url, index) => buildReferenceImageFromUrl(url, index, "public-gallery-reference")),
    )
      .then((results) => {
        if (promptApplyRequestIdRef.current !== requestId) {
          toast.dismiss(toastId);
          return;
        }
        const loadedReferences = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        if (loadedReferences.length === 0) {
          toast.error("已带入原始提示词和参数，但参考图读取失败", { id: toastId });
          return;
        }
        setReferenceImages(loadedReferences);
        const failedCount = results.length - loadedReferences.length;
        toast.success(
          failedCount > 0
            ? `已带入原始提示词、${loadedReferences.length} 张参考图和生成参数，${failedCount} 张读取失败`
            : usesPublicImageFallback
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
        toast.error("已带入原始提示词和参数，但参考图读取失败", { id: toastId });
      });
  }, [defaultImageModel, isLoadingHistory]);

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
      setImageModel(defaultImageModel);
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
      const tokenName = (event as CustomEvent<{ tokenName?: string }>).detail?.tokenName;
      setRelayTokenName(String(tokenName || window.localStorage.getItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY) || ""));
    };
    const handleTokenGroupChange = (event: Event) => {
      const tokenGroup = (event as CustomEvent<{ tokenGroup?: string }>).detail?.tokenGroup;
      setRelayTokenGroup(String(tokenGroup || window.localStorage.getItem(PROFILE_RELAY_TOKEN_GROUP_STORAGE_KEY) || ""));
    };
    window.addEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
    window.addEventListener(PROFILE_RELAY_TOKEN_GROUP_CHANGED_EVENT, handleTokenGroupChange);
    window.addEventListener("storage", handleTokenNameChange);
    window.addEventListener("storage", handleTokenGroupChange);
    return () => {
      window.removeEventListener(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, handleTokenNameChange);
      window.removeEventListener(PROFILE_RELAY_TOKEN_GROUP_CHANGED_EVENT, handleTokenGroupChange);
      window.removeEventListener("storage", handleTokenNameChange);
      window.removeEventListener("storage", handleTokenGroupChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const normalizedGroup = relayTokenGroup.trim();
    if (normalizedGroup) {
      window.localStorage.setItem(PROFILE_RELAY_TOKEN_GROUP_STORAGE_KEY, normalizedGroup);
    } else {
      window.localStorage.removeItem(PROFILE_RELAY_TOKEN_GROUP_STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent(PROFILE_RELAY_TOKEN_GROUP_CHANGED_EVENT, { detail: { tokenGroup: normalizedGroup } }));
  }, [relayTokenGroup]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const normalizedName = relayTokenName.trim();
    if (normalizedName) {
      window.localStorage.setItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY, normalizedName);
    } else {
      window.localStorage.removeItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent(PROFILE_RELAY_TOKEN_NAME_CHANGED_EVENT, { detail: { tokenName: normalizedName } }));
  }, [relayTokenName]);

  const refreshRelayKeyStatus = useCallback(async () => {
    clearStoredRelayApiKey();
    try {
      const status = await fetchProfileRelayKey(activeRelayTokenGroup, activeRelayTokenName);
      const groups = normalizeRelayTokenGroups(status.groups);
      const names = normalizeRelayTokenNames(status.token_names);
      setRelayTokenNameOptions(names);
      setRelayTokenGroup((current) => nextRelayTokenGroup(current, groups, status.group || status.configured_group));
      setRelayTokenName((current) => {
        return nextRelayTokenName(current, names, status.token_name);
      });
      setRelayKeyConfigured(status.has_key);
      setRelayKeyStatusMessage(status.has_key ? "" : status.message || NEWAPI_TOKEN_MISSING_MESSAGE);
    } catch {
      setRelayKeyConfigured(false);
      setRelayKeyStatusMessage("无法读取云棉令牌状态，请稍后重试");
    }
  }, [activeRelayTokenGroup, activeRelayTokenName]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    void refreshRelayKeyStatus();
  }, [refreshRelayKeyStatus, session]);

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
    if (selectedConversationId && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(pickFallbackConversationId(conversations));
    }
  }, [conversations, selectedConversationId]);

  const persistConversation = async (conversation: ImageConversation) => {
    const nextConversations = sortImageConversations([
      conversation,
      ...conversationsRef.current.filter((item) => item.id !== conversation.id),
    ]);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    await saveImageConversation(conversation);
  };

  const updateConversation = useCallback(
    async (
      conversationId: string,
      updater: (current: ImageConversation | null) => ImageConversation,
      options: { persist?: boolean } = {},
    ) => {
      const current = conversationsRef.current.find((item) => item.id === conversationId) ?? null;
      const nextConversation = updater(current);
      const nextConversations = sortImageConversations([
        nextConversation,
        ...conversationsRef.current.filter((item) => item.id !== conversationId),
      ]);
      conversationsRef.current = nextConversations;
      setConversations(nextConversations);
      if (options.persist !== false) {
        await saveImageConversation(nextConversation);
      }
    },
    [],
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
    setReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const resetComposer = useCallback(() => {
    clearComposerInputs();
  }, [clearComposerInputs]);

  const handleCreateDraft = () => {
    setSelectedConversationId(null);
    resetComposer();
    textareaRef.current?.focus();
  };

  const handleApplyPromptPreset = useCallback(async (preset: ImagePromptPreset) => {
    const requestId = promptApplyRequestIdRef.current + 1;
    promptApplyRequestIdRef.current = requestId;
    setSelectedConversationId(null);
    setComposerMode("image");
    setImagePrompt(preset.prompt);
    setImageCount(String(preset.count));
    const presetSizeSelection = getImageSizeSelectionFromSize(preset.size);
    setImageSizeMode(presetSizeSelection.mode);
    setImageAspectRatio(presetSizeSelection.aspectRatio);
    setImageResolution(presetSizeSelection.resolution);
    setImageCustomRatio(presetSizeSelection.customRatio);
    setImageCustomWidth(presetSizeSelection.customWidth);
    setImageCustomHeight(presetSizeSelection.customHeight);
    setImageOutputFormat(DEFAULT_IMAGE_OUTPUT_FORMAT);
    setImageOutputCompression("");
    setDefaultImageVisibility("private");
    setReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    textareaRef.current?.focus();

    const toastId = toast.loading("正在读取参考图");
    try {
      const referenceImage = await buildReferenceImageFromUrl(preset.imageSrc, 0, "preset-reference");
      if (promptApplyRequestIdRef.current !== requestId) {
        toast.dismiss(toastId);
        return;
      }
      setReferenceImages([referenceImage]);
      toast.success("已套用提示词和参考图", { id: toastId });
    } catch {
      if (promptApplyRequestIdRef.current !== requestId) {
        toast.dismiss(toastId);
        return;
      }
      toast.error("已套用提示词，但参考图读取失败", { id: toastId });
    }
  }, []);

  const handleApplyMarketPrompt = useCallback(async (prompt: BananaPrompt) => {
    const referenceImageUrls = getPromptReferenceImageUrls(prompt);
    const requestId = promptApplyRequestIdRef.current + 1;
    promptApplyRequestIdRef.current = requestId;

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
    setImageStreamEnabled(false);
    setImagePartialImages("0");
    setDefaultImageVisibility("private");
    setReferenceImages([]);
    setIsPromptMarketOpen(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    textareaRef.current?.focus();

    if (referenceImageUrls.length === 0) {
      toast.success("已套用提示词");
      return;
    }

    const toastId = toast.loading(`正在读取 ${referenceImageUrls.length} 张参考图`);
    const results = await Promise.allSettled(
      referenceImageUrls.map((url, index) => buildReferenceImageFromUrl(url, index, "prompt-reference")),
    );
    const loadedReferences = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

    if (promptApplyRequestIdRef.current !== requestId) {
      toast.dismiss(toastId);
      return;
    }
    if (loadedReferences.length > 0) {
      setReferenceImages(loadedReferences);
    }
    if (loadedReferences.length === referenceImageUrls.length) {
      toast.success("已套用提示词和参考图", { id: toastId });
    } else if (loadedReferences.length > 0) {
      toast.error(`已套用提示词，${referenceImageUrls.length - loadedReferences.length} 张参考图读取失败`, { id: toastId });
    } else {
      toast.error("已套用提示词，但参考图读取失败", { id: toastId });
    }
  }, []);

  const handleDeleteConversation = async (id: string) => {
    const nextConversations = conversations.filter((item) => item.id !== id);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    if (selectedConversationId === id) {
      setSelectedConversationId(pickFallbackConversationId(nextConversations));
      resetComposer();
    }

    try {
      await deleteImageConversation(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      const items = await listImageConversations();
      conversationsRef.current = items;
      setConversations(items);
    }
  };

  const handleClearHistory = async () => {
    try {
      await clearImageConversations();
      conversationsRef.current = [];
      setConversations([]);
      setSelectedConversationId(null);
      resetComposer();
      toast.success("已清空历史记录");
    } catch (error) {
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
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

    try {
      const previews = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type || "image/png",
          dataUrl: await readFileAsDataUrl(file),
          source: "upload" as const,
        })),
      );

        setReferenceImages((prev) => [...prev, ...previews]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取参考图失败";
      toast.error(message);
    }
  }, []);

  const handleReferenceImageChange = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      await appendReferenceImages(files);
    },
    [appendReferenceImages],
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    setReferenceImages((prev) => {
      const next = prev.filter((_, currentIndex) => currentIndex !== index);
      if (next.length === 0 && fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return next;
    });
  }, []);

  const handleContinueEdit = useCallback(
    async (conversationId: string, image: StoredImage | StoredReferenceImage) => {
      try {
        const nextReference =
          "dataUrl" in image
            ? {
                referenceImage: image,
              }
            : await buildReferenceImageFromStoredImage(
                image,
                `conversation-${conversationId}-${Date.now()}.${imageFileExtensionForOutputFormat(image.outputFormat)}`,
              );
        if (!nextReference) {
          return;
        }

        setSelectedConversationId(conversationId);
        setComposerMode("image");
        setReferenceImages((prev) => [
          ...prev,
          {
            ...nextReference.referenceImage,
            source: "conversation",
          },
        ]);
        setImagePrompt("");
        textareaRef.current?.focus();
        toast.success("已加入当前参考图，继续输入描述即可编辑");
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取结果图失败";
        toast.error(message);
      }
    },
    [],
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
    const sizeSelection = restoreImageSizeSelection(targetTurn.sizeSelection, targetTurn.size);
    setEditingTurnDraft({
      conversationId,
      turnId,
      prompt: targetTurn.prompt,
      model: imageCreationModelOptions.some((option) => option.value === targetTurn.model)
        ? targetTurn.model
        : defaultImageModel,
      mode: targetTurn.mode,
      count: String(normalizeRequestedImageCount(targetTurn.count || targetTurn.images.length || 1)),
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
      tokenGroup: targetTurn.tokenGroup || activeRelayTokenGroup,
      tokenName: targetTurn.tokenName || activeRelayTokenName,
      visibility: targetTurn.visibility || "private",
      referenceImages: targetTurn.referenceImages,
    });
  }, [activeRelayTokenGroup, activeRelayTokenName, defaultImageModel, imageCreationModelOptions]);

  const handleEditReferenceImageChange = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    try {
      const previews = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type || "image/png",
          dataUrl: await readFileAsDataUrl(file),
          source: "upload" as const,
        })),
      );
      setEditingTurnDraft((current) =>
        current
          ? {
              ...current,
              referenceImages: [...current.referenceImages, ...previews],
            }
          : current,
      );
      if (editFileInputRef.current) {
        editFileInputRef.current.value = "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取参考图失败";
      toast.error(message);
    }
  }, []);

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

  const runConversationQueue = useCallback(
    async (conversationId: string) => {
      if (activeConversationQueueIds.has(conversationId)) {
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

      activeConversationQueueIds.add(conversationId);
      const activeTurnKey = imageTurnProgressKey(conversationId, activeTurn.id);
      const activeTurnStartedAt = imageTurnStartedAtTimestamp(activeTurn.processingStartedAt, activeTurn.createdAt);
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
        activeConversationQueueIds.delete(conversationId);
        return;
      }
      updateTurnProgress(conversationId, activeTurn.id, {
        message: "正在准备生成任务",
        detail: `准备处理 ${activeTurn.images.filter((image) => image.status === "loading").length || activeTurn.count} 张图片`,
        startedAt: activeTurnStartedAt,
      });
      const applyTasks = async (tasks: CreationTask[]) => {
        const taskMap = new Map(tasks.map((task) => [task.id, task]));
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
        });
      };

      try {
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "generating",
                    error: undefined,
                    images: turn.images.map((image, imageIndex) =>
                      image.status === "loading"
                        ? {
                            ...image,
                            taskId: imageTaskIdForImage(turn.id, turn.images, imageIndex),
                          }
                        : image,
                    ),
                  }
                : turn,
            ),
          };
        });

        updateTurnProgress(conversationId, activeTurn.id, {
          message: usesReferenceImages(activeTurn.mode) ? "正在整理参考图" : "正在准备生成请求",
          detail: usesReferenceImages(activeTurn.mode) ? "正在读取参考图并准备上传" : "正在创建图片生成任务",
        });
        const referenceFiles = activeTurn.referenceImages.map((image, index) =>
          dataUrlToFile(image.dataUrl, image.name || `${activeTurn.id}-${index + 1}.png`, image.type),
        );
        if (usesReferenceImages(activeTurn.mode) && referenceFiles.length === 0) {
          throw new Error("未找到可用的参考图");
        }
        const activeTurnRelayTokenGroup = activeTurn.tokenGroup || activeRelayTokenGroup;
        const activeTurnRelayTokenName = activeTurn.tokenName || activeRelayTokenName;
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
        const taskStream = Boolean(activeTurn.stream);
        const taskPartialImages = normalizeImagePartialImages(activeTurn.partialImages);
        const pendingTaskGroups = activeTurn.images.reduce<Array<{ taskId: string; count: number }>>(
          (groups, image, imageIndex) => {
            if (image.status !== "loading") {
              return groups;
            }
            const taskId = imageTaskIdForImage(activeTurn.id, activeTurn.images, imageIndex);
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
          if (usesReferenceImages(activeTurn.mode)) {
            return createImageEditTask(
              group.taskId,
              referenceFiles,
              activeTurn.prompt,
              activeTurn.model,
              activeTurnSizeRequest.upstreamSize,
              activeTurnSizeRequest.size,
              activeTurn.quality,
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
            );
          }
          return createImageGenerationTask(
            group.taskId,
            activeTurn.prompt,
            activeTurn.model,
            activeTurnSizeRequest.upstreamSize,
            activeTurnSizeRequest.size,
            activeTurn.quality,
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
          );
        };
        updateTurnProgress(conversationId, activeTurn.id, {
          message: "正在提交生成请求",
          detail: `${pendingTaskGroups.length} 个图片任务正在入队`,
        });
        const submitted = await Promise.all(pendingTaskGroups.map(submitTaskGroup));
        let activeTaskIds = new Set(submitted.filter(isActiveCreationTask).map((task) => task.id));
        await applyTasks(submitted);
        const submittedStatus =
          submitted.length > 0 && submitted.every((task) => task.status === "queued") ? "queued" : "generating";
        updateTurnProgress(conversationId, activeTurn.id, imageTaskProgressMessage({ ...activeTurn, status: submittedStatus }));

        let pollDelayMs = 1000;
        while (true) {
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
          const taskList = await fetchCreationTasks(pollingTaskIds);
          pollDelayMs = Math.min(2500, Math.round(pollDelayMs * 1.5));
          activeTaskIds = new Set(taskList.items.filter(isActiveCreationTask).map((task) => task.id));
          if (taskList.items.length > 0) {
            await applyTasks(taskList.items);
          }
          if (taskList.missing_ids.length > 0 && latestTurn) {
            updateTurnProgress(conversationId, activeTurn.id, {
              message: "正在恢复生成任务",
              detail: `${taskList.missing_ids.length} 个任务状态丢失，正在重新提交`,
            });
            const missingTaskGroups = taskList.missing_ids.flatMap((taskId) => {
              const count = latestTurn.images.filter((image) => image.status === "loading" && image.taskId === taskId).length;
              return count > 0 ? [{ taskId, count }] : [];
            });
            const resubmitted = await Promise.all(missingTaskGroups.map(submitTaskGroup));
            if (resubmitted.length > 0) {
              await applyTasks(resubmitted);
            }
          }
        }

        updateTurnProgress(conversationId, activeTurn.id, {
          message: "生成完成",
          detail: "正在刷新会话",
        });
      } catch (error) {
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
        clearTurnProgress(conversationId, activeTurn.id);
        cancelledTurnIdsRef.current.delete(activeTurnKey);
        activeConversationQueueIds.delete(conversationId);
        for (const conversation of conversationsRef.current) {
          if (
            !activeConversationQueueIds.has(conversation.id) &&
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
    [activeRelayTokenGroup, activeRelayTokenName, clearTurnProgress, updateConversation, updateTurnProgress],
  );
  useEffect(() => {
    for (const conversation of conversations) {
      if (
        !activeConversationQueueIds.has(conversation.id) &&
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
      if (targetTurn.mode === "chat") {
        const turnKey = imageTurnProgressKey(conversationId, turnId);
        cancelledTurnIdsRef.current.add(turnKey);
        clearTurnProgress(conversationId, turnId);
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
        return;
      }

      const results = await Promise.allSettled(taskIds.map((taskId) => cancelCreationTask(taskId)));
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
    [clearTurnProgress, updateConversation],
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
      if (!relayKeyConfigured) {
        toast.error(relayKeyMissingMessage);
        return;
      }

      retryingImageIdsRef.current.add(retryKey);
      const now = new Date().toISOString();
      const retryTaskId = imageTaskBatchId(`${targetTurn.id}-${createId()}`, imageIndex);
      try {
        await updateConversation(conversationId, (current) => {
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
                      taskStatus: "queued" as const,
                      status: "loading" as const,
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
                images,
              };
            }),
          };
        });
        void runConversationQueue(conversationId);
        toast.success("已加入重试队列");
      } catch (error) {
        toast.error(formatCreationTaskError(error, "提交重试失败"));
      } finally {
        retryingImageIdsRef.current.delete(retryKey);
      }
    },
    [relayKeyConfigured, relayKeyMissingMessage, runConversationQueue, updateConversation],
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
      if (!relayKeyConfigured) {
        toast.error(relayKeyMissingMessage);
        return;
      }

      const now = new Date().toISOString();
      const regenerationId = createId();
      await updateConversation(conversationId, (current) => {
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

            const imageCount = normalizeRequestedImageCount(turn.count || turn.images.length || 1);
            const visibility = turn.visibility || "private";
            return {
              ...turn,
              count: imageCount,
              status: "queued",
              error: undefined,
              processingStartedAt: undefined,
              images: Array.from({ length: imageCount }, (_, index): StoredImage => {
                const imageId = `${turn.id}-${regenerationId}-${index}`;
                return {
                  id: imageId,
                  taskId: imageTaskBatchId(`${turn.id}-${regenerationId}`, index),
                  taskStatus: "queued" as const,
                  status: "loading" as const,
                  visibility,
                };
              }),
            };
          }),
        };
      });
      void runConversationQueue(conversationId);
      toast.success("已加入重新生成队列");
    },
    [relayKeyConfigured, relayKeyMissingMessage, runConversationQueue, updateConversation],
  );

  const handleSaveEditingTurn = useCallback(
    async (regenerate: boolean) => {
      const draft = editingTurnDraft;
      if (!draft) {
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
      if (regenerate && !relayKeyConfigured) {
        toast.error(relayKeyMissingMessage);
        return;
      }

      const imageCount = normalizeRequestedImageCount(draft.count);
      const mode = getComposerConversationMode("image", draft.referenceImages);
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
      const draftQuality = imageQualityForRequest(draft.quality);
      if (supportsStructuredImageParameters(draft.model) && isHighResolutionImageSize(draftImageSize)) {
        const sizeLabel = formatImageSizeDisplay(draftImageSize);
        if (regenerate) {
          toast.message(`${sizeLabel} 属于高分辨率目标，实际像素以生成结果为准。`);
        }
      }
      const now = new Date().toISOString();
      const regenerationId = createId();
      await updateConversation(draft.conversationId, (current) => {
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
              stream: draft.stream,
              partialImages: normalizeImagePartialImages(draft.partialImages),
              tokenGroup: draft.tokenGroup || undefined,
              tokenName: draft.tokenName || undefined,
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
                  taskId: imageTaskBatchId(`${turn.id}-${regenerationId}`, index),
                  taskStatus: "queued" as const,
                  status: "loading" as const,
                  visibility: baseTurn.visibility,
                };
              }),
            };
          }),
        };
      });

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
    [editingTurnDraft, relayKeyConfigured, relayKeyMissingMessage, runConversationQueue, updateConversation],
  );

  const handleSubmit = async () => {
    if (isSubmitDispatchingRef.current) {
      return;
    }

    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }
    if (!relayKeyConfigured) {
      toast.error(relayKeyMissingMessage);
      return;
    }
    isSubmitDispatchingRef.current = true;
    let draftProgressTarget: { conversationId: string; turnId: string } | null = null;

    try {
      const effectiveImageMode = getComposerConversationMode("image", referenceImages);
      const effectiveModel =
        imageCreationModelOptions.some((option) => option.value === imageModel)
            ? imageModel
            : defaultImageModel;
      const requestedCount = parsedCount;
      const rawImageSizeSelection = {
        mode: imageSizeMode,
        aspectRatio: imageAspectRatio,
        resolution: imageResolution,
        customRatio: imageCustomRatio,
        customWidth: imageCustomWidth,
        customHeight: imageCustomHeight,
      };
      const currentImageSizeRequest =
        buildEffectiveImageSizeRequest(effectiveModel, rawImageSizeSelection);
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
      const currentImageSize = currentImageSizeRequest?.size ?? "";
      const currentSelectionChanged = currentImageSizeRequest
        ? customImageSizeChanged(rawImageSizeSelection, currentImageSize)
        : false;
      const currentSelection = currentImageSizeRequest
        ? applyNormalizedCustomImageSize(currentImageSizeRequest.selection, currentImageSize)
        : undefined;
      const currentImageSizeSelection = currentSelection
        ? serializeImageSizeSelection(currentSelection)
        : undefined;
      const effectiveOutputFormat =
        imageOutputFormatForModel(effectiveModel, imageOutputFormat);
      const effectiveOutputCompression =
        effectiveOutputFormat === undefined
          ? undefined
          : imageOutputCompressionForModel(effectiveModel, effectiveOutputFormat, imageOutputCompression);
      const effectiveImageQuality =
        imageQualityForRequest(imageQuality);
      const isHighResolutionRequest =
        supportsStructuredImageParameters(effectiveModel) &&
        isHighResolutionImageSize(currentImageSize);
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
        referenceImages: usesReferenceImages(effectiveImageMode) ? referenceImages : [],
        count: requestedCount,
        size: currentImageSize,
        sizeSelection: currentImageSizeSelection,
        quality: effectiveImageQuality,
        outputFormat: effectiveOutputFormat,
        outputCompression: effectiveOutputCompression,
        stream: imageStreamEnabled,
        partialImages: normalizeImagePartialImages(imagePartialImages),
        tokenGroup: activeRelayTokenGroup || undefined,
        tokenName: activeRelayTokenName || undefined,
        visibility: defaultImageVisibility,
        images: Array.from({ length: requestedCount }, (_, index): StoredImage => {
          const imageId = `${turnId}-${index}`;
          return {
            id: imageId,
            taskId: imageTaskBatchId(turnId, index),
            taskStatus: "queued" as const,
            status: "loading" as const,
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
      setSelectedConversationId(conversationId);
      if (currentSelectionChanged && currentSelection) {
        setImageCustomWidth(currentSelection.customWidth);
        setImageCustomHeight(currentSelection.customHeight);
        toast.message(`宽高已自动校正为 ${formatImageSizeDisplay(currentImageSize)}`);
      }
      clearComposerInputs();

      await persistConversation(baseConversation);
      void runConversationQueue(conversationId);

      const targetStats = getImageConversationStats(baseConversation);
      if (targetStats.running > 0 || targetStats.queued > 1) {
        toast.success("已加入当前图片队列");
      } else if (!targetConversation) {
        toast.success("已创建新图片任务并开始处理");
      } else {
        toast.success("已发送到当前图片记录");
      }
    } catch (error) {
      if (draftProgressTarget) {
        clearTurnProgress(draftProgressTarget.conversationId, draftProgressTarget.turnId);
      }
      toast.error(formatCreationTaskError(error, "提交任务失败"));
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
            selectedConversationId={selectedConversationId}
            onCreateDraft={handleCreateDraft}
            onClearHistory={openClearHistoryConfirm}
            onSelectConversation={setSelectedConversationId}
            onDeleteConversation={openDeleteConversationConfirm}
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
                formatConversationTime={formatConversationTime}
                hideActionButtons
              />
            </div>
          </DialogContent>
        </Dialog>

        {editingTurnDraft ? (
          <Dialog open onOpenChange={(open) => (!open ? setEditingTurnDraft(null) : null)}>
            <DialogContent className="flex max-h-[88dvh] w-[min(92vw,640px)] flex-col overflow-hidden rounded-[28px] p-0">
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
                      accept="image/*"
                      multiple
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
                        className="rounded-full border-stone-200 bg-white"
                        onClick={() => editFileInputRef.current?.click()}
                      >
                        <ImagePlus className="size-4" />
                        上传图片
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
                              <img
                                src={image.dataUrl}
                                alt={image.name || `参考图 ${index + 1}`}
                                className="h-full w-full object-cover"
                              />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveEditReferenceImage(index)}
                              className="absolute -top-1 -right-1 z-10 inline-flex size-6 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 shadow-sm transition hover:text-stone-900"
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
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </label>

                  {editingTurnDraft.mode !== "chat" && editingDraftEffectiveSizeSelection ? (
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
                        <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="编辑图片画幅比例">
                          {IMAGE_ASPECT_RATIO_OPTIONS.map((option) => {
                            const isAuto = option.value === "";
                            const isCustom = option.value === CUSTOM_IMAGE_ASPECT_RATIO;
                            const active = isAuto
                              ? editingDraftEffectiveSizeSelection.mode === "auto"
                              : editingDraftEffectiveSizeSelection.mode === "ratio" &&
                                editingTurnDraft.aspectRatio === option.value;
                            return (
                              <button
                                key={option.value || "auto"}
                                type="button"
                                aria-pressed={active}
                                className={cn(
                                  "flex h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border border-[#e5e7eb] bg-[#f7f7f8] px-1 text-[10px] font-medium text-[#686b73] transition hover:border-[#cfd1d5] hover:bg-white hover:text-[#222222] dark:border-border dark:bg-muted/55 dark:text-muted-foreground dark:hover:bg-background dark:hover:text-foreground",
                                  active &&
                                    "border-[#bfd1ff] bg-[#eef4ff] text-[#1456f0] shadow-[inset_0_0_0_1px_rgba(20,86,240,0.08)] hover:border-[#9db9ff] hover:bg-[#eef4ff] hover:text-[#1456f0] dark:border-sky-900/80 dark:bg-sky-950/35 dark:text-sky-300",
                                )}
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
                              >
                                {isAuto || isCustom ? (
                                  <SlidersHorizontal className="size-3.5" />
                                ) : (
                                  <ImageAspectRatioGlyph ratio={option.value} />
                                )}
                                <span className="truncate">{isAuto ? "自动" : isCustom ? "自定义" : option.value}</span>
                              </button>
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

                      {editingDraftOutputControls ? (
                        <section className="space-y-1.5">
                          <ImageParameterLabel help="gpt-image-2 支持自动、低、中、高四档；质量越高，生成时间和费用通常越高。">
                            质量
                          </ImageParameterLabel>
                          <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70" role="group" aria-label="编辑图片质量">
                            {[{ value: "", label: "自动" }, ...IMAGE_QUALITY_OPTIONS].map((option) => (
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

                      {editingDraftStructuredParameters ? (
                        <section className="space-y-1.5">
                          <ImageParameterLabel help="自动比例使用常规像素；1080P、2K、4K 会结合宽高比计算，并校正为允许的尺寸。">
                            分辨率
                          </ImageParameterLabel>
                          <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#f4f4f5] p-1 dark:bg-muted/70" role="group" aria-label="编辑图片分辨率">
                            {IMAGE_RESOLUTION_OPTIONS.map((option) => {
                              const active =
                                editingTurnDraft.resolution === option.value &&
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
                        <ImageParameterLabel help="单次请求生成 1-10 张图片；系统会按并发额度拆分和排队。">
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
                            disabled={editingDraftCount >= 10}
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

                      <details className="group border-t border-[#ececef] pt-2.5 dark:border-border">
                        <summary className="flex h-8 cursor-pointer list-none items-center justify-between rounded-md px-1.5 text-xs font-semibold text-[#3f4147] outline-none transition hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-[#1456f0]/30 dark:text-foreground dark:hover:bg-accent/60 [&::-webkit-details-marker]:hidden">
                          <span>高级设置</span>
                          <ChevronDown className="size-3.5 opacity-60 transition group-open:rotate-180" />
                        </summary>
                        <div className="mt-2 space-y-3">
                          <section className="space-y-1.5">
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
                          </section>

                          <div className="flex h-9 items-center justify-between rounded-lg bg-[#f4f4f5] px-2.5 dark:bg-muted/70">
                            <ImageParameterLabel help="开启后会使用流式返回，需要图片服务支持流式响应。">
                              流式返回
                            </ImageParameterLabel>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={editingTurnDraft.stream}
                              aria-label="编辑图片流式返回"
                              className={cn(
                                "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1456f0]/30",
                                editingTurnDraft.stream ? "bg-[#1456f0]" : "bg-[#c8cbd1] dark:bg-muted-foreground/45",
                              )}
                              onClick={() =>
                                setEditingTurnDraft((current) =>
                                  current
                                    ? {
                                        ...current,
                                        stream: !current.stream,
                                        partialImages: !current.stream ? current.partialImages : "0",
                                      }
                                    : current,
                                )
                              }
                            >
                              <span
                                className={cn(
                                  "absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform",
                                  editingTurnDraft.stream ? "translate-x-[18px]" : "translate-x-0.5",
                                )}
                              />
                            </button>
                          </div>

                          {editingTurnDraft.stream ? (
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
                                    <input
                                      type="range"
                                      min="0"
                                      max="100"
                                      step="1"
                                      value={editingTurnDraft.outputCompression || "100"}
                                      onChange={(event) =>
                                        setEditingTurnDraft((current) =>
                                          current ? { ...current, outputCompression: event.target.value } : current,
                                        )
                                      }
                                      className="h-1.5 w-full accent-[#18181b] dark:accent-foreground"
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
                      </details>
                    </div>
                  ) : null}
                </div>
              </div>
              <DialogFooter className="border-t border-stone-100 px-6 py-4">
                <Button variant="outline" onClick={() => setEditingTurnDraft(null)}>
                  取消
                </Button>
                <Button variant="outline" onClick={() => void handleSaveEditingTurn(false)}>
                  保存
                </Button>
                <Button onClick={() => void handleSaveEditingTurn(true)}>
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
                新建
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
                relayKeyConfigured={relayKeyConfigured}
                relayKeyStatusMessage={relayKeyMissingMessage}
                highResolutionHint={highResolutionHint}
                referenceImages={referenceImages}
                textareaRef={textareaRef}
                fileInputRef={fileInputRef}
                onPromptChange={setImagePrompt}
                onImageCountChange={setImageCount}
                onImageModelChange={setImageModel}
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

  return <ImagePageContent session={session} />;
}
