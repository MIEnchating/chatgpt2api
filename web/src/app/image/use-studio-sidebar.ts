import { useEffect, useRef, useState } from "react";

import { getImageConversationStats, type ImageConversation } from "@/store/image-conversations";

type SidebarPreferences = { pinnedIds: string[]; unreadIds: string[] };

export function readStudioSidebarPreferences(scope: string): SidebarPreferences {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(`chatgpt2api:studio-sidebar:${scope}`) || "null");
    if (value && typeof value === "object") {
      const { pinnedIds, unreadIds } = value as Record<string, unknown>;
      return {
        pinnedIds: Array.isArray(pinnedIds) ? [...new Set(pinnedIds.filter((id): id is string => typeof id === "string"))] : [],
        unreadIds: Array.isArray(unreadIds) ? [...new Set(unreadIds.filter((id): id is string => typeof id === "string"))] : [],
      };
    }
  } catch {
    // Sidebar preferences remain usable when browser storage is unavailable.
  }
  return { pinnedIds: [], unreadIds: [] };
}

export function useStudioSidebar(scope: string, conversations: ImageConversation[], selectedId: string | null, ready: boolean) {
  const [preferences, setPreferences] = useState(() => readStudioSidebarPreferences(scope));
  const previousBusyIds = useRef(new Set<string>());

  useEffect(() => {
    try {
      window.localStorage.setItem(`chatgpt2api:studio-sidebar:${scope}`, JSON.stringify(preferences));
    } catch {
      // In-memory preferences still apply when browser storage is unavailable.
    }
  }, [preferences, scope]);

  useEffect(() => {
    if (!ready) return;
    const busyIds = new Set<string>();
    const completedIds: string[] = [];
    for (const conversation of conversations) {
      const stats = getImageConversationStats(conversation);
      if (stats.running + stats.queued > 0) busyIds.add(conversation.id);
      else if (previousBusyIds.current.has(conversation.id)) completedIds.push(conversation.id);
    }
    previousBusyIds.current = busyIds;
    setPreferences((current) => {
      const unreadIds = [...new Set([...current.unreadIds, ...completedIds])].filter((id) => id !== selectedId);
      if (unreadIds.length === current.unreadIds.length && unreadIds.every((id, index) => id === current.unreadIds[index])) return current;
      return { ...current, unreadIds };
    });
  }, [conversations, selectedId, ready]);

  function togglePin(id: string) {
    setPreferences((current) => ({
      ...current,
      pinnedIds: current.pinnedIds.includes(id) ? current.pinnedIds.filter((item) => item !== id) : [id, ...current.pinnedIds],
    }));
  }

  return { ...preferences, togglePin };
}
