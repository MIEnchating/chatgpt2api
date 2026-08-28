import { useCallback } from "react";

import {
  createVideoGenerationTask,
  type CreationTask,
  type CreationTaskRequestOptions,
} from "@/lib/api";

export type VideoTaskQueueGroup = { taskId: string; count: number };

export type VideoTaskQueueRequest = {
  prompt: string;
  model: string;
  size?: string;
  seconds: number;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  referenceImageURLs?: string[];
  firstFrameURL?: string;
  lastFrameURL?: string;
  referenceVideoURLs?: string[];
  referenceAudioURLs?: string[];
  referenceMode?: "first-frame" | "reference";
  systemPrompt?: string;
  videoMode?: string;
  negativePrompt?: string;
  multiShot?: boolean;
  shotType?: "intelligence" | "customize";
  multiPrompt?: Array<Record<string, unknown>>;
  elementList?: Array<Record<string, unknown>>;
  characterOrientation?: "image" | "video";
  relayTokenName?: string;
  assertDispatchAllowed?: (taskIds: string[]) => void;
};

type VideoTaskQueueResult = {
  submitted: CreationTask[];
  failed: Array<{ group: VideoTaskQueueGroup; error: unknown }>;
};

const wait = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

/** Owns video request fan-out and the one-shot retry policy used by the page queue. */
export function useVideoTaskQueue(options: {
  requestOptions?: CreationTaskRequestOptions;
  assertDispatchAllowed?: (taskIds: string[]) => void;
  isRetryableError?: (error: unknown) => boolean;
}) {
  const submitVideoTaskGroups = useCallback(async (
    groups: VideoTaskQueueGroup[],
    request: VideoTaskQueueRequest,
  ): Promise<VideoTaskQueueResult> => {
    const submit = async (group: VideoTaskQueueGroup) => {
      (request.assertDispatchAllowed || options.assertDispatchAllowed)?.([group.taskId]);
      const create = () => createVideoGenerationTask({
        clientTaskId: group.taskId,
        prompt: request.prompt,
        model: request.model,
        size: request.size,
        seconds: request.seconds,
        resolution: request.resolution,
        generateAudio: request.generateAudio,
        watermark: request.watermark,
        referenceImageURLs: request.referenceImageURLs,
        firstFrameURL: request.firstFrameURL,
        lastFrameURL: request.lastFrameURL,
        referenceVideoURLs: request.referenceVideoURLs,
        referenceAudioURLs: request.referenceAudioURLs,
        referenceMode: request.referenceMode || "first-frame",
        systemPrompt: request.systemPrompt,
        videoMode: request.videoMode,
        negativePrompt: request.negativePrompt,
        multiShot: request.multiShot,
        shotType: request.shotType,
        multiPrompt: request.multiPrompt,
        elementList: request.elementList,
        characterOrientation: request.characterOrientation,
        relayTokenName: request.relayTokenName,
        requestOptions: options.requestOptions,
      });
      try {
        return await create();
      } catch (error) {
        if (!options.isRetryableError?.(error)) throw error;
        await wait(750);
        (request.assertDispatchAllowed || options.assertDispatchAllowed)?.([group.taskId]);
        return create();
      }
    };

    (request.assertDispatchAllowed || options.assertDispatchAllowed)?.(groups.map((group) => group.taskId));
    const results = await Promise.allSettled(groups.map(submit));
    return {
      submitted: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
      failed: results.flatMap((result, index) => result.status === "rejected"
        ? [{ group: groups[index], error: result.reason }]
        : []),
    };
  }, [options]);

  return { submitVideoTaskGroups };
}
