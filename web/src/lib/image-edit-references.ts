import type { ImageAPIMode } from "@/lib/api";
import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";
import { isPublicReferenceURL } from "@/lib/public-reference-url";

export type ImageEditReference = File | string;

export async function prepareImageEditReferences(
  urls: readonly string[],
  apiMode: ImageAPIMode,
  signal?: AbortSignal,
  fetchImage = fetchAuthenticatedImageBlob,
) {
  return Promise.all(urls.map(async (url, index): Promise<ImageEditReference> => {
    signal?.throwIfAborted();
    if ((apiMode === "chat" || apiMode === "responses") && isPublicReferenceURL(url)) {
      const parsed = new URL(url);
      if (!parsed.pathname.startsWith("/api/files/") && (typeof location === "undefined" || parsed.origin !== location.origin)) return url;
    }
    const blob = await fetchImage(url, signal);
    signal?.throwIfAborted();
    const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
    return new File([blob], `canvas-reference-${index + 1}.${extension}`, { type: blob.type || "image/png" });
  }));
}
