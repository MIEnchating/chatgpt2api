"use client";

import type { ImageGenerationPreferences } from "@/lib/api";

export const IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT =
  "chatgpt2api:image-generation-preferences-changed";

type ImageGenerationPreferencesChangedDetail = {
  preferences: Partial<ImageGenerationPreferences>;
  sessionKey: string;
};

export function imageGenerationPreferencesFromChangedEvent(
  event: Event,
  sessionKey: string,
) {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const scoped = detail as Partial<ImageGenerationPreferencesChangedDetail>;
  if (!sessionKey || scoped.sessionKey !== sessionKey) return null;
  if (!scoped.preferences || typeof scoped.preferences !== "object" || Array.isArray(scoped.preferences)) {
    return null;
  }
  return scoped.preferences;
}

export function dispatchImageGenerationPreferencesChanged(
  sessionKey: string,
  preferences: Partial<ImageGenerationPreferences>,
  target?: EventTarget | null,
) {
  const eventTarget = target === undefined
    ? (typeof window === "undefined" ? null : window)
    : target;
  if (!sessionKey || !eventTarget || typeof CustomEvent === "undefined") return false;
  eventTarget.dispatchEvent(new CustomEvent<ImageGenerationPreferencesChangedDetail>(
    IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT,
    { detail: { preferences, sessionKey } },
  ));
  return true;
}
