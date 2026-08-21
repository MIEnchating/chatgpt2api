export const PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY = "chatgpt2api:profile_relay_token_name";

export type RelayTokenSelectionIdentity = {
  provider?: string | null;
  subjectId?: string | null;
  username?: string | null;
  name?: string | null;
};

function normalizedIdentityPart(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function relayTokenNameStorageKey(identity: RelayTokenSelectionIdentity) {
  const provider = normalizedIdentityPart(identity.provider) || "local";
  const owner =
    normalizedIdentityPart(identity.subjectId) ||
    normalizedIdentityPart(identity.username) ||
    normalizedIdentityPart(identity.name) ||
    "anonymous";
  return `${PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY}:v2:${encodeURIComponent(`${provider}:${owner}`)}`;
}

export function getStoredRelayTokenName(identity: RelayTokenSelectionIdentity) {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(relayTokenNameStorageKey(identity)) || "";
}

export function storeRelayTokenName(identity: RelayTokenSelectionIdentity, tokenName: string) {
  if (typeof window === "undefined") {
    return;
  }
  const normalizedName = tokenName.trim();
  const storageKey = relayTokenNameStorageKey(identity);
  window.localStorage.removeItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY);
  if (normalizedName) {
    window.localStorage.setItem(storageKey, normalizedName);
  } else {
    window.localStorage.removeItem(storageKey);
  }
}

export function retainSelectedRelayTokenName(current: string, options: string[]) {
  const normalized = current.trim();
  return normalized && options.includes(normalized) ? normalized : "";
}
