import { httpRequest } from "@/lib/request";
import { buildImageConversationHistoryMergeBody } from "@/app/image/image-history-pagination";

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

export type ImageConversationHistoryMutationResponse = {
  ok?: boolean;
  removed?: boolean;
  generation?: string | number | null;
  items?: ConversationRecord[];
};

export type ImageConversationHistoryMergeAcknowledgement = {
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
  authorization?: string;
  redirectOnUnauthorized?: boolean;
  generation?: string | number | null;
};

export type ImageConversationHistoryPageOptions = ImageConversationHistoryRequestOptions & {
  limit?: number;
  cursor?: string | null;
};

function historyRequestHeaders(
  options: ImageConversationHistoryRequestOptions,
  headers: Record<string, string> = {},
) {
  return options.authorization
    ? { ...headers, Authorization: options.authorization }
    : headers;
}

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
      headers: historyRequestHeaders(options, {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      }),
      redirectOnUnauthorized: options.redirectOnUnauthorized,
      timeout: 20_000,
    },
  );
}

export function fetchActiveImageConversationHistory(
  options: ImageConversationHistoryRequestOptions = {},
) {
  return httpRequest<ImageConversationHistoryPageResponse>(
    "/api/profile/image-conversations/active",
    {
      headers: historyRequestHeaders(options, {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      }),
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
      headers: historyRequestHeaders(options, {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      }),
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
    headers: historyRequestHeaders(options),
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
      headers: historyRequestHeaders(options),
      redirectOnUnauthorized: options.redirectOnUnauthorized,
      timeout: 20_000,
    },
  );
}

export function clearImageConversationHistory(options: ImageConversationHistoryRequestOptions = {}) {
  return httpRequest<ImageConversationHistoryMutationResponse>("/api/profile/image-conversations", {
    method: "DELETE",
    headers: historyRequestHeaders(options),
    redirectOnUnauthorized: options.redirectOnUnauthorized,
    timeout: 30_000,
  });
}
