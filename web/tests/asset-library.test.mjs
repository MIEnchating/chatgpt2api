import assert from "node:assert/strict";
import test from "node:test";

import { assetListKey, assetPrompt, canManageAsset, collectAssetStorageKeys, formatAssetCreatedTime, managedImageAsset, mergeAssetLibrary } from "../src/app/assets/asset-library.ts";

const now = "2026-01-01T00:00:00Z";

function textAsset(id, patch = {}) {
  return { id, kind: "text", title: id, content: id, tags: [], visibility: "private", createdAt: now, updatedAt: now, ...patch };
}

test("asset library keeps owned assets separate from read-only visible assets", () => {
  const owned = textAsset("same", { url: "/images/owned.png" });
  const shared = textAsset("same", { visibility: "public", ownerId: "user-b", ownerName: "Bob", owned: false });
  const ownedProjection = textAsset("generated-owned", { kind: "image", content: undefined, url: "/images/owned.png", managedPath: "owned.png", owned: true });
  const sharedProjection = textAsset("generated-shared", { kind: "image", content: undefined, url: "/images/shared.png", managedPath: "shared.png", visibility: "public", ownerId: "user-b", owned: false });

  const result = mergeAssetLibrary([owned], [shared], [ownedProjection, sharedProjection]);
  assert.deepEqual(result.map((asset) => asset.id), ["same", "same", "generated-shared"]);
  assert.equal(canManageAsset(owned), true);
  assert.equal(canManageAsset(shared), false);
  assert.notEqual(assetListKey(owned), assetListKey(shared));
});

test("managed image projection preserves visibility, owner, and ownership", () => {
  const asset = managedImageAsset({
    name: "result.png",
    path: "2026/01/result.png",
    owner_id: "user-b",
    owner_name: "Bob",
    visibility: "public",
    prompt: "海报",
    date: "2026-01-01",
    size: 1024,
    url: "/images/result.png",
    created_at: now,
  }, false);
  assert.equal(asset.visibility, "public");
  assert.equal(asset.ownerId, "user-b");
  assert.equal(asset.ownerName, "Bob");
  assert.equal(asset.owned, false);
  assert.equal(canManageAsset(asset), false);
});

test("managed image projection uses the persisted generation source", () => {
  const image = {
    name: "result.png",
    path: "2026/01/result.png",
    visibility: "private",
    date: "2026-01-01",
    size: 1024,
    url: "/images/result.png",
    created_at: now,
  };
  assert.equal(managedImageAsset({ ...image, generation_source: "workflow" }, true).source, "工作流");
  assert.equal(managedImageAsset({ ...image, generation_source: "canvas" }, true).source, "无限画布");
  assert.equal(managedImageAsset({ ...image, generation_source: "image-workbench" }, true).source, "生成图片");
  assert.equal(managedImageAsset(image, true).source, "生成图片");
});

test("managed image projection preserves its generation prompt", () => {
  const asset = managedImageAsset({
    name: "result.png",
    path: "2026/01/result.png",
    visibility: "private",
    prompt: "高端香水产品海报",
    date: "2026-01-01",
    size: 1024,
    url: "/images/result.png",
    created_at: now,
  }, true);
  assert.equal(assetPrompt(asset), "高端香水产品海报");
  assert.equal(assetPrompt(textAsset("plain")), "");
});

test("asset creation time supports server and ISO timestamps", () => {
  assert.equal(formatAssetCreatedTime("2026-01-02 08:05:30"), "2026-01-02 08:05");
  assert.equal(formatAssetCreatedTime("invalid"), "时间未知");
  assert.match(formatAssetCreatedTime("2026-01-02T08:05:30Z"), /^2026-01-02 \d{2}:\d{2}$/);
});

test("asset storage key collection covers assets and canvas nodes", () => {
  const keys = collectAssetStorageKeys({
    assets: [
      { storageKey: "image:asset" },
      { storageKey: "server:shared" },
    ],
    projects: [{ nodes: [{ storage_key: "video:canvas" }, { director_project: { storage_key: "server:shared" } }] }],
  });
  assert.deepEqual(Array.from(keys).sort(), ["image:asset", "server:shared", "video:canvas"]);
});
