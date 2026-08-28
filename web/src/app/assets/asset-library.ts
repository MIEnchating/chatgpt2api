import type { ManagedImage } from "@/lib/api";
import type { MyAsset } from "@/lib/my-assets";

export function managedImageAsset(item: ManagedImage, owned: boolean): MyAsset {
  return {
    id: `managed-image:${item.path}`,
    kind: "image",
    title: item.prompt || item.name || "生成图片",
    coverUrl: item.thumbnail_url || item.url,
    url: item.url,
    tags: [],
    source: "生成图片",
    visibility: item.visibility === "public" ? "public" : "private",
    ownerId: item.owner_id,
    ownerName: item.owner_name,
    owned,
    mimeType: item.output_format ? `image/${item.output_format}` : undefined,
    bytes: item.size,
    width: item.width,
    height: item.height,
    managedPath: item.path,
    createdAt: item.created_at || item.date,
    updatedAt: item.created_at || item.date,
  };
}

export function mergeAssetLibrary(ownedAssets: MyAsset[], visibleAssets: MyAsset[], managedAssets: MyAsset[]) {
  const persistentURLs = new Set(ownedAssets.map((asset) => asset.url).filter(Boolean));
  return [
    ...ownedAssets,
    ...visibleAssets.filter((asset) => asset.owned !== true),
    ...managedAssets.filter((asset) => asset.owned !== true || !persistentURLs.has(asset.url)),
  ];
}

export function canManageAsset(asset: MyAsset) {
  return asset.owned === true || (asset.owned !== false && !asset.ownerId);
}

export function assetListKey(asset: MyAsset) {
  return `${asset.ownerId || (asset.owned === false ? "shared" : "self")}:${asset.id}`;
}

export function collectAssetStorageKeys(value: unknown, keys = new Set<string>()) {
  if (!value || typeof value !== "object") return keys;
  const record = value as Record<string, unknown>;
  for (const field of ["storageKey", "storage_key"] as const) {
    const storageKey = record[field];
    if (typeof storageKey === "string" && storageKey.trim()) keys.add(storageKey.trim());
  }
  Object.values(record).forEach((item) => {
    if (Array.isArray(item)) item.forEach((child) => collectAssetStorageKeys(child, keys));
    else collectAssetStorageKeys(item, keys);
  });
  return keys;
}
