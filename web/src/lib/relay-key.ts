import type { StoredAuthSession } from "@/store/auth";

export const RELAY_API_KEY_STORAGE_KEY = "chatgpt2api:relay_api_key";
export const RELAY_API_KEY_CHANGED_EVENT = "chatgpt2api:relay-api-key-changed";
export const RELAY_PUBLIC_BASE_URL = "https://relayai.tech";

const RELAY_API_KEY_STORAGE_KEY_PREFIX = "chatgpt2api:relay_api_key:user:";

type RelayApiKeySession = Pick<StoredAuthSession, "provider" | "role" | "subjectId">;

function storageSegment(value: string) {
  return encodeURIComponent(value.trim());
}

export function relayApiKeyStorageKeyForSession(session: RelayApiKeySession | null | undefined) {
  const subjectId = session?.subjectId?.trim();
  if (!subjectId) {
    return "";
  }
  const provider = session?.provider?.trim() || "local";
  return `${RELAY_API_KEY_STORAGE_KEY_PREFIX}${storageSegment(provider)}:${storageSegment(subjectId)}`;
}

function migrateLegacyRelayApiKey(session: RelayApiKeySession | null | undefined, storageKey: string) {
  if (session?.role !== "admin") {
    return "";
  }
  const legacyValue = window.localStorage.getItem(RELAY_API_KEY_STORAGE_KEY)?.trim() || "";
  if (!legacyValue) {
    return "";
  }
  window.localStorage.setItem(storageKey, legacyValue);
  window.localStorage.removeItem(RELAY_API_KEY_STORAGE_KEY);
  return legacyValue;
}

export function getStoredRelayApiKey(session?: RelayApiKeySession | null) {
  if (typeof window === "undefined") {
    return "";
  }
  const storageKey = relayApiKeyStorageKeyForSession(session);
  if (!storageKey) {
    return "";
  }
  return window.localStorage.getItem(storageKey) || migrateLegacyRelayApiKey(session, storageKey);
}

export function saveStoredRelayApiKey(value: string, session?: RelayApiKeySession | null) {
  if (typeof window === "undefined") {
    return;
  }
  const storageKey = relayApiKeyStorageKeyForSession(session);
  if (!storageKey) {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    window.localStorage.setItem(storageKey, trimmed);
  } else {
    window.localStorage.removeItem(storageKey);
  }
  window.localStorage.removeItem(RELAY_API_KEY_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(RELAY_API_KEY_CHANGED_EVENT, { detail: { storageKey } }));
}
