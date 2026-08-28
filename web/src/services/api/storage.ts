import { httpRequest } from "@/lib/request";

type StorageObjectInfo = {
  id: string;
  objectKey: string;
  publicUrl: string;
  mimeType: string;
  bytes: number;
  direct: boolean;
};

type StorageObjectResponse<T> = {
  object?: T;
  detail?: string | { error?: string };
};

async function getStorageObjectInfo(id: string) {
  const response = await httpRequest<{ object: StorageObjectInfo }>(`/api/files/${encodeURIComponent(id)}`);
  return response.object;
}

export async function uploadStorageObject<T>(blob: Blob, filename: string, fallbackMessage: string): Promise<T> {
  const formData = new FormData();
  formData.append("file", blob, filename);
  const response = await fetch("/api/files", { method: "POST", credentials: "include", body: formData });
  const payload = await response.json().catch(() => null) as StorageObjectResponse<T> | null;
  if (!response.ok || !payload?.object) throw new Error(storageResponseMessage(payload, fallbackMessage));
  return payload.object;
}

export async function resolveStorageObjectURL(storageKey?: string, fallback = "") {
  if (!storageKey?.startsWith("server:")) return fallback;
  const id = storageKey.slice("server:".length);
  if (!id) return fallback;
  const info = await getStorageObjectInfo(id).catch(() => null);
  if (!info) return fallback;
  return info.publicUrl || `/api/files/${encodeURIComponent(id)}/content`;
}

export async function getStorageObjectBlob(storageKey: string) {
  const url = await resolveStorageObjectURL(storageKey);
  if (!url) return null;
  const response = await fetch(url, { credentials: "include" });
  return response.ok ? response.blob() : null;
}

export async function deleteStorageObjects(keys: Iterable<string>, fallbackMessage: string) {
  await Promise.all(Array.from(new Set(keys)).map(async (storageKey) => {
    if (!storageKey.startsWith("server:")) return;
    const id = storageKey.slice("server:".length);
    if (!id) return;
    const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(storageResponseMessage(await response.json().catch(() => null), fallbackMessage));
    }
  }));
}

function storageResponseMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && typeof (detail as { error?: unknown }).error === "string") {
    return String((detail as { error: string }).error);
  }
  return fallback;
}
