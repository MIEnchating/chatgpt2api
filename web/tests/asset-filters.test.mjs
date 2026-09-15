import assert from "node:assert/strict";
import test from "node:test";

import { assetLabels, assetMatchesGroup } from "../src/app/assets/asset-filters.ts";
import { assetListKey } from "../src/app/assets/asset-library.ts";
import { normalizeMyAssets, normalizeMyAssetTags } from "../src/lib/my-assets-core.ts";

const asset = { id: "same", kind: "text", title: "提示词", content: "内容", tags: ["产品", "人物"], visibility: "private" };

test("tag normalization preserves existing labels, including literal commas, when editing", () => {
  const existing = { ...asset, tags: ["产品", "red, blue"] };
  assert.deepEqual(normalizeMyAssets([{ ...existing, title: "修改标题" }])[0].tags, existing.tags);
  assert.deepEqual(normalizeMyAssetTags([" 产品 ", "", "产品", "人物"]), ["产品", "人物"]);
});

test("group filtering keeps identically named assets from different owners separate", () => {
  const shared = { ...asset, ownerId: "other", owned: false, visibility: "public" };
  const groups = [{ id: "group", name: "产品", assetKeys: [assetListKey(asset)] }];
  assert.deepEqual(assetLabels(asset, groups), ["产品"]);
  assert.deepEqual(assetLabels(shared, groups), []);
  assert.equal(assetMatchesGroup(asset, groups, "group"), true);
  assert.equal(assetMatchesGroup(shared, groups, "group"), false);
  assert.equal(assetMatchesGroup(shared, groups, "ungrouped"), true);
  assert.equal(assetMatchesGroup(asset, groups, "ungrouped"), false);
  assert.equal(assetMatchesGroup(shared, groups, "all"), true);
});
