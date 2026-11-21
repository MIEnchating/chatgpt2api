import { fetchCreationTasks, type CreationTaskRequestOptions } from "@/lib/api";
import { mergeCreationTaskList } from "@/lib/image-task-state";
import { ensureGeneratedMediaAsset, persistCreationTaskOutputs } from "@/services/generation-result-storage";
import { getEffectiveImageTurnStatus, isImageConversationHistorySummaryOnly, type ImageConversation } from "@/store/image-conversations";
import { deriveTurnStatus, deriveTurnStatusFromTaskMap, imageDataIndexForTask, imageTaskIdForImage, isTurnInProgress, taskDataToStoredImage } from "./studio-task-results";

const MISSING_RECOVERABLE_TASK_ID_ERROR = "页面刷新或任务中断，未找到可恢复的任务 ID";

function isMissingBatchImageDataError(error?: string) {
  return typeof error === "string" && error.startsWith("未返回第 ") && error.endsWith(" 张图片数据");
}

function isMissingRecoverableTaskIdError(error?: string) {
  return error === MISSING_RECOVERABLE_TASK_ID_ERROR;
}

async function syncConversationCreationTasks(
  items: ImageConversation[],
  requestOptions: CreationTaskRequestOptions,
  expectedSessionKey: string,
) {
  requestOptions.signal?.throwIfAborted();
  await backfillConversationVideoAssets(items, expectedSessionKey, requestOptions.signal);
  requestOptions.signal?.throwIfAborted();
  const taskIds = new Set<string>();
  const assetContextByTaskID = new Map<string, { prompt: string; source: string; metadata?: Record<string, unknown> }>();
  items.forEach((conversation) => conversation.turns.forEach((turn) => turn.images.forEach((image) => {
    if (!image.taskId) return;
    if (image.status === "loading") taskIds.add(image.taskId);
    assetContextByTaskID.set(image.taskId, {
      prompt: turn.prompt,
      source: turn.source === "workflow" ? "工作流" : "生成视频",
      ...(turn.source === "workflow" ? { metadata: { workflowId: turn.workflowId, workflowName: turn.workflowName } } : {}),
    });
  })));
  if (taskIds.size === 0) {
    return items;
  }

  let taskList: Awaited<ReturnType<typeof fetchCreationTasks>>;
  try {
    taskList = await fetchCreationTasks([...taskIds], requestOptions);
  } catch (error) {
    requestOptions.signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return items;
  }
  const persistedTasks = await Promise.all(taskList.items.map((task) => persistCreationTaskOutputs(task, {
    assetContext: assetContextByTaskID.get(task.id),
    expectedSessionKey,
    signal: requestOptions.signal,
  })));
  const taskMap = new Map(mergeCreationTaskList(persistedTasks).map((task) => [task.id, task]));
  return items.map((conversation) => {
    // Cursor pages can contain metadata-only rows. They are completed by the
    // selected-conversation detail request and must not enter task recovery.
    if (isImageConversationHistorySummaryOnly(conversation)) {
      return conversation;
    }
    let completedActiveTurn = false;
    const turns = conversation.turns.map((turn) => {
      if (turn.studioAgent) return turn;
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
    if (!turns.some((turn, index) => turn !== conversation.turns[index])) {
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

}

async function backfillConversationVideoAssets(
  items: ImageConversation[],
  expectedSessionKey: string,
  signal?: AbortSignal,
) {
  const requests: Promise<void>[] = [];
  items.forEach((conversation) => conversation.turns.forEach((turn) => turn.images.forEach((image, imageIndex) => {
    const url = String(image.videoUrl || image.url || "").trim();
    const isVideo = image.mediaType === "video" || Boolean(image.videoUrl) || String(image.mimeType || "").startsWith("video/");
    if (!isVideo || image.status !== "success" || !image.taskId || !image.storageKey || !url) return;
    requests.push(ensureGeneratedMediaAsset({
      id: image.taskId,
      status: "success",
      mode: "video",
      model: turn.model,
      visibility: turn.visibility,
      created_at: image.taskCreatedAt || turn.createdAt,
      updated_at: image.taskUpdatedAt || conversation.updatedAt,
    }, {
      type: "video",
      video_url: url,
      url,
      storageKey: image.storageKey,
      storage_key: image.storageKey,
      mime_type: image.mimeType || "video/mp4",
      width: image.width,
      height: image.height,
    }, imageDataIndexForTask(turn.images, imageIndex), {
      assetContext: {
        prompt: turn.prompt,
        source: turn.source === "workflow" ? "工作流" : "生成视频",
        metadata: {
          conversationId: conversation.id,
          turnId: turn.id,
          ...(turn.source === "workflow" ? { workflowId: turn.workflowId, workflowName: turn.workflowName } : {}),
        },
      },
      expectedSessionKey,
      signal,
    }));
  })));
  const results = await Promise.allSettled(requests);
  signal?.throwIfAborted();
  const aborted = results.find((result): result is PromiseRejectedResult => (
    result.status === "rejected" && result.reason instanceof DOMException && result.reason.name === "AbortError"
  ));
  if (aborted) throw aborted.reason;
}

export async function recoverConversationHistory(
  items: ImageConversation[],
  requestOptions: CreationTaskRequestOptions,
  expectedSessionKey: string,
) {
  const changedConversationIds = new Set<string>();
  const normalized = items.map((conversation) => {
    if (isImageConversationHistorySummaryOnly(conversation)) {
      return conversation;
    }
    const turns = conversation.turns.map((turn) => {
      if (turn.studioAgent) return turn;
      let turnChanged = false;
      const recoveredImages = turn.images.map((image, imageIndex) => {
        if (
          image.status === "error" &&
          image.taskId &&
          (image.taskStatus === "queued" || image.taskStatus === "running")
        ) {
          turnChanged = true;
          return {
            ...image,
            status: "loading" as const,
            error: undefined,
          };
        }
        if (image.status === "error" && isMissingBatchImageDataError(image.error)) {
          turnChanged = true;
          return {
            ...image,
            taskId: image.id,
            taskRevision: undefined,
            videoContract: undefined,
            taskStatus: "queued" as const,
            taskProgress: undefined,
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
            taskId: imageTaskIdForImage(turn.id, turn.images, imageIndex),
            taskRevision: undefined,
            videoContract: undefined,
            taskStatus: "queued" as const,
            taskProgress: undefined,
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
            taskId: imageTaskIdForImage(turn.id, turn.images, imageIndex),
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

  const synced = await syncConversationCreationTasks(normalized, requestOptions, expectedSessionKey);
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
