import { fetchAuthenticatedImageBlob } from "./authenticated-image";
import { AUTH_SESSION_CHANGE_EVENT } from "./auth-session";
import { getCachedAuthSession } from "./session";

const CACHE_NAME = "canvas-image-previews-v1";
const MAX_ENTRIES = 256;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export type ImagePreview = { blob: Blob; width: number; height: number; bytes: number };
export type CachedImagePreview = ImagePreview & { url: string };
const memoryPreviews = new Map<string, CachedImagePreview>();
const pending = new Map<string, Promise<CachedImagePreview>>();
let memoryBytes = 0;
let generation = 0;
let active = 0;
const waiting: Array<() => void> = [];
let writes = Promise.resolve();

if (typeof window !== "undefined") window.addEventListener(AUTH_SESSION_CHANGE_EVENT, () => {
  generation += 1;
  pending.clear();
  for (const preview of memoryPreviews.values()) URL.revokeObjectURL(preview.url);
  memoryPreviews.clear();
  memoryBytes = 0;
  if (typeof caches !== "undefined") writes = writes.then(async () => { await caches.delete(CACHE_NAME); }).catch(() => {});
});

export function getCachedImagePreview(src: string): CachedImagePreview | undefined {
  return memoryPreviews.get(`${generation}\0${getCachedAuthSession()?.key || ""}\0${src}`);
}

export function loadImagePreview(src: string): Promise<CachedImagePreview> {
  const scope = getCachedAuthSession()?.key || "";
  const key = `${generation}\0${scope}\0${src}`;
  const cachedPreview = memoryPreviews.get(key);
  if (cachedPreview) return Promise.resolve(cachedPreview);
  const existing = pending.get(key);
  if (existing) return existing;
  const epoch = generation;
  const request = (async () => {
    if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
    else active += 1;
    try {
      const current = () => epoch === generation && scope === (getCachedAuthSession()?.key || "");
      if (!current()) throw new Error("图片会话已改变");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${scope}\0${src}`));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const cacheKey = `${location.origin}/__image-preview-cache/${hash}`;
      await writes;
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(cacheKey);
      if (!current()) throw new Error("图片会话已改变");
      if (cached && Date.now() - Number(cached.headers.get("x-created")) < MAX_AGE) {
        const blob = await cached.blob();
        if (!current()) throw new Error("图片会话已改变");
        return { blob, width: Number(cached.headers.get("x-width")), height: Number(cached.headers.get("x-height")), bytes: Number(cached.headers.get("x-bytes")) };
      }
      const blob = await fetchAuthenticatedImageBlob(src, AbortSignal.timeout(30_000));
      if (blob.size > 32 * 1024 * 1024) throw new Error("图片超出预览缓存限制");
      const bitmap = await createImageBitmap(blob);
      let preview: ImagePreview;
      try {
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
    } finally {
      const next = waiting.shift();
      if (next) next(); else active -= 1;
    }
  })().then(preview => {
    if (epoch !== generation || scope !== (getCachedAuthSession()?.key || "")) throw new Error("图片会话已改变");
    const cached = { ...preview, url: URL.createObjectURL(preview.blob) };
    memoryPreviews.set(key, cached);
    memoryBytes += preview.blob.size;
    while (memoryPreviews.size > MAX_ENTRIES || memoryBytes > 32 * 1024 * 1024) {
      const oldestKey = memoryPreviews.keys().next().value;
      if (!oldestKey || oldestKey === key) break;
      const oldest = memoryPreviews.get(oldestKey)!;
      memoryPreviews.delete(oldestKey);
      memoryBytes -= oldest.blob.size;
      URL.revokeObjectURL(oldest.url);
    }
    return cached;
  });
  pending.set(key, request);
  void request.finally(() => { if (pending.get(key) === request) pending.delete(key); }).catch(() => {});
  return request;
}
