import assert from "node:assert/strict";
import test from "node:test";
import { clearAuthenticatedImageCache, fetchCachedAuthenticatedImage, releaseCachedAuthenticatedImage } from "../src/lib/authenticated-image.ts";
import { loadEditableImageSource } from "../src/lib/editable-image-source.ts";

test("image tools retain the displayed original without fetching or revoking its shared URL", async () => {
  const originalFetch = globalThis.fetch;
  const originalRevoke = URL.revokeObjectURL;
  let requests = 0;
  const revoked = [];
  globalThis.fetch = async () => {
    requests++;
    return { ok: true, blob: async () => new Blob(["original image"]) };
  };
  URL.revokeObjectURL = url => revoked.push(url);
  clearAuthenticatedImageCache();
  let displayed;
  let editing;
  try {
    displayed = await fetchCachedAuthenticatedImage("/images/mask-cached.png");
    editing = await loadEditableImageSource("/images/mask-cached.png", new AbortController().signal);
    assert.equal(editing.url, displayed.objectURL);
    assert.equal(requests, 1);
    editing.release();
    editing = undefined;
    assert.ok(!revoked.includes(displayed.objectURL));
  } finally {
    editing?.release();
    if (displayed) releaseCachedAuthenticatedImage(displayed.key);
    clearAuthenticatedImageCache();
    globalThis.fetch = originalFetch;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("closing during an uncached download aborts it and discards a late response", async () => {
  const originalFetch = globalThis.fetch;
  let resolveResponse;
  let requestSignal;
  globalThis.fetch = (_url, options) => {
    requestSignal = options.signal;
    return new Promise(resolve => { resolveResponse = resolve; });
  };
  try {
    const controller = new AbortController();
    const pending = loadEditableImageSource("/images/mask-late.png", controller.signal);
    controller.abort();
    assert.equal(requestSignal.aborted, true);
    resolveResponse({ ok: true, blob: async () => new Blob(["late image"]) });
    await assert.rejects(pending, { name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an uncached editable source owns and releases its downloaded object URL", async () => {
  const originalFetch = globalThis.fetch;
  const originalRevoke = URL.revokeObjectURL;
  const revoked = [];
  globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob(["original"]) });
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    const source = await loadEditableImageSource("/images/mask-owned.png", new AbortController().signal);
    assert.ok(source.url.startsWith("blob:"));
    assert.ok(!revoked.includes(source.url));
    source.release();
    assert.ok(revoked.includes(source.url));
  } finally {
    globalThis.fetch = originalFetch;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("canvas blob and embedded originals remain owned by their caller", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected download"); };
  try {
    for (const url of ["blob:canvas-original", "data:image/png;base64,b3JpZ2luYWw="]) {
      const source = await loadEditableImageSource(url, new AbortController().signal);
      assert.equal(source.url, url);
      source.release();
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(loadEditableImageSource("blob:canvas-original", controller.signal), { name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
