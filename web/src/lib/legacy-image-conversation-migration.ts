import localforage from "localforage";

import {
  fetchImageConversationHistoryItem,
  mergeImageConversationHistory,
  type ImageConversationHistoryMergeResponse,
} from "@/app/image/image-conversation-history-api";
import { rebaseImageConversationSnapshot } from "@/app/image/image-task-state";
import { getCachedAuthSession } from "@/lib/session";
import { getStoredAuthSession } from "@/store/auth";
import {
  classifyImageConversationMergeAcknowledgements,
  type ImageConversationAcknowledgementResult,
} from "@/store/image-conversation-session-scope";
import type { ImageConversation } from "@/store/image-conversations";
import {
  LEGACY_IMAGE_CONVERSATION_DATABASE_NAME,
  LEGACY_IMAGE_CONVERSATION_KEY_PREFIX,
  LEGACY_IMAGE_CONVERSATION_MIGRATION_VERSION,
  LEGACY_IMAGE_CONVERSATION_STORE_NAME,
  isLegacyImageConversationGoneStatus,
  legacyImageConversationMigrationMarkerKey,
  legacyImageConversationResponseIds,
  legacyImageConversationScope,
  legacyImageConversationStorageKey,
  splitLegacyImageConversationItems,
  validateLegacyImageConversationItems,
  type LegacyImageConversationMigrationResult,
  type LegacyImageConversationSession,
} from "@/lib/legacy-image-conversation-migration-pure";

export class LegacyImageConversationMigrationScopeChangedError extends Error {
  readonly code = "LEGACY_IMAGE_CONVERSATION_MIGRATION_SCOPE_CHANGED";

  constructor() {
    super("登录账号已切换，旧图片历史迁移已取消");
    this.name = "LegacyImageConversationMigrationScopeChangedError";
  }
}

function requestErrorStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return 0;
  }
  return Number((error as { status?: unknown }).status) || 0;
}

function isGoneStatus(error: unknown) {
  const status = requestErrorStatus(error);
  // A detail 404 only proves that the item is currently absent. It can also
  // follow an uncommitted/rolled-back batch and must not authorize deleting
  // the only local copy. Only an explicit tombstone response is final.
  return isLegacyImageConversationGoneStatus(status);
}

function isSameMigrationSession(
  expected: LegacyImageConversationSession,
  current: LegacyImageConversationSession | null | undefined,
) {
  return Boolean(current) &&
    String(current?.key || "") === String(expected.key || "") &&
    legacyImageConversationScope(current) === legacyImageConversationScope(expected);
}

async function assertMigrationSession(expected: LegacyImageConversationSession) {
  const cached = getCachedAuthSession();
  const current = cached === undefined ? await getStoredAuthSession() : cached;
  if (!isSameMigrationSession(expected, current)) {
    throw new LegacyImageConversationMigrationScopeChangedError();
  }
}

function legacyStorage() {
  if (typeof window === "undefined") {
    throw new Error("旧图片历史迁移只能在浏览器中运行");
  }
  return localforage.createInstance({
    name: LEGACY_IMAGE_CONVERSATION_DATABASE_NAME,
    storeName: LEGACY_IMAGE_CONVERSATION_STORE_NAME,
  });
}

async function readLegacyItems(storage: ReturnType<typeof legacyStorage>, key: string) {
  const raw = await storage.getItem<unknown>(key);
  const validated = validateLegacyImageConversationItems(raw);
  if (!validated.valid) {
    throw new Error("旧图片历史数据格式无效，已保留原数据");
  }
  return validated.items;
}

function migrationAuthorization(session: LegacyImageConversationSession) {
  return {
    authorization: `Bearer ${String(session.key || "").trim()}`,
    redirectOnUnauthorized: false,
  };
}

function legacyAcknowledgement(
  response: ImageConversationHistoryMergeResponse,
  item: Record<string, unknown>,
): ImageConversationAcknowledgementResult {
  return classifyImageConversationMergeAcknowledgements(response, [
    item as { id: string; revision?: number },
  ])[0];
}

async function reconcileLegacyItem(
  item: Record<string, unknown>,
  session: LegacyImageConversationSession,
) {
  const id = String(item.id || "").trim();
  let candidate = item as unknown as ImageConversation;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let detail;
    try {
      detail = await fetchImageConversationHistoryItem(id, migrationAuthorization(session));
    } catch (error) {
      if (isGoneStatus(error)) {
        return { migrated: 0, gone: 1 };
      }
      // A plain 404 can follow a rolled-back batch. It does not prove that a
      // tombstone exists and therefore must leave the IndexedDB source intact.
      throw error;
    }
    if (!detail.item || typeof detail.item !== "object") {
      throw new Error(`迁移确认缺少会话: ${id}`);
    }
    candidate = rebaseImageConversationSnapshot(
      detail.item as unknown as ImageConversation,
      candidate,
    );
    let response: ImageConversationHistoryMergeResponse;
    try {
      response = await mergeImageConversationHistory(
        [candidate as unknown as Record<string, unknown>],
        migrationAuthorization(session),
      );
    } catch (error) {
      if (isGoneStatus(error)) {
        return { migrated: 0, gone: 1 };
      }
      if (requestErrorStatus(error) === 409) {
        continue;
      }
      throw error;
    }
    const acknowledgement = legacyAcknowledgement(
      response,
      candidate as unknown as Record<string, unknown>,
    );
    if (acknowledgement.outcome === "accepted") {
      return { migrated: 1, gone: 0 };
    }
    if (acknowledgement.outcome === "gone") {
      return { migrated: 0, gone: 1 };
    }
    if (acknowledgement.outcome !== "stale") {
      throw new Error(acknowledgement.message || `迁移确认响应无效: ${id}`);
    }
  }
  throw new Error(`迁移时会话持续发生冲突，已保留原数据: ${id}`);
}

async function persistLegacyBatch(
  items: ReadonlyArray<Record<string, unknown>>,
  session: LegacyImageConversationSession,
) {
  // The write endpoint returns acknowledgements only, so migrated Base64
  // images are never echoed back to the browser as a full history list.
  let response: ImageConversationHistoryMergeResponse;
  try {
    response = await mergeImageConversationHistory(
      [...items],
      migrationAuthorization(session),
    );
  } catch (error) {
    if (items.length === 1 && isGoneStatus(error)) {
      return { migrated: 0, gone: 1 };
    }
    if (items.length !== 1 || requestErrorStatus(error) !== 409) {
      throw error;
    }
    return reconcileLegacyItem(items[0], session);
  }
  const confirmedIds = legacyImageConversationResponseIds(response);
  let migrated = 0;
  let gone = 0;
  for (const item of items) {
    const id = String(item.id || "").trim();
    if (confirmedIds.has(id)) {
      migrated += 1;
      continue;
    }
    const acknowledgement = legacyAcknowledgement(response, item);
    if (acknowledgement.outcome === "gone") {
      gone += 1;
      continue;
    }
    if (acknowledgement.outcome !== "stale") {
      throw new Error(acknowledgement.message || `迁移确认响应无效: ${id}`);
    }
    const result = await reconcileLegacyItem(item, session);
    migrated += result.migrated;
    gone += result.gone;
  }
  return { migrated, gone };
}

async function cleanupLegacyStore(storage: ReturnType<typeof legacyStorage>, key: string) {
  await storage.removeItem(key);
  const remainingKeys = await storage.keys();
  if (remainingKeys.length > 0) {
    return;
  }
  // Remove the empty object store only after the current scoped key has been
  // deleted. Other users' keys therefore remain protected during migration.
  await storage.dropInstance();
}

const migrationPromises = new Map<string, Promise<LegacyImageConversationMigrationResult>>();

async function runLegacyImageConversationMigration(
  session: LegacyImageConversationSession,
): Promise<LegacyImageConversationMigrationResult> {
  const scope = legacyImageConversationScope(session);
  const key = legacyImageConversationStorageKey(session);
  const storage = legacyStorage();
  await assertMigrationSession(session);
  const items = await readLegacyItems(storage, key);
  const markerKey = legacyImageConversationMigrationMarkerKey(session);
  const marker = window.localStorage.getItem(markerKey);
  if (items.length === 0) {
    if (!marker) {
      window.localStorage.setItem(markerKey, JSON.stringify({
        version: LEGACY_IMAGE_CONVERSATION_MIGRATION_VERSION,
        scope,
        completedAt: new Date().toISOString(),
      }));
    }
    return { status: marker ? "skipped" : "empty", scope, migrated: 0, gone: 0 };
  }

  const sourceFingerprint = JSON.stringify(items);
  let migrated = 0;
  let gone = 0;
  for (const batch of splitLegacyImageConversationItems(items)) {
    await assertMigrationSession(session);
    const result = await persistLegacyBatch(batch, session);
    migrated += result.migrated;
    gone += result.gone;
  }

  await assertMigrationSession(session);
  const latestItems = await readLegacyItems(storage, key);
  if (JSON.stringify(latestItems) !== sourceFingerprint) {
    throw new Error("旧图片历史在迁移期间发生变化，已保留原数据");
  }
  await cleanupLegacyStore(storage, key);
  window.localStorage.setItem(markerKey, JSON.stringify({
    version: LEGACY_IMAGE_CONVERSATION_MIGRATION_VERSION,
    scope,
    completedAt: new Date().toISOString(),
    migrated,
    gone,
  }));
  // The image page may have loaded its first server page before this idle
  // migration completed. Notify mounted consumers so imported conversations
  // become visible immediately instead of waiting for a browser refresh.
  window.dispatchEvent(new CustomEvent("chatgpt2api:image-conversations-changed", {
    detail: { requiresRefresh: true },
  }));
  return { status: "completed", scope, migrated, gone };
}

/**
 * Migrate one authenticated user's old local history. The source key is only
 * removed after every batch has a server/detail confirmation. Any exception
 * leaves the old key and marker untouched, so a later call can retry safely.
 */
export function migrateLegacyImageConversations(
  session: LegacyImageConversationSession,
) {
  const scope = legacyImageConversationScope(session);
  // A token rotation for the same owner must be able to start a fresh run
  // after the old request observes the scope change.
  const migrationKey = `${scope}:${String(session.key || "")}`;
  const existing = migrationPromises.get(migrationKey);
  if (existing) {
    return existing;
  }
  const promise = runLegacyImageConversationMigration(session).catch((error): LegacyImageConversationMigrationResult => ({
    status: error instanceof LegacyImageConversationMigrationScopeChangedError ? "aborted" : "failed",
    scope,
    migrated: 0,
    gone: 0,
    error: error instanceof Error ? error.message : "旧图片历史迁移失败",
  })).finally(() => {
    if (migrationPromises.get(migrationKey) === promise) {
      migrationPromises.delete(migrationKey);
    }
  });
  migrationPromises.set(migrationKey, promise);
  return promise;
}
