export const RELAY_API_KEY_STORAGE_KEY = "chatgpt2api:relay_api_key";
export const RELAY_API_KEY_CHANGED_EVENT = "chatgpt2api:relay-api-key-changed";

export function getStoredRelayApiKey() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(RELAY_API_KEY_STORAGE_KEY) || "";
}

export function saveStoredRelayApiKey(value: string) {
  if (typeof window === "undefined") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    window.localStorage.setItem(RELAY_API_KEY_STORAGE_KEY, trimmed);
  } else {
    window.localStorage.removeItem(RELAY_API_KEY_STORAGE_KEY);
  }
  window.dispatchEvent(new CustomEvent(RELAY_API_KEY_CHANGED_EVENT));
}
