import type { CreationTask, ImageOutputFormat, ImageQualityCheck, ImageVisibility } from "@/lib/api";
import { normalizeGenerationProgress } from "@/lib/generation-task-contract";
import { getManagedImagePathFromUrl } from "@/lib/image-path";
import { deriveGenerationTaskStatus, effectiveTaskOutputStatus, effectiveTaskSlotStatus, hasFinalTaskOutput, isTaskActive, taskImageHasPreview } from "@/lib/image-task-state";
import { videoTaskContractReferencesEqual } from "@/lib/video-task-contract";
import type { ImageTurn, StoredImage } from "@/store/image-conversations";

type CreationTaskDataItem = NonNullable<CreationTask["data"]>[number];

export function imageMimeTypeForOutputFormat(format?: ImageOutputFormat) {
  return format === "svg" ? "image/svg+xml" : `image/${format || "png"}`;
}

function positiveDimension(value: unknown) {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? Math.round(dimension) : undefined;
}

export function imageTaskBatchId(turnId: string, imageIndex: number) {
  return `${turnId}-task-${imageIndex}`;
}

export function imageTaskIdForImage(turnId: string, images: StoredImage[], imageIndex: number) {
  return images[imageIndex]?.taskId || imageTaskBatchId(turnId, imageIndex);
}

export function imageDataIndexForTask(images: StoredImage[], imageIndex: number) {
  const taskId = images[imageIndex]?.taskId || images[imageIndex]?.id;
  if (!taskId) {
    return 0;
  }
  return images.slice(0, imageIndex + 1).filter((image) => (image.taskId || image.id) === taskId).length - 1;
}

const STORED_IMAGE_FIELDS: Array<keyof StoredImage> = [
  "id",
  "taskId",
  "storageKey",
  "taskRevision",
  "taskStatus",
  "taskProgress",
  "canRecoverVideo",
  "videoContract",
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
  return STORED_IMAGE_FIELDS.every((field) => field === "videoContract"
    ? videoTaskContractReferencesEqual(image.videoContract, next.videoContract)
    : image[field] === next[field]) ? image : next;
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

export function storedImageVisibilityPath(image: StoredImage) {
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
    const format = image.outputFormat || "png";
    return `data:${imageMimeTypeForOutputFormat(format)};base64,${image.b64_json.trim()}`;
  }
  return "";
}

function creationTaskImageStatus(task: CreationTask, dataIndex = 0): "queued" | "running" | "success" | "error" | "cancelled" | undefined {
  const outputStatus = task.output_statuses?.[dataIndex];
  if (task.status === "queued" || task.status === "running" || task.status === "success" || task.status === "error" || task.status === "cancelled") {
    return effectiveTaskOutputStatus(task.status, outputStatus);
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

function creationTaskMetadataUpdates(task: CreationTask, completed: boolean): Partial<StoredImage> {
  const updates: Partial<StoredImage> = {
    videoContract: task.video_contract,
    taskCreatedAt: task.created_at,
    taskUpdatedAt: task.updated_at,
    taskProgress: task.mode === "video" ? task.status === "success" ? 100 : normalizeGenerationProgress(task.progress) : undefined,
    canRecoverVideo: task.mode === "video" ? task.can_recover_video : undefined,
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

export function taskDataToStoredImage(image: StoredImage, task: CreationTask, dataIndex = 0, fallbackVisibility?: ImageVisibility): StoredImage {
  const taskVisibility = task.visibility || fallbackVisibility || image.visibility || "private";
  const activeMetadata = creationTaskMetadataUpdates(task, false);
  const finalMetadata = creationTaskMetadataUpdates(task, true);
  const taskRevision = Number(task.revision);
  const normalizedTaskRevision = Number.isSafeInteger(taskRevision) && taskRevision > 0 ? taskRevision : image.taskRevision;
  const sameTask = image.taskId === task.id;
  const imageIsTerminal = image.status === "success" || image.status === "error" || image.status === "cancelled" || image.status === "message";
  if (
    sameTask &&
    isTaskActive(task.status) &&
    imageIsTerminal &&
    !(task.mode === "video" && image.canRecoverVideo === true && Number(task.revision) > Number(image.taskRevision || 0))
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
      ...finalMetadata,
      taskStatus: "success" as const,
      status: "success" as const,
      b64_json: item.b64_json,
      url: isVideo ? videoUrl || item.url : item.url,
      mediaType: isVideo ? "video" as const : "image" as const,
      videoUrl: isVideo ? videoUrl || item.url : undefined,
      mimeType: isVideo ? item.mime_type || "video/mp4" : undefined,
      path: !isVideo && item.url ? getManagedImagePathFromUrl(item.url) || image.path : image.path,
      visibility: taskVisibility,
      storageKey: item.storageKey || item.storage_key || image.storageKey,
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
        ...finalMetadata,
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
          ...finalMetadata,
          taskStatus: slotStatus,
          status: slotStatus === "cancelled" ? "cancelled" : "error",
          error: slotStatus === "cancelled" ? task.error || "任务已终止" : task.error || "生成失败",
        });
      }
      return updateStoredImage(image, {
        taskId: task.id,
        taskRevision: normalizedTaskRevision,
        ...finalMetadata,
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
    );
    if (slotStatus === "error" || slotStatus === "cancelled") {
      const error = slotStatus === "cancelled"
        ? task.error || "任务已终止"
        : task.error || "生成失败";
      return updateStoredImage(image, {
        ...(item && (item.b64_json || item.url || item.video_url) ? successUpdates(item) : {}),
        taskId: task.id,
        taskRevision: normalizedTaskRevision,
        ...finalMetadata,
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
          ...finalMetadata,
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
        ...activeMetadata,
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
        ...activeMetadata,
        taskRevision: normalizedTaskRevision,
        taskStatus: activeTaskStatus,
        status: "loading",
      });
    }
    const preview = taskImageHasPreview(image);
    return updateStoredImage(image, {
      taskId: task.id,
      taskRevision: normalizedTaskRevision,
      ...activeMetadata,
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
        ...finalMetadata,
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
        ...finalMetadata,
        taskStatus: "error",
        status: "error",
        error,
      });
    }
    return updateStoredImage(image, {
      taskId: task.id,
      taskRevision: normalizedTaskRevision,
      ...finalMetadata,
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
        ...finalMetadata,
        taskStatus: "cancelled",
        status: "cancelled",
        error: task.error || "任务已终止",
      });
    }
    return updateStoredImage(image, {
      taskId: task.id,
      taskRevision: normalizedTaskRevision,
      ...finalMetadata,
      taskStatus: "cancelled",
      status: "cancelled",
      error: task.error || "任务已终止",
    });
  }

  return updateStoredImage(image, {
    taskId: task.id,
    taskRevision: normalizedTaskRevision,
    ...activeMetadata,
    taskStatus: creationTaskImageStatus(task, dataIndex) || "queued",
    status: "loading",
    text_response: undefined,
    error: undefined,
  });
}

export function deriveTurnStatus(turn: ImageTurn): Pick<ImageTurn, "status" | "error"> {
  return deriveGenerationTaskStatus(turn.images);
}

export function deriveTurnStatusFromTaskMap(turn: ImageTurn, images: StoredImage[]): Pick<ImageTurn, "status" | "error"> {
  return deriveTurnStatus({ ...turn, images });
}

export function isTurnInProgress(turn: ImageTurn) {
  return (
    turn.status === "queued" ||
    turn.status === "generating" ||
    turn.images.some((image) => image.status === "loading")
  );
}
