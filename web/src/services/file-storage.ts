import { nanoid } from "nanoid";

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

export async function uploadMediaBlob(blob: Blob, filename: string): Promise<UploadedFile> {
  const uploaded = await uploadStorageObject<UploadedFile>(blob, filename, "媒体同步失败");
  return withMediaMetadata(uploaded, blob);
}

export async function uploadAssetMediaFile(file: File, prefix = "asset-media") {
  return uploadMediaBlob(file, file.name || `${prefix}-${nanoid()}`);
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
  const metadata: VideoMetadata = (uploaded.mimeType || blob.type).startsWith("video/")
    ? await inspectVideoBlobMetadata(blob)
    : {};
  return {
    ...uploaded,
    bytes: uploaded.bytes || blob.size,
    mimeType: uploaded.mimeType || blob.type || "application/octet-stream",
    width: uploaded.width || metadata.width,
    height: uploaded.height || metadata.height,
    durationMs: uploaded.durationMs || metadata.durationMs,
  };
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
        environment.clearScheduledTimeout(timeoutHandle);
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
    timeoutHandle = environment.scheduleTimeout(
      () => settle({}),
      VIDEO_METADATA_TIMEOUT_MS,
    );
    try {
      video.src = url;
    } catch {
      settle({});
    }
  });
}
