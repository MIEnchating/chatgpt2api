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
    const { acquireImagePreview } = await import("../src/lib/image-preview-cache.ts?preview-session-isolation");
    const first = await acquireImagePreview("/images/preview.png", new AbortController().signal);
    const second = await acquireImagePreview("/images/preview.png", new AbortController().signal);
    assert.equal(second.url, first.url);
    assert.equal(reads, 1);
    window.dispatchEvent(new Event("chatgpt2api:auth-session-change"));
    await assert.rejects(() => fetch(first.url));
    const next = await acquireImagePreview("/images/preview.png", new AbortController().signal);
    assert.notEqual(next.url, first.url);
    assert.equal(reads, 2);
    first.release();
    second.release();
    assert.equal(await (await fetch(next.url)).text(), "preview");
    window.dispatchEvent(new Event("chatgpt2api:auth-session-change"));
  } finally {
    globalThis.window = previousWindow;
    globalThis.location = previousLocation;
    globalThis.caches = previousCaches;
    globalThis.BroadcastChannel = previousBroadcastChannel;
  }
});

test("preview eviction leaves held URLs readable until the final release", async () => {
  const previousLocation = globalThis.location;
  const previousCaches = globalThis.caches;
  globalThis.location = { origin: "http://localhost" };
  globalThis.caches = { open: async () => ({ match: async () => previewResponse() }) };
  try {
    const { acquireImagePreview } = await import("../src/lib/image-preview-cache.ts?preview-eviction");
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      acquireImagePreview("/images/held.png", signal),
      acquireImagePreview("/images/held.png", signal),
    ]);
    assert.equal(second.url, first.url);
    for (let index = 0; index < 256; index++) {
      const other = await acquireImagePreview(`/images/${index}.png`, signal);
      other.release();
    }
    first.release();
    first.release();
    assert.equal(await (await fetch(second.url)).text(), "preview");
    second.release();
    await assert.rejects(() => fetch(second.url));
  } finally {
    globalThis.location = previousLocation;
    globalThis.caches = previousCaches;
  }
});

test("a cancelled queued preview leaves the queue while shared readers keep their request", async () => {
  const previousLocation = globalThis.location;
  const previousCaches = globalThis.caches;
  globalThis.location = { origin: "http://localhost" };
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let matchCount = 0;
  globalThis.caches = { open: async () => ({ match: async () => {
    if (++matchCount === 2) started.resolve();
    await gate.promise;
    return previewResponse();
  } }) };
  try {
    const { acquireImagePreview } = await import("../src/lib/image-preview-cache.ts?preview-queue");
    const first = new AbortController();
    const active = new AbortController().signal;
    const cancelled = new AbortController();
    const singleReader = acquireImagePreview("/images/first.png", first.signal);
    const sharedReader = acquireImagePreview("/images/first.png", active);
    const second = acquireImagePreview("/images/second.png", active);
    const queued = acquireImagePreview("/images/cancelled.png", cancelled.signal);
    const next = acquireImagePreview("/images/next.png", active);
    await started.promise;
    first.abort();
    cancelled.abort();
    await assert.rejects(singleReader, { name: "AbortError" });
    await assert.rejects(queued, { name: "AbortError" });
    gate.resolve();
    (await Promise.all([sharedReader, second, next])).forEach(preview => preview.release());
    assert.equal(matchCount, 3);
  } finally {
    gate.resolve();
    globalThis.location = previousLocation;
    globalThis.caches = previousCaches;
  }
});

test("a queued preview moves ahead when one of its readers enters the viewport", async () => {
  const previousLocation = globalThis.location;
  const previousCaches = globalThis.caches;
  globalThis.location = { origin: "http://localhost" };
  const enteredCache = Promise.withResolvers();
  const firstSlot = Promise.withResolvers();
  const secondSlot = Promise.withResolvers();
  let started = 0;
  globalThis.caches = { open: async () => ({ match: async () => {
    const slot = ++started;
    if (slot === 1) await firstSlot.promise;
    if (slot === 2) {
      enteredCache.resolve();
      await secondSlot.promise;
    }
    return previewResponse();
  } }) };
  try {
    const { acquireImagePreview } = await import("../src/lib/image-preview-cache.ts?preview-priority");
    const signal = new AbortController().signal;
    const running = [acquireImagePreview("/images/one.png", signal), acquireImagePreview("/images/two.png", signal)];
    await enteredCache.promise;
    const completed = [];
    const nearby = acquireImagePreview("/images/nearby.png", signal, () => false).then(preview => { completed.push("nearby"); return preview; });
    let isVisible = false;
    const visible = acquireImagePreview("/images/visible.png", signal, () => isVisible).then(preview => { completed.push("visible"); return preview; });
    isVisible = true;
    firstSlot.resolve();
    await visible;
    assert.equal(completed[0], "visible");
    secondSlot.resolve();
    (await Promise.all([...running, nearby, visible])).forEach(preview => preview.release());
  } finally {
    firstSlot.resolve();
    secondSlot.resolve();
    globalThis.location = previousLocation;
    globalThis.caches = previousCaches;
  }
});

function previewResponse() {
  return new Response(new Blob(["preview"], { type: "image/webp" }), {
    headers: { "x-created": String(Date.now()), "x-width": "100", "x-height": "50", "x-bytes": "500" },
  });
}
