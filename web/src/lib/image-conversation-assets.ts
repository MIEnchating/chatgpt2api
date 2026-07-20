export const MAX_IMAGE_CONVERSATION_REFERENCE_IMAGES = 4;
export const MAX_IMAGE_CONVERSATION_ASSET_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_IMAGE_CONVERSATION_ASSET_BATCH_BYTES = 80 * 1024 * 1024;
export const IMAGE_CONVERSATION_ASSET_URL_PREFIX = "/conversation-assets/";

export type ImageConversationAssetUploadItem = {
  assetPath: string;
  url: string;
  dataUrl: string;
  name: string;
  type: string;
  size?: number;
};

type SizedUpload = {
  size: number;
  name?: string;
  type?: string;
};

const SUPPORTED_IMAGE_CONVERSATION_ASSET_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SUPPORTED_IMAGE_CONVERSATION_ASSET_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveSize(value: unknown) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
    return undefined;
  }
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : undefined;
}

function assetPathFromURL(value: string) {
  if (!value) {
    return "";
  }
  try {
    const pathname = new URL(value, "http://localhost").pathname;
    if (!pathname.startsWith(IMAGE_CONVERSATION_ASSET_URL_PREFIX)) {
      return "";
    }
    return decodeURIComponent(pathname.slice(IMAGE_CONVERSATION_ASSET_URL_PREFIX.length)).replace(/^\/+/, "");
  } catch {
    return "";
  }
}

function assetURLFromPath(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized ? `${IMAGE_CONVERSATION_ASSET_URL_PREFIX}${normalized}` : "";
}

function mimeTypeFromReference(value: string, fallback: string) {
  const dataURLType = value.match(/^data:([^;,]+)/i)?.[1]?.trim();
  if (dataURLType) {
    return dataURLType;
  }
  const pathname = (() => {
    try {
      return new URL(value, "http://localhost").pathname.toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  })();
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (pathname.endsWith(".webp")) {
    return "image/webp";
  }
  if (pathname.endsWith(".png")) {
    return "image/png";
  }
  return fallback || "image/png";
}

function fileNameFromReference(value: string) {
  if (value.startsWith("data:")) {
    return "";
  }
  try {
    const pathname = new URL(value, "http://localhost").pathname;
    const encodedName = pathname.split("/").filter(Boolean).pop() || "";
    return encodedName ? decodeURIComponent(encodedName) : "";
  } catch {
    return "";
  }
}

export function normalizeImageConversationAssetReference(value: unknown): ImageConversationAssetUploadItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Record<string, unknown>;
  const explicitAssetPath = textValue(source.assetPath) || textValue(source.asset_path);
  const explicitDataURL = textValue(source.dataUrl) || textValue(source.data_url);
  const explicitURL = textValue(source.url);
  const assetPath = explicitAssetPath || assetPathFromURL(explicitURL) || assetPathFromURL(explicitDataURL);
  const managedURL = assetPath ? explicitURL || assetURLFromPath(assetPath) : "";
  const dataUrl = managedURL || explicitDataURL || explicitURL;
  if (!dataUrl) {
    return null;
  }
  const url = textValue(source.url) || (assetPath ? assetURLFromPath(assetPath) : dataUrl);
  const name = textValue(source.name) || fileNameFromReference(dataUrl) || "reference.png";
  const type = mimeTypeFromReference(dataUrl, textValue(source.type));
  const size = positiveSize(source.size);
  return {
    assetPath,
    url: url || dataUrl,
    dataUrl,
    name,
    type,
    ...(size === undefined ? {} : { size }),
  };
}

export function isImageConversationAssetURL(value: string) {
  return assetPathFromURL(textValue(value)) !== "";
}

export function imageConversationReferenceLimitMessage(existingCount: number, incomingCount: number) {
  const existing = Math.max(0, Math.floor(Number(existingCount) || 0));
  const incoming = Math.max(0, Math.floor(Number(incomingCount) || 0));
  if (existing + incoming <= MAX_IMAGE_CONVERSATION_REFERENCE_IMAGES) {
    return "";
  }
  return `最多支持 ${MAX_IMAGE_CONVERSATION_REFERENCE_IMAGES} 张参考图，请先移除多余图片`;
}

export function planImageConversationAssetUploadBatches<T extends SizedUpload>(
  files: readonly T[],
  maxBatchBytes = MAX_IMAGE_CONVERSATION_ASSET_BATCH_BYTES,
) {
  if (!Number.isFinite(maxBatchBytes) || maxBatchBytes <= 0) {
    throw new Error("参考图上传批次大小无效");
  }
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  for (const file of files) {
    const mimeType = textValue(file.type).toLowerCase().split(";", 1)[0];
    const extension = textValue(file.name).toLowerCase().split(/[?#]/, 1)[0].split(".").pop() || "";
    const hasSupportedType = SUPPORTED_IMAGE_CONVERSATION_ASSET_MIME_TYPES.has(mimeType);
    const canUseExtensionFallback = mimeType === "" || mimeType === "application/octet-stream";
    if (!hasSupportedType && (!canUseExtensionFallback || !SUPPORTED_IMAGE_CONVERSATION_ASSET_EXTENSIONS.has(extension))) {
      throw new Error("参考图仅支持 PNG、JPEG 和 WebP 格式");
    }
    const fileBytes = Number(file.size);
    if (!Number.isFinite(fileBytes) || fileBytes < 0) {
      throw new Error("参考图文件大小无效");
    }
    if (fileBytes > MAX_IMAGE_CONVERSATION_ASSET_FILE_BYTES) {
      throw new Error("单张参考图不能超过 40 MiB");
    }
    if (fileBytes > maxBatchBytes) {
      throw new Error("单张参考图超过当前上传批次限制");
    }
    if (batch.length > 0 && batchBytes + fileBytes > maxBatchBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(file);
    batchBytes += fileBytes;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}
