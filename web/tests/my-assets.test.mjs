import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createMyAsset, createMyAssetId, mergeMyAssets, normalizeMyAssets } from "../src/lib/my-assets-core.ts";

test("my assets preserve all four kinds and media metadata", () => {
  const items = normalizeMyAssets([
    { id: "text", kind: "text", title: "提示词", content: "电影感近景", tags: ["电影", "电影"], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "image", kind: "image", title: "图片", url: "/images/a.png", storageKey: "server:image-a", width: 1024, height: 768, bytes: 2048, mimeType: "image/png", tags: [] },
    { id: "video", kind: "video", title: "视频", url: "/video-references/a.mp4", width: 1920, height: 1080, durationMs: 5200, note: "动作参考", tags: [] },
    { id: "audio", kind: "audio", title: "音频", url: "/audio-references/a.mp3", durationMs: 3100, tags: [] },
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["text", "image", "video", "audio"]);
  assert.equal(items[1].width, 1024);
  assert.equal(items[1].storageKey, "server:image-a");
  assert.equal(items[2].durationMs, 5200);
  assert.equal(items[2].note, "动作参考");
});

test("my assets reject transient blob URLs and merge by latest update", () => {
  assert.deepEqual(normalizeMyAssets([{ id: "bad", kind: "video", title: "bad", url: "blob:temporary", tags: [] }]), []);
  const older = normalizeMyAssets([{ id: "same", kind: "text", title: "旧", content: "old", tags: [], updatedAt: "2026-01-01T00:00:00Z" }]);
  const newer = normalizeMyAssets([{ id: "same", kind: "text", title: "新", content: "new", tags: [], updatedAt: "2026-01-02T00:00:00Z" }]);
  assert.equal(mergeMyAssets(older, newer)[0].title, "新");
});

test("my assets keep the remote record when cache timestamps match", () => {
  const remote = normalizeMyAssets([{ id: "same", kind: "text", title: "提示词", content: "content", storageKey: "server:text", tags: [], updatedAt: "2026-01-01T00:00:00Z" }]);
  const cached = normalizeMyAssets([{ id: "same", kind: "text", title: "提示词", content: "content", tags: [], updatedAt: "2026-01-01T00:00:00Z" }]);
  assert.equal(mergeMyAssets(remote, cached)[0].storageKey, "server:text");
});

test("my asset ids fall back when randomUUID is unavailable on remote HTTP", () => {
  const id = createMyAssetId(() => { throw new Error("randomUUID is unavailable"); });
  assert.match(id, /^asset-[a-z0-9]+-[a-z0-9]+$/);
  const asset = createMyAsset({ kind: "text", title: "提示词", content: "内容", tags: [] });
  assert.match(asset.id, /^asset-/);
  assert.equal(asset.visibility, "private");
});

test("my assets normalize visibility and preserve ownership metadata", () => {
  const [legacy, published, shared] = normalizeMyAssets([
    { id: "legacy", kind: "text", title: "旧素材", content: "默认个人", tags: [] },
    { id: "published", kind: "image", title: "公开图片", url: "/images/public.png", visibility: "public", tags: [] },
    { id: "shared", kind: "audio", title: "共享音频", url: "/audio/shared.mp3", visibility: "public", ownerId: "user-a", ownerName: "Alice", owned: false, tags: [] },
  ]);
  assert.equal(legacy.visibility, "private");
  assert.equal(published.visibility, "public");
  assert.equal(shared.ownerId, "user-a");
  assert.equal(shared.ownerName, "Alice");
  assert.equal(shared.owned, false);
});

test("my asset clients persist item mutations without delayed full-table snapshots", () => {
  const api = readFileSync(new URL("../src/lib/my-assets.ts", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/lib/use-my-assets.ts", import.meta.url), "utf8");
  const prompts = readFileSync(new URL("../src/app/prompt-library/page.tsx", import.meta.url), "utf8");
  const canvas = readFileSync(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(api, /method:\s*"PUT"/);
  assert.match(api, /method:\s*"POST"/);
  assert.match(api, /method:\s*"DELETE"/);
  assert.doesNotMatch(hook, /syncMyAssets|setTimeout\(/);
  assert.match(hook, /upsertMyAsset\(asset\)/);
  assert.match(hook, /deleteMyAsset\(id\)/);
  assert.match(prompts, /await upsertMyAsset\(asset\)/);
  assert.match(canvas, /await upsertMyAsset\(asset\)/);
});
