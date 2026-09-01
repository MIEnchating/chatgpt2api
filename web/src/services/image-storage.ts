import { nanoid } from "nanoid";

import {
  deleteStorageObjects,
  getStorageObjectBlob,
  resolveStorageObjectURL,
  uploadStorageObject,
} from "@/services/api/storage";

export type UploadedImage = {
  id?: string;
  url: string;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
};

export const IMAGE_METADATA_TIMEOUT_MS = 8_000;

type ImageMetadata = {
  width: number;
  height: number;
};

type ImageBitmapMetadata = Pick<ImageBitmap, "close" | "height" | "width">;

type ImageMetadataElement = Pick<
  HTMLImageElement,
  "naturalHeight" | "naturalWidth" | "onerror" | "onload" | "removeAttribute" | "src"
>;

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

export type ImageMetadataInspectionEnvironment = {
  createImageBitmap?: (blob: Blob) => Promise<ImageBitmapMetadata>;
  createImageElement: () => ImageMetadataElement;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  scheduleTimeout: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearScheduledTimeout: (handle: TimeoutHandle) => void;
};

export type ImageUploadEnvironment = {
  inspectMetadata: (blob: Blob) => Promise<ImageMetadata>;
  uploadObject: (blob: Blob, filename: string, fallbackMessage: string) => Promise<UploadedImage>;
};

const browserImageMetadataInspectionEnvironment: ImageMetadataInspectionEnvironment = {
  createImageBitmap: typeof globalThis.createImageBitmap === "function"
    ? (blob) => globalThis.createImageBitmap(blob)
    : undefined,
  createImageElement: () => new Image(),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  scheduleTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearScheduledTimeout: (handle) => globalThis.clearTimeout(handle),
};

const browserImageUploadEnvironment: ImageUploadEnvironment = {
  inspectMetadata: (blob) => inspectImageBlobMetadata(blob),
  uploadObject: (blob, filename, fallbackMessage) => uploadStorageObject<UploadedImage>(blob, filename, fallbackMessage),
};

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
  const blob = typeof input === "string" ? await downloadImage(input) : input;
  return uploadImageToServer(blob, `image-${nanoid()}.${imageExtension(blob.type)}`);
}

export async function resolveImageURL(storageKey?: string, fallback = "") {
  return resolveStorageObjectURL(storageKey, fallback);
}

export async function getImageBlob(storageKey: string) {
  return getStorageObjectBlob(storageKey);
}

export async function deleteStoredImages(keys: Iterable<string>) {
  await deleteStorageObjects(keys, "删除服务端图片失败");
}

export async function imageToDataURL(image: { url?: string; storageKey?: string }) {
  const source = image.storageKey ? await resolveImageURL(image.storageKey, image.url || "") : image.url || "";
  if (!source) return "";
  if (source.startsWith("data:")) return source;
  const response = await fetch(source, { credentials: "include" });
  if (!response.ok) throw new Error(`读取图片失败：${response.status}`);
  return blobToDataURL(await response.blob());
}

export async function uploadImageToServer(
  blob: Blob,
  filename: string,
  environment: ImageUploadEnvironment = browserImageUploadEnvironment,
): Promise<UploadedImage> {
  const metadata = await environment.inspectMetadata(blob);
  const uploaded = await environment.uploadObject(blob, filename, "服务端图片上传失败");
  return {
    ...uploaded,
    width: uploaded.width || metadata.width,
    height: uploaded.height || metadata.height,
    bytes: uploaded.bytes || blob.size,
    mimeType: uploaded.mimeType || blob.type || "image/png",
  };
}

async function downloadImage(url: string) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("下载内容不是图片");
  return blob;
}

export async function inspectImageBlobMetadata(
  blob: Blob,
  environment: ImageMetadataInspectionEnvironment = browserImageMetadataInspectionEnvironment,
) {
  if (environment.createImageBitmap) {
    const metadata = await inspectImageBitmapMetadata(blob, environment).catch(() => null);
    if (metadata) return metadata;
  }
  return inspectImageElementMetadata(blob, environment);
}

function inspectImageBitmapMetadata(
  blob: Blob,
  environment: ImageMetadataInspectionEnvironment,
) {
  return new Promise<ImageMetadata>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: TimeoutHandle | null = null;

    const settle = (metadata?: ImageMetadata, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) {
        try {
          environment.clearScheduledTimeout(timeoutHandle);
        } catch {
          // Timer cleanup must not change the inspection result.
        }
        timeoutHandle = null;
      }
      if (metadata) resolve(metadata);
      else reject(error instanceof Error ? error : new Error("读取图片尺寸失败"));
    };

    timeoutHandle = environment.scheduleTimeout(() => {
      settle(undefined, new Error("读取图片尺寸超时"));
    }, IMAGE_METADATA_TIMEOUT_MS);
    Promise.resolve()
      .then(() => environment.createImageBitmap?.(blob))
      .then((bitmap) => {
        if (!bitmap) {
          settle(undefined, new Error("读取图片尺寸失败"));
          return;
        }
        let metadata: ImageMetadata | null = null;
        try {
          metadata = imageMetadata(bitmap.width, bitmap.height);
        } catch (error) {
          settle(undefined, error);
        } finally {
          try {
            bitmap.close();
          } catch {
            // Releasing a decoded bitmap must not change the inspection result.
          }
        }
        if (settled) return;
        if (metadata) {
          settle(metadata);
        } else {
          settle(undefined, new Error("读取图片尺寸失败"));
        }
      }, (error) => settle(undefined, error));
  });
}

function inspectImageElementMetadata(
  blob: Blob,
  environment: ImageMetadataInspectionEnvironment,
) {
  const image = environment.createImageElement();
  const url = environment.createObjectURL(blob);
  return new Promise<ImageMetadata>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: TimeoutHandle | null = null;

    const cleanup = () => {
      if (timeoutHandle !== null) {
        try {
          environment.clearScheduledTimeout(timeoutHandle);
        } catch {
          // Timer cleanup must not change the inspection result.
        }
        timeoutHandle = null;
      }
      image.onload = null;
      image.onerror = null;
      try {
        image.removeAttribute("src");
      } catch {
        // A detached image can already be unavailable during cleanup.
      }
      try {
        environment.revokeObjectURL(url);
      } catch {
        // URL cleanup failures must not leave metadata inspection pending.
      }
    };
    const settle = (metadata?: ImageMetadata, error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (metadata) resolve(metadata);
      else reject(error instanceof Error ? error : new Error("读取图片尺寸失败"));
    };

    image.onload = () => settle(imageMetadata(image.naturalWidth, image.naturalHeight) || undefined);
    image.onerror = () => settle(undefined, new Error("读取图片尺寸失败"));
    try {
      timeoutHandle = environment.scheduleTimeout(
        () => settle(undefined, new Error("读取图片尺寸超时")),
        IMAGE_METADATA_TIMEOUT_MS,
      );
      image.src = url;
    } catch (error) {
      settle(undefined, error);
    }
  });
}

function imageMetadata(widthValue: unknown, heightValue: unknown): ImageMetadata | null {
  const width = Number(widthValue);
  const height = Number(heightValue);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width, height }
    : null;
}

function imageExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function blobToDataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}
