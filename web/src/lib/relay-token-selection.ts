export const PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY = "chatgpt2api:profile_relay_token_name";

export type RelayTokenKind = "image" | "video";

export type RelayTokenSelectionIdentity = {
  provider?: string | null;
  subjectId?: string | null;
  username?: string | null;
  name?: string | null;
};

function normalizedIdentityPart(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function relayTokenSelectionOwner(identity: RelayTokenSelectionIdentity) {
  const provider = normalizedIdentityPart(identity.provider) || "local";
  const owner =
    normalizedIdentityPart(identity.subjectId) ||
    normalizedIdentityPart(identity.username) ||
    normalizedIdentityPart(identity.name) ||
    "anonymous";
  return encodeURIComponent(`${provider}:${owner}`);
}

function legacyRelayTokenNameStorageKey(identity: RelayTokenSelectionIdentity) {
  return `${PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY}:v2:${relayTokenSelectionOwner(identity)}`;
}

export function relayTokenNameStorageKey(identity: RelayTokenSelectionIdentity, kind: RelayTokenKind) {
  return `${PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY}:v3:${relayTokenSelectionOwner(identity)}:${kind}`;
}

export function getStoredRelayTokenName(identity: RelayTokenSelectionIdentity, kind: RelayTokenKind) {
  if (typeof window === "undefined") {
    return "";
  }
  const selectedName = window.localStorage.getItem(relayTokenNameStorageKey(identity, kind));
  if (selectedName !== null) {
    return selectedName;
  }
  return window.localStorage.getItem(legacyRelayTokenNameStorageKey(identity)) || "";
}

export function storeRelayTokenName(
  identity: RelayTokenSelectionIdentity,
  kind: RelayTokenKind,
  tokenName: string,
) {
  if (typeof window === "undefined") {
    return;
  }
  const normalizedName = tokenName.trim();
  const storageKey = relayTokenNameStorageKey(identity, kind);
  window.localStorage.removeItem(PROFILE_RELAY_TOKEN_NAME_STORAGE_KEY);
  window.localStorage.setItem(storageKey, normalizedName);
}

export function retainSelectedRelayTokenName(current: string, options: string[]) {
  const normalized = current.trim();
  return normalized && options.includes(normalized) ? normalized : "";
}
