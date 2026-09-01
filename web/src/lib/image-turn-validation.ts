import type { ImageConversationMode, ImageTurn } from "@/lib/image-conversation-types";

export function imageTurnUsesReferenceImages(mode: ImageConversationMode) {
  return mode === "image" || mode === "edit";
}

export function imageTurnReferenceValidationError(
  turn: Pick<ImageTurn, "mode" | "referenceImages">,
) {
  if (!imageTurnUsesReferenceImages(turn.mode)) return "";
  if (turn.referenceImages.length === 0) return "未找到可用的参考图";
  return "";
}
