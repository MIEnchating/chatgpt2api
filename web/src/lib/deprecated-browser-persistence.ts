import { getRememberedLogin } from "@/lib/remembered-login";

const DEPRECATED_EXACT_KEYS = new Set([
  "chatgpt2api:image_generation_response_format_b64_json",
  "chatgpt2api:image_generation_codex_cli_compatibility",
  "chatgpt2api:image_generation_snap_to_multiple_16",
  "chatgpt2api:image_similar_intent",
  "chatgpt2api:canvas_default_image_count",
  "chatgpt2api:prompt-source-pull-states:v1",
  "chatgpt2api:prompt-source-last-run:v1",
  "yunmian-canvas-mini-map-open",
]);

const DEPRECATED_KEY_PREFIXES = [
  "chatgpt2api:image_last_",
  "chatgpt2api:profile_relay_token_name:",
  "yunmian:my-assets:",
];

export function purgeDeprecatedBrowserPersistence() {
  if (typeof window === "undefined") return;
  getRememberedLogin();
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (!key) continue;
      if (DEPRECATED_EXACT_KEYS.has(key) || DEPRECATED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Cleanup is best-effort when browser storage is unavailable.
  }
}
