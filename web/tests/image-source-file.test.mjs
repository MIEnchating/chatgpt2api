import test from "node:test";
import assert from "node:assert/strict";

import { imageSourceToFile } from "../src/lib/image-source-file.ts";

test("managed conversation assets are restored through the supplied authenticated loader", async () => {
  const source = `/conversation-assets/${"a".repeat(64)}/${"b".repeat(64)}.webp`;
  let requestedSource = "";
  const file = await imageSourceToFile(source, "reference.webp", "image/png", async (requested) => {
    requestedSource = requested;
    return new Blob(["asset-body"], { type: "image/webp" });
  });

  assert.equal(requestedSource, source);
  assert.equal(file.name, "reference.webp");
  assert.equal(file.type, "image/webp");
  assert.equal(await file.text(), "asset-body");
});

test("legacy base64 references are restored without issuing a network request", async () => {
  let loaderCalled = false;
  const file = await imageSourceToFile(
    "data:image/jpeg;base64,aW1hZ2UtYm9keQ==",
    "legacy.jpg",
    undefined,
    async () => {
      loaderCalled = true;
      throw new Error("unexpected network request");
    },
  );

  assert.equal(loaderCalled, false);
  assert.equal(file.name, "legacy.jpg");
  assert.equal(file.type, "image/jpeg");
  assert.equal(await file.text(), "image-body");
});
