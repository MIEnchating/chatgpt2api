import { createExpiringRequestCache, type ExpiringRequestCache } from "@/lib/expiring-request-cache";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { httpRequest } from "@/lib/request";

export type StorageConfig = {
  mode: string;
  localStorageEnabled: boolean;
  allowUserProvider: boolean;
  allowUserGlobalProvider: boolean;
};

type UserStorageProviderBase = {
  enabled: boolean;
  name: string;
  endpoint: string;
};

export type UserS3StorageProvider = UserStorageProviderBase & {
  type: "s3";
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  pathPrefix: string;
};

export type UserWebDAVStorageProvider = UserStorageProviderBase & {
  type: "webdav";
  pathPrefix: string;
  username: string;
  password: string;
};

export type UserStorageProvider = UserS3StorageProvider | UserWebDAVStorageProvider;
export type UserStorageProviders = { s3?: UserS3StorageProvider; webdav?: UserWebDAVStorageProvider };

type StorageProviderRequest = <T>(
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<T>;

const STORAGE_PROVIDER_CACHE_TTL = 30_000;

export function defaultUserStorageProvider(): UserS3StorageProvider {
  return {
    enabled: false,
    name: "我的 S3/R2",
    type: "s3",
    endpoint: "",
    region: "auto",
    bucket: "",
    accessKeyId: "",
    secretAccessKey: "",
    publicBaseUrl: "",
    pathPrefix: "assets",
  };
}

export function defaultUserWebDAVStorageProvider(): UserWebDAVStorageProvider {
  return {
    enabled: false,
    name: "我的 WebDAV",
    type: "webdav",
    endpoint: "",
    pathPrefix: "assets",
    username: "",
    password: "",
  };
}

export function createStorageProviderClient(
  request: StorageProviderRequest,
  ttlMilliseconds = STORAGE_PROVIDER_CACHE_TTL,
) {
  const configCache = createExpiringRequestCache<StorageConfig>(ttlMilliseconds);
  const providersCache = createExpiringRequestCache<UserStorageProviders>(ttlMilliseconds);
  let scopeRevision = 0;

  const currentRequest = async <T>(cache: ExpiringRequestCache<T>, load: () => Promise<T>): Promise<T> => {
    for (;;) {
      const requestRevision = scopeRevision;
      try {
        const value = await cache.get(load);
        if (requestRevision === scopeRevision) return value;
      } catch (error) {
        if (requestRevision === scopeRevision) throw error;
      }
    }
  };

  const fetchConfig = () => currentRequest(configCache, async () => {
    const response = await request<{ config: StorageConfig }>("/api/storage/config");
    return response.config;
  });
  const fetchProviders = () => currentRequest(providersCache, async () => {
    const response = await request<{ provider: UserStorageProviders }>("/api/profile/storage-provider");
    return response.provider;
  });
  const invalidate = () => {
    scopeRevision += 1;
    configCache.clear();
    providersCache.clear();
  };

  return {
    fetchStorageConfig: fetchConfig,
    fetchUserStorageProviders: fetchProviders,
    invalidate,
    async updateUserStorageProviders(provider: UserStorageProviders) {
      const mutationRevision = scopeRevision;
      const storeResponse = providersCache.beginStore();
      try {
        const response = await request<{ provider: UserStorageProviders }>("/api/profile/storage-provider", {
          method: "POST",
          body: { provider },
        });
        if (mutationRevision !== scopeRevision) return fetchProviders();
        return storeResponse(response.provider);
      } catch (error) {
        if (mutationRevision !== scopeRevision) return fetchProviders();
        throw error;
      }
    },
  };
}

const storageProviderClient = createStorageProviderClient(httpRequest);

if (typeof window !== "undefined") {
  window.addEventListener(AUTH_SESSION_CHANGE_EVENT, storageProviderClient.invalidate);
}

export function invalidateStorageProviderCache() {
  storageProviderClient.invalidate();
}

export function fetchStorageConfig() {
  return storageProviderClient.fetchStorageConfig();
}

export function fetchUserStorageProviders() {
  return storageProviderClient.fetchUserStorageProviders();
}

export function updateUserStorageProviders(provider: UserStorageProviders) {
  return storageProviderClient.updateUserStorageProviders(provider);
}

export async function measureUserStorageProvider(provider: UserStorageProvider) {
  return httpRequest<{ result: { bytes: number; limitBytes: number; overLimit: boolean; checkedAt: string; providerName: string } }>(
    "/api/profile/storage-provider/measure",
    { method: "POST", body: { provider } },
  );
}
