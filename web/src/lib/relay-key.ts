export const RELAY_PUBLIC_BASE_URL = "https://relayai.tech";

const LEGACY_RELAY_API_KEY_STORAGE_KEY = "chatgpt2api:relay_api_key";
const LEGACY_RELAY_API_KEY_STORAGE_KEY_PREFIX = "chatgpt2api:relay_api_key:user:";

export function clearStoredRelayApiKey() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(LEGACY_RELAY_API_KEY_STORAGE_KEY);
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(LEGACY_RELAY_API_KEY_STORAGE_KEY_PREFIX)) {
      window.localStorage.removeItem(key);
    }
  }
}
