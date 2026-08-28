import { httpRequest } from "@/lib/request";
import { normalizeMyAssets, type MyAsset } from "@/lib/my-assets-core";

export {
  createMyAsset,
  mergeMyAssets,
  type MyAsset,
  type MyAssetKind,
  type MyAssetVisibility,
} from "@/lib/my-assets-core";

function storageKey(scope: string) {
  return `yunmian:my-assets:${scope || "anonymous"}`;
}

export function loadMyAssets(scope: string): MyAsset[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey(scope)) || "[]") as unknown;
    return normalizeMyAssets(value);
  } catch {
    return [];
  }
}

export function saveMyAssets(scope: string, assets: MyAsset[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(scope), JSON.stringify(assets));
}

export async function fetchMyAssets(signal?: AbortSignal) {
  const response = await httpRequest<{ items?: MyAsset[] }>("/api/profile/assets", { signal });
  return normalizeMyAssets(response.items);
}

export async function fetchVisibleMyAssets(signal?: AbortSignal) {
  const response = await httpRequest<{ items?: MyAsset[] }>("/api/profile/assets?scope=visible", { signal });
  return normalizeMyAssets(response.items);
}

export async function syncMyAssets(assets: MyAsset[]) {
  const response = await httpRequest<{ items?: MyAsset[] }>("/api/profile/assets", {
    method: "PUT",
    body: { items: assets },
  });
  return normalizeMyAssets(response.items);
}
