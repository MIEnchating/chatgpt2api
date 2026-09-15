import assert from "node:assert/strict";
import test from "node:test";
import { spyOn } from "bun:test";

import * as imageStorage from "../src/services/image-storage.ts";
import { inspectAssetImageURL } from "../src/app/assets/asset-image-metadata.ts";

test("URL metadata reads actual image size and MIME without sending credentials cross-origin", async () => {
  const originalFetch = globalThis.fetch;
  const blob = new Blob(["image bytes"], { type: "image/webp" });
  const inspect = spyOn(imageStorage, "inspectImageBlobMetadata").mockResolvedValue({ width: 900, height: 600 });
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://cdn.example.com/image");
      assert.equal(options.credentials, "same-origin");
      return new Response(blob);
    };
    assert.deepEqual(await inspectAssetImageURL("https://cdn.example.com/image", new AbortController().signal), { width: 900, height: 600, bytes: blob.size, mimeType: "image/webp" });
  } finally {
    globalThis.fetch = originalFetch;
    inspect.mockRestore();
  }
});

test("a canceled metadata decode never returns stale results", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const inspect = spyOn(imageStorage, "inspectImageBlobMetadata").mockImplementation(async () => {
    controller.abort();
    return { width: 900, height: 600 };
  });
  try {
    globalThis.fetch = async () => new Response(new Blob(["image"], { type: "image/png" }));
    await assert.rejects(inspectAssetImageURL("https://cdn.example.com/image", controller.signal), { name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
    inspect.mockRestore();
  }
});

test("protected image metadata uses the existing authenticated reader", async () => {
  const originalFetch = globalThis.fetch;
  const inspect = spyOn(imageStorage, "inspectImageBlobMetadata").mockResolvedValue({ width: 1, height: 1 });
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.credentials, "include");
      return new Response(new Blob(["image"], { type: "image/png" }));
    };
    await inspectAssetImageURL("/images/private.png", new AbortController().signal);
  } finally {
    globalThis.fetch = originalFetch;
    inspect.mockRestore();
  }
});
