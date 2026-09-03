export const CUSTOM_IMAGE_ASPECT_RATIO = "custom";
export const DEFAULT_IMAGE_CUSTOM_RATIO = "16:9";

export const IMAGE_ASPECT_RATIO_OPTIONS = [
  { value: "", label: "自动" },
  { value: "1:1", label: "1:1 (正方形)" },
  { value: "16:9", label: "16:9 (横版)" },
  { value: "9:16", label: "9:16 (竖版)" },
  { value: "4:3", label: "4:3 (横版)" },
  { value: "3:4", label: "3:4 (竖版)" },
  { value: "3:2", label: "3:2 (横版)" },
  { value: "2:3", label: "2:3 (竖版)" },
  { value: "4:5", label: "4:5 (竖版)" },
  { value: "5:4", label: "5:4 (横版)" },
  { value: "21:9", label: "21:9 (超宽横版)" },
  { value: "2:1", label: "2:1 (宽幅横版)" },
  { value: "1:2", label: "1:2 (长竖版)" },
  { value: "19.5:9", label: "19.5:9 (手机宽屏)" },
  { value: "9:19.5", label: "9:19.5 (手机竖屏)" },
  { value: "20:9", label: "20:9 (超宽屏)" },
  { value: "9:20", label: "9:20 (超长竖屏)" },
  { value: "1:4", label: "1:4 (长竖版)" },
  { value: "1:8", label: "1:8 (超长竖版)" },
  { value: "4:1", label: "4:1 (长横版)" },
  { value: "8:1", label: "8:1 (超长横版)" },
] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIO_OPTIONS)[number]["value"] | typeof CUSTOM_IMAGE_ASPECT_RATIO;

const REFERENCE_IMAGE_ASPECT_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"] as const;

export const IMAGE_ASPECT_RATIO_PRESET_OPTIONS = [
  ...REFERENCE_IMAGE_ASPECT_RATIOS.map((aspectRatio) => ({
    value: `${aspectRatio}-auto`,
    label: aspectRatio,
    aspectRatio,
    resolution: "auto" as const,
    size: aspectRatio,
  })),
  { value: "1:1-2k", label: "1:1(2k)", aspectRatio: "1:1", resolution: "2k" as const, size: "2048x2048" },
  { value: "16:9-2k", label: "16:9(2k)", aspectRatio: "16:9", resolution: "2k" as const, size: "2048x1152" },
  { value: "9:16-2k", label: "9:16(2k)", aspectRatio: "9:16", resolution: "2k" as const, size: "1152x2048" },
  { value: "21:9-2k", label: "21:9(2k)", aspectRatio: "21:9", resolution: "2k" as const, size: "3136x1344" },
  { value: "16:9-4k", label: "16:9(4k)", aspectRatio: "16:9", resolution: "4k" as const, size: "3840x2160" },
  { value: "9:16-4k", label: "9:16(4k)", aspectRatio: "9:16", resolution: "4k" as const, size: "2160x3840" },
  { value: "21:9-4k", label: "21:9(4k)", aspectRatio: "21:9", resolution: "4k" as const, size: "6272x2688" },
  { value: "auto", label: "自动", aspectRatio: "" as const, resolution: "auto" as const, size: "auto" },
] as const;

const IMAGE_SIZE_MODE_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "ratio", label: "按比例" },
  { value: "custom", label: "手动宽高" },
] as const;

export type ImageSizeMode = (typeof IMAGE_SIZE_MODE_OPTIONS)[number]["value"];

const IMAGE_RESOLUTION_OPTIONS = [
  { value: "auto", label: "自动", description: "不指定固定像素，交给图片工具决定" },
  { value: "1080p", label: "1080P", description: "正方形为 1088×1088，宽高按所选比例计算" },
  { value: "2k", label: "2K", description: "2K 正方形为 2048×2048，实际结果按模型能力生成" },
  { value: "4k", label: "4K", description: "按链路像素上限收敛，实际结果按模型能力生成" },
] as const;

const GEMINI_IMAGE_RESOLUTION_OPTIONS = [
  { value: "auto", label: "自动", description: "使用 Gemini 默认的图片尺寸" },
  { value: "512", label: "512", description: "仅 Gemini 3.1 Flash Image 支持" },
  { value: "1k", label: "1K", description: "Gemini 默认图片尺寸" },
  { value: "2k", label: "2K", description: "Gemini 大尺寸图片" },
  { value: "4k", label: "4K", description: "Gemini 最大图片尺寸" },
] as const;

const XAI_IMAGE_RESOLUTION_OPTIONS = [
  { value: "auto", label: "自动", description: "不指定固定尺寸，使用 Grok 默认设置" },
  { value: "1k", label: "1K", description: "xAI 官方 1K 图片尺寸" },
  { value: "2k", label: "2K", description: "xAI 官方 2K 图片尺寸" },
] as const;

export type ImageResolution =
  | (typeof IMAGE_RESOLUTION_OPTIONS)[number]["value"]
  | (typeof GEMINI_IMAGE_RESOLUTION_OPTIONS)[number]["value"];

export type ImageSizeSelection = {
  mode: ImageSizeMode;
  aspectRatio: ImageAspectRatio;
  resolution: ImageResolution;
  customRatio: string;
  customWidth: string;
  customHeight: string;
};

const IMAGE_ASPECT_RATIO_VALUES = new Set<string>([
  ...IMAGE_ASPECT_RATIO_OPTIONS.map((option) => option.value),
  CUSTOM_IMAGE_ASPECT_RATIO,
]);
const IMAGE_SIZE_MODE_VALUES = new Set<string>(IMAGE_SIZE_MODE_OPTIONS.map((option) => option.value));
const IMAGE_RESOLUTION_VALUES = new Set<string>([
  ...IMAGE_RESOLUTION_OPTIONS.map((option) => option.value),
  ...GEMINI_IMAGE_RESOLUTION_OPTIONS.map((option) => option.value),
  ...XAI_IMAGE_RESOLUTION_OPTIONS.map((option) => option.value),
]);
const SIZE_PATTERN = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/;
const RATIO_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*[:xX×]\s*(\d+(?:\.\d+)?)\s*$/;
const SIZE_MULTIPLE = 16;
const MAX_EDGE = 3840;
// Gemini supports extended 1:8 and 8:1 canvases; keep the client-side
// normalization wide enough to represent every advertised ratio.
const MAX_ASPECT_RATIO = 8;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const HIGH_RESOLUTION_EDGE_THRESHOLD = 2048;
const REFERENCE_IMAGE_SIZE_PRESETS: Partial<Record<Exclude<ImageResolution, "auto">, Partial<Record<ImageAspectRatio, string>>>> = {
  "2k": {
    "1:1": "2048x2048",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "21:9": "3136x1344",
  },
  "4k": {
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "21:9": "6272x2688",
  },
};
const REFERENCE_IMAGE_DEFAULT_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "16:9": "1920x1080",
  "9:16": "1080x1920",
  "21:9": "1568x672",
};
const EXACT_REFERENCE_IMAGE_SIZES = new Set([
  "2048x2048",
  "2048x1152",
  "1152x2048",
  "3136x1344",
  "3840x2160",
  "2160x3840",
  "6272x2688",
]);
export const DEFAULT_IMAGE_CUSTOM_WIDTH = "1024";
export const DEFAULT_IMAGE_CUSTOM_HEIGHT = "1024";

export const IMAGE_QUALITY_OPTIONS = [
  { value: "low", label: "低", description: "低质量，速度更快，适合草稿测试" },
  { value: "medium", label: "中", description: "均衡质量与速度，适合日常生成" },
  { value: "high", label: "高", description: "高质量，耗时更长，适合最终出图" },
] as const;

export const IMAGE_WORKBENCH_QUALITY_OPTIONS = [
  { value: "", label: "自动" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
] as const;

export function imageWorkbenchAcceptsReferenceImages(model: string) {
  void model;
  return true;
}

export function imageWorkbenchReferenceImageLimit(model: string) {
  void model;
  return Number.POSITIVE_INFINITY;
}

export function imageWorkbenchSupportsSize(model: string) {
  void model;
  return true;
}

const REFERENCE_IMAGE_QUALITY_BASE: Record<string, number> = {
  low: 1024,
  medium: 2048,
  high: 2880,
  standard: 1024,
  hd: 2048,
};

const REFERENCE_IMAGE_QUALITY_ALIASES: Record<string, string> = {
  "1k": "low",
  "2k": "medium",
  "4k": "high",
};

export function normalizeReferenceImageQuality(value: unknown) {
  const quality = String(value || "").trim().toLowerCase();
  if (!quality || quality === "auto") return "auto";
  const normalized = REFERENCE_IMAGE_QUALITY_ALIASES[quality] || quality;
  return REFERENCE_IMAGE_QUALITY_BASE[normalized] ? normalized : "auto";
}

function greatestCommonDivisor(first: number, second: number) {
  let a = Math.round(first);
  let b = Math.round(second);
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export function resolveReferenceImageRequestSize(qualityValue: unknown, sizeValue: string) {
  const size = sizeValue.trim().toLowerCase();
  if (!size || size === "auto") return undefined;
  if (/^\d+x\d+$/.test(size)) return size;
  const parts = size.split(":");
  if (parts.length !== 2) return undefined;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!width || !height) return undefined;
  const quality = normalizeReferenceImageQuality(qualityValue);
  const basePixels = REFERENCE_IMAGE_QUALITY_BASE[quality] || REFERENCE_IMAGE_QUALITY_BASE.low;
  const divisor = greatestCommonDivisor(width, height);
  const unit = Math.round(Math.sqrt((basePixels * basePixels) / ((width / divisor) * (height / divisor))) / 16) * 16;
  return `${(width / divisor) * unit}x${(height / divisor) * unit}`;
}

function roundToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function floorToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

function ceilToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

function normalizeDimensions(width: number, height: number) {
  let normalizedWidth = roundToMultiple(width, SIZE_MULTIPLE);
  let normalizedHeight = roundToMultiple(height, SIZE_MULTIPLE);

  const scaleToFit = (scale: number) => {
    normalizedWidth = floorToMultiple(normalizedWidth * scale, SIZE_MULTIPLE);
    normalizedHeight = floorToMultiple(normalizedHeight * scale, SIZE_MULTIPLE);
  };
  const scaleToFill = (scale: number) => {
    normalizedWidth = ceilToMultiple(normalizedWidth * scale, SIZE_MULTIPLE);
    normalizedHeight = ceilToMultiple(normalizedHeight * scale, SIZE_MULTIPLE);
  };

  for (let index = 0; index < 4; index += 1) {
    const maxEdge = Math.max(normalizedWidth, normalizedHeight);
    if (maxEdge > MAX_EDGE) {
      scaleToFit(MAX_EDGE / maxEdge);
    }

    if (normalizedWidth / normalizedHeight > MAX_ASPECT_RATIO) {
      normalizedWidth = floorToMultiple(normalizedHeight * MAX_ASPECT_RATIO, SIZE_MULTIPLE);
    } else if (normalizedHeight / normalizedWidth > MAX_ASPECT_RATIO) {
      normalizedHeight = floorToMultiple(normalizedWidth * MAX_ASPECT_RATIO, SIZE_MULTIPLE);
    }

    const pixels = normalizedWidth * normalizedHeight;
    if (pixels > MAX_PIXELS) {
      scaleToFit(Math.sqrt(MAX_PIXELS / pixels));
    } else if (pixels < MIN_PIXELS) {
      scaleToFill(Math.sqrt(MIN_PIXELS / pixels));
    }
  }

  return { width: normalizedWidth, height: normalizedHeight };
}

function normalizeImageSize(size: string) {
  const trimmed = size.trim();
  const canonical = trimmed.toLowerCase().replace(/\s+/g, "").replace(/×/g, "x");
  if (EXACT_REFERENCE_IMAGE_SIZES.has(canonical)) {
    return canonical;
  }
  const match = trimmed.match(SIZE_PATTERN);
  if (!match) {
    return trimmed;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "";
  }

  const normalized = normalizeDimensions(width, height);
  return `${normalized.width}x${normalized.height}`;
}

export function parseImageSizeDimensions(size: string) {
  const match = normalizeImageSize(size).match(SIZE_PATTERN);
  if (!match) {
    return null;
  }
  return { width: match[1], height: match[2] };
}

export function isHighResolutionImageSize(
  size: string,
  selection?: { mode?: string; resolution?: string } | null,
) {
  if (selection?.mode === "auto") {
    return false;
  }
  if (selection?.mode === "ratio" && isImageResolution(selection.resolution)) {
    return selection.resolution === "2k" || selection.resolution === "4k";
  }

  const inferredResolution = getImageResolutionFromSize(size);
  if (inferredResolution !== "auto") {
    return inferredResolution === "2k" || inferredResolution === "4k";
  }

  const dimensions = parseImageSizeDimensions(size);
  if (!dimensions) {
    return false;
  }
  return Math.max(Number(dimensions.width), Number(dimensions.height)) >= HIGH_RESOLUTION_EDGE_THRESHOLD;
}

export function parseImageRatio(ratio: string) {
  const match = ratio.match(RATIO_PATTERN);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  if (width / height > MAX_ASPECT_RATIO || height / width > MAX_ASPECT_RATIO) {
    return null;
  }
  return { width, height };
}

function getActiveImageAspectRatio({
  aspectRatio,
  customRatio,
}: Pick<ImageSizeSelection, "aspectRatio" | "customRatio">) {
  if (aspectRatio === CUSTOM_IMAGE_ASPECT_RATIO) {
    return parseImageRatio(customRatio) ? customRatio.trim() : "";
  }
  return aspectRatio;
}

export function calculateImageSize(resolution: Exclude<ImageResolution, "auto">, ratio: string) {
  const preset = REFERENCE_IMAGE_SIZE_PRESETS[resolution]?.[ratio as ImageAspectRatio];
  if (preset) {
    return preset;
  }
  const parsed = parseImageRatio(ratio);
  if (!parsed) {
    return "";
  }

  const { width: ratioWidth, height: ratioHeight } = parsed;
  if (ratioWidth === ratioHeight) {
    if (resolution === "512") {
      return "512x512";
    }
    const side = resolution === "1k" ? 1024 : resolution === "1080p" ? 1080 : resolution === "2k" ? 2048 : 3840;
    return normalizeImageSize(`${side}x${side}`);
  }

  if (resolution === "512" || resolution === "1k") {
    const longSide = resolution === "512" ? 512 : 1024;
    return fitImageRatioToLongSide(ratioWidth, ratioHeight, longSide);
  }

  if (resolution === "1080p") {
    return normalizeImageSize(fitImageRatioToShortSide(ratioWidth, ratioHeight, 1080));
  }

  const longSide = resolution === "2k" ? 2048 : 3840;
  return normalizeImageSize(fitImageRatioToLongSide(ratioWidth, ratioHeight, longSide));
}

export function calculateDefaultImageSize(ratio: string) {
  const referenceSize = REFERENCE_IMAGE_DEFAULT_SIZES[ratio];
  if (referenceSize) {
    return referenceSize;
  }
  const parsed = parseImageRatio(ratio);
  if (!parsed) {
    return "";
  }

  const { width: ratioWidth, height: ratioHeight } = parsed;
  if (ratioWidth === ratioHeight) {
    return "1024x1024";
  }

  return normalizeImageSize(fitImageRatioToLongSide(ratioWidth, ratioHeight, 1536));
}

function fitImageRatioToLongSide(ratioWidth: number, ratioHeight: number, longSide: number) {
  const width =
    ratioWidth > ratioHeight
      ? longSide
      : roundToMultiple((longSide * ratioWidth) / ratioHeight, SIZE_MULTIPLE);
  const height =
    ratioWidth > ratioHeight
      ? roundToMultiple((longSide * ratioHeight) / ratioWidth, SIZE_MULTIPLE)
      : longSide;
  return `${width}x${height}`;
}

function fitImageRatioToShortSide(ratioWidth: number, ratioHeight: number, shortSide: number) {
  const width =
    ratioWidth > ratioHeight
      ? roundToMultiple((shortSide * ratioWidth) / ratioHeight, SIZE_MULTIPLE)
      : shortSide;
  const height =
    ratioWidth > ratioHeight
      ? shortSide
      : roundToMultiple((shortSide * ratioHeight) / ratioWidth, SIZE_MULTIPLE);
  return `${width}x${height}`;
}

function alignImageDimension(value: number, enabled = true) {
  if (!enabled) return Math.max(1, Math.floor(value));
  return Math.max(16, Math.ceil(value / SIZE_MULTIPLE) * SIZE_MULTIPLE);
}

export function buildCustomImageSize(width: string, height: string, snapToMultiple16 = true) {
  const parsedWidth = Number.parseInt(width, 10);
  const parsedHeight = Number.parseInt(height, 10);
  if (!Number.isFinite(parsedWidth) || !Number.isFinite(parsedHeight) || parsedWidth <= 0 || parsedHeight <= 0) {
    return "";
  }
  if (!snapToMultiple16) {
    return `${Math.floor(parsedWidth)}x${Math.floor(parsedHeight)}`;
  }
  return `${alignImageDimension(parsedWidth)}x${alignImageDimension(parsedHeight)}`;
}

export function formatImageSizeDisplay(size: string) {
  return size.replace(/x/g, "×");
}

export function getImageSizeRequirementLabel(
  size: string,
  selection?: { mode?: string; resolution?: string } | null,
) {
  if (!size || size === "auto") {
    return "自动";
  }
  return isHighResolutionImageSize(size, selection) ? "大尺寸" : "常规尺寸";
}

export function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && IMAGE_ASPECT_RATIO_VALUES.has(value);
}

export function isImageSizeMode(value: unknown): value is ImageSizeMode {
  return typeof value === "string" && IMAGE_SIZE_MODE_VALUES.has(value);
}

export function isImageResolution(value: unknown): value is ImageResolution {
  return typeof value === "string" && IMAGE_RESOLUTION_VALUES.has(value);
}

export function buildImageSize(
  {
    mode,
    aspectRatio,
    resolution,
    customRatio,
    customWidth,
    customHeight,
  }: ImageSizeSelection,
  options: { preserveAspectRatio?: boolean; snapToMultiple16?: boolean } = {},
) {
  if (mode === "auto") {
    return "";
  }
  if (mode === "custom") {
    return buildCustomImageSize(customWidth, customHeight, options.snapToMultiple16 ?? true);
  }
  const activeAspectRatio = getActiveImageAspectRatio({ aspectRatio, customRatio });
  if (aspectRatio === CUSTOM_IMAGE_ASPECT_RATIO && !activeAspectRatio) {
    return "";
  }
  if (options.preserveAspectRatio && resolution === "auto" && aspectRatio !== CUSTOM_IMAGE_ASPECT_RATIO && activeAspectRatio) {
    return activeAspectRatio;
  }
  if (resolution === "auto") {
    return activeAspectRatio ? calculateDefaultImageSize(activeAspectRatio) : "";
  }
  if (!activeAspectRatio) {
    return calculateImageSize(resolution, "1:1");
  }
  return calculateImageSize(resolution, activeAspectRatio) || activeAspectRatio;
}

function getImageAspectRatioFromSize(size: string): ImageAspectRatio {
  const normalized = normalizeImageSize(size);
  if (isImageAspectRatio(normalized) && normalized !== CUSTOM_IMAGE_ASPECT_RATIO) {
    return normalized;
  }
  const isDimensionSize = SIZE_PATTERN.test(normalized);
  for (const aspectRatio of IMAGE_ASPECT_RATIO_OPTIONS.map((option) => option.value)) {
    if (!aspectRatio) {
      continue;
    }
    if (calculateDefaultImageSize(aspectRatio) === normalized) {
      return aspectRatio;
    }
    for (const resolution of IMAGE_RESOLUTION_OPTIONS.map((option) => option.value)) {
      if (resolution === "auto") {
        continue;
      }
      if (calculateImageSize(resolution, aspectRatio) === normalized) {
        return aspectRatio;
      }
    }
  }
  if (!isDimensionSize && parseImageRatio(normalized)) {
    return CUSTOM_IMAGE_ASPECT_RATIO;
  }
  return "";
}

function getImageResolutionFromSize(size: string): ImageResolution {
  const normalized = normalizeImageSize(size);
  if (isImageResolution(normalized)) {
    return normalized;
  }
  for (const aspectRatio of IMAGE_ASPECT_RATIO_OPTIONS.map((option) => option.value)) {
    if (!aspectRatio) {
      continue;
    }
    for (const resolution of IMAGE_RESOLUTION_OPTIONS.map((option) => option.value)) {
      if (resolution === "auto") {
        continue;
      }
      if (calculateImageSize(resolution, aspectRatio) === normalized) {
        return resolution;
      }
    }
  }
  return "auto";
}

export function getImageSizeSelectionFromSize(size: string, preferredResolution?: unknown): ImageSizeSelection {
  const rawDimensionsMatch = size.trim().match(SIZE_PATTERN);
  const rawDimensions = rawDimensionsMatch
    ? { width: rawDimensionsMatch[1], height: rawDimensionsMatch[2] }
    : null;
  const normalized = normalizeImageSize(size);
  const normalizedDimensions = parseImageSizeDimensions(normalized);
  // Keep arbitrary custom dimensions stable while they are edited. Normalizing
  // an intermediate value such as 8x1024 can otherwise turn it into a valid
  // preset (for example 1:8), making the width/height inputs appear locked.
  const rawSizeWasNormalized = Boolean(
    rawDimensions && normalizedDimensions &&
      (rawDimensions.width !== normalizedDimensions.width || rawDimensions.height !== normalizedDimensions.height),
  );
  const customSize = rawSizeWasNormalized ? rawDimensions : normalizedDimensions;
  const aspectRatio = rawSizeWasNormalized ? "" : getImageAspectRatioFromSize(normalized);
  const resolution = isImageResolution(preferredResolution)
    ? preferredResolution
    : getImageResolutionFromSize(normalized);
  const customRatio = aspectRatio === CUSTOM_IMAGE_ASPECT_RATIO ? normalized : DEFAULT_IMAGE_CUSTOM_RATIO;
  const baseSelection = {
    aspectRatio,
    resolution,
    customRatio,
    customWidth: customSize?.width ?? DEFAULT_IMAGE_CUSTOM_WIDTH,
    customHeight: customSize?.height ?? DEFAULT_IMAGE_CUSTOM_HEIGHT,
  };

  if (!normalized || normalized === "auto") {
    return {
      mode: "auto",
      aspectRatio: "",
      resolution: "auto",
      customRatio: baseSelection.customRatio,
      customWidth: baseSelection.customWidth,
      customHeight: baseSelection.customHeight,
    };
  }
  if (customSize && !aspectRatio && (rawSizeWasNormalized || resolution === "auto")) {
    return {
      ...baseSelection,
      mode: "custom",
    };
  }
  return {
    ...baseSelection,
    mode: "ratio",
  };
}
