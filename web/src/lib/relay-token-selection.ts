export type RelayTokenKind = "text" | "image" | "video" | "audio";
export const RELAY_TOKEN_KINDS = ["text", "image", "video", "audio"] as const;

export type RelayTokenNames = Record<RelayTokenKind, string>;

export const EMPTY_RELAY_TOKEN_NAMES: RelayTokenNames = {
  text: "",
  image: "",
  video: "",
  audio: "",
};

type RelayTokenPreferenceSource = {
  default_text_relay_token_name?: unknown;
  default_image_relay_token_name?: unknown;
  default_video_relay_token_name?: unknown;
  default_audio_relay_token_name?: unknown;
};

export function relayTokenNamesFromPreferences(value: RelayTokenPreferenceSource | null | undefined): RelayTokenNames {
  return {
    text: String(value?.default_text_relay_token_name || "").trim(),
    image: String(value?.default_image_relay_token_name || "").trim(),
    video: String(value?.default_video_relay_token_name || "").trim(),
    audio: String(value?.default_audio_relay_token_name || "").trim(),
  };
}

export function relayTokenPreferenceField(kind: RelayTokenKind) {
  return `default_${kind}_relay_token_name` as const;
}

export function retainSelectedRelayTokenName(current: string, options: string[]) {
  const normalized = current.trim();
  return normalized && options.includes(normalized) ? normalized : "";
}
