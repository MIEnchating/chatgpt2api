import {
  cancelCreationTask,
  createImageEditTask,
  createImageGenerationTask,
  createVideoGenerationTask,
  fetchCreationTasks,
  type CreationTask,
  type CreationTaskRequestOptions,
  type ImageRequestQuality,
} from "@/lib/api";
import { isRetryableTaskPollError } from "@/lib/generation-task-contract";
import type { ImageTurn } from "@/lib/image-conversation-types";
import { imageTurnUsesReferenceImages } from "@/lib/image-turn-validation";

type StudioTaskGroup = { taskId: string; count: number };

export type StudioTaskSubmissionFailure = { group: StudioTaskGroup; error: unknown };

type StudioImageRequest = {
  referenceFiles: File[];
  size?: string;
  requestedSize?: string;
  imageResolution?: string;
  quality: ImageRequestQuality;
  outputFormat: ImageTurn["outputFormat"];
  outputCompression: ImageTurn["outputCompression"];
  stream: boolean;
  partialImages: number;
  responseFormatB64JSON: boolean;
  codexCLICompatibility: boolean;
  systemPrompt: string;
};

export class ImageTaskDispatchAbortedError extends Error {
  constructor() {
    super("生成任务提交已取消");
    this.name = "ImageTaskDispatchAbortedError";
  }
}

export function createStudioTaskSubmitter({
  turn,
  image,
  videoReferenceURLs,
  requestOptions,
  assertDispatchAllowed,
  isSessionCurrent,
}: {
  turn: ImageTurn;
  image: StudioImageRequest;
  videoReferenceURLs: string[];
  requestOptions: CreationTaskRequestOptions;
  assertDispatchAllowed: (taskIds: string[]) => void;
  isSessionCurrent: () => boolean;
}) {
  const relayTokenName = turn.tokenName?.trim() || undefined;
  const relayTokenGroup = turn.tokenGroup?.trim() || undefined;
  const usesReferenceImages = imageTurnUsesReferenceImages(turn.mode);
  const trackedVideos = new Set<string>();
  if (turn.mode === "video") {
    for (const result of turn.images) {
      if (result.taskId && (Number(result.taskRevision) > 0 || result.taskCreatedAt)) {
        trackedVideos.add(result.taskId);
      }
    }
  }

  const createTask = ({ taskId, count }: StudioTaskGroup) => {
    if (turn.mode === "video") {
      return createVideoGenerationTask({
        clientTaskId: taskId,
        prompt: turn.prompt,
        model: turn.model,
        size: turn.size || undefined,
        seconds: turn.videoSeconds ?? 4,
        parameters: turn.videoParameters,
        resolution: turn.videoResolution || undefined,
        generateAudio: turn.videoGenerateAudio ?? false,
        watermark: turn.videoWatermark ?? false,
        referenceImageURLs: videoReferenceURLs,
        firstFrameURL: turn.videoFirstFrameURL,
        lastFrameURL: turn.videoLastFrameURL,
        referenceVideoURLs: turn.videoReferenceVideoURLs,
        referenceAudioURLs: turn.videoReferenceAudioURLs,
        referenceMode: turn.videoReferenceMode || "first-frame",
        systemPrompt: turn.videoSystemPrompt,
        relayTokenName,
        requestOptions,
      });
    }
    const args = [
      turn.promptContext?.preparedPrompt || turn.prompt,
      turn.model,
      image.size,
      image.requestedSize,
      image.quality,
      count,
      turn.visibility || "private",
      image.imageResolution,
      image.outputFormat,
      image.outputCompression,
      image.stream,
      image.partialImages,
      {
        imageOptions: turn.imageOptions,
        apiMode: turn.apiMode,
        responseFormatB64JSON: turn.responseFormatB64JSON ?? image.responseFormatB64JSON,
        codexCLICompatibility: turn.codexCLICompatibility ?? image.codexCLICompatibility,
        systemPrompt: turn.imageSystemPrompt ?? image.systemPrompt,
      },
      relayTokenGroup,
      relayTokenName,
      undefined,
      undefined,
      requestOptions,
    ] satisfies Parameters<typeof createImageGenerationTask> extends [string, ...infer Args] ? Args : never;
    return usesReferenceImages
      ? createImageEditTask(taskId, image.referenceFiles, ...args)
      : createImageGenerationTask(taskId, ...args);
  };

  return async (groups: StudioTaskGroup[]) => {
    const taskIds = groups.map(({ taskId }) => taskId);
    assertDispatchAllowed(taskIds);
    const trackedIds = taskIds.filter((taskId) => trackedVideos.has(taskId));
    const trackedTasks = trackedIds.length > 0
      ? fetchCreationTasks(trackedIds, requestOptions).then(({ items }) => new Map(items.map((task) => [task.id, task])))
      : undefined;
    const results = await Promise.allSettled(groups.map(async (group) => {
      if (trackedTasks && trackedVideos.has(group.taskId)) {
        const task = (await trackedTasks).get(group.taskId);
        if (!task) {
          throw new Error("原视频任务记录暂时不可用，请稍后同步");
        }
        return task;
      }
      try {
        return await createTask(group);
      } catch (error) {
        if (!isRetryableTaskPollError(error)) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
        assertDispatchAllowed([group.taskId]);
        return createTask(group);
      }
    }));

    try {
      assertDispatchAllowed(taskIds);
    } catch (error) {
      if (!(error instanceof ImageTaskDispatchAbortedError)) throw error;
      const uniqueIds = Array.from(new Set(taskIds));
      // A task may reach the server after the first cancellation request.
      if (isSessionCurrent()) {
        await Promise.allSettled(uniqueIds.map((id) => cancelCreationTask(id, requestOptions)));
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        if (isSessionCurrent()) {
          await Promise.allSettled(uniqueIds.map((id) => cancelCreationTask(id, requestOptions)));
        }
      }
      throw error;
    }

    const submitted: CreationTask[] = [];
    const failed: StudioTaskSubmissionFailure[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") submitted.push(result.value);
      else failed.push({ group: groups[index], error: result.reason });
    }
    return { submitted, failed };
  };
}
