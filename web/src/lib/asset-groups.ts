import { httpRequest } from "@/lib/request";

export type AssetGroup = { id: string; name: string; assetKeys: string[] };
export type AssetGroupMutation = { id: string; name?: string; add?: string[]; remove?: string[] };

export async function fetchAssetGroups(signal: AbortSignal) {
  const response = await httpRequest<{ items: AssetGroup[] }>("/api/profile/asset-groups", { signal });
  return response.items;
}

export async function mutateAssetGroup(method: "POST" | "PATCH" | "DELETE", body: AssetGroupMutation, signal: AbortSignal) {
  const response = await httpRequest<{ items: AssetGroup[] }>("/api/profile/asset-groups", { method, body, signal });
  return response.items;
}
