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

let storageConfigPromise: Promise<StorageConfig> | null = null;

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

export async function fetchStorageConfig() {
  storageConfigPromise ??= httpRequest<{ config: StorageConfig }>("/api/storage/config").then((value) => value.config);
  return storageConfigPromise;
}

export async function fetchUserStorageProviders() {
  const response = await httpRequest<{ provider: UserStorageProviders }>("/api/profile/storage-provider");
  return response.provider;
}

export async function updateUserStorageProviders(provider: UserStorageProviders) {
  const response = await httpRequest<{ provider: UserStorageProviders }>("/api/profile/storage-provider", {
    method: "POST",
    body: { provider },
  });
  return response.provider;
}

export async function measureUserStorageProvider(provider: UserStorageProvider) {
  return httpRequest<{ result: { bytes: number; limitBytes: number; overLimit: boolean; checkedAt: string; providerName: string } }>(
    "/api/profile/storage-provider/measure",
    { method: "POST", body: { provider } },
  );
}
