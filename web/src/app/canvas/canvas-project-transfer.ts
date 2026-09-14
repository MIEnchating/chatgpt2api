import { createZip, readZip } from "@/lib/zip";
import { deleteStoredMedia, getMediaBlob, uploadMediaBlob, type UploadedFile } from "@/services/file-storage";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import type { CanvasDocument } from "@/services/api/canvas";
import { isCanvasExportFile, type CanvasExportAsset, type CanvasExportFile } from "./canvas-project-transfer-types";

export async function createCanvasProjectArchive(projects: CanvasDocument[]) {
  const projectKeys = projects.map((project) => collectStorageKeys(project));
  const storageKeys = [...new Set(projectKeys.flat())];
  const filesByKey = new Map<string, CanvasExportAsset>();
  const results = await settleCanvasMedia(storageKeys, async (storageKey, index) => {
    const blob = await getMediaBlob(storageKey);
    if (!blob) throw new Error(`无法读取画布媒体：${storageKey}`);
    const path = `files/${index}.${fileExtension(blob.type)}`;
    filesByKey.set(storageKey, { storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
    return { name: path, data: blob };
  });
  const zipFiles = results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  const exportedProjects = projects.map((project, index) => ({
    project,
    files: projectKeys[index].map((key) => filesByKey.get(key)!),
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
    const referencedKeys = new Set<string>();
    for (const asset of item.files) {
      const blob = zip.get(asset.path);
      if (!blob || blob.size !== asset.bytes) throw new Error(`画布媒体缺失或大小不符：${asset.path}`);
      const existing = assets.get(asset.storageKey);
      if (existing && (existing.asset.mimeType !== asset.mimeType || existing.asset.bytes !== asset.bytes)) {
        throw new Error(`压缩包包含冲突的媒体引用：${asset.storageKey}`);
      }
      if (existing && existing.asset.path !== asset.path) {
        const previous = new Uint8Array(await existing.blob.arrayBuffer());
        const current = new Uint8Array(await blob.arrayBuffer());
        if (previous.some((byte, index) => byte !== current[index])) throw new Error(`压缩包包含冲突的媒体引用：${asset.storageKey}`);
      }
      if (!assets.has(asset.storageKey)) assets.set(asset.storageKey, { asset, blob });
      referencedKeys.add(asset.storageKey);
    }
    for (const key of collectStorageKeys(item.project)) {
      if (!referencedKeys.has(key)) throw new Error(`压缩包缺少媒体引用：${key}`);
    }
  }
  const uploadedByStorageKey = new Map<string, UploadedFile | UploadedImage>();
  const results = await settleCanvasMedia([...assets.values()], async ({ asset, blob }) => {
    const typedBlob = blob.slice(0, blob.size, asset.mimeType);
    const uploaded = asset.mimeType.startsWith("image/")
      ? await uploadImage(typedBlob)
      : await uploadMediaBlob(typedBlob, asset.path.split("/").pop() || "imported-media");
    uploadedByStorageKey.set(asset.storageKey, uploaded);
  });
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function collectStorageKeys(value: unknown) {
  const keys = new Set<string>();
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string") {
      const key = storageKeyFromContentURL(current);
      if (key) keys.add(key);
    } else if (current && typeof current === "object") {
      if ("storage_key" in current && typeof current.storage_key === "string" && current.storage_key) keys.add(current.storage_key);
      if ("storageKey" in current && typeof current.storageKey === "string" && current.storageKey) keys.add(current.storageKey);
      for (const child of Object.values(current)) pending.push(child);
    }
  }
  return [...keys];
}

async function settleCanvasMedia<T, R>(items: readonly T[], run: (item: T, index: number) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = [];
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try { results[index] = { status: "fulfilled", value: await run(items[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
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
    if (uploaded && ["url", "dataUrl"].includes(field) && typeof child === "string" && child) {
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
  if (typeof value === "string") return mapping.get(storageKeyFromContentURL(value))?.url || urls.get(value) || value;
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
  for (const field of ["url", "dataUrl"] as const) {
    if (typeof source[field] === "string") result[field] = uploaded.url;
  }
  result.bytes = uploaded.bytes;
  if ("mime_type" in source) result.mime_type = uploaded.mimeType;
  if ("mimeType" in source) result.mimeType = uploaded.mimeType;
  return result;
}
