import { nanoid } from "nanoid";
import { uploadImage, imageToDataURL } from "@/services/image-storage";
import { uploadMediaBlob } from "@/services/file-storage";
import { isPublicReferenceURL } from "@/lib/public-reference-url";
import type { CanvasAssistantMessage, CanvasAssistantReference, CanvasInsertAssetPayload, CanvasPendingAgentAsset } from "./canvas-agent-types";

export function canvasAgentStarterAttachment(asset: CanvasPendingAgentAsset): CanvasAssistantReference {
  return { ...canvasAgentAttachment(asset.payload), id: asset.reference.id, label: asset.reference.label };
}

export function canvasAgentSessionAttachments(messages: readonly CanvasAssistantMessage[], current: readonly CanvasAssistantReference[] = []) {
  return [...new Map([...messages.flatMap((message) => message.role === "user" ? message.references || [] : []), ...current]
    .filter((reference) => reference.source === "attachment")
    .map((reference) => [reference.id, reference])).values()];
}

export function canvasAgentAttachment(payload: CanvasInsertAssetPayload): CanvasAssistantReference {
  return {
    id: `attachment-${nanoid()}`,
    source: "attachment",
    type: payload.kind,
    title: payload.title,
    label: payload.title,
    ...(payload.kind === "text" ? { text: payload.content } : {
      url: payload.kind === "image" ? payload.dataUrl : payload.url,
      storageKey: payload.storageKey,
      mimeType: payload.mimeType,
    }),
  };
}

export async function uploadCanvasAgentAttachment(file: File, signal: AbortSignal): Promise<CanvasAssistantReference> {
  signal.throwIfAborted();
  if (file.type.startsWith("image/")) {
    const uploaded = await uploadImage(file, signal);
    signal.throwIfAborted();
    return canvasAgentAttachment({ kind: "image", title: file.name || "图片附件", dataUrl: uploaded.url, storageKey: uploaded.storageKey, mimeType: uploaded.mimeType });
  }
  const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : null;
  if (!kind) throw new Error("请选择图片、视频或音频文件");
  const uploaded = await uploadMediaBlob(file, file.name, signal);
  signal.throwIfAborted();
  return canvasAgentAttachment({ kind, title: file.name, url: uploaded.url, storageKey: uploaded.storageKey, mimeType: uploaded.mimeType });
}

export async function hydrateCanvasAgentAttachment(reference: CanvasAssistantReference, signal: AbortSignal): Promise<CanvasAssistantReference> {
  if (reference.source !== "attachment" || reference.type !== "image") return reference;
  return { ...reference, dataUrl: await canvasAgentImageURL(reference, signal) };
}

export async function canvasAgentImageURL(reference: CanvasAssistantReference, signal: AbortSignal) {
  signal.throwIfAborted();
  if (reference.url && isPublicReferenceURL(reference.url)) {
    const parsed = new URL(reference.url);
    if (!/^\/(api\/files|images)\//.test(parsed.pathname) && (typeof location === "undefined" || parsed.origin !== location.origin)) return reference.url;
  }
  return imageToDataURL({ url: reference.url, storageKey: reference.storageKey }, signal);
}
