import { nanoid } from "nanoid";

import { inspectAudioReferenceFile } from "@/lib/audio-reference-file";
import {
  deleteStorageObjects,
  getStorageObjectBlob,
  resolveStorageObjectURL,
  uploadStorageObject,
} from "@/services/api/storage";

export type UploadedFile = {
  id?: string;
  url: string;
  storageKey: string;
  bytes: number;
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
};

export const VIDEO_METADATA_TIMEOUT_MS = 8_000;

type VideoMetadata = {
  width?: number;
  height?: number;
  durationMs?: number;
};

export type MediaMetadataInspectors = {
  inspectAudio: (blob: Blob) => Promise<{ durationMs?: number }>;
  inspectVideo: (blob: Blob) => Promise<VideoMetadata>;
};

type VideoMetadataElement = Pick<
  HTMLVideoElement,
  | "duration"
  | "load"
  | "onerror"
  | "onloadedmetadata"
  | "preload"
  | "removeAttribute"
  | "src"
  | "videoHeight"
  | "videoWidth"
>;

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

export type VideoMetadataInspectionEnvironment = {
  createVideoElement: () => VideoMetadataElement;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  scheduleTimeout: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearScheduledTimeout: (handle: TimeoutHandle) => void;
};

const browserVideoMetadataInspectionEnvironment: VideoMetadataInspectionEnvironment = {
  createVideoElement: () => document.createElement("video"),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  scheduleTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearScheduledTimeout: (handle) => globalThis.clearTimeout(handle),
};

const browserMediaMetadataInspectors: MediaMetadataInspectors = {
  inspectAudio: (blob) => inspectAudioReferenceFile(blob),
  inspectVideo: (blob) => inspectVideoBlobMetadata(blob),
};

export async function uploadMediaBlob(blob: Blob, filename: string, signal?: AbortSignal): Promise<UploadedFile> {
  signal?.throwIfAborted();
  const uploaded = await uploadStorageObject<UploadedFile>(blob, filename, "媒体同步失败", signal);
  signal?.throwIfAborted();
  const result = await withMediaMetadata(uploaded, blob);
  signal?.throwIfAborted();
  return result;
}

export async function uploadAssetMediaFile(file: File, prefix = "asset-media", signal?: AbortSignal) {
  return uploadMediaBlob(file, file.name || `${prefix}-${nanoid()}`, signal);
}

export async function resolveMediaURL(storageKey?: string, fallback = "") {
  return resolveStorageObjectURL(storageKey, fallback);
}

export async function getMediaBlob(storageKey: string) {
  return getStorageObjectBlob(storageKey);
}

export async function deleteStoredMedia(keys: Iterable<string>) {
  await deleteStorageObjects(keys, "删除服务端媒体失败");
}

async function withMediaMetadata(uploaded: UploadedFile, blob: Blob) {
  const metadata = await inspectMediaBlobMetadata(blob, uploaded.mimeType || blob.type);
  return {
    ...uploaded,
    bytes: uploaded.bytes || blob.size,
    mimeType: uploaded.mimeType || blob.type || "application/octet-stream",
    width: uploaded.width || metadata.width,
    height: uploaded.height || metadata.height,
    durationMs: uploaded.durationMs || metadata.durationMs,
  };
}

export async function inspectMediaBlobMetadata(
  blob: Blob,
  mimeType = blob.type,
  inspectors: MediaMetadataInspectors = browserMediaMetadataInspectors,
): Promise<VideoMetadata> {
  try {
    if (mimeType.startsWith("video/")) return await inspectors.inspectVideo(blob);
    if (mimeType.startsWith("audio/")) {
      const metadata = await inspectors.inspectAudio(blob);
      return metadata.durationMs ? { durationMs: metadata.durationMs } : {};
    }
  } catch {
    // Metadata is optional; a decoder failure must not discard an uploaded file.
  }
  return {};
}

export function inspectVideoBlobMetadata(
  blob: Blob,
  environment: VideoMetadataInspectionEnvironment = browserVideoMetadataInspectionEnvironment,
) {
  return new Promise<VideoMetadata>((resolve) => {
    const video = environment.createVideoElement();
    const url = environment.createObjectURL(blob);
    let timeoutHandle: TimeoutHandle | null = null;
    let settled = false;

    const cleanup = () => {
      if (timeoutHandle !== null) {
        try {
          environment.clearScheduledTimeout(timeoutHandle);
        } catch {
          // Timer cleanup must not change the inspection result.
        }
        timeoutHandle = null;
      }
      video.onloadedmetadata = null;
      video.onerror = null;
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // Cleanup must not leave the metadata promise unsettled.
      }
      try {
        environment.revokeObjectURL(url);
      } catch {
        // Cleanup failures must not keep the upload pending.
      }
    };
    const settle = (metadata: VideoMetadata) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(metadata);
    };

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const width = Number(video.videoWidth);
      const height = Number(video.videoHeight);
      const durationMs = Math.round(Number(video.duration) * 1000);
      settle({
        ...(Number.isFinite(width) && width > 0 ? { width } : {}),
        ...(Number.isFinite(height) && height > 0 ? { height } : {}),
        ...(Number.isFinite(durationMs) && durationMs > 0 ? { durationMs } : {}),
      });
    };
    video.onerror = () => settle({});
    try {
      timeoutHandle = environment.scheduleTimeout(
        () => settle({}),
        VIDEO_METADATA_TIMEOUT_MS,
      );
      video.src = url;
    } catch {
      settle({});
    }
  });
}
