import webConfig from "@/constants/common-env";

const MANAGED_IMAGE_PREFIXES = ["/images/", "/image-references/", "/image-thumbnails/", "/conversation-assets/"] as const;
const MAX_CACHED_AUTHENTICATED_IMAGE_ENTRIES = 320;
const MAX_CACHED_AUTHENTICATED_IMAGE_BYTES = 160 * 1024 * 1024;

type CachedAuthenticatedImage = {
  objectURL: string;
  byteSize: number;
  references: number;
  lastUsedAt: number;
};

export type RetainedAuthenticatedImage = {
  key: string;
  objectURL: string;
  byteSize: number;
};

const authenticatedImageCache = new Map<string, CachedAuthenticatedImage>();
const pendingAuthenticatedImageFetches = new Map<string, Promise<{ key: string; objectURL: string; byteSize: number }>>();
const pendingAuthenticatedImageReservations = new Map<string, CachedAuthenticatedImage>();
let authenticatedImageCacheBytes = 0;
let authenticatedImageCacheGeneration = 0;

function isAbsoluteURL(value: string) {
  return /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//");
}

function browserBaseURL() {
  if (typeof window === "undefined") {
    return "http://localhost/";
  }
  return window.location.href;
}

function apiBaseURL() {
  const value = String(webConfig.apiUrl || "").trim();
  return value ? `${value.replace(/\/$/, "")}/` : "";
}

function isManagedImagePath(pathname: string) {
  return MANAGED_IMAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function touchCachedAuthenticatedImage(entry: CachedAuthenticatedImage) {
  entry.lastUsedAt = Date.now();
}

function retainAuthenticatedImageCacheEntry(key: string, entry: CachedAuthenticatedImage): RetainedAuthenticatedImage {
  touchCachedAuthenticatedImage(entry);
  entry.references += 1;
  return { key, objectURL: entry.objectURL, byteSize: entry.byteSize };
}

function reservePendingAuthenticatedImage(key: string, entry: CachedAuthenticatedImage) {
  if (pendingAuthenticatedImageReservations.get(key) === entry) return;
  entry.references += 1;
  pendingAuthenticatedImageReservations.set(key, entry);
}

function releasePendingAuthenticatedImageReservation(key: string) {
  const entry = pendingAuthenticatedImageReservations.get(key);
  if (!entry) return;
  pendingAuthenticatedImageReservations.delete(key);
  entry.references = Math.max(0, entry.references - 1);
}

function trimAuthenticatedImageCache() {
  while (
    authenticatedImageCache.size > MAX_CACHED_AUTHENTICATED_IMAGE_ENTRIES ||
    authenticatedImageCacheBytes > MAX_CACHED_AUTHENTICATED_IMAGE_BYTES
  ) {
    let evictableKey = "";
    let evictableEntry: CachedAuthenticatedImage | null = null;
    for (const [key, entry] of authenticatedImageCache) {
      if (entry.references > 0) {
        continue;
      }
      if (!evictableEntry || entry.lastUsedAt < evictableEntry.lastUsedAt) {
        evictableKey = key;
        evictableEntry = entry;
      }
    }
    if (!evictableEntry) {
      return;
    }
    URL.revokeObjectURL(evictableEntry.objectURL);
    authenticatedImageCacheBytes -= evictableEntry.byteSize;
    authenticatedImageCache.delete(evictableKey);
  }
}

function storeAuthenticatedImageCacheEntry(
  key: string,
  objectURL: string,
  byteSize: number,
  trim = true,
) {
  const existing = authenticatedImageCache.get(key);
  if (existing) {
    URL.revokeObjectURL(objectURL);
    touchCachedAuthenticatedImage(existing);
    return existing;
  }
  const entry = {
    objectURL,
    byteSize,
    references: 0,
    lastUsedAt: Date.now(),
  };
  authenticatedImageCache.set(key, entry);
  authenticatedImageCacheBytes += byteSize;
  if (trim) {
    trimAuthenticatedImageCache();
  }
  return entry;
}

async function decodeAuthenticatedImage(objectURL: string) {
  if (typeof Image === "undefined") return;
  const image = new Image();
  image.decoding = "async";
  if (typeof image.decode === "function") {
    image.src = objectURL;
    await image.decode();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("图片解码失败"));
    image.src = objectURL;
  });
}

export function resolveImageRequestURL(src: string) {
  const value = String(src || "").trim();
  if (!value) {
    return "";
  }

  const browserBase = browserBaseURL();
  const apiBase = apiBaseURL();
  if (!isAbsoluteURL(value) && value.startsWith("/") && apiBase) {
    const relativeCandidate = new URL(value, apiBase);
    if (isManagedImagePath(relativeCandidate.pathname)) {
      return relativeCandidate.toString();
    }
  }

  const candidate = new URL(value, browserBase);
  if (apiBase && isManagedImagePath(candidate.pathname)) {
    return new URL(`${candidate.pathname}${candidate.search}`, apiBase).toString();
  }

  return candidate.toString();
}

export function isManagedImageURL(src: string) {
  try {
    return isManagedImagePath(new URL(resolveImageRequestURL(src)).pathname);
  } catch {
    return false;
  }
}

export function shouldUseAuthenticatedImageFallback(src: string) {
  const value = String(src || "").trim();
  return Boolean(value) && !value.startsWith("data:") && !value.startsWith("blob:") && isManagedImageURL(value);
}

export async function fetchAuthenticatedImageBlob(src: string, signal?: AbortSignal) {
  const requestURL = resolveImageRequestURL(src);
  const managedImage = isManagedImageURL(src);

  const response = await fetch(requestURL, {
    signal,
    credentials: managedImage ? "include" : "same-origin",
  });
  if (!response.ok) {
    throw new Error(`读取图片失败 (${response.status})`);
  }
  return response.blob();
}

export function retainCachedAuthenticatedImage(src: string): RetainedAuthenticatedImage | null {
  const key = resolveImageRequestURL(src);
  const entry = authenticatedImageCache.get(key);
  return entry ? retainAuthenticatedImageCacheEntry(key, entry) : null;
}

export async function fetchCachedAuthenticatedImage(src: string): Promise<RetainedAuthenticatedImage> {
  const key = resolveImageRequestURL(src);
  const cached = authenticatedImageCache.get(key);
  if (cached) {
    return retainAuthenticatedImageCacheEntry(key, cached);
  }

  const generation = authenticatedImageCacheGeneration;
  let pending = pendingAuthenticatedImageFetches.get(key);
  if (!pending) {
    const fetchPromise = fetchAuthenticatedImageBlob(src)
      .then(async (blob) => {
        const objectURL = URL.createObjectURL(blob);
        try {
          await decodeAuthenticatedImage(objectURL);
          if (generation !== authenticatedImageCacheGeneration) {
            throw new Error("图片缓存已重置");
          }
          // The new entry has no external reference until the awaiting caller
          // resumes. Trimming here can evict that same entry when every older
          // cache entry is retained.
          const entry = storeAuthenticatedImageCacheEntry(key, objectURL, blob.size, false);
          reservePendingAuthenticatedImage(key, entry);
          return { key, objectURL, byteSize: blob.size };
        } catch (error) {
          URL.revokeObjectURL(objectURL);
          throw error;
        }
      });
    pending = fetchPromise.finally(() => {
      if (pendingAuthenticatedImageFetches.get(key) === pending) {
        pendingAuthenticatedImageFetches.delete(key);
      }
    });
    pendingAuthenticatedImageFetches.set(key, pending);
  }

  await pending;
  const entry = authenticatedImageCache.get(key);
  if (!entry) {
    releasePendingAuthenticatedImageReservation(key);
    throw new Error("图片缓存不可用");
  }
  const retained = retainAuthenticatedImageCacheEntry(key, entry);
  releasePendingAuthenticatedImageReservation(key);
  trimAuthenticatedImageCache();
  return retained;
}

export async function primeAuthenticatedImageCache(src: string, blob: Blob) {
  const key = resolveImageRequestURL(src);
  if (!key || authenticatedImageCache.has(key)) return;
  const generation = authenticatedImageCacheGeneration;
  let objectURL = "";
  try {
    objectURL = URL.createObjectURL(blob);
    await decodeAuthenticatedImage(objectURL);
    if (generation !== authenticatedImageCacheGeneration) {
      throw new Error("图片缓存已重置");
    }
    storeAuthenticatedImageCacheEntry(key, objectURL, blob.size);
  } catch (error) {
    if (objectURL) URL.revokeObjectURL(objectURL);
    throw error;
  }
}

export function releaseCachedAuthenticatedImage(key: string) {
  const entry = authenticatedImageCache.get(key);
  if (!entry) {
    return;
  }
  entry.references = Math.max(0, entry.references - 1);
  touchCachedAuthenticatedImage(entry);
  trimAuthenticatedImageCache();
}

export function getCachedAuthenticatedImageByteSize(src?: string) {
  if (!src) return 0;
  try {
    const entry = authenticatedImageCache.get(resolveImageRequestURL(src));
    if (!entry) {
      return 0;
    }
    touchCachedAuthenticatedImage(entry);
    return entry.byteSize;
  } catch {
    return 0;
  }
}

export function clearAuthenticatedImageCache() {
  authenticatedImageCacheGeneration += 1;
  pendingAuthenticatedImageFetches.clear();
  pendingAuthenticatedImageReservations.clear();
  for (const entry of authenticatedImageCache.values()) {
    URL.revokeObjectURL(entry.objectURL);
  }
  authenticatedImageCache.clear();
  authenticatedImageCacheBytes = 0;
}
