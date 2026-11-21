import assert from "node:assert/strict";
import test from "node:test";

import { indexAssetLabels } from "../src/app/assets/asset-filters.ts";
import { assetListKey } from "../src/app/assets/asset-library.ts";
import { normalizeMyAssets, normalizeMyAssetTags } from "../src/lib/my-assets-core.ts";

const asset = { id: "same", kind: "text", title: "提示词", content: "内容", tags: ["产品", "人物"], visibility: "private" };

test("tag normalization preserves existing labels, including literal commas, when editing", () => {
  const existing = { ...asset, tags: ["产品", "red, blue"] };
  assert.deepEqual(normalizeMyAssets([{ ...existing, title: "修改标题" }])[0].tags, existing.tags);
  assert.deepEqual(normalizeMyAssetTags([" 产品 ", "", "产品", "人物"]), ["产品", "人物"]);
});

test("asset labels preserve group order and keep matching IDs from different owners separate", () => {
  const shared = { ...asset, ownerId: "other", owned: false, visibility: "public" };
  const ownKey = assetListKey(asset);
  const sharedKey = assetListKey(shared);
  const labels = indexAssetLabels([
    { id: "product", name: "产品", assetKeys: [ownKey, ownKey] },
    { id: "shared", name: "公开", assetKeys: [sharedKey] },
    { id: "approved", name: "已审核", assetKeys: [ownKey, sharedKey] },
  ]);
  assert.deepEqual(labels.get(ownKey), ["产品", "已审核"]);
  assert.deepEqual(labels.get(sharedKey), ["公开", "已审核"]);
  assert.equal(labels.has("self:untagged"), false);
});
