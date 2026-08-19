export type VideoModelProfile =
  | "seedance-25"
  | "seedance-20"
  | "seedance-15"
  | "seedance-10"
  | "kling-3"
  | "kling-legacy"
  | "minimax-h3"
  | "minimax-hailuo"
  | "grok-15"
  | "grok"
  | "sora"
  | "generic";

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

export function videoModelProfile(model: string): VideoModelProfile {
  const value = String(model || "").trim().toLowerCase();
  if (value.includes("seedance") || value.includes("doubao-seedance")) {
    if (value.includes("2-5") || value.includes("2.5")) return "seedance-25";
    if (value.includes("1-5") || value.includes("1.5")) return "seedance-15";
    if (value.includes("1-0") || value.includes("1.0")) return "seedance-10";
    return "seedance-20";
  }
  if (value.includes("kling")) return value.includes("v3") || value.includes("3-0") ? "kling-3" : "kling-legacy";
  if (value.includes("minimax") || value.includes("hailuo") || value.startsWith("t2v-") || value.startsWith("i2v-") || value.startsWith("s2v-")) {
    return value.includes("h3") ? "minimax-h3" : "minimax-hailuo";
  }
  if (value.includes("grok")) return value.includes("1.5") || value.includes("1-5") ? "grok-15" : "grok";
  if (value.includes("sora")) return "sora";
  return "generic";
}

/** Values mirror the provider's official `ratio`/`aspect_ratio` enums. */
export function videoSizeOptions(model: string): string[] {
  switch (videoModelProfile(model)) {
    case "seedance-25":
    case "seedance-20":
    case "seedance-15":
    case "seedance-10":
      return ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
    case "kling-3":
    case "kling-legacy":
      return ["16:9", "9:16", "1:1"];
    case "minimax-h3":
      return ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
    case "minimax-hailuo":
      // The v1 MiniMax API has no aspect-ratio field; leave it unset.
      return [];
    case "grok-15":
    case "grok":
      return ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
    default:
      return ["1280x720", "720x1280"];
  }
}

export function videoSecondsOptions(model: string): number[] {
  switch (videoModelProfile(model)) {
    case "seedance-25": return [-1, ...range(4, 30)];
    case "seedance-20": return [-1, ...range(4, 15)];
    case "seedance-15": return [-1, ...range(4, 12)];
    case "seedance-10": return range(2, 12);
    case "kling-3": return range(3, 15);
    case "kling-legacy": return [5, 10];
    case "minimax-h3": return range(4, 15);
    case "minimax-hailuo": return [6, 10];
    case "grok-15":
    case "grok": return range(1, 15);
    default: return [4, 8, 12];
  }
}

export function videoResolutionOptions(model: string): string[] {
  switch (videoModelProfile(model)) {
    case "seedance-20": return ["480p", "720p", "1080p", "4k"];
    case "seedance-25":
    case "seedance-15":
    case "seedance-10": return ["480p", "720p", "1080p"];
    case "minimax-h3": return ["768P", "2K"];
    case "minimax-hailuo": return ["768P", "1080P"];
    case "grok-15": return ["480p", "720p", "1080p"];
    case "grok": return ["480p", "720p"];
    case "kling-3":
    case "kling-legacy": return ["720p", "1080p"];
    default: return ["720p", "1080p"];
  }
}

export function videoAudioControl(model: string): "toggle" | "always" | "none" {
  switch (videoModelProfile(model)) {
    case "seedance-25":
    case "seedance-20":
    case "seedance-15":
    case "kling-legacy": return "toggle";
    case "grok-15":
    case "grok": return "always";
    default: return "none";
  }
}

export function videoWatermarkSupported(model: string) {
  const profile = videoModelProfile(model);
  return profile === "seedance-25" || profile === "seedance-20" || profile === "seedance-15" || profile === "seedance-10" || profile === "minimax-h3" || profile === "minimax-hailuo";
}

export function videoSizeLabel(size: string) {
  const labels: Record<string, string> = {
    adaptive: "自适应",
    "16:9": "16:9 横屏",
    "9:16": "9:16 竖屏",
    "1:1": "1:1 方形",
    "4:3": "4:3 横屏",
    "3:4": "3:4 竖屏",
    "21:9": "21:9 宽银幕",
    "3:2": "3:2 横幅",
    "2:3": "2:3 竖幅",
    "1280x720": "16:9 横屏",
    "720x1280": "9:16 竖屏",
  };
  return labels[size] || size;
}
