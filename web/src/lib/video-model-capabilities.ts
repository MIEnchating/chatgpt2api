import { videoModelContract } from "@/lib/video-model-contracts";

type SharedVideoCapability = {
  sizes: string[];
  seconds: number[];
  resolutions: string[];
  default_size: string;
  default_seconds: number;
  default_resolution: string;
  references: { image: number; video: number; audio: number };
  first_frame_image_limit: number;
  reference_mode: boolean;
  audio_control: "toggle" | "always" | "none";
  watermark: boolean;
};

const emptyVideoCapability: SharedVideoCapability = {
  sizes: [],
  seconds: [],
  resolutions: [],
  default_size: "",
  default_seconds: 0,
  default_resolution: "",
  references: { image: 0, video: 0, audio: 0 },
  first_frame_image_limit: 0,
  reference_mode: false,
  audio_control: "none",
  watermark: false,
};

export function canonicalVideoModel(model: string): string {
  return String(model || "").trim();
}

export function resolveConfiguredVideoModel(
  configuredModels: readonly string[],
  ...preferredModels: readonly string[]
): string {
  const available = Array.from(new Set(configuredModels.map(canonicalVideoModel).filter(Boolean)));
  for (const preferred of preferredModels) {
    const candidate = canonicalVideoModel(preferred);
    if (available.includes(candidate)) return candidate;
  }
  return available[0] || "";
}

function videoCapability(model: string): SharedVideoCapability {
  const capability = videoModelContract(model)?.capability;
  if (!capability) return emptyVideoCapability;
  return {
    ...capability,
    audio_control: capability.audio_control as SharedVideoCapability["audio_control"],
    references: {
      image: capability.references.image,
      video: capability.references.video,
      audio: capability.references.audio,
    },
  };
}

export function videoSizeOptions(model: string): string[] {
  return [...videoCapability(model).sizes];
}

export function videoSecondsOptions(model: string): number[] {
  return [...videoCapability(model).seconds];
}

export function videoDefaultSeconds(model: string) {
  const capability = videoCapability(model);
  return capability.default_seconds || capability.seconds[0] || 0;
}

export function videoDefaultSize(model: string) {
  const capability = videoCapability(model);
  return capability.default_size || capability.sizes[0] || "";
}

export function videoDefaultResolution(model: string) {
  const capability = videoCapability(model);
  const requestedDefault = capability.default_resolution || "";
  const options = videoResolutionOptions(model);
  return options.find((value) => value.toLowerCase() === requestedDefault.toLowerCase()) || options[0] || "";
}

export function videoResolutionOptions(model: string): string[] {
  return [...videoCapability(model).resolutions];
}

export function videoReferenceImageLimit(model: string) {
  return videoCapability(model).first_frame_image_limit;
}

export function supportsVideoFrameReferences(model: string) {
  return Boolean(videoModelContract(model)?.generation.modes.some((mode) => mode.kind === "image"));
}

export function supportsVideoMultimodalReferences(model: string) {
  return videoCapability(model).reference_mode;
}

export function videoMultimodalReferenceLimits(model: string) {
  return { ...videoCapability(model).references };
}

export function videoWorkbenchReferenceLimits(model: string) {
  return videoMultimodalReferenceLimits(model);
}

export function videoRequiresReferenceImage(model: string) {
  return everyVideoGenerationMode(model, (mode) => mode.materials.first_frame.min > 0 || mode.materials.image.min > 0);
}

export function videoRequiresReferenceVideo(model: string) {
  return everyVideoGenerationMode(model, (mode) => mode.materials.video.min > 0);
}

export function videoRequiresReferenceAudio(model: string) {
  return everyVideoGenerationMode(model, (mode) => mode.materials.audio.min > 0);
}

export function videoRequiresMultimodalReferenceMode(model: string) {
  return everyVideoGenerationMode(model, (mode) => mode.kind === "reference");
}

function everyVideoGenerationMode(
  model: string,
  predicate: (mode: NonNullable<ReturnType<typeof videoModelContract>>["generation"]["modes"][number]) => boolean,
) {
  const modes = videoModelContract(model)?.generation.modes || [];
  return modes.length > 0 && modes.every(predicate);
}

export function videoAudioControl(model: string): "toggle" | "always" | "none" {
  return videoCapability(model).audio_control;
}

function videoWatermarkSupported(model: string) {
  return videoCapability(model).watermark;
}

export function videoComposerWatermarkSupported(model: string) {
  return videoWatermarkSupported(model);
}

export function videoSecondsIsValid(model: string, value: number) {
  return Number.isInteger(value) && videoSecondsOptions(model).includes(value);
}

export function videoAllowsCustomDuration(model: string) {
  void model;
  return false;
}

export function videoResolutionIsValid(model: string, value: string) {
  const requested = String(value || "").trim();
  const options = videoResolutionOptions(model);
  if (options.length === 0) return requested === "";
  return options.some((option) => option.toLowerCase() === requested.toLowerCase());
}

export function videoWorkbenchResolutionOptions(model: string) {
  return videoResolutionOptions(model);
}

export function videoWorkbenchSecondsOptions(model: string) {
  return videoSecondsOptions(model);
}

export type VideoWorkbenchMaterialSections = {
  image: boolean;
  video: boolean;
  audio: boolean;
  imageLabel: "首尾帧" | "参考图";
};

export function videoWorkbenchMaterialSections(model: string): VideoWorkbenchMaterialSections {
  const contract = videoModelContract(model);
  const imageMode = contract?.generation.modes.find((mode) => mode.kind === "image");
  const referenceMode = contract?.generation.modes.find((mode) => mode.kind === "reference");
  return {
    image: Boolean(imageMode || referenceMode?.materials.image.max),
    video: Boolean(referenceMode?.materials.video.max),
    audio: Boolean(referenceMode?.materials.audio.max),
    imageLabel: imageMode && !referenceMode ? "首尾帧" : "参考图",
  };
}

export function videoSizeLabel(size: string) {
  const labels: Record<string, string> = {
    auto: "自动",
    adaptive: "自动",
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

export function videoComposerSizeLabel(size: string) {
  const labels: Record<string, string> = {
    auto: "自动",
    adaptive: "自动",
    "16:9": "横屏",
    "9:16": "竖屏",
    "1:1": "方形",
    "4:3": "标准横屏",
    "3:4": "标准竖屏",
    "21:9": "宽银幕",
  };
  return labels[size] || videoSizeLabel(size);
}

export function videoComposerPixelLabel(resolution: string, size: string) {
  if (size === "adaptive" || size === "auto") return "自动匹配";
  const pixels: Record<string, Record<string, string>> = {
    "480p": { "16:9": "864x496", "4:3": "752x560", "1:1": "640x640", "3:4": "560x752", "9:16": "496x864", "21:9": "992x432" },
    "720p": { "16:9": "1280x720", "4:3": "1112x834", "1:1": "960x960", "3:4": "834x1112", "9:16": "720x1280", "21:9": "1470x630" },
    "768p": { "16:9": "1366x768", "4:3": "1024x768", "1:1": "768x768", "3:4": "768x1024", "9:16": "768x1366", "21:9": "1792x768" },
    "1080p": { "16:9": "1920x1080", "4:3": "1664x1248", "1:1": "1440x1440", "3:4": "1248x1664", "9:16": "1080x1920", "21:9": "2206x946" },
    "2k": { "16:9": "2560x1440", "4:3": "2224x1668", "1:1": "1920x1920", "3:4": "1668x2224", "9:16": "1440x2560", "21:9": "2940x1260" },
    "4k": { "16:9": "3840x2160", "4:3": "3328x2496", "1:1": "2880x2880", "3:4": "2496x3328", "9:16": "2160x3840", "21:9": "4412x1892" },
  };
  return pixels[normalizeVideoWorkbenchResolutionToken(resolution)]?.[size] || size;
}

function normalizeVideoWorkbenchResolutionToken(resolution: string) {
  const value = String(resolution || "").trim().toLowerCase();
  if (/^\d{3,5}$/.test(value)) return `${value}p`;
  return value;
}

const VIDEO_WORKBENCH_RATIO_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"] as const;

function closestVideoWorkbenchRatio(size: string) {
  if (size === "auto" || size === "adaptive") return "adaptive";
  if ((VIDEO_WORKBENCH_RATIO_OPTIONS as readonly string[]).includes(size)) return size;
  const dimensions = size.match(/^(\d+)x(\d+)$/i);
  if (!dimensions) return "16:9";
  const ratio = Number(dimensions[1]) / Number(dimensions[2]);
  const candidates = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["21:9", 21 / 9],
  ] as const;
  return candidates.reduce((best, item) => Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best, candidates[0])[0];
}

export function videoWorkbenchDisplaySize(model: string, size: string) {
  const requested = String(size || "").trim();
  const options = videoSizeOptions(model);
  return options.find((option) => option.toLowerCase() === requested.toLowerCase()) || videoDefaultSize(model);
}

export function videoWorkbenchRatioForSize(size: string) {
  return closestVideoWorkbenchRatio(String(size || "").trim().toLowerCase());
}

export function videoWorkbenchDisplayResolution(model: string, resolution: string) {
  const requested = String(resolution || "").trim();
  const options = videoResolutionOptions(model);
  return options.find((option) => option.toLowerCase() === requested.toLowerCase()) || videoDefaultResolution(model);
}

export function videoWorkbenchDisplaySeconds(model: string, seconds: string | number) {
  const requested = Math.floor(Number(seconds));
  if (Number.isFinite(requested) && videoSecondsOptions(model).includes(requested)) return String(requested);
  return String(videoDefaultSeconds(model));
}

export function videoComposerAspectRatio(size: string) {
  if (/^\d+:\d+$/.test(size)) return size;
  const dimensions = size.match(/^(\d+)x(\d+)$/i);
  return dimensions ? `${dimensions[1]}:${dimensions[2]}` : undefined;
}
