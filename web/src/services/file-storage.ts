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
  const metadata = (uploaded.mimeType || blob.type).startsWith("video/") ? await readVideoMetadata(uploaded.url) : {};
  return { ...uploaded, bytes: uploaded.bytes || blob.size, mimeType: uploaded.mimeType || blob.type || "application/octet-stream", ...metadata };
}

function readVideoMetadata(url: string) {
  return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
    const video = document.createElement("video");
    const done = () => resolve({
      width: video.videoWidth || 1280,
      height: video.videoHeight || 720,
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
    });
    video.onloadedmetadata = done;
    video.onerror = done;
    video.src = url;
  });
}
