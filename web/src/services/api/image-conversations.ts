import { httpRequest } from "@/lib/request";
import { buildImageConversationHistoryMergeBody } from "@/lib/image-conversation-history";

type ConversationRecord = Record<string, unknown>;

export type ImageConversationHistoryPageResponse = {
  items?: ConversationRecord[];
  next_cursor?: string | null;
  has_more?: boolean;
  generation?: string | number | null;
};

export type ImageConversationHistoryDetailResponse = {
  item?: ConversationRecord | null;
  generation?: string | number | null;
};

export type ImageConversationHistoryWindowResponse = {
  first_page: ImageConversationHistoryPageResponse;
  active_page: ImageConversationHistoryPageResponse;
};

export type ImageConversationHistoryMutationResponse = {
  ok?: boolean;
  removed?: boolean;
  generation?: string | number | null;
  items?: ConversationRecord[];
};

type ImageConversationHistoryMergeAcknowledgement = {
  accepted?: boolean;
  gone?: boolean;
  id?: string;
  revision?: number;
};

export type ImageConversationHistoryMergeResponse = {
  items?: ConversationRecord[];
  ok?: boolean;
  accepted?: boolean;
  id?: string;
  revision?: number;
  count?: number;
  generation?: string | number | null;
  acknowledgements?: ImageConversationHistoryMergeAcknowledgement[];
};

export type ImageConversationHistoryRequestOptions = {
  redirectOnUnauthorized?: boolean;
  generation?: string | number | null;
};

export type ImageConversationHistoryPageOptions = ImageConversationHistoryRequestOptions & {
  limit?: number;
  cursor?: string | null;
};

/** Fetch one bounded keyset-pagination page. */
export function fetchImageConversationHistoryPage(
  options: ImageConversationHistoryPageOptions = {},
) {
  const params = new URLSearchParams();
  const limit = Number(options.limit);
  if (Number.isSafeInteger(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  const cursor = String(options.cursor || "").trim();
  if (cursor) {
    params.set("cursor", cursor);
  }
  const query = params.toString();
  return httpRequest<ImageConversationHistoryPageResponse>(
    `/api/profile/image-conversations${query ? `?${query}` : ""}`,
    {
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      redirectOnUnauthorized: options.redirectOnUnauthorized,
      timeout: 20_000,
    },
  );
}

export function fetchImageConversationHistoryWindow(
  options: ImageConversationHistoryPageOptions = {},
) {
  const params = new URLSearchParams();
  const limit = Number(options.limit);
  if (Number.isSafeInteger(limit) && limit > 0) params.set("limit", String(limit));
  const query = params.toString();
  return httpRequest<ImageConversationHistoryWindowResponse>(
    `/api/profile/image-conversations/window${query ? `?${query}` : ""}`,
    {
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      redirectOnUnauthorized: options.redirectOnUnauthorized,
      timeout: 20_000,
    },
  );
}

export function fetchImageConversationHistoryItem(
  id: string,
  options: ImageConversationHistoryRequestOptions = {},
) {
  return httpRequest<ImageConversationHistoryDetailResponse>(
    `/api/profile/image-conversations/${encodeURIComponent(id)}`,
    {
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      redirectOnUnauthorized: options.redirectOnUnauthorized,
      timeout: 20_000,
    },
  );
}

export function mergeImageConversationHistory(
  items: ConversationRecord[],
  options: ImageConversationHistoryRequestOptions = {},
) {
  return httpRequest<ImageConversationHistoryMergeResponse>("/api/profile/image-conversations", {
    method: "POST",
    body: buildImageConversationHistoryMergeBody(items, options.generation),
    redirectOnUnauthorized: options.redirectOnUnauthorized,
    timeout: 30_000,
  });
}

export function deleteImageConversationHistoryItem(
  id: string,
  options: ImageConversationHistoryRequestOptions = {},
) {
  return httpRequest<ImageConversationHistoryMutationResponse>(
    `/api/profile/image-conversations/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      redirectOnUnauthorized: options.redirectOnUnauthorized,
      timeout: 20_000,
    },
  );
}

export function clearImageConversationHistory(options: ImageConversationHistoryRequestOptions = {}) {
  return httpRequest<ImageConversationHistoryMutationResponse>("/api/profile/image-conversations", {
    method: "DELETE",
    redirectOnUnauthorized: options.redirectOnUnauthorized,
    timeout: 30_000,
  });
}
