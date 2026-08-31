export type RelayTokenKind = "text" | "image" | "video" | "audio";

export type RelayTokenNames = Record<RelayTokenKind, string[]>;
export type RelayTokenModels = Record<string, string[]>;
export type RelayTokenRouteStatus = "loading" | "missing-selection" | "model-list-error" | "model-unavailable" | "ready";
export type RelayTokenRoute = { status: RelayTokenRouteStatus; tokenName: string };
export type RelayTokenAvailability = { authoritative: boolean; names: string[] };

export const EMPTY_RELAY_TOKEN_NAMES: RelayTokenNames = {
  text: [],
  image: [],
  video: [],
  audio: [],
};

type RelayTokenPreferenceSource = {
  default_text_relay_token_names?: unknown;
  default_image_relay_token_names?: unknown;
  default_video_relay_token_names?: unknown;
  default_audio_relay_token_names?: unknown;
};

function normalizeRelayTokenNames(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((name) => String(name || "").trim()).filter(Boolean))).slice(0, 20);
}

export function relayTokenNamesFromPreferences(value: RelayTokenPreferenceSource | null | undefined): RelayTokenNames {
  return {
    text: normalizeRelayTokenNames(value?.default_text_relay_token_names),
    image: normalizeRelayTokenNames(value?.default_image_relay_token_names),
    video: normalizeRelayTokenNames(value?.default_video_relay_token_names),
    audio: normalizeRelayTokenNames(value?.default_audio_relay_token_names),
  };
}

export function relayTokenPreferencesFromNames(value: RelayTokenNames) {
  return {
    default_text_relay_token_names: normalizeRelayTokenNames(value.text),
    default_image_relay_token_names: normalizeRelayTokenNames(value.image),
    default_video_relay_token_names: normalizeRelayTokenNames(value.video),
    default_audio_relay_token_names: normalizeRelayTokenNames(value.audio),
  };
}

export function relayTokenPreferenceField(kind: RelayTokenKind) {
  return `default_${kind}_relay_token_names` as const;
}

export function retainSelectedRelayTokenNames(current: string[], options: string[]) {
  const available = new Set(options);
  return normalizeRelayTokenNames(current).filter((name) => available.has(name));
}

export function relayTokenAvailabilityFromBalance(
  value: { has_balance?: unknown; token_names?: unknown } | null | undefined,
): RelayTokenAvailability {
  if (value?.has_balance !== true || !Array.isArray(value.token_names)) {
    return { authoritative: false, names: [] };
  }
  return { authoritative: true, names: normalizeRelayTokenNames(value.token_names) };
}

export function relayTokenNamesUpdateForAvailability(
  current: string[],
  availability: RelayTokenAvailability,
  additionalOptions: string[] = [],
) {
  if (!availability.authoritative) return null;
  const retained = retainSelectedRelayTokenNames(current, [...availability.names, ...additionalOptions]);
  return retained.join("\0") === normalizeRelayTokenNames(current).join("\0") ? null : retained;
}

export function relayTokenNameForModel(names: string[], model: string, modelsByToken: RelayTokenModels) {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) return names[0] || "";
  return names.find((name) => (modelsByToken[name] || []).some((candidate) => candidate.trim().toLowerCase() === normalizedModel)) || "";
}

export function relayTokenRouteForModel(
  names: string[],
  model: string,
  modelsByToken: RelayTokenModels,
  failedTokenNames: readonly string[],
  ready: boolean,
): RelayTokenRoute {
  if (!ready) return { status: "loading", tokenName: "" };
  if (names.length === 0) return { status: "missing-selection", tokenName: "" };
  const tokenName = relayTokenNameForModel(names, model, modelsByToken);
  if (tokenName) return { status: "ready", tokenName };
  const failed = new Set(failedTokenNames);
  if (names.some((name) => failed.has(name))) return { status: "model-list-error", tokenName: "" };
  return { status: "model-unavailable", tokenName: "" };
}
