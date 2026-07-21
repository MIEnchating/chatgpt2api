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
