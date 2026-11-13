"use client";

import { EmptyState } from "@/components/ui/empty-state";

import { Spinner } from "@/components/ui/spinner";

import { Bubble, BubbleContent } from "@/components/ui/bubble";

import { Badge } from "@/components/ui/badge";
import { Attachment, AttachmentGroup, AttachmentMedia, AttachmentTrigger } from "@/components/ui/attachment";
import { Checkbox } from "@/components/ui/checkbox";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { Message, MessageContent, MessageFooter, MessageHeader } from "@/components/ai-elements/message";
import { RunStatus } from "@/components/ai-elements/run-status";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LoadingState } from "@/components/ui/loading-state";
import { Skeleton } from "@/components/ui/skeleton";

import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";



import { useEffect, useRef, useState } from "react";
import { AlertCircle, Brush, ChevronDown, CircleStop, Clock3, Download, Eye, Globe2, Lock, PencilLine, Plus, RotateCcw, Sparkles } from "lucide-react";

import { AuthenticatedImage } from "@/components/authenticated-image";
import { ImagePreview } from "@/components/image-preview";
import { MediaVideoPlayer } from "@/components/media-video-player";
import { GenerationProgress } from "@/components/generation/generation-progress";
import { normalizeGenerationProgress } from "@/lib/generation-task-contract";
import { canRecoverVideoTask, videoTaskErrorMessage } from "@/lib/video-task-error";
import { ChatMarkdown } from "@/app/image/components/chat-markdown";
import { StudioAgentProcess } from "./studio-agent-process";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { TooltipButton, TooltipHint } from "@/components/ui/tooltip";
import { formatImageSizeDisplay } from "@/lib/image-options";
import type { ImageVisibility } from "@/lib/api";
import {
  fetchAuthenticatedImageBlob,
  getCachedAuthenticatedImageByteSize,
  shouldUseAuthenticatedImageFallback,
} from "@/lib/authenticated-image";
import { getManagedImageUrlFromPath } from "@/lib/image-path";
import { formatBase64ImageFileSize, formatImageFileSize } from "@/lib/image-size";
import { generationFrameAspectRatio, videoFrameMaxWidth } from "@/lib/generation-frame-aspect";
import { cn, formatElapsedClock } from "@/lib/utils";
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
import { resolveMediaURL } from "@/services/file-storage";
import { resolveImageURL } from "@/services/image-storage";

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
  conversationId: string | null;
  selectedConversation: ImageConversation | null;
  isLoadingHistory: boolean;
  conversationDetailError: string;
  onRetryConversationDetail: () => void;
  progressByTurnKey: Record<string, ImageTurnProgress>;
  progressNow: number;
  onOpenLightbox: (images: ImageLightboxItem[], index: number) => void;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
  onMaskEdit: (conversationId: string, turnId: string, sourceURL: string) => void;
  onEditTurn: (conversationId: string, turnId: string) => void;
  onCancelTurn: (conversationId: string, turnId: string) => void | Promise<void>;
  onResumeAgent: (conversationId: string, turnId: string) => void;
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

function getStoredImageSrc(image: StoredImage, resolvedStorageURLs: Readonly<Record<string, string>> = {}) {
  if (image.storageKey && resolvedStorageURLs[image.storageKey]) return resolvedStorageURLs[image.storageKey];
  if (image.mediaType === "video" || image.videoUrl) {
    return image.videoUrl || image.url || "";
  }
  if (image.b64_json) {
    return `data:${image.outputFormat === "svg" ? "image/svg+xml" : `image/${image.outputFormat || "png"}`};base64,${image.b64_json}`;
  }
  if (image.path) {
    const managedURL = getManagedImageUrlFromPath(image.path);
    if (managedURL) {
      return managedURL;
    }
  }
  return image.url || "";
}

function isStoredVideo(image: StoredImage) {
  return image.mediaType === "video" || Boolean(image.videoUrl) || image.mimeType?.startsWith("video/") === true;
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

function imageVisibilityLabel(visibility?: ImageVisibility) {
  return visibility === "public" ? "已公开" : "私有";
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

function GeneratedVideoPlayer({ src, aspectRatio, title }: { src: string; aspectRatio: string; title: string }) {
  // Saving a durable copy must not reset playback of this result.
  const [playbackSrc] = useState(src);
  return <MediaVideoPlayer src={playbackSrc} aspectRatio={aspectRatio} title={title} embedded />;
}

export function ImageResults({
  conversationId,
  selectedConversation,
  isLoadingHistory,
  conversationDetailError,
  onRetryConversationDetail,
  progressByTurnKey,
  progressNow,
  onOpenLightbox,
  onContinueEdit,
  onMaskEdit,
  onEditTurn,
  onCancelTurn,
  onResumeAgent,
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
  const [resolvedStorageURLs, setResolvedStorageURLs] = useState<Record<string, string>>({});
  const pendingImageSizeIdsRef = useRef<Set<string>>(new Set());
  const hasConversationDetail = Boolean(selectedConversation && !selectedConversation.historySummaryOnly);

  useEffect(() => {
    setSelectedImageIds({});
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    const storedImages = selectedConversation?.turns.flatMap((turn) => turn.images).filter((image) => image.storageKey) || [];
    void Promise.all(storedImages.map(async (image) => {
      const storageKey = image.storageKey || "";
      const fallback = image.videoUrl || image.url || "";
      const url = isStoredVideo(image)
        ? await resolveMediaURL(storageKey, fallback)
        : await resolveImageURL(storageKey, fallback);
      return [storageKey, url] as const;
    })).then((entries) => {
      if (!cancelled) setResolvedStorageURLs((current) => ({ ...current, ...Object.fromEntries(entries.filter((entry) => entry[1])) }));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedConversation]);

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
      <LoadingState className="min-h-0 flex-1" label="正在读取历史记录" />
    );
  }

  if (conversationDetailError && !hasConversationDetail) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8 text-center">
        <Card className="flex w-full max-w-xs flex-col items-center gap-3 p-6">
          <EmptyState compact role="alert" icon={AlertCircle} title="暂时无法读取会话" className="min-h-0 p-0" description={<ScrollArea className="max-h-36">{conversationDetailError}</ScrollArea>} action={<Button type="button" variant="outline" onClick={onRetryConversationDetail}>重试读取</Button>} />
        </Card>
      </div>
    );
  }

  if (conversationId && !hasConversationDetail) {
    return (
      <LoadingState data-image-conversation-detail-loading className="min-h-0 flex-1" label="正在读取会话详情" />
    );
  }

  if (!selectedConversation) return null;

  return (
    <>
      {conversationDetailError ? (
        <Card role="alert" className="flex flex-row items-center justify-between gap-3 p-3">
          <span className="text-sm">会话更新失败：{conversationDetailError}</span>
          <Button type="button" variant="outline" size="sm" onClick={onRetryConversationDetail}>重试读取</Button>
        </Card>
      ) : null}
      {selectedConversation.turns.map((turn, turnIndex) => {
        const progress = progressByTurnKey[turnProgressKey(selectedConversation.id, turn.id)];
        const displayedReferenceImages = [
          ...(turn.videoFirstFrameURL ? [{ name: "首帧", dataUrl: turn.videoFirstFrameURL }] : []),
          ...(turn.videoLastFrameURL ? [{ name: "尾帧", dataUrl: turn.videoLastFrameURL }] : []),
          ...turn.referenceImages,
        ];
        const referenceLightboxImages = displayedReferenceImages.map((image, index) => ({
          id: `${turn.id}-reference-${index}`,
          src: image.dataUrl,
          fileName: image.name,
        }));
        const downloadableImages = turn.images.flatMap((image, index) => {
          const src = image.status === "success" ? getStoredImageSrc(image, resolvedStorageURLs) : "";
          return src
            ? [
                {
                  id: image.id,
                  selectionKey: imageSelectionKey(selectedConversation.id, turn.id, image.id),
                  src,
                  fileName: isStoredVideo(image)
                    ? `yunmian-video-${turn.id.slice(0, 8)}-${String(index + 1).padStart(2, "0")}.mp4`
                    : buildDownloadName(turn.createdAt, turn.id, index, image.outputFormat || turn.outputFormat, src),
                  imageIndex: index,
                },
              ]
            : [];
        });
        const selectedDownloadableImages = downloadableImages.filter((image) => selectedImageIds[image.selectionKey]);
        const successfulTurnImages = turn.images.flatMap((image, index) => {
          if (isStoredVideo(image)) {
            return [];
          }
          const src = image.status === "success" ? getStoredImageSrc(image, resolvedStorageURLs) : "";
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
          image.status === "success" && getStoredImageSrc(image, resolvedStorageURLs) ? [image] : [],
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
            successfulVisualImages.map((image) => isStoredVideo(image) ? "MP4" : imageExtension(image.outputFormat, getStoredImageSrc(image, resolvedStorageURLs)).toUpperCase()),
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
        const isVideoTurn = turn.mode === "video";
        const turnFrameAspectRatio = generationFrameAspectRatio(turn);
        const [videoWidth, videoHeight] = turnFrameAspectRatio.split(" / ").map(Number);
        const turnVideoFrameMaxWidth = `min(${videoFrameMaxWidth(turnFrameAspectRatio)}, max(14rem, ${(22 * videoWidth / videoHeight).toFixed(3)}rem))`;
        const videoResolutionLabel = turn.videoResolution || "默认清晰度";
        const videoDurationLabel = turn.videoSeconds === -1 ? "智能时长" : turn.videoSeconds ? `${turn.videoSeconds} 秒` : "默认时长";
        const videoAudioLabel = turn.videoGenerateAudio === false ? "静音" : turn.videoGenerateAudio === true ? "含声音" : "默认音频";
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
            ? progress?.message || "等待任务开始"
            : progress?.message || (turnBusy ? turn.mode === "video" ? "正在处理视频" : "正在处理图片" : "");
        const requestedSizeLabel = turn.size ? formatImageSizeDisplay(turn.size) : "自动";
        const downloadActions = downloadableImages.length > 0
          ? (
            <>
              {selectedDownloadableImages.length > 0 ? (
              <Button
                type="button"
                size="sm"

                disabled={downloadingKey !== null}
                onClick={() =>
                  void downloadItems(
                    `selected:${selectedConversation.id}:${turn.id}`,
                    selectedDownloadableImages,
                  )
                }
              >
                {downloadingKey === `selected:${selectedConversation.id}:${turn.id}` ? (
                  <Spinner />
                ) : (
                  <Download  />
                )}
                下载已选 ({selectedDownloadableImages.length})
              </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"

                disabled={downloadingKey !== null}
                onClick={() =>
                  void downloadItems(
                    `all:${selectedConversation.id}:${turn.id}`,
                    downloadableImages,
                  )
                }
              >
                {downloadingKey === `all:${selectedConversation.id}:${turn.id}` ? (
                  <Spinner />
                ) : (
                  <Download  />
                )}
                {downloadableImages.length === 1 ? "下载" : "下载全部"}
              </Button>
            </>
          ) : null;

        return (
          <MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor data-conversation-turn className="mx-auto flex w-full max-w-4xl flex-col gap-4 [content-visibility:visible] sm:gap-5">
            <section data-message-role="user" aria-label="你的消息" className="min-w-0">
              <Message from="user">
                <MessageContent className="max-w-[min(90%,42rem)]">
                  <MessageHeader className="flex-wrap justify-end gap-x-2 px-0">
                    <span>你</span>
                    <span>第 {turnIndex + 1} 轮 · {formatConversationTime(turn.createdAt)}</span>
                  </MessageHeader>
                  <Bubble align="end" variant="secondary" className="max-w-full">
                    <BubbleContent>
                      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.prompt}</p>
                      {displayedReferenceImages.length > 0 ? (
                        <AttachmentGroup className="mt-2 flex-wrap gap-2 overflow-visible">
                          {displayedReferenceImages.map((image, index) => (
                            <Attachment key={`${turn.id}-${image.name}-${index}`} orientation="vertical" size="xs" className="w-10">
                              <AttachmentMedia variant="image">
                                <AuthenticatedImage src={image.dataUrl} alt={image.name || `参考图 ${index + 1}`} className="size-full object-cover" placeholderClassName="min-h-0" />
                              </AttachmentMedia>
                              <AttachmentTrigger onClick={() => onOpenLightbox(referenceLightboxImages, index)} aria-label={`预览参考图 ${image.name || index + 1}`} />
                            </Attachment>
                          ))}
                        </AttachmentGroup>
                      ) : null}
                    </BubbleContent>
                  </Bubble>
                  <Collapsible className="flex max-w-full flex-col items-end gap-2">
                    <MessageFooter className="flex-wrap gap-1 px-0">
                      <Badge variant="outline">{getTurnModeLabel(turn)}</Badge>
                      {turn.workflowName ? <span>{turn.workflowName}</span> : null}
                      {turn.promptContext ? (
                        <CollapsibleTrigger asChild>
                          <Button type="button" variant="ghost" size="sm">
                            生图提示词<ChevronDown />
                          </Button>
                        </CollapsibleTrigger>
                      ) : null}
                      <div className="flex shrink-0 items-center gap-1">
                        {turnBusy ? (
                          <TooltipHint content={"终止"}><Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"

                            onClick={() => void onCancelTurn(selectedConversation.id, turn.id)}
                            aria-label="终止生成任务"
                          >
                            <CircleStop  />
                          </Button></TooltipHint>
                        ) : (
                          <>
                            <TooltipHint content={"编辑"}><Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"

                              onClick={() => onEditTurn(selectedConversation.id, turn.id)}
                              aria-label="编辑生成设置"
                            >
                              <PencilLine  />
                            </Button></TooltipHint>
                            <TooltipHint content={"重新生成"}><Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"

                              disabled={turnBusy || !turn.prompt.trim()}
                              onClick={() => void onRegenerateTurn(selectedConversation.id, turn.id)}
                              aria-label="重新生成"
                            >
                              <RotateCcw  />
                            </Button></TooltipHint>
                          </>
                        )}
                      </div>
                    </MessageFooter>
                    {turn.promptContext ? (
                      <CollapsibleContent forceMount className="w-full data-[state=closed]:hidden">
                        <Bubble variant="outline" className="w-full max-w-full">
                          <BubbleContent className="w-full">
                            <p className="text-muted-foreground">文本模型：{turn.promptContext.model}</p>
                            <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.promptContext.preparedPrompt || "结合历史要求和相关图片整理后生成。"}</p>
                          </BubbleContent>
                        </Bubble>
                      </CollapsibleContent>
                    ) : null}
                  </Collapsible>
                </MessageContent>
              </Message>
            </section>

            <section data-message-role="assistant" aria-label="模型回复" className="w-full min-w-0">
              <Message from="assistant">
                <MessageContent>
                {turn.studioAgent ? <StudioAgentProcess runId={turn.studioAgent.runId} needsResult={turn.status !== "success" && turn.status !== "message"} onResume={() => onResumeAgent(selectedConversation.id, turn.id)} /> : null}
                <div className="mb-2" data-video-result-summary={isVideoTurn || undefined}>
                  <MessageHeader data-result-header className="min-h-7 flex-wrap gap-x-2 gap-y-1 px-0">
                    <Sparkles className="size-4 shrink-0" aria-hidden="true" />
                    <span>模型回复</span>
                    <TooltipHint content={turn.model}><span className="min-w-0 max-w-full break-all sm:max-w-48 sm:truncate">{turn.model}</span></TooltipHint>
                    <Badge variant={effectiveStatus === "error" ? "destructive" : "secondary"}>{getTurnStatusLabel(effectiveStatus)}</Badge>
                    {showResultSummary ? <span>{resultCount}{turnBusy || turn.count !== resultCount ? ` / ${turn.count}` : ""} {isVideoTurn ? "个视频" : "张"}</span> : null}
                    {isRunning ? <span className="tabular-nums">{elapsedClock}</span> : null}
                    {mismatchedImages.length > 0 ? <Badge variant="destructive">{resultQualityCheckLabel}</Badge> : null}
                    <div className="flex flex-wrap items-center gap-1">
                      {downloadActions}
                      {showResultSummary ? (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button type="button" variant="ghost" size="sm" aria-label="查看生成详情">
                              详情<ChevronDown />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent align="start" className="w-[min(calc(100vw-2rem),20rem)]">
                            <PopoverHeader><PopoverTitle>生成详情</PopoverTitle></PopoverHeader>
                            <div className="min-w-0 space-y-2">
                              {isVideoTurn ? <p className="text-xs text-muted-foreground">{videoResolutionLabel} · {videoDurationLabel} · {videoAudioLabel}</p> : null}
                              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-muted-foreground sm:text-xs">
                          {requestedSizeLabel ? (
                            <span>
                              {isVideoTurn ? "画幅" : "请求"}：<strong className="font-semibold text-foreground">{requestedSizeLabel}</strong>
                            </span>
                          ) : null}
                          {resultDimensionsLabel ? (
                            <span>
                              返回：<strong className="font-semibold text-foreground">{resultDimensionsLabel}</strong>
                            </span>
                          ) : null}
                          {!isVideoTurn && successfulVisualImages.length > 0 ? (
                            <TooltipHint content={resultQualityCheckImage ? imageQualityCheckTitle(resultQualityCheckImage) : "当前结果没有检测信息"}><Badge variant="secondary"
                              className="inline-flex items-center"
                            >
                              检测：{resultQualityCheckLabel || "未检测"}
                            </Badge></TooltipHint>
                          ) : null}
                          {resultGenerationDuration ? (
                            <span className="font-mono font-medium tabular-nums text-primary">
                              {resultGenerationDuration}
                            </span>
                          ) : null}
                          {resultSizeLabel ? (
                            <span>大小：<strong className="font-semibold text-foreground">{resultSizeLabel}</strong></span>
                          ) : null}
                          {resultFormatLabel ? (
                            <Badge variant="default">
                              {resultFormatLabel}
                            </Badge>
                          ) : null}
                          {resultCompletedAt ? <span>{resultCompletedAt}</span> : null}
                              </div>
                            </div>
                          </PopoverContent>
                        </Popover>
                      ) : null}
                    </div>
                  </MessageHeader>
                </div>

                {textReplyImages.length > 0 ? (
                  <div className="mb-3 flex flex-col gap-2">
                    {textReplyImages.map(({ image, index }) => (
                      <Bubble variant="outline"
                        key={image.id}
                        className="w-full max-w-[min(94%,760px)]"
                      ><BubbleContent className="w-full">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                            <Badge variant="secondary" className="max-w-full [overflow-wrap:anywhere]">
                              {turn.studioAgent ? "Agent 回复" : "模型文本回复"}
                            </Badge>
                          </div>
                          {turn.mode !== "chat" && !turn.studioAgent ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"

                              disabled={turnBusy || !turn.prompt.trim()}
                              onClick={() => void onRetryImage(selectedConversation.id, turn.id, index)}
                            >
                              <RotateCcw  />
                              重试生成
                            </Button>
                          ) : null}
                        </div>
                        <ChatMarkdown>{image.text_response || ""}</ChatMarkdown>
                      </BubbleContent></Bubble>
                    ))}
                  </div>
                ) : null}

                {visualImages.length > 0 ? (
                  <div className={turn.mode === "video" ? "grid min-w-0 grid-cols-1 items-start gap-4" : "grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] items-start gap-3 sm:gap-4"}>
                    {visualImages.map(({ image, index }) => {
                    const imageSrc = getStoredImageSrc(image, resolvedStorageURLs);
                    const video = isStoredVideo(image) || turn.mode === "video";
                    const isProcessingPreview =
                      image.status === "loading" &&
                      (image.taskStatus === "queued" || image.taskStatus === "running") &&
                      Boolean(imageSrc);
                    const isTerminalPreview =
                      (image.status === "error" || image.status === "cancelled") && Boolean(imageSrc);
                    const isPreview = isProcessingPreview || isTerminalPreview;
                    if (video && image.status === "success" && imageSrc) {
                      const selectionKey = imageSelectionKey(selectedConversation.id, turn.id, image.id);
                      const selected = Boolean(selectedImageIds[selectionKey]);
                      return (
                        <Card
                          key={image.id}
                          data-video-result-card
                          size="sm"
                          className="group relative w-full min-w-0 overflow-hidden gap-0 p-0"
                          style={{ maxWidth: turnVideoFrameMaxWidth }}
                        >
                          <GeneratedVideoPlayer
                            key={`${image.id}:${image.taskId || ""}`}
                            aspectRatio={turnFrameAspectRatio}
                            src={imageSrc}
                            title={`生成视频 ${index + 1}`}
                          />
                          <Checkbox
                            checked={selected}
                            onCheckedChange={() => toggleImageSelection(selectionKey)}
                            className={cn("absolute top-2 left-2 z-10", !selected && "sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100")}
                            aria-label={selected ? `取消选择视频 ${index + 1}` : `选择视频 ${index + 1}`}
                          />
                        </Card>
                      );
                    }
                    if (video && image.status !== "success") {
                      const failed = image.status === "error";
                      const recoverable = canRecoverVideoTask(image);
                      const cancelled = image.status === "cancelled";
                      const phase = getStoredImageLoadingPhase(image, turn);
                      const running = phase === "running";
                      const taskProgress = normalizeGenerationProgress(image.taskProgress);
                      const waitingForVideoResult = running && taskProgress === 100;
                      const errorMessage = videoTaskErrorMessage(image.error);
                      if (!failed && !cancelled) {
                        return (
                          <Card
                            key={image.id}
                            data-video-task-state={image.status}
                            aria-label={`视频 ${index + 1}`}
                            className="relative w-full min-w-0 gap-0 p-0"
                            style={{ aspectRatio: turnFrameAspectRatio, maxWidth: turnVideoFrameMaxWidth }}
                          >
                            {turn.count > 1 ? <span className="absolute top-3 left-3 text-xs text-muted-foreground">视频 {index + 1} / {turn.count}</span> : null}
                            <CardContent className="absolute inset-0 flex min-w-0 flex-col items-center justify-center gap-3 px-4 pt-2 pb-12">
                              {running ? (
                                <LoadingState
                                  label={waitingForVideoResult ? "正在保存视频" : "正在生成视频"}
                                  description={waitingForVideoResult ? "正在获取生成结果" : undefined}
                                  className="h-auto min-h-0 p-0"
                                />
                              ) : <EmptyState compact icon={Clock3} title="视频排队中" role="status" className="min-h-0 flex-none p-0" />}
                              {running && !waitingForVideoResult && taskProgress !== undefined ? <GenerationProgress progress={taskProgress} label="视频生成进度" className="max-w-48" /> : null}
                            </CardContent>
                            <div className="absolute inset-x-3 bottom-3 flex min-w-0 items-center justify-between gap-2">
                              <span className="min-w-0 text-xs text-muted-foreground">{videoResolutionLabel} · {videoDurationLabel}</span>
                              <TooltipButton type="button" variant="ghost" size="icon-sm" tooltip="终止生成" aria-label="终止生成" onClick={() => void onCancelTurn(selectedConversation.id, turn.id)}><CircleStop /></TooltipButton>
                            </div>
                          </Card>
                        );
                      }
                      return (
                        <Card key={image.id} data-video-task-state={image.status} className="min-w-0">
                          <CardContent>
                            <RunStatus
                              status={failed ? "error" : "cancelled"}
                              title={recoverable ? "原视频任务待恢复" : failed ? "视频生成失败" : "视频生成已终止"}
                              description={`视频 ${index + 1} · ${turn.model}`}
                            />
                          </CardContent>
                          <CardContent className="space-y-3">
                            <p className="text-sm leading-6 text-muted-foreground">{recoverable ? "原任务已被上游接收，状态查询或成品保存未完成。可恢复原任务继续获取结果。" : failed ? "本次未能生成视频。可重试当前任务，或修改生成设置后重新生成。" : "此视频任务已停止。你可以修改设置，开始新的生成。"}</p>
                            {failed ? errorMessage.length > 280 ? (
                              <Collapsible className="group">
                                <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-start whitespace-normal cursor-pointer h-auto min-h-8">查看完整错误信息</Button></CollapsibleTrigger><CollapsibleContent forceMount className="data-[state=closed]:hidden">
                                <Alert variant="destructive"><AlertDescription><ScrollArea className="max-h-48" contentClassName="whitespace-pre-wrap [overflow-wrap:anywhere]">{errorMessage}</ScrollArea></AlertDescription></Alert>
                              </CollapsibleContent></Collapsible>
                            ) : <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap [overflow-wrap:anywhere]">{errorMessage}</AlertDescription></Alert> : image.error ? <ScrollArea className="max-h-36" contentClassName="whitespace-pre-wrap [overflow-wrap:anywhere]">{image.error}</ScrollArea> : null}
                          </CardContent>
                          <CardFooter className="flex-wrap justify-between gap-3">
                            <span className="text-[11px] text-muted-foreground">{videoResolutionLabel} · {videoDurationLabel}</span>
                            <div className="flex items-center gap-2">
                              <Button type="button" variant="outline" size="sm"  disabled={turnBusy} onClick={() => onEditTurn(selectedConversation.id, turn.id)}><PencilLine  />调整设置</Button>
                              {failed || recoverable ? <Button type="button" size="sm"  disabled={turnBusy || (!recoverable && !turn.prompt.trim())} onClick={() => void onRetryImage(selectedConversation.id, turn.id, index)}><RotateCcw  />{recoverable ? "恢复原任务" : "重试视频生成"}</Button> : null}
                            </div>
                          </CardFooter>
                        </Card>
                      );
                    }
                    if (image.status === "success" || isPreview) {
                      const currentIndex = successfulTurnImages.findIndex((item) => item.id === image.id);
                      const selectionKey = imageSelectionKey(selectedConversation.id, turn.id, image.id);
                      const selected = !isPreview && Boolean(selectedImageIds[selectionKey]);
                      const visibility = image.visibility || turn.visibility || "private";
                      const nextVisibility = visibility === "public" ? "private" : "public";
                      const visibilityMutatingKey = `${selectedConversation.id}:${turn.id}:${image.id}`;
                      const isVisibilityMutating = visibilityMutatingImageKey === visibilityMutatingKey;
                      const canUpdateVisibility = image.status === "success" && Boolean(image.path || image.url || image.b64_json);

                      return (
                        <Attachment
                          orientation="vertical"
                          key={image.id}
                          data-image-result-card
                          data-selected={selected}
                          className="group relative w-full min-w-0 max-w-xs overflow-hidden gap-0"
                          onMouseLeave={(event) => blurFocusedElementInContainer(event.currentTarget)}
                        >
                          <div className="relative w-full max-h-[max(8rem,min(20rem,calc(100cqh-7rem)))] overflow-hidden" style={{ aspectRatio: image.width && image.height ? `${image.width} / ${image.height}` : turnFrameAspectRatio }}>
                            {imageSrc ? <ImagePreview
                              src={imageSrc}
                              alt={`Generated result ${index + 1}`}
                              width={image.width || undefined}
                              height={image.height || undefined}
                              loading="lazy"
                              decoding="async"
                              className="absolute inset-0 size-full min-h-0 object-contain"
                              onMetadata={(width, height) => {
                                updateImageDimensions(image.id, width, height);
                                if (!image.b64_json) {
                                  ensureImageSizeLabel(image.id, imageSrc);
                                }
                              }}
                            /> : <Skeleton role="status" aria-label="正在加载图片" className="absolute inset-0 size-full" />}
                            <AttachmentTrigger
                              onClick={(event) => {
                                toggleImageSelection(selectionKey);
                                event.currentTarget.blur();
                              }}
                              disabled={isPreview || !imageSrc}
                              aria-label={selected ? "取消选择图片" : "选择图片"}
                            />
                            {isPreview ? (
                              <div className={cn("pointer-events-none absolute inset-0 z-10 flex items-center justify-center", isTerminalPreview ? "bg-black/45" : "bg-black/20")}>
                                <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden pointer-events-auto max-h-[80%] max-w-[min(88%,32rem)] backdrop-blur-sm" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><div className="min-w-0 flex flex-col items-center gap-2 text-center text-xs font-medium px-3 py-2">
                                  {isProcessingPreview ? (
                                    <span className="inline-flex items-center gap-1.5"><Spinner className="size-3.5 animate-spin" />正在处理</span>
                                  ) : (
                                    <span className="whitespace-pre-wrap break-words">{image.error || (image.status === "cancelled" ? "任务已终止" : "生成失败")}</span>
                                  )}
                                  {image.status === "error" ? (
                                    <Button variant="ghost"
                                      type="button"
                                      className="inline-flex shrink-0 items-center transition"
                                      disabled={turnBusy || !turn.prompt.trim()}
                                      onClick={() => void onRetryImage(selectedConversation.id, turn.id, index)}
                                    >
                                      <RotateCcw  />
                                      重试
                                    </Button>
                                  ) : null}
                                </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
                              </div>
                            ) : null}
                            <Checkbox
                              checked={selected}
                              onCheckedChange={() => toggleImageSelection(selectionKey)}
                              className={cn("absolute top-2 left-2 z-10", !selected && "sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100")}
                              disabled={isPreview || !imageSrc}
                              aria-label={selected ? "取消选择图片" : "选择图片"}
                            />
                            {!isPreview && imageSrc ? <div data-image-result-actions className="absolute top-2 right-2 z-10 flex items-center gap-1 sm:pointer-events-none sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100">
                              <TooltipButton
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  event.currentTarget.blur();
                                  onOpenLightbox(successfulTurnImages, currentIndex);
                                }}
                                className="inline-flex items-center transition"
                                variant="secondary"
                                aria-label="查看原图"
                                tooltip="查看原图"
                              >
                                <Eye  />
                              </TooltipButton>
                              <TooltipButton
                                type="button"
                                onClick={() => onMaskEdit(selectedConversation.id, turn.id, imageSrc)}
                                disabled={turnBusy}
                                className="inline-flex items-center justify-center transition disabled:opacity-50"
                                variant="secondary"
                                aria-label="局部重绘"
                                tooltip="局部重绘"
                              >
                                <Brush  />
                              </TooltipButton>
                              <TooltipButton
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  event.currentTarget.blur();
                                  onContinueEdit(selectedConversation.id, image);
                                }}
                                className="inline-flex items-center justify-center transition"
                                variant="secondary"
                                aria-label="加入编辑"
                                tooltip="加入编辑"
                              >
                                <Plus  />
                              </TooltipButton>
                            </div> : null}
                          </div>
                          <div data-image-result-visibility className="flex w-full items-center justify-between gap-2 px-3 py-2">
                            <TooltipHint content={visibility === "public" ? "所有用户可见" : "仅自己可见"}>
                              <Badge aria-live="polite">
                                {visibility === "public" ? <Globe2 /> : <Lock />}
                                {imageVisibilityLabel(visibility)}
                              </Badge>
                            </TooltipHint>
                            {canUpdateVisibility ? (
                              <TooltipButton
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
                                variant="ghost"
                                size="sm"
                                className="shrink-0"
                                aria-label={visibility === "public" ? "取消公开图片" : "公开图片"}
                                tooltip={visibility === "public" ? "改为私有后仅自己可见" : "公开后所有用户可见"}
                              >
                                {isVisibilityMutating ? (
                                  <Spinner />
                                ) : visibility === "public" ? (
                                  <Lock  />
                                ) : (
                                  <Globe2  />
                                )}
                                {visibility === "public" ? "设为私有" : "公开图片"}
                              </TooltipButton>
                            ) : null}
                          </div>
                        </Attachment>
                      );
                    }

                    if (image.status === "cancelled") {
                      return (
                        <Card
                          key={image.id}
                          className="h-[160px] w-full min-w-0 max-w-xs overflow-hidden gap-0 p-0"
                        >
                          <div className="flex h-full min-h-16 items-center justify-center px-4 py-4 text-center text-sm leading-6 text-amber-700 sm:px-6 sm:py-8 dark:text-amber-300">
                            {image.error || "任务已终止"}
                          </div>
                        </Card>
                      );
                    }

                    if (image.status === "error") {
                      return (
                        <Card
                          key={image.id}
                          className="min-h-[160px] w-full min-w-0 max-w-xs flex-col overflow-hidden gap-0 p-0"
                        >
                          <div className="flex min-h-[112px] min-w-0 flex-1 flex-col items-start gap-2.5 px-5 py-5 text-left text-sm leading-6 text-destructive sm:px-6">
                            <span className="inline-flex items-center gap-2 font-semibold">
                              <AlertCircle className="size-4 shrink-0" />
                              {video ? "视频生成失败" : "生成失败"}
                            </span>
                            <p className="w-full min-w-0 whitespace-pre-wrap font-normal [overflow-wrap:anywhere]">
                              {video ? videoTaskErrorMessage(image.error) : image.error || "请稍后重试"}
                            </p>
                          </div>
                          <div className="flex shrink-0 justify-end border-t border-destructive/20 bg-card/70 px-5 py-3 sm:px-6">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"

                              disabled={turnBusy || !turn.prompt.trim()}
                              onClick={() => void onRetryImage(selectedConversation.id, turn.id, index)}
                            >
                              <RotateCcw  />
                              重试
                            </Button>
                          </div>
                        </Card>
                      );
                    }

                    const imageLoadingPhase = getStoredImageLoadingPhase(image, turn);
                    const imageBusyLabel = imageLoadingPhase === "queued"
                      ? "排队中..."
                      : imageLoadingPhase === "running"
                        ? video ? "正在生成视频..." : "正在处理图片..."
                        : "";

                    return (
                      <Card
                        key={image.id}
                        className={cn("w-full min-w-0 overflow-hidden gap-0 p-0", video ? "mx-auto block" : "max-w-xs")}
                        style={{
                          aspectRatio: turnFrameAspectRatio,
                          ...(video ? { maxWidth: turnVideoFrameMaxWidth } : {}),
                        }}
                      >
                        <LoadingState label={imageLoadingPhase === "running" ? progressMessage || imageBusyLabel : imageBusyLabel} className="min-h-0 p-4" />
                        {video && imageLoadingPhase === "running" ? <GenerationProgress progress={image.taskProgress} label="视频生成进度" className="mx-auto mb-4 max-w-64" /> : null}
                      </Card>
                    );
                    })}
                  </div>
                ) : null}

                </MessageContent>
              </Message>
            </section>
          </MessageScrollerItem>
        );
      })}
    </>
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

function getTurnModeLabel(turn: ImageTurn) {
  if (turn.mode === "chat") {
    return "文本记录";
  }
  if (turn.mode === "generate") {
    return "文生图";
  }
  if (turn.mode === "video") {
    if (turn.videoReferenceMode === "reference") {
      return turn.videoReferenceVideoURLs?.some(Boolean) ? "视频生视频" : "参考生视频";
    }
    return turn.videoFirstFrameURL || turn.videoLastFrameURL || turn.referenceImages.length > 0 ? "图生视频" : "文生视频";
  }
  if (turn.mode === "edit" && turn.referenceImages.some((image) => image.source === "conversation")) {
    return "编辑图";
  }
  return "图生图";
}

function formatImageDimensions(width: number, height: number) {
  return `${width} x ${height}`;
}
