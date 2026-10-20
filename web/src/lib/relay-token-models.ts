import type { RelayTokenModels } from "./relay-token-selection";

export const RELAY_TOKEN_MODELS_REFRESH_MS = 60_000;

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
  now = Date.now,
}: {
  tokenNames: string[];
  load: (options: { tokenName: string; signal: AbortSignal }) => Promise<unknown>;
  onChange: (snapshot: RelayTokenModelSnapshot) => void;
  now?: () => number;
}) {
  const names = Array.from(new Set(tokenNames));
  const controller = new AbortController();
  let snapshot = EMPTY_RELAY_TOKEN_MODEL_SNAPSHOT;
  let inFlight: Promise<void> | null = null;
  let refreshedAt: number | null = null;

  return {
    refresh(force = false): Promise<void> {
      if (controller.signal.aborted) return Promise.resolve();
      if (inFlight) return inFlight;
      if (!force && refreshedAt !== null && now() - refreshedAt < RELAY_TOKEN_MODELS_REFRESH_MS) return Promise.resolve();

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
        refreshedAt = now();
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
