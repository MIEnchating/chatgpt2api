import type { NormalizedVideoRequest } from "@/lib/video-request-normalizer";

/**
 * Converts the provider-normalized request into the fields persisted by the
 * creator queue. The queue must never fall back to pre-normalized form state.
 */
export function videoTurnFieldsFromNormalizedRequest(request: NormalizedVideoRequest) {
  return {
    size: request.size || "",
    videoSeconds: request.seconds,
    videoResolution: request.resolution,
    videoGenerateAudio: request.generateAudio,
    videoWatermark: request.watermark,
    videoReferenceMode: request.referenceMode,
    videoFirstFrameURL: request.firstFrameURL,
    videoLastFrameURL: request.lastFrameURL,
    videoReferenceImageURLs: request.referenceImageURLs,
    videoReferenceVideoURLs: request.referenceVideoURLs,
    videoReferenceAudioURLs: request.referenceAudioURLs,
  };
}
