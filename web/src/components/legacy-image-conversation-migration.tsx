"use client";

import { useEffect } from "react";

import { AUTH_SESSION_CHANGE_EVENT, getVerifiedAuthSession } from "@/lib/session";
import { migrateLegacyImageConversations } from "@/lib/legacy-image-conversation-migration";

function scheduleIdle(callback: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }
  const idleCallback = (window as Window & {
    requestIdleCallback?: (handler: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  }).requestIdleCallback;
  if (idleCallback) {
    const handle = idleCallback(callback, { timeout: 2_000 });
    return () => {
      (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(handle);
    };
  }
  const handle = window.setTimeout(callback, 150);
  return () => window.clearTimeout(handle);
}

/** Runs once per authenticated owner without delaying the first route paint. */
export function LegacyImageConversationMigration() {
  useEffect(() => {
    let disposed = false;
    let cancelScheduled: (() => void) | null = null;

    const run = () => {
      cancelScheduled = null;
      if (disposed) {
        return;
      }
      void getVerifiedAuthSession()
        .then((session) => {
          if (!session || disposed) {
            return null;
          }
          return migrateLegacyImageConversations(session);
        })
        .catch(() => undefined);
    };

    const schedule = () => {
      cancelScheduled?.();
      cancelScheduled = scheduleIdle(run);
    };

    schedule();
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, schedule);
    window.addEventListener("online", schedule);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        schedule();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      disposed = true;
      cancelScheduled?.();
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, schedule);
      window.removeEventListener("online", schedule);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  return null;
}
