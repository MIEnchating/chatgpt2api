import type { StoredAuthSession } from "@/store/auth";

export const LEGACY_IMAGE_CONVERSATION_DATABASE_NAME = "chatgpt2api";
export const LEGACY_IMAGE_CONVERSATION_STORE_NAME = "image_conversations";
export const LEGACY_IMAGE_CONVERSATION_KEY_PREFIX = "items";
export const LEGACY_IMAGE_CONVERSATION_MIGRATION_VERSION = 1;
const LEGACY_MIGRATION_MARKER_PREFIX = "chatgpt2api:image-conversations-migration";
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024;

export type LegacyImageConversationSession = Pick<
  StoredAuthSession,
  "key" | "role" | "subjectId" | "provider"
>;

export type LegacyImageConversationMigrationResult = {
  status: "completed" | "skipped" | "empty" | "failed" | "aborted";
  scope: string;
  migrated: number;
  gone: number;
  error?: string;
};

export function isLegacyImageConversationGoneStatus(value: unknown) {
  return Number(value) === 410;
}

export function legacyImageConversationScope(
  session: LegacyImageConversationSession | null | undefined,
) {
  if (!session) {
    return "anonymous";
  }
  const subjectId = String(session.subjectId || "").trim();
  if (!subjectId) {
    return `${String(session.provider || "local").trim() || "local"}:${session.role}:unknown`;
  }
  return `${String(session.provider || "local").trim() || "local"}:${session.role}:${subjectId}`;
}

export function legacyImageConversationStorageKey(
  session: LegacyImageConversationSession | null | undefined,
) {
  return `${LEGACY_IMAGE_CONVERSATION_KEY_PREFIX}:${legacyImageConversationScope(session)}`;
}

function stableScopeHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function legacyImageConversationMigrationMarkerKey(
  session: LegacyImageConversationSession | null | undefined,
) {
  return `${LEGACY_MIGRATION_MARKER_PREFIX}:v${LEGACY_IMAGE_CONVERSATION_MIGRATION_VERSION}:${stableScopeHash(legacyImageConversationScope(session))}`;
}

function serializedByteLength(value: unknown) {
  let serialized = "";
  try {
    serialized = JSON.stringify(value) || "";
  } catch {
    serialized = "";
  }
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(serialized).byteLength;
  }
  return serialized.length;
}

export function normalizeLegacyImageConversationItems(value: unknown): Record<string, unknown>[] {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const candidate of source) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const item = candidate as Record<string, unknown>;
    const id = String(item.id || "").trim();
    if (!id) {
      continue;
    }
    byId.set(id, { ...item, id });
  }
  return [...byId.values()];
}

export function validateLegacyImageConversationItems(value: unknown) {
  if (value === null || value === undefined) {
    return { valid: true, items: [] as Record<string, unknown>[] };
  }
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : null;
  if (!source) {
    return { valid: false, items: [] as Record<string, unknown>[] };
  }
  const ids = new Set<string>();
  for (const candidate of source) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { valid: false, items: [] as Record<string, unknown>[] };
    }
    const id = String((candidate as { id?: unknown }).id || "").trim();
    if (!id || ids.has(id)) {
      return { valid: false, items: [] as Record<string, unknown>[] };
    }
    ids.add(id);
  }
  return {
    valid: true,
    items: normalizeLegacyImageConversationItems(value),
  };
}

export function splitLegacyImageConversationItems(
  items: ReadonlyArray<Record<string, unknown>>,
  maxItems = DEFAULT_BATCH_SIZE,
  maxBytes = DEFAULT_BATCH_BYTES,
) {
  const itemLimit = Math.max(1, Math.floor(Number(maxItems) || DEFAULT_BATCH_SIZE));
  const byteLimit = Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_BATCH_BYTES));
  const batches: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const itemBytes = serializedByteLength(item);
    if (current.length > 0 && (current.length >= itemLimit || currentBytes + itemBytes > byteLimit)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

export function legacyImageConversationResponseIds(response: {
  items?: unknown;
  acknowledgements?: unknown;
  id?: unknown;
  accepted?: unknown;
  gone?: unknown;
}) {
  const confirmed = new Set<string>();
  if (Array.isArray(response.items)) {
    for (const item of response.items) {
      if (item && typeof item === "object") {
        const id = String((item as { id?: unknown }).id || "").trim();
        if (id) {
          confirmed.add(id);
        }
      }
    }
  }
  if (response.id !== undefined && (response.accepted === true || response.gone === true)) {
    const id = String(response.id || "").trim();
    if (id) {
      confirmed.add(id);
    }
  }
  if (Array.isArray(response.acknowledgements)) {
    for (const acknowledgement of response.acknowledgements) {
      if (!acknowledgement || typeof acknowledgement !== "object") {
        continue;
      }
      const value = acknowledgement as { id?: unknown; accepted?: unknown; gone?: unknown };
      if (value.accepted === true || value.gone === true) {
        const id = String(value.id || "").trim();
        if (id) {
          confirmed.add(id);
        }
      }
    }
  }
  return confirmed;
}
