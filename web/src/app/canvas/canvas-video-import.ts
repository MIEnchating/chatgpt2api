export const CANVAS_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export function canvasVideoFileError(file: Pick<File, "name" | "size" | "type">) {
  const mimeType = file.type.toLowerCase().split(";", 1)[0];
  if (mimeType !== "video/mp4" && mimeType !== "video/quicktime" && !/\.(mp4|mov)$/i.test(file.name)) {
    return "视频仅支持 MP4 或 MOV 格式";
  }
  if (file.size > CANVAS_VIDEO_MAX_BYTES) return "视频不能超过 50 MiB";
  return "";
}

export function canvasVideoDisplaySize(width: number, height: number) {
  const safeWidth = Math.max(1, Number(width) || 1280);
  const safeHeight = Math.max(1, Number(height) || 720);
  const scale = Math.min(1, 420 / safeWidth, 420 / safeHeight);
  return { width: safeWidth * scale, height: safeHeight * scale };
}
