import type { RelayTokenModels } from "./relay-token-selection";
import type { SettingsConfig } from "./api";

export const RELAY_MODEL_CONFIG_CHANGED_EVENT = "chatgpt2api:relay-model-config-changed";

export function relayModelSettingsSignature(config: SettingsConfig) {
  return JSON.stringify([
    config.relay_base_url, config.proxy, config.allow_user_custom_relay_config,
    config.relay_database_type, config.relay_database_driver,
    config.relay_database_host, config.relay_database_port,
    config.relay_database_name, config.relay_database_user,
    config.relay_text_group, config.relay_image_group,
    config.relay_video_group, config.relay_audio_group,
  ]);
}

export type RelayTokenModelSnapshot = {
  modelsByToken: RelayTokenModels;
  failedModelTokenNames: string[];
  ready: boolean;
  refreshing: boolean;
};

export const EMPTY_RELAY_TOKEN_MODEL_SNAPSHOT: RelayTokenModelSnapshot = {
  modelsByToken: {},
  failedModelTokenNames: [],
  ready: false,
  refreshing: false,
};

function modelNamesFromResponse(response: unknown): string[] {
  if (!response || typeof response !== "object" || !("data" in response) || !Array.isArray(response.data)) {
    throw new Error("模型列表响应格式无效");
  }
  const names = response.data.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !item.id.trim()) {
      throw new Error("模型列表中包含无效模型");
    }
    return item.id.trim();
  });
  return Array.from(new Set(names));
}

export function createRelayTokenModelLoader({
  tokenNames,
  load,
  onChange,
}: {
  tokenNames: string[];
  load: (options: { tokenName: string; signal: AbortSignal }) => Promise<unknown>;
  onChange: (snapshot: RelayTokenModelSnapshot) => void;
}) {
  const names = Array.from(new Set(tokenNames));
  const controller = new AbortController();
  let snapshot = EMPTY_RELAY_TOKEN_MODEL_SNAPSHOT;
  let inFlight: Promise<void> | null = null;

  return {
    refresh(): Promise<void> {
      if (controller.signal.aborted) return Promise.resolve();
      if (inFlight) return inFlight;

      snapshot = { ...snapshot, refreshing: true };
      onChange(snapshot);
      inFlight = Promise.all(names.map(async (name) => {
        try {
          const response = await load({ tokenName: name, signal: controller.signal });
          return { name, models: modelNamesFromResponse(response), failed: false };
        } catch {
          return { name, models: [] as string[], failed: true };
        }
      })).then((entries) => {
        if (controller.signal.aborted) return;
        snapshot = {
          modelsByToken: Object.fromEntries(entries.map((entry) => [entry.name, entry.models])),
          failedModelTokenNames: entries.filter((entry) => entry.failed).map((entry) => entry.name),
          ready: true,
          refreshing: false,
        };
        onChange(snapshot);
      }).finally(() => { inFlight = null; });
      return inFlight;
    },
    dispose() {
      controller.abort();
    },
  };
}
