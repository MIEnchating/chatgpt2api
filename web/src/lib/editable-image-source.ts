import { fetchAuthenticatedImageBlob, releaseCachedAuthenticatedImage, retainCachedAuthenticatedImage } from "@/lib/authenticated-image";

export async function loadEditableImageSource(sourceURL: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!sourceURL) throw new Error("未找到可用的原图地址");
  if (sourceURL.startsWith("blob:") || sourceURL.startsWith("data:")) {
    return { url: sourceURL, release: () => {} };
  }
  const cached = retainCachedAuthenticatedImage(sourceURL);
  if (cached) {
    return { url: cached.objectURL, release: () => releaseCachedAuthenticatedImage(cached.key) };
  }
  const blob = await fetchAuthenticatedImageBlob(sourceURL, signal);
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  return { url, release: () => URL.revokeObjectURL(url) };
}
