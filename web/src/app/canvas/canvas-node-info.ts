import type { CanvasNode } from "@/services/api/canvas";

export function canvasNodeInfoJSON(value: unknown) {
  return JSON.stringify(value, (_key, item) => (
    typeof item === "string" && /^data:image\/[^,]+;base64,/i.test(item) ? "[base64 image]" : item
  ), 2);
}

export function canvasGenerationStatusLabel(status: "idle" | "loading" | "success" | "error") {
  if (status === "idle") return "待生成";
  if (status === "loading") return "生成中";
  if (status === "success") return "已完成";
  return "生成失败";
}

export function canvasNodeFallbackTitle(type: CanvasNode["type"]) {
  if (type === "image") return "图片";
  if (type === "video") return "视频";
  if (type === "config") return "生成配置";
  if (type === "audio") return "音频";
  if (type === "panorama") return "全景图";
  if (type === "script") return "脚本";
  if (type === "director") return "导演台";
  if (type === "group") return "组";
  return "文字";
}
