"use client";

import {
  clearImageConversationHistory,
  deleteImageConversationHistoryItem,
  fetchImageConversationHistoryItem,
  fetchImageConversationHistoryPage,
  fetchImageConversationHistoryWindow,
  mergeImageConversationHistory,
  type ImageConversationHistoryMergeResponse,
  type ImageConversationHistoryPageOptions,
  type ImageConversationHistoryRequestOptions,
} from "@/services/api/image-conversations";
import {
  DEFAULT_IMAGE_MODEL,
  isImageCreationModel,
  isImageModeration,
  isImageOutputFormat,
  isImageQuality,
  supportsImageOutputCompression,
  type ImageVisibility,
} from "@/lib/api";
import {
  effectiveStoredImageLoadingPhase,
  mergeImageConversationLists,
  mergeImageConversationSnapshot,
  rebaseImageConversationSnapshot,
} from "@/lib/image-task-state";
import {
  imageConversationHistoryGenerationsMatch,
  imageConversationHistoryGenerationAtLeast,
  maxImageConversationHistoryGeneration,
  normalizeImageConversationHistoryGeneration,
} from "@/lib/image-conversation-history";
import { getManagedImagePathFromUrl } from "@/lib/image-path";
import { normalizeImageConversationAssetReference } from "@/lib/image-conversation-assets";
import { isWorkflowImageConversation } from "@/lib/image-conversation-source";
import type {
  ImageConversation,
  ImageConversationHistorySummary,
  ImageConversationMode,
  ImageConversationStats,
  ImageTurn,
  ImageTurnLoadingCounts,
  ImageTurnLoadingPhase,
  ImageTurnStatus,
  StoredImage,
  StoredImageSizeSelection,
  StoredReferenceImage,
} from "@/lib/image-conversation-types";
import { normalizeStoredVideoSeconds } from "@/lib/video-request-normalizer";
import { AUTH_SESSION_CHANGE_EVENT, getCachedAuthSession, getVerifiedAuthSession } from "@/lib/session";
import {
  classifyImageConversationMergeAcknowledgements,
  enqueueScopedWrite,
  imageConversationAcknowledgementsRequireRefresh,
  imageConversationScopeBinding,
  ImageConversationScopeChangedError,
  ImageConversationScopeFailureRegistry,
  ImageConversationSessionScopeCoordinator,
  isMatchingImageConversationMinimalAck,
  isImageConversationScopeChangedError,
  isRetryableImageConversationSaveError,
  runCurrentImageConversationScopeOperation,
  waitForScopedWrites,
  type ImageConversationAcknowledgementResult,
  type ImageConversationSessionScope,
} from "@/store/image-conversation-session-scope";

export type {
  ImageConversation,
  ImageConversationMode,
  ImageConversationStats,
  ImageTurn,
  ImageTurnLoadingCounts,
  ImageTurnLoadingPhase,
  ImageTurnStatus,
  StoredImage,
  StoredImageSizeSelection,
  StoredReferenceImage,
} from "@/lib/image-conversation-types";

export type ImageConversationHistoryPage = {
  items: ImageConversation[];
  nextCursor: string | null;
  hasMore: boolean;
  generation: string | null;
};

export type ImageConversationHistoryWindow = {
  firstPage: ImageConversationHistoryPage;
  activePage: ImageConversationHistoryPage;
  generation: string | null;
};

export type ImageConversationHistoryPageRequestOptions = Omit<
  ImageConversationHistoryPageOptions,
  "redirectOnUnauthorized"
> & ImageConversationHistoryRequestOptions;

export const IMAGE_CONVERSATIONS_CHANGED_EVENT = "chatgpt2api:image-conversations-changed";
export const ACTIVE_IMAGE_CONVERSATION_STORAGE_KEY = "chatgpt2api:image_active_conversation_id";
export const IMAGE_ACTIVE_CONVERSATION_REQUEST_EVENT = "chatgpt2api:image-open-conversation";
class ImageConversationHistoryRequestStaleError extends Error {
  readonly code = "IMAGE_CONVERSATION_HISTORY_REQUEST_STALE";

  constructor() {
    super("图片历史请求已被更新的会话状态取代");
    this.name = "ImageConversationHistoryRequestStaleError";
  }
}

class ImageConversationHistoryGenerationMismatchError extends Error {
  readonly code = "IMAGE_CONVERSATION_HISTORY_GENERATION_MISMATCH";

  constructor() {
    super("图片历史分页版本不一致，请重新读取");
    this.name = "ImageConversationHistoryGenerationMismatchError";
  }
}
type CoalescedConversationWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};
type CoalescedConversationSave = {
  conversation: ImageConversation;
  waiters: CoalescedConversationWaiter[];
};

type ImageConversationScopeState = {
  scope: ImageConversationSessionScope;
  coalescedSaves: Map<string, CoalescedConversationSave>;
  coalescedFailures: Map<string, unknown>;
  failedSnapshots: Map<string, ImageConversation>;
  durableFailures: Set<string>;
  coalescedDrain: Promise<void> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  paginationEpoch: number;
  remoteCursorGeneration: string | null;
  pageRequests: Map<string, { epoch: number; promise: Promise<ImageConversationHistoryPage> }>;
  windowRequests: Map<number, { epoch: number; promise: Promise<ImageConversationHistoryWindow> }>;
  detailRequests: Map<string, { epoch: number; promise: Promise<ImageConversation | null> }>;
};

const imageConversationScopeCoordinator = new ImageConversationSessionScopeCoordinator();
const imageConversationScopeFailures = new ImageConversationScopeFailureRegistry();
let imageConversationAuthGeneration = 0;
let activeImageConversationScopeState: ImageConversationScopeState | null = null;

function createImageConversationScopeState(scope: ImageConversationSessionScope): ImageConversationScopeState {
  return {
    scope,
    coalescedSaves: new Map(),
    coalescedFailures: new Map(),
    failedSnapshots: new Map(),
    durableFailures: new Set(),
    coalescedDrain: null,
    retryTimer: null,
    paginationEpoch: 0,
    remoteCursorGeneration: null,
    pageRequests: new Map(),
    windowRequests: new Map(),
    detailRequests: new Map(),
  };
}

function rejectCoalescedConversationWaiters(
  saves: Iterable<CoalescedConversationSave>,
  error: unknown,
) {
  for (const { waiters } of saves) {
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
}

function retireImageConversationScopeState(state: ImageConversationScopeState) {
  const error = new ImageConversationScopeChangedError();
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  rejectCoalescedConversationWaiters(state.coalescedSaves.values(), error);
  state.coalescedSaves.clear();
  state.coalescedFailures.clear();
  state.failedSnapshots.clear();
  state.durableFailures.clear();
  state.paginationEpoch += 1;
  state.pageRequests.clear();
  state.windowRequests.clear();
  state.detailRequests.clear();
  state.remoteCursorGeneration = null;
}

function invalidateImageConversationSessionScope() {
  imageConversationAuthGeneration += 1;
  const previous = activeImageConversationScopeState;
  activeImageConversationScopeState = null;
  imageConversationScopeCoordinator.invalidate();
  if (previous) {
    retireImageConversationScopeState(previous);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener(AUTH_SESSION_CHANGE_EVENT, invalidateImageConversationSessionScope);
}

async function getCurrentImageConversationScopeState() {
  const authGeneration = imageConversationAuthGeneration;
  const cachedSession = getCachedAuthSession();
  const session = cachedSession === undefined ? await getVerifiedAuthSession() : cachedSession;
  if (authGeneration !== imageConversationAuthGeneration) {
    throw new ImageConversationScopeChangedError();
  }
  const scope = imageConversationScopeCoordinator.activate(imageConversationScopeBinding(session));
  const current = activeImageConversationScopeState;
  if (current?.scope === scope) {
    return current;
  }
  if (current) {
    retireImageConversationScopeState(current);
  }
  const state = createImageConversationScopeState(scope);
  activeImageConversationScopeState = state;
  return state;
}

function isCurrentImageConversationScope(state: ImageConversationScopeState) {
  return activeImageConversationScopeState === state &&
    imageConversationScopeCoordinator.isCurrent(state.scope);
}

function assertCurrentImageConversationScope(state: ImageConversationScopeState) {
  if (!isCurrentImageConversationScope(state)) {
    throw new ImageConversationScopeChangedError();
  }
}

function assertCurrentImageConversationRequest(
  state: ImageConversationScopeState,
  requestEpoch: number,
) {
  assertCurrentImageConversationScope(state);
  if (requestEpoch !== state.paginationEpoch) {
    throw new ImageConversationHistoryRequestStaleError();
  }
}

function historyRequestOptions(): ImageConversationHistoryRequestOptions {
  return {
    redirectOnUnauthorized: false,
  };
}

function assertDurableConversationAcknowledgement(
  response: ImageConversationHistoryMergeResponse,
  conversation: ImageConversation,
) {
  const acknowledgement = classifyImageConversationMergeAcknowledgements(response, [conversation])[0];
  if (
    acknowledgement?.outcome === "accepted" &&
    isMatchingImageConversationMinimalAck(response, conversation)
  ) {
    return;
  }
  throw imageConversationAcknowledgementError(
    acknowledgement || {
      id: conversation.id,
      expectedRevision: conversation.revision,
      outcome: "protocol",
      httpStatus: 503,
      code: "IMAGE_CONVERSATION_ACK_PROTOCOL_ERROR",
      message: `图片历史未确认写入数据库: ${conversation.id}`,
    },
  );
}

function imageConversationAcknowledgementError(
  acknowledgement: ImageConversationAcknowledgementResult,
) {
  const error = new Error(
    acknowledgement.message || `图片历史未确认写入数据库: ${acknowledgement.id}`,
  ) as Error & {
    status?: number;
    code?: string;
    conversationId?: string;
    actualRevision?: number;
  };
  error.status = acknowledgement.httpStatus;
  error.code = acknowledgement.code;
  error.conversationId = acknowledgement.id;
  error.actualRevision = acknowledgement.actualRevision;
  return error;
}

function isImageConversationRevisionConflict(error: unknown) {
  return historyErrorStatus(error) === 409 ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "IMAGE_CONVERSATION_REVISION_STALE");
}

function imageConversationGoneError(id: string) {
  return imageConversationAcknowledgementError({
    id,
    outcome: "gone",
    httpStatus: 410,
    code: "IMAGE_CONVERSATION_GONE",
    message: `图片历史已删除或清空: ${id}`,
  });
}

function rememberPendingDurableConversation(
  state: ImageConversationScopeState,
  conversation: ImageConversation,
  error: unknown,
) {
  if (!isCurrentImageConversationScope(state)) {
    return;
  }
  const current = state.failedSnapshots.get(conversation.id);
  state.failedSnapshots.set(
    conversation.id,
    current ? mergeImageConversationSnapshot(current, conversation) : conversation,
  );
  state.coalescedFailures.set(conversation.id, error);
  state.durableFailures.add(conversation.id);
}

async function rebaseImageConversationAfterConflict(
  state: ImageConversationScopeState,
  conversation: ImageConversation,
) {
  assertCurrentImageConversationScope(state);
  const current = await getImageConversation(conversation.id);
  assertCurrentImageConversationScope(state);
  if (!current) {
    throw imageConversationGoneError(conversation.id);
  }
  return rebaseImageConversationSnapshot(current, conversation);
}

function bindImageConversationFailureToScope(
  state: ImageConversationScopeState,
  error: unknown,
) {
  return imageConversationScopeFailures.bind(state.scope, error);
}

function waitForConversationSaveRetry(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function rememberFailedConversationSnapshot(
  state: ImageConversationScopeState,
  conversation: ImageConversation,
  error: unknown,
  requiresDurableAcknowledgement = false,
) {
  if (!isCurrentImageConversationScope(state) || isImageConversationScopeChangedError(error)) {
    return;
  }
  if (!isRetryableImageConversationSaveError(error)) {
    state.failedSnapshots.delete(conversation.id);
    state.coalescedFailures.delete(conversation.id);
    state.durableFailures.delete(conversation.id);
    return;
  }
  const current = state.failedSnapshots.get(conversation.id);
  state.failedSnapshots.set(
    conversation.id,
    current ? mergeImageConversationSnapshot(current, conversation) : conversation,
  );
  state.coalescedFailures.set(conversation.id, error);
  if (requiresDurableAcknowledgement) {
    state.durableFailures.add(conversation.id);
  }
  scheduleFailedConversationRetry(state);
}

function scheduleFailedConversationRetry(state: ImageConversationScopeState) {
  if (!isCurrentImageConversationScope(state) || state.retryTimer || state.failedSnapshots.size === 0) {
    return;
  }
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (!isCurrentImageConversationScope(state)) {
      return;
    }
    for (const [id, conversation] of state.failedSnapshots) {
      if (state.durableFailures.has(id)) {
        state.failedSnapshots.delete(id);
        state.coalescedFailures.delete(id);
        state.durableFailures.delete(id);
        void persistImageConversationDurably(state, conversation).catch(() => undefined);
        continue;
      }
      const queued = state.coalescedSaves.get(id);
      state.coalescedSaves.set(id, {
        conversation: queued
          ? mergeImageConversationSnapshot(conversation, queued.conversation)
          : conversation,
        waiters: queued?.waiters || [],
      });
    }
    void ensureCoalescedConversationDrain(state);
  }, 5000);
}

function dispatchImageConversationsChanged(
  state: ImageConversationScopeState,
  options: { requiresRefresh?: boolean } = {},
) {
  if (!isCurrentImageConversationScope(state)) {
    return;
  }
  // A local durable write invalidates any pagination cursor/cache. Keep
  // in-flight requests alive for their callers, but prevent a later caller
  // from reusing their pre-write response.
  state.paginationEpoch += 1;
  state.pageRequests.clear();
  state.windowRequests.clear();
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(IMAGE_CONVERSATIONS_CHANGED_EVENT, {
    detail: {
      source: "server-write",
      ownerScope: state.scope.ownerScope,
      requiresRefresh: options.requiresRefresh === true,
    },
  }));
}

export function getStoredImageLoadingPhase(
  image: StoredImage,
  context?: { images?: StoredImage[]; status?: unknown },
): ImageTurnLoadingPhase {
  return effectiveStoredImageLoadingPhase(image, context);
}

export function getImageTurnLoadingCounts(turn: { images: StoredImage[]; status?: unknown }): ImageTurnLoadingCounts {
  const loadingImages = turn.images.filter((image) => image.status === "loading");
  const running = loadingImages.filter((image) => getStoredImageLoadingPhase(image, turn) === "running").length;
  return {
    queued: loadingImages.length - running,
    running,
  };
}

function getImageTurnLoadingPhase(turn: { images: StoredImage[]; status?: unknown }): ImageTurnLoadingPhase {
  const { queued, running } = getImageTurnLoadingCounts(turn);
  if (running > 0) {
    return "running";
  }
  if (queued > 0) {
    return "queued";
  }
  return "idle";
}

export function getEffectiveImageTurnStatus(turn: {
  images: StoredImage[];
  status?: unknown;
}): ImageTurnStatus {
  const loadingPhase = getImageTurnLoadingPhase(turn);
  if (loadingPhase === "running") {
    return "generating";
  }
  if (loadingPhase === "queued") {
    return "queued";
  }

  if (turn.images.some((image) => image.status === "error")) {
    return "error";
  }
  if (turn.images.some((image) => image.status === "cancelled")) {
    return "cancelled";
  }
  if (turn.images.some((image) => image.status === "success")) {
    return "success";
  }
  if (turn.images.some((image) => image.status === "message")) {
    return "message";
  }

  if (
    turn.status === "queued" ||
    turn.status === "generating" ||
    turn.status === "success" ||
    turn.status === "error" ||
    turn.status === "cancelled" ||
    turn.status === "message"
  ) {
    return turn.status;
  }
  return "success";
}

function normalizeStoredError(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return undefined;
  }
  const normalized = text.toLowerCase();
  if (
    normalized.includes("task returned no output data") ||
    normalized.includes("任务没有返回图片数据") ||
    normalized.includes("图片任务没有返回图片数据")
  ) {
    return "图片任务没有返回图片数据。通常是生成服务没有产出图片、模型参数不匹配、提示词被拒绝或服务链路异常导致；请调整提示词或参数后重试，并检查服务日志。";
  }
  return text;
}

function normalizeStoredImage(image: StoredImage): StoredImage {
  const url = typeof image.url === "string" && image.url ? image.url : undefined;
  const width = Number(image.width);
  const height = Number(image.height);
  const resolution = typeof image.resolution === "string" && image.resolution ? image.resolution : undefined;
  const taskStatus =
    image.taskStatus === "queued" ||
    image.taskStatus === "running" ||
    image.taskStatus === "success" ||
    image.taskStatus === "error" ||
    image.taskStatus === "cancelled"
      ? image.taskStatus
      : image.status === "loading"
        ? "queued"
        : undefined;
  const taskRevision = Number(image.taskRevision);
  const normalized = {
    ...image,
    mediaType: image.mediaType === "video" || image.videoUrl || image.mimeType?.startsWith("video/") ? "video" as const : "image" as const,
    videoUrl: typeof image.videoUrl === "string" && image.videoUrl ? image.videoUrl : undefined,
    mimeType: typeof image.mimeType === "string" && image.mimeType ? image.mimeType : undefined,
    taskId: typeof image.taskId === "string" && image.taskId ? image.taskId : undefined,
    taskRevision:
      Number.isSafeInteger(taskRevision) && taskRevision > 0
        ? taskRevision
        : undefined,
    taskStatus,
    path:
      typeof image.path === "string" && image.path
        ? image.path
        : url
          ? getManagedImagePathFromUrl(url) || undefined
          : undefined,
    visibility:
      image.visibility === "public" || image.visibility === "private" ? image.visibility : undefined,
    url,
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
    resolution,
    outputFormat: isImageOutputFormat(image.outputFormat) ? image.outputFormat : undefined,
    qualityCheck: image.qualityCheck && typeof image.qualityCheck === "object" ? image.qualityCheck : undefined,
    taskCreatedAt: typeof image.taskCreatedAt === "string" && image.taskCreatedAt ? image.taskCreatedAt : undefined,
    taskUpdatedAt: typeof image.taskUpdatedAt === "string" && image.taskUpdatedAt ? image.taskUpdatedAt : undefined,
    generationDurationMs:
      typeof image.generationDurationMs === "number" && Number.isFinite(image.generationDurationMs) && image.generationDurationMs >= 0
        ? image.generationDurationMs
        : undefined,
    revised_prompt: typeof image.revised_prompt === "string" ? image.revised_prompt : undefined,
    text_response: typeof image.text_response === "string" && image.text_response ? image.text_response : undefined,
    error: normalizeStoredError(image.error),
  };
  if (image.status === "loading" || image.status === "error" || image.status === "success" || image.status === "cancelled" || image.status === "message") {
    return normalized;
  }
  return {
    ...normalized,
    status: image.b64_json || image.url || image.videoUrl ? "success" : "loading",
  };
}

function normalizeReferenceImage(image: Record<string, unknown>): StoredReferenceImage | null {
  const normalized = normalizeImageConversationAssetReference(image);
  if (!normalized) {
    return null;
  }
  const source =
    image.source === "upload" || image.source === "conversation"
      ? image.source
      : undefined;
  return {
    name: normalized.name,
    type: normalized.type,
    dataUrl: normalized.dataUrl,
    ...(normalized.assetPath ? { assetPath: normalized.assetPath } : {}),
    ...(normalized.size === undefined ? {} : { size: normalized.size }),
    ...(source ? { source } : {}),
  };
}

function normalizeImageMode(value: unknown, referenceImages: StoredReferenceImage[]): ImageConversationMode {
  if (value === "video") {
    return "video";
  }
  if (value === "generate") {
    return "generate";
  }
  if (value === "image") {
    return "image";
  }
  if (value === "edit") {
    return referenceImages.some((image) => image.source === "conversation") ? "edit" : "image";
  }
  return referenceImages.length > 0 ? "image" : "generate";
}

function normalizeSizeSelection(value: unknown): StoredImageSizeSelection | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const selection = {
    mode: typeof source.mode === "string" ? source.mode : "",
    aspectRatio: typeof source.aspectRatio === "string" ? source.aspectRatio : "",
    resolution: typeof source.resolution === "string" ? source.resolution : "",
    customRatio: typeof source.customRatio === "string" ? source.customRatio : "",
    customWidth: typeof source.customWidth === "string" ? source.customWidth : "",
    customHeight: typeof source.customHeight === "string" ? source.customHeight : "",
  };
  if (
    !selection.mode &&
    !selection.aspectRatio &&
    !selection.resolution &&
    !selection.customRatio &&
    !selection.customWidth &&
    !selection.customHeight
  ) {
    return undefined;
  }
  return selection;
}

function normalizeOutputCompression(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }
  return Math.min(100, Math.round(numeric));
}

function normalizePartialImages(value: unknown): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.max(0, Math.min(3, Math.round(numeric)));
}

function normalizeHistorySummary(value: unknown): ImageConversationHistorySummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const normalizeCount = (candidate: unknown) => {
    const numeric = Number(candidate);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
  };
  return {
    turnCount: normalizeCount(source.turnCount ?? source.turn_count),
    queued: normalizeCount(source.queued),
    running: normalizeCount(source.running),
  };
}

export function isImageConversationHistorySummaryOnly(
  conversation: ImageConversation | null | undefined,
) {
  return conversation?.historySummaryOnly === true;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => key.trim() ? [[key, String(item ?? "")] as const] : []);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeReferenceImages(value: unknown): StoredReferenceImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image) => {
    if (!image || typeof image !== "object") return [];
    const normalized = normalizeReferenceImage(image as Record<string, unknown>);
    return normalized ? [normalized] : [];
  });
}

function normalizeTurn(turn: ImageTurn & Record<string, unknown>): ImageTurn {
  const normalizedImages = Array.isArray(turn.images) ? turn.images.map(normalizeStoredImage) : [];
  const referenceImages = normalizeReferenceImages(turn.referenceImages);
  const mode = normalizeImageMode(turn.mode, referenceImages);
  const sizeSelection = normalizeSizeSelection(turn.sizeSelection);
  const visibility: ImageVisibility = turn.visibility === "public" ? "public" : "private";
  const images = normalizedImages.map((image) =>
    image.visibility ? image : { ...image, visibility },
  );
  const model =
    isImageCreationModel(turn.model)
        ? turn.model
        : DEFAULT_IMAGE_MODEL;
  return {
    id: String(turn.id || `${Date.now()}`),
    source: turn.source === "workflow" ? "workflow" : turn.source === "image-workbench" ? "image-workbench" : undefined,
    workflowId: typeof turn.workflowId === "string" && turn.workflowId.trim() ? turn.workflowId.trim() : undefined,
    workflowName: typeof turn.workflowName === "string" && turn.workflowName.trim() ? turn.workflowName.trim() : undefined,
    workflowInputs: normalizeStringRecord(turn.workflowInputs),
    workflowTaskId: typeof turn.workflowTaskId === "string" && turn.workflowTaskId.trim() ? turn.workflowTaskId.trim() : undefined,
    prompt: String(turn.prompt || ""),
    model,
    mode,
    referenceImages,
    count: Math.max(1, Number(turn.count || images.length || 1)),
    size: typeof turn.size === "string" ? turn.size : "",
    ...(sizeSelection ? { sizeSelection } : {}),
    quality: isImageQuality(turn.quality) ? turn.quality : undefined,
    outputFormat: isImageOutputFormat(turn.outputFormat) ? turn.outputFormat : undefined,
    outputCompression:
      isImageOutputFormat(turn.outputFormat) && supportsImageOutputCompression(turn.outputFormat)
        ? normalizeOutputCompression(turn.outputCompression)
        : undefined,
    apiMode: turn.apiMode === "responses" || turn.apiMode === "chat" ? turn.apiMode : "images",
    imageSystemPrompt: typeof turn.imageSystemPrompt === "string" && turn.imageSystemPrompt.trim() ? turn.imageSystemPrompt.trim() : undefined,
    stream: Boolean(turn.stream),
    partialImages: normalizePartialImages(turn.partialImages),
    responseFormatB64JSON: typeof turn.responseFormatB64JSON === "boolean" ? turn.responseFormatB64JSON : undefined,
    codexCLICompatibility: typeof turn.codexCLICompatibility === "boolean" ? turn.codexCLICompatibility : undefined,
    videoSeconds: normalizeStoredVideoSeconds(turn.videoSeconds),
    videoResolution: typeof turn.videoResolution === "string" && turn.videoResolution ? turn.videoResolution : undefined,
    videoGenerateAudio: typeof turn.videoGenerateAudio === "boolean" ? turn.videoGenerateAudio : undefined,
    videoWatermark: typeof turn.videoWatermark === "boolean" ? turn.videoWatermark : undefined,
    videoReferenceMode: turn.videoReferenceMode === "reference" ? "reference" : "first-frame",
    videoFirstFrameURL: typeof turn.videoFirstFrameURL === "string" && turn.videoFirstFrameURL.trim() ? turn.videoFirstFrameURL.trim() : undefined,
    videoLastFrameURL: typeof turn.videoLastFrameURL === "string" && turn.videoLastFrameURL.trim() ? turn.videoLastFrameURL.trim() : undefined,
    videoReferenceImageURLs: normalizeStringList(turn.videoReferenceImageURLs),
    videoReferenceVideoURLs: normalizeStringList(turn.videoReferenceVideoURLs),
    videoReferenceAudioURLs: normalizeStringList(turn.videoReferenceAudioURLs),
    videoSystemPrompt: typeof turn.videoSystemPrompt === "string" && turn.videoSystemPrompt.trim() ? turn.videoSystemPrompt.trim() : undefined,
    moderation: isImageModeration(turn.moderation) ? turn.moderation : undefined,
    tokenGroup: typeof turn.tokenGroup === "string" && turn.tokenGroup.trim() ? turn.tokenGroup.trim() : undefined,
    tokenName: typeof turn.tokenName === "string" && turn.tokenName.trim() ? turn.tokenName.trim() : undefined,
    visibility,
    images,
    createdAt: String(turn.createdAt || new Date().toISOString()),
    processingStartedAt: typeof turn.processingStartedAt === "string" ? turn.processingStartedAt : undefined,
    status: getEffectiveImageTurnStatus({ status: turn.status, images }),
    error: normalizeStoredError(turn.error),
  };
}

function normalizeConversation(conversation: ImageConversation & Record<string, unknown>): ImageConversation {
  const historySummaryOnly =
    conversation.historySummaryOnly === true || conversation.history_summary_only === true;
  const historySummary = normalizeHistorySummary(
    conversation.historySummary ?? conversation.history_summary,
  );
  const turns = historySummaryOnly
    ? []
    : Array.isArray(conversation.turns)
      ? conversation.turns.map((turn) => normalizeTurn(turn as ImageTurn & Record<string, unknown>))
      : [];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  return {
    id: String(conversation.id || `${Date.now()}`),
    revision:
      Number.isSafeInteger(Number(conversation.revision)) && Number(conversation.revision) > 0
        ? Number(conversation.revision)
        : undefined,
    title: String(conversation.title || ""),
    createdAt: String(conversation.createdAt || lastTurn?.createdAt || new Date().toISOString()),
    updatedAt: String(conversation.updatedAt || lastTurn?.createdAt || new Date().toISOString()),
    turns,
    ...(historySummaryOnly
      ? {
          historySummaryOnly: true,
          historySummary: historySummary || { turnCount: 0, queued: 0, running: 0 },
        }
      : {}),
  };
}

function sortImageConversations(conversations: ImageConversation[]): ImageConversation[] {
  return [...conversations].sort((a, b) => {
    const updated = b.updatedAt.localeCompare(a.updatedAt);
    return updated !== 0 ? updated : b.id.localeCompare(a.id);
  });
}

/** Merge page/active/detail responses by ID without allowing stale snapshots
 * to regress a newer local or durable task state. */
export function mergeImageConversationItems(
  ...groups: ReadonlyArray<ReadonlyArray<ImageConversation>>
): ImageConversation[] {
  const byID = new Map<string, ImageConversation>();
  for (const group of groups) {
    for (const item of group) {
      if (isWorkflowImageConversation(item)) continue;
      const previous = byID.get(item.id);
      byID.set(item.id, previous ? mergeImageConversationSnapshot(previous, item) : item);
    }
  }
  return sortImageConversations([...byID.values()]);
}

function normalizeHistoryGeneration(value: unknown): string | null {
  return normalizeImageConversationHistoryGeneration(value);
}

function updateRemoteCursorGenerationFromResponse(
  state: ImageConversationScopeState,
  response: { generation?: unknown },
) {
  if (!isCurrentImageConversationScope(state)) {
    return;
  }
  const generation = normalizeHistoryGeneration(response.generation);
  if (generation !== null) {
    state.remoteCursorGeneration = maxImageConversationHistoryGeneration(
      state.remoteCursorGeneration,
      generation,
    );
  }
}

function normalizeHistoryPageItems(rawItems: unknown): ImageConversation[] {
  if (!Array.isArray(rawItems)) {
    return [];
  }
  return sortImageConversations(
    rawItems.map((item) => normalizeConversation(item as ImageConversation & Record<string, unknown>)),
  );
}

function mergeFailedSnapshotsIntoHistory(
  state: ImageConversationScopeState,
  serverItems: ImageConversation[],
) {
  const failedItems = [...state.failedSnapshots.values()];
  if (failedItems.length === 0) {
    return serverItems;
  }
  scheduleFailedConversationRetry(state);
  return mergeImageConversationLists(failedItems, serverItems, true);
}

function normalizedHistoryPageLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return 24;
  }
  return Math.min(100, Math.max(1, parsed));
}

function historyErrorStatus(error: unknown) {
  return error && typeof error === "object" && "status" in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
}

function isMissingHistoryDetail(error: unknown) {
  const status = historyErrorStatus(error);
  return status === 404 || status === 410;
}

function historyPageRequestKey(limit: number, cursor: string | null) {
  return `${limit}:${cursor || ""}`;
}

function normalizeHistoryPage(
  state: ImageConversationScopeState,
  response: {
    items?: unknown;
    next_cursor?: unknown;
    has_more?: unknown;
    generation?: unknown;
  },
  includeFailedSnapshots: boolean,
  requestEpoch: number,
): ImageConversationHistoryPage {
  const generation = normalizeHistoryGeneration(response.generation);
  if (requestEpoch === state.paginationEpoch && generation !== null) {
    state.remoteCursorGeneration = maxImageConversationHistoryGeneration(
      state.remoteCursorGeneration,
      generation,
    );
  }
  const serverItems = normalizeHistoryPageItems(response.items);
  const items = includeFailedSnapshots
    ? mergeFailedSnapshotsIntoHistory(state, serverItems)
    : serverItems;
  const nextCursor = typeof response.next_cursor === "string" && response.next_cursor.trim()
    ? response.next_cursor.trim()
    : null;
  return {
    items,
    nextCursor,
    hasMore: response.has_more === true || Boolean(nextCursor),
    generation: generation ?? state.remoteCursorGeneration,
  };
}

function conversationForServerPersistence(conversation: ImageConversation): ImageConversation {
  let changed = false;
  const turns = conversation.turns.map((turn) => {
    let turnChanged = false;
    const images = turn.images.map((image) => {
      if (
        image.status !== "loading" ||
        (!image.b64_json && !image.url && !image.path && !image.text_response)
      ) {
        return image;
      }
      turnChanged = true;
      changed = true;
      return {
        ...image,
        b64_json: undefined,
        url: undefined,
        path: undefined,
        text_response: undefined,
      };
    });
    return turnChanged ? { ...turn, images } : turn;
  });
  return changed ? { ...conversation, turns } : conversation;
}

function queueImageConversationWrite<T>(
  state: ImageConversationScopeState,
  operation: () => Promise<T>,
): Promise<T> {
  return enqueueScopedWrite(
    state.scope.writes,
    () => runCurrentImageConversationScopeOperation(
      imageConversationScopeCoordinator,
      state.scope,
      async () => {
        assertCurrentImageConversationScope(state);
        return operation();
      },
    ),
  );
}

async function mergeImageConversationBatchWithRebase(
  state: ImageConversationScopeState,
  conversations: ImageConversation[],
) {
  const candidates = [...conversations];
  const finalAcknowledgements: Array<ImageConversationAcknowledgementResult | undefined> =
    Array.from({ length: candidates.length });
  let pendingIndices = candidates.map((_, index) => index);
  let rebased = false;

  for (let attempt = 0; attempt < 3 && pendingIndices.length > 0; attempt += 1) {
    const pending = pendingIndices.map((index) => candidates[index]);
    let response: ImageConversationHistoryMergeResponse;
    try {
      response = await mergeImageConversationHistory(
        pending.map((conversation) =>
          conversationForServerPersistence(conversation) as unknown as Record<string, unknown>),
        historyRequestOptions(),
      );
      updateRemoteCursorGenerationFromResponse(state, response);
    } catch (error) {
      if (
        pendingIndices.length === 1 &&
        attempt < 2 &&
        isImageConversationRevisionConflict(error)
      ) {
        const index = pendingIndices[0];
        rememberPendingDurableConversation(state, candidates[index], error);
        candidates[index] = await rebaseImageConversationAfterConflict(state, candidates[index]);
        rememberPendingDurableConversation(state, candidates[index], error);
        rebased = true;
        continue;
      }
      if (
        attempt < 2 &&
        isRetryableImageConversationSaveError(error) &&
        isCurrentImageConversationScope(state)
      ) {
        await waitForConversationSaveRetry(500 * 2 ** attempt);
        continue;
      }
      throw error;
    }

    const results = classifyImageConversationMergeAcknowledgements(response, pending);
    const retryIndices: number[] = [];
    for (const [pendingIndex, acknowledgement] of results.entries()) {
      const candidateIndex = pendingIndices[pendingIndex];
      if (acknowledgement.outcome === "stale" && attempt < 2) {
        const error = imageConversationAcknowledgementError(acknowledgement);
        rememberPendingDurableConversation(state, candidates[candidateIndex], error);
        candidates[candidateIndex] = await rebaseImageConversationAfterConflict(
          state,
          candidates[candidateIndex],
        );
        rememberPendingDurableConversation(state, candidates[candidateIndex], error);
        retryIndices.push(candidateIndex);
        rebased = true;
        continue;
      }
      finalAcknowledgements[candidateIndex] = acknowledgement;
    }
    pendingIndices = retryIndices;
  }

  for (const index of pendingIndices) {
    finalAcknowledgements[index] ||= {
      id: candidates[index].id,
      expectedRevision: candidates[index].revision,
      outcome: "protocol",
      httpStatus: 503,
      code: "IMAGE_CONVERSATION_ACK_PROTOCOL_ERROR",
      message: `图片历史重试未返回确认: ${candidates[index].id}`,
    };
  }

  return {
    conversations: candidates,
    acknowledgements: finalAcknowledgements.map((acknowledgement, index) =>
      acknowledgement || {
        id: candidates[index].id,
        expectedRevision: candidates[index].revision,
        outcome: "protocol" as const,
        httpStatus: 503 as const,
        code: "IMAGE_CONVERSATION_ACK_PROTOCOL_ERROR" as const,
        message: `图片历史批量确认响应缺少会话: ${candidates[index].id}`,
      }),
    rebased,
  };
}

/**
 * Fetch a cursor page for the current account. Requests are keyed by cursor
 * and page size so the image page and the global task queue share one network
 * request while they are mounted together.
 */
export async function listImageConversationPage(
  options: ImageConversationHistoryPageRequestOptions = {},
): Promise<ImageConversationHistoryPage> {
  const state = await getCurrentImageConversationScopeState();
  const limit = normalizedHistoryPageLimit(options.limit);
  const cursor = String(options.cursor || "").trim() || null;
  const key = historyPageRequestKey(limit, cursor);
  const cached = state.pageRequests.get(key);
  if (cached?.epoch === state.paginationEpoch) {
    return cached.promise;
  }

  const requestEpoch = state.paginationEpoch;
  const promise = fetchImageConversationHistoryPage({
    ...historyRequestOptions(),
    limit,
    cursor,
  })
    .then((response) => {
      assertCurrentImageConversationRequest(state, requestEpoch);
      return normalizeHistoryPage(state, response, cursor === null, requestEpoch);
    })
    .finally(() => {
      const entry = state.pageRequests.get(key);
      if (entry?.promise === promise) {
        state.pageRequests.delete(key);
      }
    });
  state.pageRequests.set(key, { epoch: requestEpoch, promise });
  return promise;
}

/** Load the first page and active conversations in one version-consistent request. */
export async function loadImageConversationHistoryWindow(
  limit = 24,
): Promise<ImageConversationHistoryWindow> {
  const state = await getCurrentImageConversationScopeState();
  const normalizedLimit = normalizedHistoryPageLimit(limit);
  const cached = state.windowRequests.get(normalizedLimit);
  if (cached?.epoch === state.paginationEpoch) return cached.promise;

  const requestEpoch = state.paginationEpoch;
  const promise = fetchImageConversationHistoryWindow({
    ...historyRequestOptions(),
    limit: normalizedLimit,
  }).then((response) => {
    assertCurrentImageConversationRequest(state, requestEpoch);
    const firstPage = normalizeHistoryPage(state, response.first_page, true, requestEpoch);
    const activePage = normalizeHistoryPage(state, response.active_page, true, requestEpoch);
    const firstGeneration = normalizeHistoryGeneration(firstPage.generation);
    const activeGeneration = normalizeHistoryGeneration(activePage.generation);
    const generation = maxImageConversationHistoryGeneration(firstGeneration, activeGeneration);
    if (!imageConversationHistoryGenerationsMatch(firstGeneration, activeGeneration)) {
      throw new ImageConversationHistoryGenerationMismatchError();
    }
    return { firstPage, activePage, generation };
  }).finally(() => {
    if (state.windowRequests.get(normalizedLimit)?.promise === promise) {
      state.windowRequests.delete(normalizedLimit);
    }
  });
  state.windowRequests.set(normalizedLimit, { epoch: requestEpoch, promise });
  return promise;
}

/** Fetch one full conversation when it is not present in the loaded pages. */
export async function getImageConversation(id: string): Promise<ImageConversation | null> {
  const conversationID = String(id || "").trim();
  if (!conversationID) {
    return null;
  }
  const state = await getCurrentImageConversationScopeState();
  const cached = state.detailRequests.get(conversationID);
  if (cached?.epoch === state.paginationEpoch) {
    return cached.promise;
  }

  const requestEpoch = state.paginationEpoch;
  const promise = fetchImageConversationHistoryItem(conversationID, historyRequestOptions())
    .then((response) => {
      assertCurrentImageConversationRequest(state, requestEpoch);
      const generation = normalizeHistoryGeneration(response.generation);
      if (!imageConversationHistoryGenerationAtLeast(generation, state.remoteCursorGeneration)) {
        throw new ImageConversationHistoryRequestStaleError();
      }
      const rawItem = response.item;
      if (!rawItem || typeof rawItem !== "object") {
        return null;
      }
      const fetched = normalizeConversation(rawItem as ImageConversation & Record<string, unknown>);
      if (generation !== null) {
        state.remoteCursorGeneration = maxImageConversationHistoryGeneration(
          state.remoteCursorGeneration,
          generation,
        );
      }
      const failed = state.failedSnapshots.get(fetched.id);
      return failed ? mergeImageConversationSnapshot(failed, fetched) : fetched;
    })
    .catch((error) => {
      if (isMissingHistoryDetail(error)) {
        assertCurrentImageConversationRequest(state, requestEpoch);
        return null;
      }
      throw error;
    })
    .finally(() => {
      if (state.detailRequests.get(conversationID)?.promise === promise) {
        state.detailRequests.delete(conversationID);
      }
    });
  state.detailRequests.set(conversationID, { epoch: requestEpoch, promise });
  return promise;
}

export async function saveImageConversation(conversation: ImageConversation): Promise<ImageConversation> {
  const state = await getCurrentImageConversationScopeState();
  const nextConversation = normalizeConversation(conversation);
  return persistImageConversationDurably(state, nextConversation);
}

async function persistImageConversationDurably(
  state: ImageConversationScopeState,
  conversation: ImageConversation,
): Promise<ImageConversation> {
  let candidate = conversation;
  let hadRebase = false;
  try {
    return await queueImageConversationWrite(state, async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const payload = conversationForServerPersistence(candidate);
          const response = await mergeImageConversationHistory(
            [payload as unknown as Record<string, unknown>],
            historyRequestOptions(),
          );
          updateRemoteCursorGenerationFromResponse(state, response);
          assertDurableConversationAcknowledgement(response, candidate);
          state.failedSnapshots.delete(candidate.id);
          state.coalescedFailures.delete(candidate.id);
          state.durableFailures.delete(candidate.id);
          // A successful conflict rebase may contain turns from another
          // device. Ask mounted pages to reload even when the caller ignores
          // the returned rebased snapshot.
          dispatchImageConversationsChanged(state, { requiresRefresh: hadRebase });
          return candidate;
        } catch (error) {
          lastError = error;
          if (
            attempt >= 2 ||
            !isImageConversationRevisionConflict(error) ||
            !isCurrentImageConversationScope(state)
          ) {
            throw error;
          }
          rememberPendingDurableConversation(state, candidate, error);
          candidate = await rebaseImageConversationAfterConflict(state, candidate);
          hadRebase = true;
          rememberPendingDurableConversation(state, candidate, error);
        }
      }
      throw lastError || new Error(`图片历史写入失败: ${candidate.id}`);
    });
  } catch (error) {
    const scopedError = bindImageConversationFailureToScope(state, error);
    rememberFailedConversationSnapshot(state, candidate, scopedError, true);
    throw scopedError;
  }
}

function ensureCoalescedConversationDrain(state: ImageConversationScopeState) {
  if (state.coalescedDrain) {
    return state.coalescedDrain;
  }
  state.coalescedDrain = (async () => {
    await Promise.resolve();
    while (isCurrentImageConversationScope(state) && state.coalescedSaves.size > 0) {
      const batch = Array.from(state.coalescedSaves.values());
      state.coalescedSaves.clear();
      try {
        const result = await queueImageConversationWrite(
          state,
          () => mergeImageConversationBatchWithRebase(
            state,
            batch.map(({ conversation }) => conversation),
          ),
        );
        dispatchImageConversationsChanged(state, {
          requiresRefresh:
            result.rebased || imageConversationAcknowledgementsRequireRefresh(result.acknowledgements),
        });
        for (const [index, { waiters }] of batch.entries()) {
          const conversation = result.conversations[index];
          const acknowledgement = result.acknowledgements[index];
          if (acknowledgement?.outcome === "accepted") {
            state.failedSnapshots.delete(conversation.id);
            state.coalescedFailures.delete(conversation.id);
            state.durableFailures.delete(conversation.id);
            for (const waiter of waiters) {
              waiter.resolve();
            }
            continue;
          }
          const error = imageConversationAcknowledgementError(
            acknowledgement || {
              id: conversation.id,
              expectedRevision: conversation.revision,
              outcome: "protocol",
              httpStatus: 503,
              code: "IMAGE_CONVERSATION_ACK_PROTOCOL_ERROR",
              message: `图片历史批量确认响应缺少会话: ${conversation.id}`,
            },
          );
          rememberFailedConversationSnapshot(state, conversation, error);
          for (const waiter of waiters) {
            waiter.reject(error);
          }
        }
      } catch (error) {
        for (const { conversation, waiters } of batch) {
          rememberFailedConversationSnapshot(state, conversation, error);
          for (const waiter of waiters) {
            waiter.reject(error);
          }
        }
      }
    }
  })().finally(() => {
    state.coalescedDrain = null;
    if (isCurrentImageConversationScope(state) && state.coalescedSaves.size > 0) {
      void ensureCoalescedConversationDrain(state);
    }
  });
  return state.coalescedDrain;
}

export async function saveImageConversationCoalesced(conversation: ImageConversation): Promise<void> {
  const state = await getCurrentImageConversationScopeState();
  const nextConversation = normalizeConversation(conversation);
  return new Promise<void>((resolve, reject) => {
    if (!isCurrentImageConversationScope(state)) {
      reject(new ImageConversationScopeChangedError());
      return;
    }
    const current = state.coalescedSaves.get(nextConversation.id);
    state.coalescedSaves.set(nextConversation.id, {
      conversation: current
        ? mergeImageConversationSnapshot(current.conversation, nextConversation)
        : nextConversation,
      waiters: [...(current?.waiters || []), { resolve, reject }],
    });
    void ensureCoalescedConversationDrain(state);
  });
}

async function flushImageConversationScopeSaves(state: ImageConversationScopeState) {
  while (state.coalescedDrain) {
    await state.coalescedDrain;
  }
  await waitForScopedWrites(state.scope.writes);
  assertCurrentImageConversationScope(state);
  const failure = state.coalescedFailures.values().next().value;
  if (failure) {
    throw failure;
  }
}

export async function flushImageConversationSaves(): Promise<void> {
  const state = await getCurrentImageConversationScopeState();
  await flushImageConversationScopeSaves(state);
}

export function discardFailedImageConversationSave(id: string, error: unknown) {
  const state = activeImageConversationScopeState;
  if (
    !state ||
    imageConversationScopeFailures.scopeFor(error) !== state.scope ||
    !isCurrentImageConversationScope(state)
  ) {
    return;
  }
  state.failedSnapshots.delete(id);
  state.coalescedFailures.delete(id);
  state.durableFailures.delete(id);
  if (state.failedSnapshots.size === 0 && state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
}

export async function deleteImageConversation(id: string): Promise<void> {
  const state = await getCurrentImageConversationScopeState();
  await flushImageConversationScopeSaves(state).catch(() => undefined);
  await queueImageConversationWrite(state, async () => {
    const response = await deleteImageConversationHistoryItem(id, historyRequestOptions());
    updateRemoteCursorGenerationFromResponse(state, response);
    state.failedSnapshots.delete(id);
    state.coalescedFailures.delete(id);
    state.durableFailures.delete(id);
    state.coalescedSaves.delete(id);
    state.paginationEpoch += 1;
    state.pageRequests.clear();
    state.windowRequests.clear();
    dispatchImageConversationsChanged(state);
  });
}

export async function clearImageConversations(): Promise<void> {
  const state = await getCurrentImageConversationScopeState();
  await flushImageConversationScopeSaves(state).catch(() => undefined);
  await queueImageConversationWrite(state, async () => {
    const response = await clearImageConversationHistory(historyRequestOptions());
    updateRemoteCursorGenerationFromResponse(state, response);
    state.failedSnapshots.clear();
    state.coalescedSaves.clear();
    state.coalescedFailures.clear();
    state.durableFailures.clear();
    state.paginationEpoch += 1;
    state.pageRequests.clear();
    state.windowRequests.clear();
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    dispatchImageConversationsChanged(state);
  });
}

export function getImageConversationStats(conversation: ImageConversation | null): ImageConversationStats {
  if (!conversation) {
    return { queued: 0, running: 0 };
  }

  if (conversation.historySummaryOnly && conversation.historySummary) {
    return {
      queued: conversation.historySummary.queued,
      running: conversation.historySummary.running,
    };
  }

  return conversation.turns.reduce(
    (acc, turn) => {
      const status = getEffectiveImageTurnStatus(turn);
      if (status === "queued") {
        acc.queued += 1;
      } else if (status === "generating") {
        acc.running += 1;
      }
      return acc;
    },
    { queued: 0, running: 0 },
  );
}
