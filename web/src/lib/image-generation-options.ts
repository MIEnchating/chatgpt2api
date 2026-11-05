import { isGPTImage26 } from "./image-model-capabilities";

export type ImageGenerationOptions = {
  complexity?: "low" | "medium" | "high";
  background?: "auto" | "opaque" | "transparent";
  frame_count?: number;
  frame_duration_ms?: number;
  markup?: string;
};

export function normalizeImageGenerationOptions(value: unknown): ImageGenerationOptions {
  if (!value || typeof value !== "object") return {};
  const options = value as Record<string, unknown>;
  return {
    ...(["low", "medium", "high"].includes(String(options.complexity)) ? { complexity: options.complexity as ImageGenerationOptions["complexity"] } : {}),
    ...(["auto", "opaque", "transparent"].includes(String(options.background)) ? { background: options.background as ImageGenerationOptions["background"] } : {}),
    ...(Number.isInteger(options.frame_count) && Number(options.frame_count) >= 2 && Number(options.frame_count) <= 16 ? { frame_count: Number(options.frame_count) } : {}),
    ...(Number.isInteger(options.frame_duration_ms) && Number(options.frame_duration_ms) >= 20 && Number(options.frame_duration_ms) <= 2000 ? { frame_duration_ms: Number(options.frame_duration_ms) } : {}),
    ...(typeof options.markup === "string" && options.markup.startsWith("data:image/png;base64,") ? { markup: options.markup } : {}),
  };
}

export function imageGenerationRequestOptions(model: string, format: string | undefined, options: ImageGenerationOptions | undefined, edit: boolean) {
  if (!isGPTImage26(model)) {
    if (format === "svg" || format === "gif") throw new Error("当前模型未适配 SVG 或 GIF 输出");
    return {};
  }
  if (edit && (format === "svg" || format === "gif")) throw new Error("SVG 和 GIF 仅支持文生图，请移除参考图或选择 PNG、JPEG、WebP");
  if (options?.markup && !edit) throw new Error("标注编辑需要上传原始参考图");
  if (options?.background === "transparent" && format && format !== "png" && format !== "webp") throw new Error("透明背景需要 PNG 或 WebP 格式");
  if (format === "gif") {
    for (const [key, min, max] of [["frame_count", 2, 16], ["frame_duration_ms", 20, 2000]] as const) {
      const value = options?.[key];
      if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) throw new Error(`${key} 必须是 ${min}-${max} 的整数`);
    }
  }
  const normalized = normalizeImageGenerationOptions(options);
  if (format !== "gif") { delete normalized.frame_count; delete normalized.frame_duration_ms; }
  return normalized;
}

export function imageOutputSupportsStreaming(format: string | undefined) {
  return format !== "svg" && format !== "gif";
}
