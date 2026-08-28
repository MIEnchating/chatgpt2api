import { fetchAuthenticatedImageBlob, shouldUseAuthenticatedImageFallback } from "@/lib/authenticated-image";
import type { MyAsset, MyAssetKind } from "@/lib/my-assets";
import { resolveMediaURL } from "@/services/file-storage";
import { resolveImageURL } from "@/services/image-storage";

export type AssetMediaMetadata = Pick<MyAsset, "bytes" | "mimeType" | "width" | "height" | "durationMs">;

export async function inspectAssetFile(file: File, kind: Exclude<MyAssetKind, "text">): Promise<AssetMediaMetadata> {
  const base = { bytes: file.size, mimeType: file.type || fallbackMimeType(kind) };
  if (kind === "image") {
    try {
      const bitmap = await createImageBitmap(file);
      const result = { ...base, width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return result;
    } catch {
      return base;
    }
  }

  const objectURL = URL.createObjectURL(file);
  try {
    const media = document.createElement(kind === "video" ? "video" : "audio");
    media.preload = "metadata";
    media.src = objectURL;
    await waitForMetadata(media);
    return {
      ...base,
      ...(kind === "video" && media instanceof HTMLVideoElement && media.videoWidth > 0
        ? { width: media.videoWidth, height: media.videoHeight }
        : {}),
      ...(Number.isFinite(media.duration) && media.duration > 0 ? { durationMs: Math.round(media.duration * 1000) } : {}),
    };
  } catch {
    return base;
  } finally {
    URL.revokeObjectURL(objectURL);
  }
}

function formatAssetBytes(value?: number) {
  if (!value || value < 1) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatAssetDuration(value?: number) {
  if (!value || value < 1) return "";
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds} 秒`;
}

export function assetMediaSummary(asset: MyAsset) {
  if (asset.kind === "text") return asset.content || "暂无文本内容";
  return [asset.width && asset.height ? `${asset.width} × ${asset.height}` : "", formatAssetDuration(asset.durationMs), formatAssetBytes(asset.bytes), asset.mimeType || ""]
    .filter(Boolean)
    .join(" · ") || asset.url || "暂无媒体信息";
}

export async function downloadMyAsset(asset: MyAsset) {
  if (asset.kind === "text") {
    const objectURL = URL.createObjectURL(new Blob([asset.content || ""], { type: "text/plain;charset=utf-8" }));
    triggerAssetDownload(objectURL, `${safeFileName(asset.title || "asset")}.txt`);
    window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
    return;
  }
  if (!asset.url) return;
  const resolvedURL = asset.storageKey
    ? asset.kind === "image"
      ? await resolveImageURL(asset.storageKey, asset.url)
      : await resolveMediaURL(asset.storageKey, asset.url)
    : asset.url;
  let href = resolvedURL;
  let objectURL = "";
  try {
    const blob = asset.kind === "image" && shouldUseAuthenticatedImageFallback(resolvedURL)
      ? await fetchAuthenticatedImageBlob(resolvedURL)
      : await fetch(resolvedURL, { credentials: "include" }).then((response) => response.ok ? response.blob() : null);
    if (blob) {
      objectURL = URL.createObjectURL(blob);
      href = objectURL;
    }
  } catch {
    href = resolvedURL;
  }
  triggerAssetDownload(href, `${safeFileName(asset.title || "asset")}.${assetExtension(asset)}`);
  if (objectURL) window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
}

function triggerAssetDownload(href: string, fileName: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function waitForMetadata(media: HTMLMediaElement) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("metadata timeout")), 8000);
    media.onloadedmetadata = () => { window.clearTimeout(timer); resolve(); };
    media.onerror = () => { window.clearTimeout(timer); reject(new Error("metadata unavailable")); };
  });
}

function fallbackMimeType(kind: Exclude<MyAssetKind, "text">) {
  return kind === "image" ? "image/*" : kind === "video" ? "video/mp4" : "audio/mpeg";
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "asset";
}

function assetExtension(asset: MyAsset) {
  const mime = String(asset.mimeType || "").toLowerCase();
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg")) return "mp3";
  const pathExtension = asset.url?.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1];
  return pathExtension || (asset.kind === "image" ? "png" : asset.kind === "video" ? "mp4" : "mp3");
}
