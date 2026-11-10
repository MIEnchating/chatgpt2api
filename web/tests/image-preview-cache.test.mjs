import assert from "node:assert/strict";
import test from "node:test";

test("image previews are immediately reusable and cleared when the session changes", async () => {
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  const previousCaches = globalThis.caches;
  const previousBroadcastChannel = globalThis.BroadcastChannel;
  const window = new EventTarget();
  globalThis.window = window;
  globalThis.location = { origin: "http://localhost" };
  globalThis.BroadcastChannel = undefined;
  let reads = 0;
  globalThis.caches = {
    open: async () => ({
      match: async () => {
        reads += 1;
        return new Response(new Blob(["preview"], { type: "image/webp" }), {
          headers: { "x-created": String(Date.now()), "x-width": "100", "x-height": "50", "x-bytes": "500" },
        });
      },
    }),
    delete: async () => true,
  };
  try {
    const { getCachedImagePreview, loadImagePreview } = await import("../src/lib/image-preview-cache.ts?preview-session-isolation");
    const first = await loadImagePreview("/images/preview.png");
    assert.equal(getCachedImagePreview("/images/preview.png"), first);
    assert.equal(await loadImagePreview("/images/preview.png"), first);
    assert.equal(reads, 1);
    window.dispatchEvent(new Event("chatgpt2api:auth-session-change"));
    assert.equal(getCachedImagePreview("/images/preview.png"), undefined);
    const next = await loadImagePreview("/images/preview.png");
    assert.notEqual(next.url, first.url);
    assert.equal(reads, 2);
    window.dispatchEvent(new Event("chatgpt2api:auth-session-change"));
  } finally {
    globalThis.window = previousWindow;
    globalThis.location = previousLocation;
    globalThis.caches = previousCaches;
    globalThis.BroadcastChannel = previousBroadcastChannel;
  }
});
