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

async function uploadImageToServer(
  blob: Blob,
  filename: string,
): Promise<UploadedImage> {
  const uploaded = await uploadStorageObject<UploadedImage>(blob, filename, "服务端图片上传失败");
  const metadata = await readImageMetadata(blob);
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

async function readImageMetadata(blob: Blob) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    const metadata = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return metadata;
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("读取图片尺寸失败"));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
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
