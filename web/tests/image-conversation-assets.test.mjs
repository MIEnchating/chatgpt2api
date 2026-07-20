import test from "node:test";
import assert from "node:assert/strict";

import {
  IMAGE_CONVERSATION_ASSET_URL_PREFIX,
  MAX_IMAGE_CONVERSATION_ASSET_BATCH_BYTES,
  imageConversationReferenceLimitMessage,
  isImageConversationAssetURL,
  normalizeImageConversationAssetReference,
  planImageConversationAssetUploadBatches,
} from "../src/lib/image-conversation-assets.ts";

test("conversation asset responses normalize to the stored reference shape", () => {
  const assetPath = `${"a".repeat(64)}/${"b".repeat(64)}.png`;
  const url = `${IMAGE_CONVERSATION_ASSET_URL_PREFIX}${assetPath}`;
  assert.deepEqual(
    normalizeImageConversationAssetReference({
      assetPath,
      url,
      name: "reference.png",
      type: "image/png",
      size: 1234,
    }),
    {
      assetPath,
      url,
      dataUrl: url,
      name: "reference.png",
      type: "image/png",
      size: 1234,
    },
  );
  assert.equal(isImageConversationAssetURL(url), true);
});

test("reference normalization supports assetPath-only, snake case and legacy data URLs", () => {
  const assetPath = `${"c".repeat(64)}/${"d".repeat(64)}.webp`;
  const expectedURL = `${IMAGE_CONVERSATION_ASSET_URL_PREFIX}${assetPath}`;
  assert.deepEqual(normalizeImageConversationAssetReference({ asset_path: assetPath }), {
    assetPath,
    url: expectedURL,
    dataUrl: expectedURL,
    name: `${"d".repeat(64)}.webp`,
    type: "image/webp",
  });

  assert.equal(normalizeImageConversationAssetReference({
    assetPath,
    url: expectedURL,
    dataUrl: "data:image/webp;base64,stale",
  })?.dataUrl, expectedURL);

  const legacyDataURL = "data:image/jpeg;base64,AA==";
  assert.deepEqual(normalizeImageConversationAssetReference({ data_url: legacyDataURL, name: "old.jpg" }), {
    assetPath: "",
    url: legacyDataURL,
    dataUrl: legacyDataURL,
    name: "old.jpg",
    type: "image/jpeg",
  });
  assert.equal(normalizeImageConversationAssetReference({ dataUrl: legacyDataURL })?.name, "reference.png");
});

test("reference count validation accepts four and clearly rejects overflow", () => {
  assert.equal(imageConversationReferenceLimitMessage(0, 4), "");
  assert.equal(imageConversationReferenceLimitMessage(3, 1), "");
  assert.match(imageConversationReferenceLimitMessage(4, 1), /最多支持 4 张参考图/);
  assert.match(imageConversationReferenceLimitMessage(2, 3), /最多支持 4 张参考图/);
});

test("asset upload batches stay under 80 MiB and preserve file order", () => {
  const mib = 1024 * 1024;
  const files = [
    { id: "first", name: "first.png", type: "image/png", size: 30 * mib },
    { id: "second", name: "second.jpg", type: "image/jpeg", size: 30 * mib },
    { id: "third", name: "third.webp", type: "image/webp", size: 30 * mib },
    { id: "fourth", name: "fourth.png", type: "image/png", size: 1 * mib },
  ];
  const batches = planImageConversationAssetUploadBatches(files);
  assert.deepEqual(batches.map((batch) => batch.map((file) => file.id)), [
    ["first", "second"],
    ["third", "fourth"],
  ]);
  assert.deepEqual(batches.flat().map((file) => file.id), files.map((file) => file.id));
  assert.ok(batches.every((batch) => batch.reduce((total, file) => total + file.size, 0) <= MAX_IMAGE_CONVERSATION_ASSET_BATCH_BYTES));
});

test("asset upload planning rejects a file above the backend file limit", () => {
  assert.throws(
    () => planImageConversationAssetUploadBatches([{ name: "large.png", type: "image/png", size: 40 * 1024 * 1024 + 1 }]),
    /40 MiB/,
  );
});

test("asset upload planning rejects unsupported image types before the request", () => {
  assert.throws(
    () => planImageConversationAssetUploadBatches([{ name: "animation.gif", type: "image/gif", size: 10 }]),
    /仅支持 PNG、JPEG 和 WebP/,
  );
  assert.throws(
    () => planImageConversationAssetUploadBatches([{ name: "photo.heic", type: "image/heic", size: 10 }]),
    /仅支持 PNG、JPEG 和 WebP/,
  );
  assert.doesNotThrow(() => planImageConversationAssetUploadBatches([
    { name: "browser-missing-type.webp", type: "", size: 10 },
  ]));
});
