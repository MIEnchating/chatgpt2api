import { httpRequest } from "@/lib/request";
import { normalizeMyAssets, type MyAsset } from "@/lib/my-assets-core";

const ASSET_CACHE_TTL_MS = 10_000;

type AssetCacheEntry = {
  items: MyAsset[];
  expiresAt: number;
};

const assetCache = new Map<string, AssetCacheEntry>();
const assetRequests = new Map<string, Promise<MyAsset[]>>();
let assetCacheEpoch = 0;

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
  type MyAsset,
  type MyAssetKind,
  type MyAssetVisibility,
} from "@/lib/my-assets-core";

function scopedCacheKey(scope: string, visibility: "own" | "visible") {
  return `${scope.trim()}:${visibility}`;
}

function invalidateAssetCache() {
  assetCacheEpoch += 1;
  assetCache.clear();
  assetRequests.clear();
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
    const epoch = assetCacheEpoch;
    const pending = httpRequest<{ items?: MyAsset[] }>(path)
      .then((response) => {
        const items = normalizeMyAssets(response.items);
        if (epoch === assetCacheEpoch) {
          assetCache.set(key, { items, expiresAt: Date.now() + ASSET_CACHE_TTL_MS });
        }
        return items;
      });
    let tracked: Promise<MyAsset[]>;
    tracked = pending.finally(() => {
      if (assetRequests.get(key) === tracked) assetRequests.delete(key);
    });
    request = tracked;
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

export async function upsertMyAsset(asset: MyAsset, signal?: AbortSignal) {
  signal?.throwIfAborted();
  invalidateAssetCache();
  try {
    const response = await httpRequest<{ item?: MyAsset }>("/api/profile/assets", {
      method: "POST",
      body: { item: asset },
      signal,
    });
    signal?.throwIfAborted();
    const item = normalizeMyAssets([response.item])[0];
    if (!item) throw new Error("素材保存响应无效");
    return item;
  } finally {
    invalidateAssetCache();
  }
}

export async function deleteMyAsset(id: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  invalidateAssetCache();
  try {
    const response = await httpRequest<{ deleted?: boolean }>("/api/profile/assets", {
      method: "DELETE",
      body: { id },
      signal,
    });
    signal?.throwIfAborted();
    return response.deleted === true;
  } finally {
    invalidateAssetCache();
  }
}
