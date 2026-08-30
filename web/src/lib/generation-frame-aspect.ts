type GenerationFrameInput = {
  mode?: string;
  size?: string;
  sizeSelection?: {
    mode?: string;
    aspectRatio?: string;
    customRatio?: string;
    customWidth?: string;
    customHeight?: string;
  } | null;
};

export function mediaAspectRatio(value: string, fallback: string) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*[:xX\u00d7]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return fallback;
  return `${width} / ${height}`;
}

export function generationFrameAspectRatio(input: GenerationFrameInput) {
  const isVideo = input.mode === "video";
  const fallback = isVideo ? "16 / 9" : "1 / 1";
  if (isVideo) return mediaAspectRatio(input.size || "", fallback);

  const selection = input.sizeSelection;
  if (selection?.mode === "custom") {
    return mediaAspectRatio(`${selection.customWidth || ""}x${selection.customHeight || ""}`, fallback);
  }
  if (selection?.mode === "ratio") {
    const selectedRatio = selection.aspectRatio === "custom"
      ? selection.customRatio || ""
      : selection.aspectRatio || "";
    const resolved = mediaAspectRatio(selectedRatio, "");
    if (resolved) return resolved;
  }
  return mediaAspectRatio(input.size || "", fallback);
}

export function videoFrameMaxWidth(aspectRatio: string) {
  const match = aspectRatio.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!match) return "960px";
  const ratio = Number(match[1]) / Number(match[2]);
  if (ratio < 0.8) return "420px";
  if (ratio < 1.15) return "640px";
  return "960px";
}
