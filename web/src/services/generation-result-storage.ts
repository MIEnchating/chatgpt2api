import type { CreationTask, CreationTaskData } from "@/lib/api";
import { isManagedImageURL } from "@/lib/authenticated-image";
import { upsertMyAsset, type MyAsset } from "@/lib/my-assets";
import { uploadAssetMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";

type StoredCreationTaskData = CreationTaskData & {
  storageKey?: string;
  storage_key?: string;
};

export type CreationTaskAssetContext = {
  prompt?: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type CreationTaskOutputPersistenceFailure = {
  error: unknown;
  index: number;
  kind: "image" | "video" | "audio";
  taskId: string;
};

const registeredGeneratedAssetIDs = new Set<string>();
const generatedAssetRequests = new Map<string, Promise<void>>();
const MAX_REGISTERED_GENERATED_ASSETS = 512;

function rememberGeneratedAssetRegistration(key: string) {
  registeredGeneratedAssetIDs.add(key);
  while (registeredGeneratedAssetIDs.size > MAX_REGISTERED_GENERATED_ASSETS) {
    const oldestKey = registeredGeneratedAssetIDs.values().next().value;
    if (typeof oldestKey !== "string") break;
    registeredGeneratedAssetIDs.delete(oldestKey);
  }
}

export async function persistCreationTaskOutputs(
  task: CreationTask,
  options: {
    assetContext?: CreationTaskAssetContext;
    onError?: (failure: CreationTaskOutputPersistenceFailure) => void;
  } = {},
): Promise<CreationTask> {
  if (!isTerminalTask(task) || !task.data?.length) return task;

  const data = await Promise.all(task.data.map(async (item, index) => {
    if (!shouldPersistTaskItem(task, item, index)) return item;
    const stored = item as StoredCreationTaskData;
    const kind = taskItemKind(task, item);
    try {
      let persistedItem = item;
      if (kind === "image") {
        if (stored.storageKey || stored.storage_key) return item;
        const source = taskItemImageSource(item);
        if (!source) return item;
        if (isManagedImageURL(source)) return item;
        const uploaded = await uploadImage(source);
        persistedItem = {
          ...item,
          url: uploaded.url,
          storageKey: uploaded.storageKey,
          storage_key: uploaded.storageKey,
          width: uploaded.width || item.width,
          height: uploaded.height || item.height,
          bytes: uploaded.bytes || item.bytes,
          mime_type: uploaded.mimeType || item.mime_type,
        };
      } else if (!(stored.storageKey || stored.storage_key)) {
        const source = String(kind === "video" ? item.video_url || item.url || "" : item.audio_url || item.url || "").trim();
        if (!source) return item;
        const response = await fetch(source, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`${kind === "video" ? "视频" : "音频"}结果下载失败：${response.status}`);
        const blob = await response.blob();
        const filename = `generated-${kind}-${task.id}-${index + 1}.${mediaExtension(blob.type || item.mime_type, kind)}`;
        const uploaded = await uploadAssetMediaFile(new File([blob], filename, { type: blob.type || item.mime_type || defaultMediaType(kind) }), `generated-${kind}`);
        persistedItem = {
          ...item,
          url: uploaded.url,
          ...(kind === "video" ? { video_url: uploaded.url } : { audio_url: uploaded.url }),
          storageKey: uploaded.storageKey,
          storage_key: uploaded.storageKey,
          bytes: uploaded.bytes || item.bytes || item.size,
          mime_type: uploaded.mimeType || item.mime_type || defaultMediaType(kind),
          width: uploaded.width || item.width,
          height: uploaded.height || item.height,
          duration_ms: uploaded.durationMs || item.duration_ms,
        };
      }
      if ((kind === "video" || kind === "audio") && storageKeyOf(persistedItem)) {
        await ensureGeneratedMediaAsset(task, persistedItem, index, options.assetContext);
      }
      return persistedItem;
    } catch (error) {
      options.onError?.({ error, index, kind, taskId: task.id });
      return item;
    }
  }));

  return data.some((item, index) => item !== task.data?.[index]) ? { ...task, data } : task;
}

export async function ensureGeneratedMediaAsset(
  task: CreationTask,
  item: CreationTaskData,
  index: number,
  context: CreationTaskAssetContext = {},
) {
  const asset = generatedMediaAsset(task, item, index, context);
  if (!asset) return;
  const registrationKey = `${asset.id}:${asset.storageKey || ""}`;
  if (registeredGeneratedAssetIDs.has(registrationKey)) return;
  let request = generatedAssetRequests.get(registrationKey);
  if (!request) {
    request = upsertMyAsset(asset).then(() => {
      rememberGeneratedAssetRegistration(registrationKey);
    }).finally(() => generatedAssetRequests.delete(registrationKey));
    generatedAssetRequests.set(registrationKey, request);
  }
  await request;
}

export function generatedMediaAsset(
  task: CreationTask,
  item: CreationTaskData,
  index: number,
  context: CreationTaskAssetContext = {},
): MyAsset | null {
  const kind = taskItemKind(task, item);
  if (kind !== "video" && kind !== "audio") return null;
  const url = String(kind === "video" ? item.video_url || item.url || "" : item.audio_url || item.url || "").trim();
  const storageKey = storageKeyOf(item);
  if (!url || !storageKey) return null;
  const prompt = String(context.prompt || "").trim();
  const workflowContext = task.workflow_context && typeof task.workflow_context === "object"
    ? task.workflow_context as Record<string, unknown>
    : {};
  const generatedLabel = kind === "video" ? "生成视频" : "生成音频";
  const source = String(context.source || (Object.keys(workflowContext).length ? "工作流" : generatedLabel)).trim();
  const createdAt = validTaskDate(task.created_at);
  const updatedAt = validTaskDate(task.updated_at) || createdAt;
  return {
    id: `generated-${kind}:${task.id}:${index}`,
    kind,
    title: promptTitle(prompt, generatedLabel),
    url,
    storageKey,
    mimeType: item.mime_type || defaultMediaType(kind),
    ...(positiveNumber(item.bytes || item.size) ? { bytes: positiveNumber(item.bytes || item.size) } : {}),
    ...(positiveNumber(item.width) ? { width: positiveNumber(item.width) } : {}),
    ...(positiveNumber(item.height) ? { height: positiveNumber(item.height) } : {}),
    ...(positiveNumber(item.duration_ms) ? { durationMs: positiveNumber(item.duration_ms) } : {}),
    tags: [],
    visibility: task.visibility === "public" ? "public" : "private",
    source,
    metadata: {
      ...context.metadata,
      ...(prompt ? { prompt } : {}),
      taskId: task.id,
      outputIndex: index,
      ...(task.model ? { model: task.model } : {}),
    },
    createdAt,
    updatedAt,
  };
}

function storageKeyOf(item: CreationTaskData) {
  return String(item.storageKey || item.storage_key || "").trim();
}

function promptTitle(prompt: string, fallback: string) {
  if (!prompt) return fallback;
  return prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt;
}

function validTaskDate(value: string | undefined) {
  return value && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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
