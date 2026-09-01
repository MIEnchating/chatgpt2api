/** Media-neutral task vocabulary shared by image and video creation flows. */
export type GenerationMediaType = "image" | "video" | "audio";
export type GenerationTaskStatus = "queued" | "running" | "success" | "error" | "cancelled";
export type GenerationOutputStatus = GenerationTaskStatus;
export type GenerationTaskSlot = {
  status?: "loading" | "success" | "error" | "cancelled" | "message";
  taskStatus?: GenerationTaskStatus;
  error?: string;
};

export type GenerationTaskMode = "generate" | "edit" | "chat" | "video" | "audio";

export function isRetryableTaskPollError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
