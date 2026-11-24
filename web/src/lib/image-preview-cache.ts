import { fetchAuthenticatedImageBlob } from "./authenticated-image";
import { AUTH_SESSION_CHANGE_EVENT } from "./auth-session";
import { getCachedAuthSession } from "./session";

const CACHE_NAME = "canvas-image-previews-v1";
const MAX_ENTRIES = 256;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_PREVIEWS = 2;
type PreviewMetadata = { width: number; height: number; bytes: number };
type ImagePreview = PreviewMetadata & { blob: Blob };
export type HeldImagePreview = PreviewMetadata & { url: string; release: () => void };
type PreviewRequest = { controller: AbortController; promise: Promise<ImagePreview>; readers: Set<() => boolean> };
const memoryPreviews = new Map<string, ImagePreview>();
const heldPreviews = new Map<string, { preview: ImagePreview; url: string; readers: number }>();
const pending = new Map<string, PreviewRequest>();
let memoryBytes = 0;
let generation = 0;
let active = 0;
const waiting = new Map<() => void, () => boolean>();
let writes = Promise.resolve();

if (typeof window !== "undefined") window.addEventListener(AUTH_SESSION_CHANGE_EVENT, () => {
  generation += 1;
  for (const request of pending.values()) request.controller.abort();
  pending.clear();
  for (const preview of heldPreviews.values()) URL.revokeObjectURL(preview.url);
  heldPreviews.clear();
  memoryPreviews.clear();
  memoryBytes = 0;
  if (typeof caches !== "undefined") writes = writes.then(async () => { await caches.delete(CACHE_NAME); }).catch(() => {});
});

function holdPreview(key: string, preview: ImagePreview): HeldImagePreview {
  const held = heldPreviews.get(key) ?? { preview, url: URL.createObjectURL(preview.blob), readers: 0 };
  heldPreviews.set(key, held);
  held.readers += 1;
  let released = false;
  return {
    url: held.url, width: held.preview.width, height: held.preview.height, bytes: held.preview.bytes,
    release() {
      if (released) return;
      released = true;
      held.readers -= 1;
      if (held.readers > 0 || heldPreviews.get(key) !== held) return;
      heldPreviews.delete(key);
      URL.revokeObjectURL(held.url);
    },
  };
}

export async function acquireImagePreview(src: string, signal: AbortSignal, isVisible = () => true): Promise<HeldImagePreview> {
  signal.throwIfAborted();
  const scope = getCachedAuthSession()?.key || "";
  const epoch = generation;
  const key = `${epoch}\0${scope}\0${src}`;
  const cached = memoryPreviews.get(key);
  if (cached) {
    memoryPreviews.delete(key);
    memoryPreviews.set(key, cached);
    return holdPreview(key, cached);
  }
  const held = heldPreviews.get(key);
  if (held) return holdPreview(key, held.preview);

  let request = pending.get(key);
  if (!request) {
    const controller = new AbortController();
    const readers = new Set<() => boolean>();
    const current = () => !controller.signal.aborted && epoch === generation && scope === (getCachedAuthSession()?.key || "");
    const hasVisibleReader = () => {
      for (const visible of readers) if (visible()) return true;
      return false;
    };
    const promise = schedulePreview(controller.signal, hasVisibleReader, () => buildPreview(src, scope, controller.signal, current)).then(preview => {
      if (!current()) throw new DOMException("图片预览已取消", "AbortError");
      if (preview.blob.size <= MAX_MEMORY_BYTES) {
        memoryPreviews.set(key, preview);
        memoryBytes += preview.blob.size;
        while (memoryPreviews.size > MAX_ENTRIES || memoryBytes > MAX_MEMORY_BYTES) {
          const oldest = memoryPreviews.entries().next().value!;
          memoryPreviews.delete(oldest[0]);
          memoryBytes -= oldest[1].blob.size;
        }
      }
      return preview;
    });
    const next = { controller, promise, readers };
    pending.set(key, next);
    const forget = () => { if (pending.get(key) === next) pending.delete(key); };
    void promise.then(forget, forget);
    request = next;
  }

  const shared = request;
  const reader = () => !signal.aborted && isVisible();
  shared.readers.add(reader);
  const lifetime = AbortSignal.any([signal, shared.controller.signal]);
  try {
    const preview = await new Promise<ImagePreview>((resolve, reject) => {
      const abort = () => {
        shared.readers.delete(reader);
        if (!shared.readers.size && pending.get(key) === shared) {
          pending.delete(key);
          shared.controller.abort();
        }
        reject(lifetime.reason);
      };
      lifetime.addEventListener("abort", abort, { once: true });
      const cleanup = () => lifetime.removeEventListener("abort", abort);
      void shared.promise.then(
        value => { cleanup(); resolve(value); },
        error => { cleanup(); reject(error); },
      );
    });
    lifetime.throwIfAborted();
    if (epoch !== generation || scope !== (getCachedAuthSession()?.key || "")) throw new DOMException("图片会话已改变", "AbortError");
    return holdPreview(key, preview);
  } finally {
    shared.readers.delete(reader);
  }
}

function schedulePreview(signal: AbortSignal, isVisible: () => boolean, build: () => Promise<ImagePreview>): Promise<ImagePreview> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      waiting.delete(start);
      reject(signal.reason);
    };
    const start = () => {
      signal.removeEventListener("abort", cancel);
      active += 1;
      void build().then(resolve, reject).finally(() => {
        active -= 1;
        let next = waiting.keys().next().value;
        for (const [queued, visible] of waiting) {
          if (!visible()) continue;
          next = queued;
          break;
        }
        if (next) {
          waiting.delete(next);
          next();
        }
      });
    };
    if (active < MAX_ACTIVE_PREVIEWS) start();
    else {
      waiting.set(start, isVisible);
      signal.addEventListener("abort", cancel, { once: true });
    }
  });
}

async function buildPreview(src: string, scope: string, signal: AbortSignal, current: () => boolean): Promise<ImagePreview> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}\0${src}`));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const cacheKey = `${location.origin}/__image-preview-cache/${hash}`;
  await writes;
  signal.throwIfAborted();
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (!current()) throw new Error("图片会话已改变");
  if (cached && Date.now() - Number(cached.headers.get("x-created")) < MAX_AGE) {
    const blob = await cached.blob();
    if (!current()) throw new Error("图片会话已改变");
    return { blob, width: Number(cached.headers.get("x-width")), height: Number(cached.headers.get("x-height")), bytes: Number(cached.headers.get("x-bytes")) };
  }
  const blob = await fetchAuthenticatedImageBlob(src, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
  if (blob.size > 32 * 1024 * 1024) throw new Error("图片超出预览缓存限制");
  const bitmap = await createImageBitmap(blob);
  let preview: ImagePreview;
  try {
    signal.throwIfAborted();
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 64_000_000) throw new Error("图片尺寸超出预览缓存限制");
    const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建图片预览");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("无法编码图片预览")), "image/webp", 0.82));
    preview = { blob: thumbnail, width: bitmap.width, height: bitmap.height, bytes: blob.size };
  } finally { bitmap.close(); }
  if (!current()) throw new Error("图片会话已改变");
  const save = writes.then(async () => {
    if (!current()) return;
    await cache.delete(cacheKey);
    await cache.put(cacheKey, new Response(preview.blob, { headers: { "content-type": preview.blob.type, "x-created": String(Date.now()), "x-width": String(preview.width), "x-height": String(preview.height), "x-bytes": String(preview.bytes) } }));
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)).map(key => cache.delete(key)));
  });
  writes = save.catch(() => {});
  await writes;
  if (!current()) throw new Error("图片会话已改变");
  return preview;
}
