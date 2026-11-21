import type { AssetGroup } from "@/lib/asset-groups";

export function indexAssetLabels(groups: readonly AssetGroup[]) {
  const labels = new Map<string, string[]>();
  for (const group of groups) {
    for (const key of new Set(group.assetKeys)) {
      const names = labels.get(key);
      if (names) names.push(group.name);
      else labels.set(key, [group.name]);
    }
  }
  return labels;
}
