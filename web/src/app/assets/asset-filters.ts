import type { AssetGroup } from "@/lib/asset-groups";
import type { MyAsset } from "@/lib/my-assets";
import { assetListKey } from "@/app/assets/asset-library";

export function assetLabels(asset: MyAsset, groups: readonly AssetGroup[]) {
  const key = assetListKey(asset);
  return groups.filter((group) => group.assetKeys.includes(key)).map((group) => group.name);
}

export function assetMatchesGroup(asset: MyAsset, groups: readonly AssetGroup[], selected: string) {
  if (selected === "all") return true;
  const key = assetListKey(asset);
  if (selected === "ungrouped") return !groups.some((group) => group.assetKeys.includes(key));
  return groups.some((group) => group.id === selected && group.assetKeys.includes(key));
}
