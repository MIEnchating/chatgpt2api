import type { ImageTurn, StoredReferenceImage } from "@/lib/image-conversation-types";

export function imageMaskEditPrompt(prompt: string) {
  return `参考图中蓝色高亮覆盖区域是需要修改的位置，蓝色只是编辑标记，不要保留在最终图像中。只修改蓝色高亮区域，其他区域的构图、人物、文字、光影和风格保持不变。修改要求：${prompt.trim()}`;
}

export function createMaskEditTurn(source: ImageTurn, id: string, prompt: string, model: string, reference: StoredReferenceImage, now: string): ImageTurn {
  return {
    id, prompt: imageMaskEditPrompt(prompt), model, mode: "edit", source: "image-workbench",
    referenceImages: [reference], count: 1, size: source.size, sizeSelection: source.sizeSelection,
    quality: source.quality, outputFormat: source.outputFormat, outputCompression: source.outputCompression,
    apiMode: source.apiMode, imageSystemPrompt: source.imageSystemPrompt, stream: source.stream,
    partialImages: source.partialImages, responseFormatB64JSON: source.responseFormatB64JSON,
    codexCLICompatibility: source.codexCLICompatibility, moderation: source.moderation,
    tokenGroup: source.tokenGroup, tokenName: source.tokenName, visibility: source.visibility,
    images: [{ id: `${id}-0`, taskId: `${id}-task-0`, taskStatus: "queued", status: "loading", mediaType: "image", visibility: source.visibility }],
    createdAt: now, status: "queued",
  };
}
