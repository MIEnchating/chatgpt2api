import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";
import { getManagedImageUrlFromPath } from "@/lib/image-path";
import { resolveStorageObjectURL } from "@/services/api/storage";
import type { StoredImage } from "@/lib/image-conversation-types";

export async function fetchStoredMedia(image: StoredImage, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const fallback = image.videoUrl || (image.b64_json
    ? `data:image/${image.outputFormat || "png"};base64,${image.b64_json}`
    : (image.path ? getManagedImageUrlFromPath(image.path) : "") || image.url || "");
  const url = await resolveStorageObjectURL(image.storageKey, fallback, signal);
  if (!url) throw new Error("媒体文件没有可用地址");
  return fetchAuthenticatedImageBlob(url, signal);
}

export function storedMediaExtension(image: StoredImage, mimeType: string) {
  const mime = mimeType.split(";", 1)[0].toLowerCase();
  const extensions: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "image/svg+xml": "svg", "image/avif": "avif",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
  };
  return extensions[mime] || (image.mediaType === "video" || image.videoUrl ? "mp4" : image.outputFormat || "png");
}
