"use client";

import { toast } from "sonner";

export const IMAGE_GENERATION_PREFERENCES_RETRY_EVENT =
  "chatgpt2api:image-generation-preferences-retry";

const IMAGE_GENERATION_PREFERENCES_ERROR_TOAST_ID =
  "image-generation-preferences-load-error";

export function requestImageGenerationPreferencesRetry(target?: EventTarget | null) {
  const retryTarget = target === undefined
    ? (typeof window === "undefined" ? null : window)
    : target;
  if (!retryTarget || typeof Event === "undefined") return;
  retryTarget.dispatchEvent(new Event(IMAGE_GENERATION_PREFERENCES_RETRY_EVENT));
}

export function showImageGenerationPreferencesLoadError(error: unknown) {
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : "请检查网络连接后重试";
  toast.error("创作偏好读取失败", {
    id: IMAGE_GENERATION_PREFERENCES_ERROR_TOAST_ID,
    description: message,
    duration: Infinity,
    action: {
      label: "重试",
      onClick: () => requestImageGenerationPreferencesRetry(),
    },
  });
}

export function dismissImageGenerationPreferencesLoadError() {
  toast.dismiss(IMAGE_GENERATION_PREFERENCES_ERROR_TOAST_ID);
}
