export type AudioReferenceFileMetadata = {
  durationMs: number;
  bytes: number;
};

export function audioReferenceMetadataError(metadata: AudioReferenceFileMetadata, totalDurationMs: number) {
  if (metadata.durationMs < 2000 || metadata.durationMs > 15000) return "参考音频时长需要在 2-15 秒之间";
  if (totalDurationMs + metadata.durationMs > 15000) return "参考音频总时长不能超过 15 秒";
  return "";
}
