import assert from "node:assert/strict";
import test from "node:test";

import {
  clearAuthenticatedImageCache,
  fetchCachedAuthenticatedImage,
  releaseCachedAuthenticatedImage,
} from "../src/lib/authenticated-image.ts";

test("a newly fetched image is retained before cache capacity trimming", async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let nextObjectURL = 0;

  globalThis.fetch = async () => ({
    ok: true,
    blob: async () => new Blob(["x"], { type: "image/png" }),
  });
  URL.createObjectURL = () => `blob:cached-image-${nextObjectURL++}`;
  URL.revokeObjectURL = () => {};
  clearAuthenticatedImageCache();

  const retained = [];
  try {
    for (let index = 0; index <= 320; index += 1) {
      retained.push(await fetchCachedAuthenticatedImage(`/images/cache-${index}.png`));
    }

    assert.equal(retained.length, 321);
    assert.equal(retained[320].objectURL, "blob:cached-image-320");
  } finally {
    for (const image of retained) {
      releaseCachedAuthenticatedImage(image.key);
    }
    clearAuthenticatedImageCache();
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test("concurrent new URLs stay reserved until both cache waiters retain them", async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const revokedURLs = [];
  let nextObjectURL = 0;

  globalThis.fetch = async () => ({
    ok: true,
    blob: async () => new Blob(["x"], { type: "image/png" }),
  });
  URL.createObjectURL = () => `blob:concurrent-image-${nextObjectURL++}`;
  URL.revokeObjectURL = (url) => revokedURLs.push(url);
  clearAuthenticatedImageCache();

  const retained = [];
  try {
    for (let index = 0; index < 320; index += 1) {
      retained.push(await fetchCachedAuthenticatedImage(`/images/retained-${index}.png`));
    }

    const firstPending = fetchCachedAuthenticatedImage("/images/concurrent-a.png");
    const secondPending = fetchCachedAuthenticatedImage("/images/concurrent-b.png");
    const [first, second] = await Promise.all([firstPending, secondPending]);
    retained.push(first, second);

    assert.equal(first.objectURL, "blob:concurrent-image-320");
    assert.equal(second.objectURL, "blob:concurrent-image-321");
  } finally {
    for (const image of retained) {
      releaseCachedAuthenticatedImage(image.key);
    }
    clearAuthenticatedImageCache();
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }

  assert.equal(revokedURLs.length, 322);
  assert.equal(new Set(revokedURLs).size, 322);
});
