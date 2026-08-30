import { httpRequest } from "@/lib/request";
import { normalizeMyAssets, type MyAsset } from "@/lib/my-assets-core";

const ASSET_CACHE_TTL_MS = 10_000;

type AssetCacheEntry = {
  items: MyAsset[];
  expiresAt: number;
};

const assetCache = new Map<string, AssetCacheEntry>();
const assetRequests = new Map<string, Promise<MyAsset[]>>();

function pruneAssetCache() {
  const now = Date.now();
  for (const [key, entry] of assetCache) {
    if (entry.expiresAt <= now) assetCache.delete(key);
  }
  while (assetCache.size > 8) {
    const oldestKey = assetCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    assetCache.delete(oldestKey);
  }
}

export {
  createMyAsset,
  mergeMyAssets,
  type MyAsset,
  type MyAssetKind,
  type MyAssetVisibility,
} from "@/lib/my-assets-core";

function scopedCacheKey(scope: string, visibility: "own" | "visible") {
  return `${scope.trim()}:${visibility}`;
}

function waitForAssets(request: Promise<MyAsset[]>, signal?: AbortSignal) {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(signal.reason || new Error("request aborted"));
  return new Promise<MyAsset[]>((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    request.then(
      (items) => {
        signal.removeEventListener("abort", abort);
        resolve(items);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function fetchAssets(scope: string, visibility: "own" | "visible", signal?: AbortSignal) {
  pruneAssetCache();
  const key = scopedCacheKey(scope, visibility);
  const cached = assetCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return normalizeMyAssets(cached.items);

  let request = assetRequests.get(key);
  if (!request) {
    const path = visibility === "visible" ? "/api/profile/assets?scope=visible" : "/api/profile/assets";
    request = httpRequest<{ items?: MyAsset[] }>(path)
      .then((response) => {
        const items = normalizeMyAssets(response.items);
        assetCache.set(key, { items, expiresAt: Date.now() + ASSET_CACHE_TTL_MS });
        return items;
      })
      .finally(() => assetRequests.delete(key));
    assetRequests.set(key, request);
  }
  return normalizeMyAssets(await waitForAssets(request, signal));
}

export function fetchMyAssets(scope: string, signal?: AbortSignal) {
  return fetchAssets(scope, "own", signal);
}

export function fetchVisibleMyAssets(scope: string, signal?: AbortSignal) {
  return fetchAssets(scope, "visible", signal);
}

export async function syncMyAssets(scope: string, assets: MyAsset[]) {
  const response = await httpRequest<{ items?: MyAsset[] }>("/api/profile/assets", {
    method: "PUT",
    body: { items: assets },
  });
  const items = normalizeMyAssets(response.items);
  pruneAssetCache();
  assetCache.set(scopedCacheKey(scope, "own"), { items, expiresAt: Date.now() + ASSET_CACHE_TTL_MS });
  for (const key of assetCache.keys()) {
    if (key.endsWith(":visible")) assetCache.delete(key);
  }
  return normalizeMyAssets(items);
}

export async function upsertMyAsset(asset: MyAsset) {
  const response = await httpRequest<{ items?: MyAsset[] }>("/api/profile/assets", {
    method: "POST",
    body: { item: asset },
  });
  const items = normalizeMyAssets(response.items);
  pruneAssetCache();
  for (const key of assetCache.keys()) {
    if (key.endsWith(":own")) assetCache.set(key, { items, expiresAt: Date.now() + ASSET_CACHE_TTL_MS });
    else if (key.endsWith(":visible")) assetCache.delete(key);
  }
  return normalizeMyAssets(items);
}
