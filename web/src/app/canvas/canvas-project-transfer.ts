import { createZip, readZip } from "@/lib/zip";
import { getMediaBlob, uploadMediaBlob, type UploadedFile } from "@/services/file-storage";
import { getImageBlob, uploadImage, type UploadedImage } from "@/services/image-storage";
import type { CanvasDocument } from "@/services/api/canvas";
import { isCanvasExportFile, type CanvasExportAsset, type CanvasExportFile } from "./canvas-project-transfer-types";

export async function createCanvasProjectArchive(projects: CanvasDocument[]) {
  const zipFiles: { name: string; data: BlobPart }[] = [];
  const exportedProjects = await Promise.all(projects.map(async (project) => {
    const files: CanvasExportAsset[] = [];
    await Promise.all(collectStorageKeys(project).map(async (storageKey) => {
      const blob = await getImageBlob(storageKey) || await getMediaBlob(storageKey);
      if (!blob) return;
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

export async function readCanvasProjectArchive(file: Blob) {
  const zip = await readZip(file);
  const projectFile = zip.get("projects.json");
  if (!projectFile) throw new Error("画布压缩包缺少 projects.json");
  const data = JSON.parse(await projectFile.text()) as unknown;
  if (!isCanvasExportFile(data)) throw new Error("画布压缩包格式或版本不受支持");

  const uploadedByStorageKey = new Map<string, UploadedFile | UploadedImage>();
  await Promise.all(data.projects.flatMap((item) => item.files.map(async (asset) => {
    const blob = zip.get(asset.path);
    if (!blob) throw new Error(`画布压缩包缺少媒体文件：${asset.path}`);
    const typedBlob = blob.slice(0, blob.size, asset.mimeType);
    const uploaded = asset.mimeType.startsWith("image/")
      ? await uploadImage(typedBlob)
      : await uploadMediaBlob(typedBlob, asset.path.split("/").pop() || "imported-media");
    uploadedByStorageKey.set(asset.storageKey, uploaded);
  })));
  return data.projects.map((item) => replaceImportedStorageReferences(item.project, uploadedByStorageKey));
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

function replaceImportedStorageReferences(
  value: CanvasDocument,
  mapping: ReadonlyMap<string, UploadedFile | UploadedImage>,
): CanvasDocument {
  return replaceImportedValue(value, mapping) as CanvasDocument;
}

function replaceImportedValue(value: unknown, mapping: ReadonlyMap<string, UploadedFile | UploadedImage>): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceImportedValue(item, mapping));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const currentKey = typeof source.storage_key === "string"
    ? source.storage_key
    : typeof source.storageKey === "string" ? source.storageKey : "";
  const uploaded = mapping.get(currentKey);
  const result: Record<string, unknown> = {};
  Object.entries(source).forEach(([key, child]) => {
    result[key] = replaceImportedValue(child, mapping);
  });
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
