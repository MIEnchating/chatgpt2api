import type { CreationTask, CreationTaskData } from "@/lib/api";
import { isManagedImageURL } from "@/lib/authenticated-image";
import { uploadAssetMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";

type StoredCreationTaskData = CreationTaskData & {
  storageKey?: string;
  storage_key?: string;
};

export async function persistCreationTaskOutputs(task: CreationTask): Promise<CreationTask> {
  if (!isTerminalTask(task) || !task.data?.length) return task;

  const data = await Promise.all(task.data.map(async (item, index) => {
    if (!shouldPersistTaskItem(task, item, index)) return item;
    const stored = item as StoredCreationTaskData;
    if (stored.storageKey || stored.storage_key) return item;

    const kind = taskItemKind(task, item);
    if (kind === "image") {
      const source = taskItemImageSource(item);
      if (!source) return item;
      if (isManagedImageURL(source)) return item;
      const uploaded = await uploadImage(source);
      return {
        ...item,
        url: uploaded.url,
        storageKey: uploaded.storageKey,
        storage_key: uploaded.storageKey,
        width: uploaded.width || item.width,
        height: uploaded.height || item.height,
        bytes: uploaded.bytes || item.bytes,
        mime_type: uploaded.mimeType || item.mime_type,
      };
    }

    const source = String(kind === "video" ? item.video_url || item.url || "" : item.audio_url || item.url || "").trim();
    if (!source) return item;
    const response = await fetch(source, { credentials: "include" });
    if (!response.ok) throw new Error(`${kind === "video" ? "视频" : "音频"}结果下载失败：${response.status}`);
    const blob = await response.blob();
    const filename = `generated-${kind}-${task.id}-${index + 1}.${mediaExtension(blob.type || item.mime_type, kind)}`;
    const uploaded = await uploadAssetMediaFile(new File([blob], filename, { type: blob.type || item.mime_type || defaultMediaType(kind) }), `generated-${kind}`);
    return {
      ...item,
      url: uploaded.url,
      ...(kind === "video" ? { video_url: uploaded.url } : { audio_url: uploaded.url }),
      storageKey: uploaded.storageKey,
      storage_key: uploaded.storageKey,
      bytes: uploaded.bytes || item.bytes || item.size,
      mime_type: uploaded.mimeType || item.mime_type || defaultMediaType(kind),
      width: uploaded.width || item.width,
      height: uploaded.height || item.height,
    };
  }));

  return data.some((item, index) => item !== task.data?.[index]) ? { ...task, data } : task;
}

function isTerminalTask(task: CreationTask) {
  return task.status === "success" || task.status === "error" || task.status === "cancelled";
}

function shouldPersistTaskItem(task: CreationTask, item: CreationTaskData, index: number) {
  const status = task.output_statuses?.[index];
  if (status && status !== "success") return false;
  if (!status && task.status !== "success") return false;
  return Boolean(item.url || item.video_url || item.audio_url || item.b64_json);
}

function taskItemKind(task: CreationTask, item: CreationTaskData): "image" | "video" | "audio" {
  const type = String(item.type || task.output_type || "").toLowerCase();
  const mimeType = String(item.mime_type || "").toLowerCase();
  if (type === "video" || item.video_url || mimeType.startsWith("video/")) return "video";
  if (type === "audio" || item.audio_url || mimeType.startsWith("audio/")) return "audio";
  return "image";
}

function taskItemImageSource(item: CreationTaskData) {
  const url = String(item.url || "").trim();
  if (url) return url;
  const base64 = String(item.b64_json || "").trim();
  if (!base64) return "";
  const mimeType = item.mime_type?.startsWith("image/") ? item.mime_type : "image/png";
  return `data:${mimeType};base64,${base64}`;
}

function mediaExtension(mimeType: string | undefined, kind: "video" | "audio") {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("aac")) return "aac";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  return kind === "video" ? "mp4" : "mp3";
}

function defaultMediaType(kind: "video" | "audio") {
  return kind === "video" ? "video/mp4" : "audio/mpeg";
}
