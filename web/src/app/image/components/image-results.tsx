"use client";

import { useRef, useState } from "react";
import { Check, CircleStop, Clock3, Download, Eye, Globe2, LoaderCircle, Lock, PencilLine, Plus, RotateCcw } from "lucide-react";

import { AuthenticatedImage } from "@/components/authenticated-image";
import { ChatMarkdown } from "@/app/image/components/chat-markdown";
import { Button } from "@/components/ui/button";
import type { ImagePromptPreset } from "@/app/image/image-presets";
import { formatImageSizeDisplay, isHighResolutionImageSize } from "@/app/image/image-options";
import type { ImageVisibility } from "@/lib/api";
import {
  fetchAuthenticatedImageBlob,
  getCachedAuthenticatedImageByteSize,
  shouldUseAuthenticatedImageFallback,
} from "@/lib/authenticated-image";
import { getManagedImageUrlFromPath } from "@/lib/image-path";
import { formatBase64ImageFileSize, formatImageFileSize } from "@/lib/image-size";
import { cn } from "@/lib/utils";
import {
  getEffectiveImageTurnStatus,
  getStoredImageLoadingPhase,
  type ImageConversation,
  type ImageTurn,
  type ImageTurnStatus,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";
import { imageTurnStartedAtTimestamp, type ImageTurnProgress } from "@/store/image-turn-progress";

export type ImageLightboxItem = {
  id: string;
  src: string;
  fileName?: string;
  outputFormat?: string;
  sizeLabel?: string;
  dimensions?: string;
};

type DownloadableImage = {
  id: string;
  selectionKey: string;
  src: string;
  fileName: string;
  imageIndex: number;
};

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  isLoadingHistory: boolean;
  progressByTurnKey: Record<string, ImageTurnProgress>;
  progressNow: number;
  promptPresets: readonly ImagePromptPreset[];
  onOpenLightbox: (images: ImageLightboxItem[], index: number) => void;
  onApplyPromptPreset: (preset: ImagePromptPreset) => void | Promise<void>;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
  onEditTurn: (conversationId: string, turnId: string) => void;
  onCancelTurn: (conversationId: string, turnId: string) => void | Promise<void>;
  onRegenerateTurn: (conversationId: string, turnId: string) => void | Promise<void>;
  onRetryImage: (conversationId: string, turnId: string, imageIndex: number) => void | Promise<void>;
  onImageVisibilityChange: (
    conversationId: string,
    turnId: string,
    imageIndex: number,
    visibility: ImageVisibility,
  ) => void | Promise<void>;
  visibilityMutatingImageKey: string;
  formatConversationTime: (value: string) => string;
};

function getStoredImageSrc(image: StoredImage) {
  if (image.b64_json) {
    return `data:image/${image.outputFormat || "png"};base64,${image.b64_json}`;
  }
  if (image.path) {
    const managedURL = getManagedImageUrlFromPath(image.path);
    if (managedURL) {
      return managedURL;
    }
  }
  return image.url || "";
}

function isTurnBusy(turn: ImageTurn) {
  const status = getEffectiveImageTurnStatus(turn);
  return status === "queued" || status === "generating";
}

function imageSelectionKey(conversationId: string, turnId: string, imageId: string) {
  return `${conversationId}:${turnId}:${imageId}`;
}

function imageResolutionLabel(image: StoredImage, dimensions?: string) {
  if (image.resolution) {
    return image.resolution.replace(/x/g, " x ");
  }
  if (image.width && image.height) {
    return formatImageDimensions(image.width, image.height);
  }
  return dimensions || "";
}

function formatGenerationDuration(ms?: number) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return "";
  }
  return formatElapsedClock(Math.max(0, Math.round(ms / 1000)));
}

function imageQualityCheckLabel(image: StoredImage) {
  const check = image.qualityCheck;
  if (!check) {
    return "";
  }
  const sizeFailed = check.size_matched === false;
  const formatFailed = check.output_format_matched === false;
  if (sizeFailed && formatFailed) {
    return "尺寸/格式不一致";
  }
  if (sizeFailed) {
    return "尺寸不一致";
  }
  if (formatFailed) {
    return "格式不一致";
  }
  if (check.size_matched === true || check.output_format_matched === true) {
    return "检测通过";
  }
  return check.actual_size || check.actual_output_format ? "已检测" : "";
}

function imageQualityCheckClass(image: StoredImage) {
  const check = image.qualityCheck;
  if (check?.size_matched === false || check?.output_format_matched === false) {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  }
  return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
}

function imageQualityCheckTitle(image: StoredImage) {
  const check = image.qualityCheck;
  if (!check) {
    return "";
  }
  const parts = [
    check.requested_size || check.actual_size
      ? `尺寸：请求 ${check.requested_size || "-"}，实际 ${check.actual_size || "-"}`
      : "",
    check.requested_output_format || check.actual_output_format
      ? `格式：请求 ${check.requested_output_format || "-"}，实际 ${check.actual_output_format || "-"}`
      : "",
    ...(check.warnings || []),
  ].filter(Boolean);
  return parts.join("\n");
}

function getLongTaskHint(turn: ImageTurn, elapsedSeconds: number) {
  void elapsedSeconds;
  if (!isTurnBusy(turn)) {
    return "";
  }
  if (isHighResolutionImageSize(turn.size, turn.sizeSelection)) {
    return "高分辨率任务已提交，正在等待生成结果";
  }
  return "";
}

function imageVisibilityLabel(visibility?: ImageVisibility) {
  return visibility === "public" ? "已公开" : "私有";
}

function imageVisibilityPillClass(visibility?: ImageVisibility) {
  return visibility === "public"
    ? "bg-[#e8f2ff] text-[#1456f0] ring-1 ring-[#bfdbfe]"
    : "bg-[#181e25]/82 text-white ring-1 ring-white/20";
}

function imageVisibilityActionClass(visibility?: ImageVisibility) {
  return visibility === "public"
    ? "bg-white/95 text-[#1456f0] hover:bg-[#e8f2ff]"
    : "bg-white/95 text-stone-800 hover:bg-stone-100";
}

function blurFocusedElementInContainer(container: HTMLElement) {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && container.contains(activeElement)) {
    activeElement.blur();
  }
}

function imageExtensionFromSrc(src?: string) {
  const dataUrlFormat = src?.match(/^data:image\/([^;,]+)/i)?.[1];
  const urlFormat = src?.split(/[?#]/, 1)[0]?.match(/\.([a-z0-9]+)$/i)?.[1];
  const format = String(dataUrlFormat || urlFormat || "").toLowerCase();
  if (format === "jpg" || format === "jpeg") {
    return "jpg";
  }
  if (format === "png" || format === "webp") {
    return format;
  }
  return "";
}

function imageExtension(outputFormat?: string, src?: string) {
  if (outputFormat === "jpeg") {
    return "jpg";
  }
  return outputFormat || imageExtensionFromSrc(src) || "png";
}

function buildDownloadName(createdAt: string, turnId: string, index: number, outputFormat?: string, src?: string) {
  const date = new Date(createdAt);
  const safeIndex = String(index + 1).padStart(2, "0");
  const extension = imageExtension(outputFormat, src);
  if (Number.isNaN(date.getTime())) {
    return `chatgpt-image-${turnId.slice(0, 8)}-${safeIndex}.${extension}`;
  }

  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const sec = String(date.getSeconds()).padStart(2, "0");
  return `chatgpt-image-${yyyy}${mm}${dd}-${hh}${min}${sec}-${safeIndex}.${extension}`;
}

async function downloadImage(image: DownloadableImage) {
  let href = image.src;
  let objectUrl = "";

  if (!image.src.startsWith("data:")) {
    try {
      const blob = shouldUseAuthenticatedImageFallback(image.src)
        ? await fetchAuthenticatedImageBlob(image.src)
        : await fetch(image.src).then((response) => (response.ok ? response.blob() : null));
      if (blob) {
        objectUrl = URL.createObjectURL(blob);
        href = objectUrl;
      }
    } catch {
      href = image.src;
    }
  }

  const link = document.createElement("a");
  link.href = href;
  link.download = image.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  if (objectUrl) {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchImageSizeLabel(src: string) {
  if (!src || src.startsWith("data:")) {
    return "";
  }
  const cachedByteSize = getCachedAuthenticatedImageByteSize(src);
  if (cachedByteSize > 0) {
    return formatImageFileSize(cachedByteSize);
  }

  try {
    const blob = shouldUseAuthenticatedImageFallback(src)
      ? await fetchAuthenticatedImageBlob(src)
      : await fetch(src).then((response) => (response.ok ? response.blob() : null));
    if (!blob) return "";
    return formatImageFileSize(blob.size);
  } catch {
    return "";
  }
}

export function ImageResults({
  selectedConversation,
  isLoadingHistory,
  progressByTurnKey,
  progressNow,
  promptPresets,
  onOpenLightbox,
  onApplyPromptPreset,
  onContinueEdit,
  onEditTurn,
  onCancelTurn,
  onRegenerateTurn,
  onRetryImage,
  onImageVisibilityChange,
  visibilityMutatingImageKey,
  formatConversationTime,
}: ImageResultsProps) {
  const [imageDimensions, setImageDimensions] = useState<Record<string, string>>({});
  const [imageSizeLabels, setImageSizeLabels] = useState<Record<string, string>>({});
  const [selectedImageIds, setSelectedImageIds] = useState<Record<string, boolean>>({});
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const pendingImageSizeIdsRef = useRef<Set<string>>(new Set());

  const updateImageDimensions = (id: string, width: number, height: number) => {
    const dimensions = formatImageDimensions(width, height);
    setImageDimensions((current) => {
      if (current[id] === dimensions) {
        return current;
      }
      return { ...current, [id]: dimensions };
    });
  };

  const toggleImageSelection = (selectionKey: string) => {
    setSelectedImageIds((current) => ({
      ...current,
      [selectionKey]: !current[selectionKey],
    }));
  };

  const updateImageSizeLabel = (id: string, sizeLabel: string) => {
    if (!sizeLabel) {
      return;
    }
    setImageSizeLabels((current) => {
      if (current[id] === sizeLabel) {
        return current;
      }
      return { ...current, [id]: sizeLabel };
    });
  };

  const ensureImageSizeLabel = (id: string, src: string) => {
    if (imageSizeLabels[id] || pendingImageSizeIdsRef.current.has(id)) {
      return;
    }

    pendingImageSizeIdsRef.current.add(id);
    void fetchImageSizeLabel(src)
      .then((sizeLabel) => updateImageSizeLabel(id, sizeLabel))
      .finally(() => {
        pendingImageSizeIdsRef.current.delete(id);
      });
  };

  const downloadItems = async (key: string, items: DownloadableImage[]) => {
    if (items.length === 0 || downloadingKey) {
      return;
    }

    setDownloadingKey(key);
    try {
      for (let index = 0; index < items.length; index += 1) {
        await downloadImage(items[index]);
        if (index < items.length - 1) {
          await sleep(120);
        }
      }
    } finally {
      setDownloadingKey(null);
    }
  };

  if (isLoadingHistory) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center px-0 py-3 text-center sm:min-h-[420px] sm:py-6">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-white px-4 py-2 text-sm text-[#45515e] shadow-sm dark:border-border dark:bg-card dark:text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin text-[#1456f0] dark:text-sky-300" />
          正在读取历史记录
        </div>
      </div>
    );
  }

  if (!selectedConversation) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center px-0 py-3 text-center sm:min-h-[420px] sm:py-6">
        <div className="mx-auto flex w-full max-w-[960px] flex-col gap-5">
          <div className="hide-scrollbar flex gap-3 overflow-x-auto px-1 pb-1 text-left sm:grid sm:grid-cols-2 sm:overflow-visible lg:grid-cols-3">
            {promptPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="group w-[250px] shrink-0 overflow-hidden rounded-[22px] border border-[#f2f3f5] bg-white transition hover:-translate-y-0.5 hover:shadow-[0_12px_16px_-4px_rgba(36,36,36,0.08)] sm:w-auto"
                onClick={() => void onApplyPromptPreset(preset)}
                aria-label={`套用预设：${preset.title}`}
              >
                <div className="relative aspect-[16/9] overflow-hidden bg-[#f0f0f0]">
                  <img
                    src={preset.imageSrc}
                    alt={preset.title}
                    loading="lazy"
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                  />
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 via-black/25 to-transparent px-3 pt-8 pb-2">
                    <span className="rounded-full bg-white/92 px-2 py-0.5 text-[11px] font-medium text-[#18181b] shadow-sm">
                      {preset.size || "自动"}
                    </span>
                    <span className="rounded-full bg-white/18 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm backdrop-blur">
                      {preset.count} 张
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-2 px-4 py-3.5">
                  <div className="font-display text-sm font-semibold text-[#222222]">{preset.title}</div>
                  <div className="line-clamp-2 text-sm leading-6 text-[#45515e]">{preset.hint}</div>
                  <div className="border-t border-[#f2f3f5] pt-2 text-xs font-medium text-[#1456f0]">套用这个预设</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5 sm:gap-8">
      {selectedConversation.turns.map((turn, turnIndex) => {
        const progress = progressByTurnKey[turnProgressKey(selectedConversation.id, turn.id)];
        const referenceLightboxImages = turn.referenceImages.map((image, index) => ({
          id: `${turn.id}-reference-${index}`,
          src: image.dataUrl,
          fileName: image.name,
        }));
        const downloadableImages = turn.images.flatMap((image, index) => {
          const src = image.status === "success" ? getStoredImageSrc(image) : "";
          return src
            ? [
                {
                  id: image.id,
                  selectionKey: imageSelectionKey(selectedConversation.id, turn.id, image.id),
                  src,
                  fileName: buildDownloadName(turn.createdAt, turn.id, index, image.outputFormat || turn.outputFormat, src),
                  imageIndex: index,
                },
              ]
            : [];
        });
        const selectedDownloadableImages = downloadableImages.filter((image) => selectedImageIds[image.selectionKey]);
        const successfulTurnImages = turn.images.flatMap((image, index) => {
          const src = image.status === "success" ? getStoredImageSrc(image) : "";
          return src
            ? [
                {
                  id: image.id,
                  src,
                  fileName: buildDownloadName(turn.createdAt, turn.id, index, image.outputFormat || turn.outputFormat, src),
                  outputFormat: image.outputFormat || turn.outputFormat,
                  sizeLabel: image.b64_json ? formatBase64ImageFileSize(image.b64_json) : imageSizeLabels[image.id],
                  dimensions: imageDimensions[image.id],
                },
              ]
            : [];
        });
        const textReplyImages = turn.images
          .map((image, index) => ({ image, index }))
          .filter(({ image }) => image.status === "message" && Boolean(image.text_response));
        const visualImages = turn.images
          .map((image, index) => ({ image, index }))
          .filter(({ image }) => !textReplyImages.some((reply) => reply.image.id === image.id));
        const successfulVisualImages = visualImages.flatMap(({ image }) =>
          image.status === "success" && getStoredImageSrc(image) ? [image] : [],
        );
        const checkedImages = successfulVisualImages.filter((image) => imageQualityCheckLabel(image));
        const mismatchedImages = checkedImages.filter(
          (image) => image.qualityCheck?.size_matched === false || image.qualityCheck?.output_format_matched === false,
        );
        const resultQualityCheckImage = mismatchedImages[0] || checkedImages[0];
        const resultQualityCheckLabel =
          mismatchedImages.length > 1
            ? `${mismatchedImages.length} 张检测异常`
            : mismatchedImages.length === 1
              ? imageQualityCheckLabel(mismatchedImages[0])
              : checkedImages.length > 0
                ? "检测通过"
                : "";
        const generationDurations = successfulVisualImages
          .map((image) => image.generationDurationMs)
          .filter((duration): duration is number => typeof duration === "number" && Number.isFinite(duration));
        const resultGenerationDuration =
          generationDurations.length > 0
            ? `${generationDurations.length > 1 ? "最长耗时" : "耗时"}：${formatGenerationDuration(Math.max(...generationDurations))}`
            : "";
        const resultDimensions = Array.from(
          new Set(
            successfulVisualImages
              .map((image) => imageResolutionLabel(image, imageDimensions[image.id]))
              .filter(Boolean),
          ),
        );
        const resultSizeLabel =
          successfulVisualImages.length === 1
            ? successfulVisualImages[0].b64_json
              ? formatBase64ImageFileSize(successfulVisualImages[0].b64_json)
              : imageSizeLabels[successfulVisualImages[0].id] || ""
            : "";
        const resultDimensionsLabel =
          resultDimensions.length === 1 ? formatImageSizeDisplay(resultDimensions[0]) : resultDimensions.length > 1 ? "多尺寸" : "";
        const resultFormats = Array.from(
          new Set(
            successfulTurnImages.map((image) => imageExtension(image.outputFormat, image.src).toUpperCase()),
          ),
        );
        const resultFormatLabel = resultFormats.length === 1 ? resultFormats[0] : resultFormats.length > 1 ? "多格式" : "";
        const latestTaskUpdatedAt = successfulVisualImages
          .map((image) => image.taskUpdatedAt || "")
          .filter(Boolean)
          .sort()
          .at(-1);
        const resultCompletedAt = latestTaskUpdatedAt ? formatConversationTime(latestTaskUpdatedAt) : "";
        const effectiveStatus = getEffectiveImageTurnStatus(turn);
        const turnBusy = effectiveStatus === "queued" || effectiveStatus === "generating";
        const resultCount = successfulVisualImages.length;
        const showResultSummary = turn.mode !== "chat" && (visualImages.length > 0 || turnBusy);
        const isQueued = effectiveStatus === "queued";
        const isRunning = effectiveStatus === "generating";
        const elapsedSeconds = isRunning
          ? Math.max(
              0,
              Math.floor((progressNow - imageTurnStartedAtTimestamp(turn.processingStartedAt, turn.createdAt)) / 1000),
            )
          : 0;
        const elapsedClock = isRunning ? formatElapsedClock(elapsedSeconds) : "";
        const progressMessage =
          isQueued
            ? "等待任务开始"
            : progress?.message || (turnBusy ? "正在处理图片" : "");
        const requestedSizeLabel = turn.size ? formatImageSizeDisplay(turn.size) : "自动";
        const longTaskHint = getLongTaskHint(turn, elapsedSeconds);
        const downloadActions =
          downloadableImages.length > 0 ? (
            <>
              <Button
                type="button"
                size="sm"
                className="h-8 rounded-full bg-[#1456f0] px-2.5 text-[11px] text-white shadow-sm hover:bg-[#2563eb]"
                disabled={selectedDownloadableImages.length === 0 || downloadingKey !== null}
                onClick={() =>
                  void downloadItems(
                    `selected:${selectedConversation.id}:${turn.id}`,
                    selectedDownloadableImages,
                  )
                }
              >
                {downloadingKey === `selected:${selectedConversation.id}:${turn.id}` ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <Download className="size-3" />
                )}
                下载已选 ({selectedDownloadableImages.length})
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-full border-[#e5e7eb] bg-white px-2.5 text-[11px] text-[#45515e] shadow-sm hover:bg-black/[0.05]"
                disabled={downloadingKey !== null}
                onClick={() =>
                  void downloadItems(
                    `all:${selectedConversation.id}:${turn.id}`,
                    downloadableImages,
                  )
                }
              >
                {downloadingKey === `all:${selectedConversation.id}:${turn.id}` ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <Download className="size-3" />
                )}
                下载全部
              </Button>
            </>
          ) : null;

        return (
          <div key={turn.id} className="flex flex-col gap-3 sm:gap-4">
            <div className="flex justify-end">
              <article className="w-full max-w-[min(94%,760px)] rounded-[24px] border border-[#f2f3f5] bg-white px-4 py-3 text-left text-[14px] leading-6 text-[#222222] shadow-[0_4px_6px_rgba(0,0,0,0.08)] sm:px-5 sm:py-4 sm:text-[15px] sm:leading-7">
                <div className="mb-3 flex items-start justify-between gap-3 border-b border-[#f2f3f5] pb-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] leading-5 text-[#45515e]">
                    <span className="rounded-full bg-[#f0f0f0] px-2.5 py-0.5 text-[#45515e]">第 {turnIndex + 1} 轮</span>
                    <span className="rounded-full bg-[#f0f0f0] px-2.5 py-0.5 text-[#45515e]">{getTurnModeLabel(turn)}</span>
                    <span className="rounded-full bg-[#f0f0f0] px-2.5 py-0.5 text-[#45515e]">{turn.model}</span>
                    <span className="rounded-full bg-[#f0f0f0] px-2.5 py-0.5 text-[#45515e]">
                      {getTurnStatusLabel(effectiveStatus)}
                    </span>
                    <span className="px-1 text-[#8e8e93]">{formatConversationTime(turn.createdAt)}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {turnBusy ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-8 rounded-full border-amber-200 bg-amber-50 text-amber-700 shadow-none hover:bg-amber-100"
                        onClick={() => void onCancelTurn(selectedConversation.id, turn.id)}
                        aria-label="终止生成任务"
                        title="终止"
                      >
                        <CircleStop className="size-4" />
                      </Button>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="size-8 rounded-full border-[#e5e7eb] bg-white text-[#45515e] shadow-none hover:bg-black/[0.05]"
                          onClick={() => onEditTurn(selectedConversation.id, turn.id)}
                          aria-label="编辑生成设置"
                          title="编辑"
                        >
                          <PencilLine className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="size-8 rounded-full border-[#e5e7eb] bg-white text-[#45515e] shadow-none hover:bg-black/[0.05]"
                          disabled={turnBusy || !turn.prompt.trim()}
                          onClick={() => void onRegenerateTurn(selectedConversation.id, turn.id)}
                          aria-label="重新生成"
                          title="重新生成"
                        >
                          <RotateCcw className="size-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div>
                  <div className="whitespace-pre-wrap break-words">{turn.prompt}</div>
                  {turn.referenceImages.length > 0 ? (
                    <div className="mt-3 flex flex-wrap justify-start gap-2">
                      {turn.referenceImages.map((image, index) => (
                        <button
                          key={`${turn.id}-${image.name}-${index}`}
                          type="button"
                          onClick={() => onOpenLightbox(referenceLightboxImages, index)}
                          className="group relative size-20 shrink-0 overflow-hidden rounded-2xl border border-stone-200/80 bg-stone-100/60 text-left transition hover:border-stone-300 sm:size-24"
                          aria-label={`预览参考图 ${image.name || index + 1}`}
                        >
                          <AuthenticatedImage
                            src={image.dataUrl}
                            alt={image.name || `参考图 ${index + 1}`}
                            className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                            placeholderClassName="min-h-0"
                          />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </article>
            </div>

            <div className="flex justify-start">
              <section className="w-full px-1">
                {showResultSummary ? (
                  <div className="hide-scrollbar mb-3 flex items-center gap-3 overflow-x-auto border-b border-[#eceef1] pb-3 sm:mb-4">
                    <div className="flex shrink-0 items-center gap-3 whitespace-nowrap text-[11px] text-[#6b7280] sm:text-xs">
                      {turnBusy ? (
                        <span>
                          已完成 <strong className="font-semibold text-[#30343b]">{resultCount}</strong>
                          {" / "}目标 <strong className="font-semibold text-[#30343b]">{turn.count}</strong> 张
                        </span>
                      ) : (
                        <span>
                          生成结果：<strong className="font-semibold text-[#30343b]">{resultCount} 张</strong>
                        </span>
                      )}
                      {!turnBusy && turn.count !== resultCount ? (
                        <span>目标 <strong className="font-semibold text-[#30343b]">{turn.count}</strong> 张</span>
                      ) : null}
                      {requestedSizeLabel ? (
                        <span>
                          请求：<strong className="font-semibold text-[#30343b]">{requestedSizeLabel}</strong>
                        </span>
                      ) : null}
                      {resultDimensionsLabel ? (
                        <span>
                          返回：<strong className="font-semibold text-[#30343b]">{resultDimensionsLabel}</strong>
                        </span>
                      ) : null}
                      {successfulVisualImages.length > 0 ? (
                        <span
                          className={cn(
                            "inline-flex items-center rounded-md px-2 py-0.5 font-medium",
                            resultQualityCheckImage
                              ? imageQualityCheckClass(resultQualityCheckImage)
                              : "bg-[#f3f4f6] text-[#6b7280] ring-1 ring-[#e5e7eb]",
                          )}
                          title={resultQualityCheckImage ? imageQualityCheckTitle(resultQualityCheckImage) : "当前结果没有检测信息"}
                        >
                          检测：{resultQualityCheckLabel || "未检测"}
                        </span>
                      ) : null}
                      {resultGenerationDuration ? (
                        <span className="font-mono font-medium tabular-nums text-[#1456f0]">
                          {resultGenerationDuration}
                        </span>
                      ) : null}
                      {resultSizeLabel ? (
                        <span>大小：<strong className="font-semibold text-[#30343b]">{resultSizeLabel}</strong></span>
                      ) : null}
                      {resultFormatLabel ? (
                        <span className="rounded-md bg-[#18181b] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          {resultFormatLabel}
                        </span>
                      ) : null}
                      {resultCompletedAt ? <span className="text-[#8e8e93]">{resultCompletedAt}</span> : null}
                      {effectiveStatus !== "success" ? (
                        <span className={cn("rounded-full px-3 py-1", getStatusChipClass(effectiveStatus))}>
                          {getTurnStatusLabel(effectiveStatus)}
                        </span>
                      ) : null}
                    </div>
                    {turnBusy || downloadActions ? (
                      <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
                        {turnBusy ? (
                          <span className="flex max-w-full flex-col gap-0.5 rounded-2xl bg-amber-50 px-3 py-1 text-[11px] leading-5 text-amber-700 sm:text-xs">
                            <span className="w-fit whitespace-nowrap font-medium">{progressMessage}</span>
                            {longTaskHint ? <span className="max-w-[20rem] text-[11px] leading-5">{longTaskHint}</span> : null}
                          </span>
                        ) : null}
                        {downloadActions}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {textReplyImages.length > 0 ? (
                  <div className="mb-3 flex flex-col gap-2">
                    {textReplyImages.map(({ image, index }) => (
                      <div
                        key={image.id}
                        className="w-full max-w-[min(94%,760px)] rounded-[20px] border border-[#f2f3f5] bg-white px-4 py-3 text-left text-sm leading-6 text-[#45515e] shadow-[0_4px_6px_rgba(0,0,0,0.08)]"
                      >
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500">
                            <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-stone-600">
                              模型文本回复
                            </span>
                          </div>
                          {turn.mode !== "chat" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 rounded-full border-[#e5e7eb] bg-white px-3 text-xs text-[#45515e] shadow-none hover:bg-black/[0.05] hover:text-[#18181b]"
                              disabled={turnBusy || !turn.prompt.trim()}
                              onClick={() => void onRetryImage(selectedConversation.id, turn.id, index)}
                            >
                              <RotateCcw className="size-3.5" />
                              重试生成
                            </Button>
                          ) : null}
                        </div>
                        <ChatMarkdown>{image.text_response || ""}</ChatMarkdown>
                      </div>
                    ))}
                  </div>
                ) : null}

                {visualImages.length > 0 ? (
                  <div className="columns-1 gap-3 sm:columns-2 sm:gap-4 xl:columns-3">
                    {visualImages.map(({ image, index }) => {
                    const imageSrc = getStoredImageSrc(image);
                    const isProcessingPreview =
                      image.status === "loading" &&
                      (image.taskStatus === "queued" || image.taskStatus === "running") &&
                      Boolean(imageSrc);
                    const isTerminalPreview =
                      (image.status === "error" || image.status === "cancelled") && Boolean(imageSrc);
                    const isPreview = isProcessingPreview || isTerminalPreview;
                    if ((image.status === "success" || isPreview) && imageSrc) {
                      const currentIndex = successfulTurnImages.findIndex((item) => item.id === image.id);
                      const selectionKey = imageSelectionKey(selectedConversation.id, turn.id, image.id);
                      const selected = !isPreview && Boolean(selectedImageIds[selectionKey]);
                      const visibility = image.visibility || turn.visibility || "private";
                      const nextVisibility = visibility === "public" ? "private" : "public";
                      const visibilityMutatingKey = `${selectedConversation.id}:${turn.id}:${image.id}`;
                      const isVisibilityMutating = visibilityMutatingImageKey === visibilityMutatingKey;
                      const canUpdateVisibility = image.status === "success" && Boolean(image.path || image.url || image.b64_json);

                      return (
                        <figure
                          key={image.id}
                          className="group relative mb-3 inline-block w-full break-inside-avoid overflow-hidden rounded-[22px] bg-[#f0f0f0] shadow-[0_0_15px_rgba(44,30,116,0.16)] sm:mb-4"
                          onMouseLeave={(event) => blurFocusedElementInContainer(event.currentTarget)}
                        >
                          {selected ? (
                            <div className="pointer-events-none absolute inset-0 z-10 rounded-[22px] border-[3px] border-[#1456f0]/90" />
                          ) : null}
                          <div className="relative overflow-hidden">
                            <button
                              type="button"
                              onClick={(event) => {
                                toggleImageSelection(selectionKey);
                                event.currentTarget.blur();
                              }}
                              disabled={isPreview}
                              className={cn("block w-full overflow-hidden text-left", isPreview ? "cursor-default" : "cursor-pointer")}
                              aria-label={selected ? "取消选择图片" : "选择图片"}
                            >
                              <AuthenticatedImage
                                src={imageSrc}
                                alt={`Generated result ${index + 1}`}
                                width={image.width || undefined}
                                height={image.height || undefined}
                                loading="lazy"
                                decoding="async"
                                className="block h-auto w-full transition duration-200 group-hover:brightness-95"
                                onLoad={(event) => {
                                  updateImageDimensions(
                                    image.id,
                                    event.currentTarget.naturalWidth,
                                    event.currentTarget.naturalHeight,
                                  );
                                  if (!image.b64_json) {
                                    ensureImageSizeLabel(image.id, imageSrc);
                                  }
                                }}
                              />
                            </button>
                            {isPreview ? (
                              <div className={cn(
                                "pointer-events-none absolute inset-0 z-10 flex items-center justify-center",
                                isTerminalPreview ? "bg-black/45" : "bg-black/20",
                              )}>
                                <span className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white shadow-sm backdrop-blur-sm">
                                  {isProcessingPreview ? (
                                    <LoaderCircle className="size-3.5 animate-spin" />
                                  ) : (
                                    <CircleStop className="size-3.5" />
                                  )}
                                  {isProcessingPreview ? "正在处理" : image.status === "cancelled" ? "任务已终止" : "生成失败"}
                                  {image.status === "error" ? (
                                    <button
                                      type="button"
                                      className="ml-1 inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 transition hover:bg-white/25"
                                      disabled={turnBusy || !turn.prompt.trim()}
                                      onClick={() => void onRetryImage(selectedConversation.id, turn.id, index)}
                                    >
                                      <RotateCcw className="size-3" />
                                      重试
                                    </button>
                                  ) : null}
                                </span>
                              </div>
                            ) : null}
                            <button
                              type="button"
                              onClick={(event) => {
                                toggleImageSelection(selectionKey);
                                event.currentTarget.blur();
                              }}
                              className={cn(
                                "absolute top-2 left-2 z-10 inline-flex size-6 items-center justify-center rounded-full border transition duration-150",
                                selected
                                  ? "border-[#1456f0] bg-[#1456f0] text-white opacity-100 shadow-sm"
                                  : "pointer-events-none border-white/90 bg-black/20 text-transparent opacity-0 shadow-sm group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-black/30",
                              )}
                              disabled={isPreview}
                              aria-label={selected ? "取消选择图片" : "选择图片"}
                            >
                              {selected ? <Check className="size-3.5" /> : null}
                            </button>
                            {!isPreview ? <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 transition duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  event.currentTarget.blur();
                                  onOpenLightbox(successfulTurnImages, currentIndex);
                                }}
                                className="inline-flex h-7 items-center gap-1 rounded-full bg-white/95 px-2 text-[11px] font-medium text-stone-800 shadow-sm transition hover:bg-white hover:text-stone-950"
                                aria-label="查看原图"
                                title="查看原图"
                              >
                                <Eye className="size-3" />
                                查看原图
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  event.currentTarget.blur();
                                  onContinueEdit(selectedConversation.id, image);
                                }}
                                className="inline-flex size-7 items-center justify-center rounded-full bg-white/95 text-stone-800 shadow-sm transition hover:bg-white hover:text-stone-950"
                                aria-label="加入编辑"
                                title="加入编辑"
                              >
                                <Plus className="size-3.5" />
                              </button>
                            </div> : null}
                            <div className="absolute right-2 bottom-2 z-20 flex items-center gap-1">
                              {canUpdateVisibility ? (
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    event.currentTarget.blur();
                                    void onImageVisibilityChange(
                                      selectedConversation.id,
                                      turn.id,
                                      index,
                                      nextVisibility,
                                    );
                                  }}
                                  disabled={isVisibilityMutating}
                                  className={cn(
                                    "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:opacity-70",
                                    imageVisibilityActionClass(visibility),
                                  )}
                                  aria-label={visibility === "public" ? "取消公开图片" : "公开图片"}
                                  title={visibility === "public" ? "取消公开" : "公开"}
                                >
                                  {isVisibilityMutating ? (
                                    <LoaderCircle className="size-3 animate-spin" />
                                  ) : visibility === "public" ? (
                                    <Lock className="size-3" />
                                  ) : (
                                    <Globe2 className="size-3" />
                                  )}
                                  {visibility === "public" ? "取消公开" : "公开"}
                                </button>
                              ) : null}
                              <div
                                className={cn(
                                  "pointer-events-none inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium shadow-sm backdrop-blur-sm",
                                  imageVisibilityPillClass(visibility),
                                )}
                              >
                                {visibility === "public" ? <Globe2 className="size-3" /> : <Lock className="size-3" />}
                                {imageVisibilityLabel(visibility)}
                              </div>
                            </div>
                          </div>
                        </figure>
                      );
                    }

                    if (image.status === "cancelled") {
                      return (
                        <div
                          key={image.id}
                          className="mb-3 inline-block h-[160px] w-full break-inside-avoid overflow-hidden rounded-[18px] border border-amber-200 bg-amber-50 sm:mb-4"
                        >
                          <div className="flex h-full min-h-16 items-center justify-center px-4 py-4 text-center text-sm leading-6 text-amber-700 sm:px-6 sm:py-8">
                            {image.error || "任务已终止"}
                          </div>
                        </div>
                      );
                    }

                    if (image.status === "error") {
                      return (
                        <div
                          key={image.id}
                          className="mb-3 inline-flex h-[160px] w-full break-inside-avoid flex-col overflow-hidden rounded-[18px] border border-rose-200 bg-rose-50 sm:mb-4"
                        >
                          <div className="flex min-h-0 flex-1 items-center justify-center whitespace-pre-line px-4 py-3 text-center text-sm leading-6 text-rose-600 sm:px-5">
                            {image.error || "生成失败"}
                          </div>
                          <div className="flex justify-end border-t border-rose-100 bg-white/70 px-3 py-2.5">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 rounded-full border-rose-200 bg-white px-3 text-xs text-rose-600 shadow-none hover:bg-rose-50 hover:text-rose-700"
                              disabled={turnBusy || !turn.prompt.trim()}
                              onClick={() => void onRetryImage(selectedConversation.id, turn.id, index)}
                            >
                              <RotateCcw className="size-3.5" />
                              重试
                            </Button>
                          </div>
                        </div>
                      );
                    }

                    const imageLoadingPhase = getStoredImageLoadingPhase(image, turn);
                    const imageBusyLabel = imageLoadingPhase === "queued"
                      ? "排队中..."
                      : imageLoadingPhase === "running"
                        ? "正在处理图片..."
                        : "";

                    return (
                      <div
                        key={image.id}
                        className="mb-3 inline-block h-[160px] w-full break-inside-avoid overflow-hidden rounded-[18px] border border-stone-200/80 bg-stone-100/80 sm:mb-4"
                      >
                        <div className="flex h-full flex-col items-center justify-center gap-2 px-5 py-5 text-center text-stone-500">
                          <div className="rounded-full bg-white p-3 shadow-sm">
                            {imageLoadingPhase === "queued" ? (
                              <Clock3 className="size-5" />
                            ) : (
                              <LoaderCircle className="size-5 animate-spin" />
                            )}
                          </div>
                          <p className="text-sm">
                            {imageBusyLabel}
                          </p>
                          {imageLoadingPhase === "running" ? (
                            <p className="min-w-[7.5rem] rounded-full bg-white/70 px-2.5 py-1 font-mono text-xs tabular-nums text-stone-400">
                              已运行 {elapsedClock}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    );
                    })}
                  </div>
                ) : null}

              </section>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function getTurnStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "处理中";
  }
  if (status === "success") {
    return "已完成";
  }
  if (status === "message") {
    return "文本回复";
  }
  if (status === "cancelled") {
    return "已终止";
  }
  return "失败";
}

function turnProgressKey(conversationId: string, turnId: string) {
  return `${conversationId}:${turnId}`;
}

function formatElapsedClock(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getStatusChipClass(status: ImageTurnStatus) {
  if (status === "queued") {
    return "bg-amber-50 text-amber-700";
  }
  if (status === "generating") {
    return "bg-blue-50 text-[#1456f0]";
  }
  if (status === "success") {
    return "bg-emerald-50 text-emerald-700";
  }
  if (status === "message") {
    return "bg-stone-100 text-stone-600";
  }
  if (status === "cancelled") {
    return "bg-amber-50 text-amber-700";
  }
  return "bg-rose-50 text-rose-700";
}

function getTurnModeLabel(turn: ImageTurn) {
  if (turn.mode === "chat") {
    return "文本记录";
  }
  if (turn.mode === "generate") {
    return "文生图";
  }
  if (turn.mode === "edit" && turn.referenceImages.some((image) => image.source === "conversation")) {
    return "编辑图";
  }
  return "图生图";
}

function formatImageDimensions(width: number, height: number) {
  return `${width} x ${height}`;
}
