export type VideoReferenceFileMetadata = {
  durationMs: number;
  width: number;
  height: number;
  bytes: number;
};

export type AudioReferenceFileMetadata = {
  durationMs: number;
  bytes: number;
};

export function videoReferenceMetadataError(metadata: VideoReferenceFileMetadata, totalDurationMs: number) {
  if (metadata.durationMs < 2000 || metadata.durationMs > 15000) return "参考视频时长需要在 2-15 秒之间";
  if (totalDurationMs + metadata.durationMs > 15000) return "参考视频总时长不能超过 15 秒";
  if (metadata.width < 300 || metadata.width > 6000 || metadata.height < 300 || metadata.height > 6000) return "参考视频宽高需要在 300-6000px 之间";
  const ratio = metadata.width / metadata.height;
  if (ratio < 0.4 || ratio > 2.5) return "参考视频宽高比需要在 0.4-2.5 之间";
  const pixels = metadata.width * metadata.height;
  if (pixels < 640 * 640 || pixels > 2206 * 946) return "参考视频像素总量不符合要求，请转成 480p、720p 或 1080p 后再上传";
  return "";
}

export function audioReferenceMetadataError(metadata: AudioReferenceFileMetadata, totalDurationMs: number) {
  if (metadata.durationMs < 2000 || metadata.durationMs > 15000) return "参考音频时长需要在 2-15 秒之间";
  if (totalDurationMs + metadata.durationMs > 15000) return "参考音频总时长不能超过 15 秒";
  return "";
}
