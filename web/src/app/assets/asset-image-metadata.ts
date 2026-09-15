import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";
import { inspectImageBlobMetadata } from "@/services/image-storage";
import type { AssetMediaMetadata } from "@/app/assets/asset-media";

export async function inspectAssetImageURL(source: string, signal: AbortSignal): Promise<AssetMediaMetadata> {
  signal.throwIfAborted();
  const blob = await fetchAuthenticatedImageBlob(source, signal);
  signal.throwIfAborted();
  const dimensions = await inspectImageBlobMetadata(blob);
  signal.throwIfAborted();
  return { ...dimensions, bytes: blob.size, ...(blob.type ? { mimeType: blob.type } : {}) };
}
