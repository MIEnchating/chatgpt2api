import { createZip, readZip } from "@/lib/zip";
import { deleteStoredMedia, getMediaBlob, uploadMediaBlob, type UploadedFile } from "@/services/file-storage";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import type { CanvasDocument } from "@/services/api/canvas";
import { isCanvasExportFile, type CanvasExportAsset, type CanvasExportFile } from "./canvas-project-transfer-types";

export async function createCanvasProjectArchive(projects: CanvasDocument[]) {
  const zipFiles: { name: string; data: BlobPart }[] = [];
  const exportedProjects = await Promise.all(projects.map(async (project) => {
    const files: CanvasExportAsset[] = [];
    await Promise.all(collectStorageKeys(project).map(async (storageKey) => {
      const blob = await getMediaBlob(storageKey);
      if (!blob) throw new Error(`无法读取画布媒体：${storageKey}`);
      const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type)}`;
      files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
      zipFiles.push({ name: path, data: blob });
    }));
    return { project, files };
  }));

  const data: CanvasExportFile = {
    app: "infinite-canvas",
    version: 3,
    exportedAt: new Date().toISOString(),
    projects: exportedProjects,
  };
  return createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
}

export async function readCanvasProjectArchive(file: Blob, maxProjects = 24) {
  const zip = await readZip(file);
  const projectFile = zip.get("projects.json");
  if (!projectFile) throw new Error("画布压缩包缺少 projects.json");
  const data = JSON.parse(await projectFile.text()) as unknown;
  if (!isCanvasExportFile(data)) throw new Error("画布压缩包格式或版本不受支持");
  if (!data.projects.length || data.projects.length > maxProjects) {
    throw new Error(`压缩包须包含 1-${maxProjects} 个画布项目`);
  }

  const assets = new Map<string, { asset: CanvasExportAsset; blob: Blob }>();
  for (const item of data.projects) {
    for (const asset of item.files) {
      const blob = zip.get(asset.path);
      if (!blob || blob.size !== asset.bytes) throw new Error(`画布媒体缺失或大小不符：${asset.path}`);
      if (!assets.has(asset.storageKey)) assets.set(asset.storageKey, { asset, blob });
    }
    for (const key of collectStorageKeys(item.project)) {
      if (!item.files.some((asset) => asset.storageKey === key)) throw new Error(`压缩包缺少媒体引用：${key}`);
    }
  }
  const uploadedByStorageKey = new Map<string, UploadedFile | UploadedImage>();
  const results = await Promise.allSettled([...assets.values()].map(async ({ asset, blob }) => {
    const typedBlob = blob.slice(0, blob.size, asset.mimeType);
    const uploaded = asset.mimeType.startsWith("image/")
      ? await uploadImage(typedBlob)
      : await uploadMediaBlob(typedBlob, asset.path.split("/").pop() || "imported-media");
    uploadedByStorageKey.set(asset.storageKey, uploaded);
  }));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    try {
      await deleteStoredMedia([...uploadedByStorageKey.values()].map((uploaded) => uploaded.storageKey));
    } catch (cleanupError) {
      throw new AggregateError([failure.reason, cleanupError], "画布导入失败，部分已上传媒体未能清理");
    }
    throw failure.reason;
  }
  const urls = new Map<string, string>();
  for (const { project } of data.projects) collectImportedURLs(project, uploadedByStorageKey, urls);
  return data.projects.map((item) => replaceImportedValue(item.project, uploadedByStorageKey, urls) as CanvasDocument);
}

export function downloadCanvasProjectArchive(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(fileName)}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
  if (typeof value === "string") {
    const key = storageKeyFromContentURL(value);
    if (key) keys.add(key);
    return [...keys];
  }
  if (!value || typeof value !== "object") return [...keys];
  if ("storage_key" in value && typeof value.storage_key === "string" && value.storage_key) keys.add(value.storage_key);
  if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey) keys.add(value.storageKey);
  Object.values(value).forEach((item) => {
    if (Array.isArray(item)) item.forEach((child) => collectStorageKeys(child, keys));
    else collectStorageKeys(item, keys);
  });
  return [...keys];
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return mimeType.startsWith("image/") ? "png" : "bin";
}

function collectImportedURLs(
  value: unknown,
  mapping: ReadonlyMap<string, UploadedFile | UploadedImage>,
  urls: Map<string, string>,
) {
  if (!value || typeof value !== "object") return;
  const source = value as Record<string, unknown>;
  const uploaded = mapping.get(String(source.storage_key || source.storageKey || ""));
  for (const [field, child] of Object.entries(source)) {
    if (uploaded && ["url", "dataUrl", "coverUrl", "thumbnail_url"].includes(field) && typeof child === "string" && child) {
      urls.set(child, uploaded.url);
    }
    collectImportedURLs(child, mapping, urls);
  }
}

function storageKeyFromContentURL(value: string) {
  const match = value.match(/^\/api\/files\/([^/?#]+)\/content(?:[?#].*)?$/);
  if (!match) return "";
  try { return `server:${decodeURIComponent(match[1])}`; } catch { return ""; }
}

function replaceImportedValue(value: unknown, mapping: ReadonlyMap<string, UploadedFile | UploadedImage>, urls: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return urls.get(value) || mapping.get(storageKeyFromContentURL(value))?.url || value;
  if (Array.isArray(value)) return value.map((item) => replaceImportedValue(item, mapping, urls));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const currentKey = typeof source.storage_key === "string"
    ? source.storage_key
    : typeof source.storageKey === "string" ? source.storageKey : "";
  const uploaded = mapping.get(currentKey);
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(source).map(([key, child]) => [key, replaceImportedValue(child, mapping, urls)]));
  if (!uploaded) return result;
  if ("storage_key" in source) result.storage_key = uploaded.storageKey;
  if ("storageKey" in source) result.storageKey = uploaded.storageKey;
  for (const field of ["url", "dataUrl", "coverUrl", "thumbnail_url"] as const) {
    if (typeof source[field] === "string") result[field] = uploaded.url;
  }
  result.bytes = uploaded.bytes;
  if ("mime_type" in source) result.mime_type = uploaded.mimeType;
  if ("mimeType" in source) result.mimeType = uploaded.mimeType;
  return result;
}
