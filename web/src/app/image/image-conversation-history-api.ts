import { httpRequest } from "@/lib/request";

type ConversationRecord = Record<string, unknown>;

export function fetchImageConversationHistory() {
  return httpRequest<{ items: ConversationRecord[] }>("/api/profile/image-conversations", {
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
}

export function mergeImageConversationHistory(items: ConversationRecord[]) {
  return httpRequest<{ items: ConversationRecord[] }>("/api/profile/image-conversations", {
    method: "POST",
    body: { items },
  });
}

export function deleteImageConversationHistoryItem(id: string) {
  return httpRequest<{ items: ConversationRecord[] }>(
    `/api/profile/image-conversations/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export function clearImageConversationHistory() {
  return httpRequest<{ items: ConversationRecord[] }>("/api/profile/image-conversations", {
    method: "DELETE",
  });
}
