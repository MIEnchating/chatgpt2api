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
const authenticatedImageCacheKeyGenerations = new Map<string, number>();
const authenticatedImageKeyOperations = new Map<string, number>();
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

function normalizeManagedCachePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function decodedPathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function managedImageSourcePathFromURL(value: string) {
  try {
    const pathname = new URL(value).pathname;
    if (pathname.startsWith("/images/")) {
      return normalizeManagedCachePath(decodedPathSegment(pathname.slice("/images/".length)));
    }
    if (pathname.startsWith("/image-thumbnails/")) {
      const thumbnailPath = decodedPathSegment(pathname.slice("/image-thumbnails/".length));
      return normalizeManagedCachePath(thumbnailPath.replace(/\.jpg$/i, ""));
    }
    if (pathname.startsWith("/image-references/")) {
      const referencePath = normalizeManagedCachePath(decodedPathSegment(pathname.slice("/image-references/".length)));
      const markerIndex = referencePath.lastIndexOf(".refs/");
      return markerIndex > 0 ? referencePath.slice(0, markerIndex) : referencePath;
    }
    if (pathname.startsWith("/conversation-assets/")) {
      return normalizeManagedCachePath(decodedPathSegment(pathname.slice("/conversation-assets/".length)));
    }
  } catch {
    // Ignore invalid cache keys; they cannot match managed image paths.
  }
  return "";
}

function touchCachedAuthenticatedImage(entry: CachedAuthenticatedImage) {
  entry.lastUsedAt = Date.now();
}

function retainAuthenticatedImageCacheEntry(key: string, entry: CachedAuthenticatedImage): RetainedAuthenticatedImage {
  touchCachedAuthenticatedImage(entry);
  entry.references += 1;
  return { key, objectURL: entry.objectURL, byteSize: entry.byteSize };
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

function storeAuthenticatedImageCacheEntry(key: string, objectURL: string, byteSize: number) {
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
  trimAuthenticatedImageCache();
  return entry;
}

function authenticatedImageKeyGeneration(key: string) {
  return authenticatedImageCacheKeyGenerations.get(key) ?? 0;
}

function beginAuthenticatedImageKeyOperation(key: string) {
  authenticatedImageKeyOperations.set(key, (authenticatedImageKeyOperations.get(key) ?? 0) + 1);
  return authenticatedImageKeyGeneration(key);
}

function finishAuthenticatedImageKeyOperation(key: string) {
  const remaining = (authenticatedImageKeyOperations.get(key) ?? 1) - 1;
  if (remaining > 0) {
    authenticatedImageKeyOperations.set(key, remaining);
    return;
  }
  authenticatedImageKeyOperations.delete(key);
  authenticatedImageCacheKeyGenerations.delete(key);
}

function invalidateAuthenticatedImageKey(key: string) {
  if ((authenticatedImageKeyOperations.get(key) ?? 0) > 0) {
    authenticatedImageCacheKeyGenerations.set(key, authenticatedImageKeyGeneration(key) + 1);
  } else {
    authenticatedImageCacheKeyGenerations.delete(key);
  }
  pendingAuthenticatedImageFetches.delete(key);
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
    const keyGeneration = beginAuthenticatedImageKeyOperation(key);
    const fetchPromise = fetchAuthenticatedImageBlob(src)
      .then(async (blob) => {
        const objectURL = URL.createObjectURL(blob);
        try {
          await decodeAuthenticatedImage(objectURL);
          if (generation !== authenticatedImageCacheGeneration || keyGeneration !== authenticatedImageKeyGeneration(key)) {
            throw new Error("图片缓存已重置");
          }
          storeAuthenticatedImageCacheEntry(key, objectURL, blob.size);
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
      finishAuthenticatedImageKeyOperation(key);
    });
    pendingAuthenticatedImageFetches.set(key, pending);
  }

  await pending;
  const entry = authenticatedImageCache.get(key);
  if (!entry) {
    throw new Error("图片缓存不可用");
  }
  return retainAuthenticatedImageCacheEntry(key, entry);
}

export async function primeAuthenticatedImageCache(src: string, blob: Blob) {
  const key = resolveImageRequestURL(src);
  if (!key || authenticatedImageCache.has(key)) return;
  const generation = authenticatedImageCacheGeneration;
  const keyGeneration = beginAuthenticatedImageKeyOperation(key);
  let objectURL = "";
  try {
    objectURL = URL.createObjectURL(blob);
    await decodeAuthenticatedImage(objectURL);
    if (generation !== authenticatedImageCacheGeneration || keyGeneration !== authenticatedImageKeyGeneration(key)) {
      throw new Error("图片缓存已重置");
    }
    storeAuthenticatedImageCacheEntry(key, objectURL, blob.size);
  } catch (error) {
    if (objectURL) URL.revokeObjectURL(objectURL);
    throw error;
  } finally {
    finishAuthenticatedImageKeyOperation(key);
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

export function getCachedAuthenticatedImageByteSize(src: string) {
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

export function invalidateAuthenticatedImageCacheForPaths(paths: string[]) {
  const pathSet = new Set(paths.map(normalizeManagedCachePath));
  const keys = new Set<string>();
  for (const key of authenticatedImageCache.keys()) {
    const sourcePath = managedImageSourcePathFromURL(key);
    if (sourcePath && pathSet.has(sourcePath)) {
      keys.add(key);
    }
  }
  for (const key of pendingAuthenticatedImageFetches.keys()) {
    const sourcePath = managedImageSourcePathFromURL(key);
    if (sourcePath && pathSet.has(sourcePath)) {
      keys.add(key);
    }
  }
  for (const key of authenticatedImageKeyOperations.keys()) {
    const sourcePath = managedImageSourcePathFromURL(key);
    if (sourcePath && pathSet.has(sourcePath)) {
      keys.add(key);
    }
  }

  for (const key of keys) {
    invalidateAuthenticatedImageKey(key);
    const entry = authenticatedImageCache.get(key);
    if (entry) {
      URL.revokeObjectURL(entry.objectURL);
      authenticatedImageCacheBytes -= entry.byteSize;
      authenticatedImageCache.delete(key);
    }
  }
}

export function clearAuthenticatedImageCache() {
  authenticatedImageCacheGeneration += 1;
  pendingAuthenticatedImageFetches.clear();
  authenticatedImageCacheKeyGenerations.clear();
  for (const entry of authenticatedImageCache.values()) {
    URL.revokeObjectURL(entry.objectURL);
  }
  authenticatedImageCache.clear();
  authenticatedImageCacheBytes = 0;
}
