export type ImageModelRoute = "openai-image" | "google-gemini-image" | "xai-image" | "zhipu-image" | "agnes-image" | "kie-image" | "apimart-image";

const GOOGLE_GEMINI_IMAGE_MODELS = new Set([
  "gemini-3.1-flash-lite-image",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gemini-2.5-flash-image",
]);

const XAI_IMAGE_MODELS = new Set([
  "grok-2-image-1212",
  "grok-imagine-image",
  "grok-imagine-image-2026-03-02",
  "grok-imagine-image-quality",
  "grok-imagine-image-quality-20260403",
  "grok-imagine-image-quality-latest",
  "grok-imagine-image-pro",
  "grok-imagine-image-2.0",
]);

const XAI_IMAGE_ASPECT_RATIOS = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
]);

const XAI_ONLY_IMAGE_ASPECT_RATIOS = new Set([
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
]);

const GOOGLE_GEMINI_IMAGE_ASPECT_RATIOS = new Set([
  "1:1",
  "1:4",
  "1:8",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "21:9",
]);

const GOOGLE_GEMINI_STANDARD_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

const APIMART_IMAGE_ASPECT_RATIOS = new Set([
  "1:1", "2:1", "1:2", "3:1", "1:3", "5:4", "4:5", "16:9", "9:16",
  "4:3", "3:4", "3:2", "2:3", "21:9", "9:21",
]);

type APIMartImageCapabilities = {
  hasResolution: boolean;
  maxResolution: number;
  minResolution: number;
  hasCount: boolean;
  hasQuality: boolean;
  hasOutput: boolean;
  hasReferences: boolean;
  maxReferences: number;
};

function normalizedAPIMartImageModel(model: string) {
  return model.trim().toLowerCase().replace(/[_.]/g, "-").replaceAll("/", "-");
}

function isKnownAPIMartImageModel(model: string) {
  const raw = model.trim().toLowerCase();
  const value = normalizedAPIMartImageModel(model);
  if (!value || raw.includes("/")) return false;
  if (value === "z-image" || value === "nano-banana" || value === "nano-banana-pro" || value.startsWith("nano-banana-2") || value.startsWith("gpt-image-2-text-to-image") || value.startsWith("gpt-image-2-image-to-image")) return false;
  if (value.endsWith("-apimart")) return true;
  return ["gemini-31", "nano-banana2", "seedream", "seedance-4", "qwen", "wan2-7", "flux-2"]
    .some((prefix) => value.startsWith(prefix)) || value === "gpt-image-2-official" || value === "gpt-image-2-apimart";
}

function apimartImageCapabilities(model: string): APIMartImageCapabilities | null {
  if (!isKnownAPIMartImageModel(model)) return null;
  const value = normalizedAPIMartImageModel(model);
  const result: APIMartImageCapabilities = {
    hasResolution: true,
    maxResolution: 4,
    minResolution: 1,
    hasCount: true,
    hasQuality: false,
    hasOutput: false,
    hasReferences: value !== "grok-imagine-1-5-apimart" && value !== "imagen-4-0-apimart",
    maxReferences: Number.POSITIVE_INFINITY,
  };
  if (value.includes("gpt-image-2")) {
    result.hasQuality = true;
    result.hasOutput = value.includes("official");
  } else if (value.includes("gpt-4o-image")) {
    result.hasResolution = false;
  } else if (value.includes("gpt-image-1")) {
    result.hasResolution = false;
    result.hasQuality = true;
    result.hasOutput = true;
  } else if (value.includes("gemini-3-1-flash-lite")) {
    result.maxResolution = 1;
  } else if (value.includes("gemini-3-1") || value.includes("gemini-31") || value.includes("nano-banana2") || value.includes("gemini-3-pro") || value.includes("nano-banana-pro")) {
    result.hasCount = false;
  } else if (value.includes("gemini-2-5") || value.includes("nano-banana")) {
    result.maxResolution = 1;
    result.hasCount = false;
  } else if (value.includes("imagen")) {
    result.hasResolution = false;
    result.hasCount = false;
    result.hasReferences = false;
  } else if (value.includes("seedream-5-0-pro")) {
    result.maxResolution = 2;
    result.hasCount = false;
    result.maxReferences = 10;
  } else if (value.includes("seedream-5")) {
    result.minResolution = 2;
    result.hasOutput = true;
  } else if (value.includes("seedream-4-5") || value.includes("seedance-4-5")) {
    result.minResolution = 2;
  } else if (value.includes("qwen")) {
    result.maxResolution = 2;
  } else if (value.includes("z-image")) {
    result.maxResolution = 2;
    result.hasCount = false;
    result.hasReferences = false;
  } else if (value.includes("grok-imagine")) {
    result.hasResolution = false;
  } else if (value.includes("flux-2")) {
    result.hasCount = false;
  }
  return result;
}

function isGoogleGeminiImageModelName(value: string) {
  return GOOGLE_GEMINI_IMAGE_MODELS.has(value);
}

function isZhipuImageModelName(value: string) {
  return value === "glm-image" || value.startsWith("cogview-");
}

function isAgnesImageModelName(value: string) {
  const normalized = value.replace(/[\s_]+/g, "-");
  return normalized.startsWith("agnes-image") || normalized.startsWith("agens-image");
}

function isAgnesImage21Model(model: string) {
  return model.trim().toLowerCase().replace(/[\s_]+/g, "-") === "agnes-image-2.1-flash";
}

function isOfficialGPTImageModelName(value: string) {
  return value.startsWith("gpt-image-") || value === "chatgpt-image-latest";
}

function isXAIImage20Model(model: string) {
  return model.trim().toLowerCase() === "grok-imagine-image-2.0";
}

function isOfficialXAIImageModelName(model: string) {
  const value = model.trim().toLowerCase();
  return XAI_IMAGE_MODELS.has(value) && value !== "grok-2-image-1212";
}

function isKIEImageModelName(model: string) {
  const value = model.trim().toLowerCase();
  if (value === "z-image" || value.includes("nano-banana") || value.startsWith("gpt-image-2-")) {
    return true;
  }
  if (!value.includes("/")) {
    return false;
  }
  if ([
    "bytedance/",
    "flux-2/",
    "google/",
    "gpt-image/",
    "grok-imagine/",
    "ideogram/",
    "qwen/",
    "qwen2/",
    "recraft/",
    "seedream/",
    "topaz/",
    "wan/2-7-image",
    "z-image",
  ].some((prefix) => value.startsWith(prefix))) {
    return true;
  }
  return value.includes("imagen4");
}

function isKIEImageEditModel(model: string) {
  const value = model.trim().toLowerCase();
  return isKIEImageModelName(value) && (
    value.includes("image-to-image") || value.includes("image-edit") || value.includes("edit") ||
    value.includes("remix") || value.includes("character") || value.includes("upscale") ||
    value.includes("remove-background") || value.includes("extend")
  );
}

function isGoogleGemini3ImageModel(model: string) {
  const value = model.trim().toLowerCase();
  return value === "gemini-3.1-flash-lite-image" ||
    value === "gemini-3.1-flash-image" ||
    value === "gemini-3-pro-image";
}

function isGoogleGeminiFlashLiteImageModel(model: string) {
  return model.trim().toLowerCase() === "gemini-3.1-flash-lite-image";
}

function isGoogleGemini31FlashImageModel(model: string) {
  return model.trim().toLowerCase() === "gemini-3.1-flash-image";
}

function supportsGoogleGeminiExtendedAspectRatios(model: string) {
  const value = model.trim().toLowerCase();
  return value === "gemini-3.1-flash-image";
}

export function imageModelRoute(model: string): ImageModelRoute {
  const value = model.trim().toLowerCase();
  if (isKnownAPIMartImageModel(value)) {
    return "apimart-image";
  }
  if (isKIEImageModelName(value)) {
    return "kie-image";
  }
  if (XAI_IMAGE_MODELS.has(value)) {
    return "xai-image";
  }
  if (isGoogleGeminiImageModelName(value)) {
    return "google-gemini-image";
  }
  if (isZhipuImageModelName(value)) {
    return "zhipu-image";
  }
  if (isAgnesImageModelName(value)) {
    return "agnes-image";
  }
  return "openai-image";
}

export function supportsImageEditing(model: string) {
  const route = imageModelRoute(model);
  if (route === "apimart-image") return apimartImageCapabilities(model)?.hasReferences === true;
  if (route === "kie-image") return isKIEImageEditModel(model);
  return route === "openai-image" || route === "google-gemini-image" || route === "xai-image" || route === "agnes-image";
}

export function supportsImageMask(model: string) {
  return imageModelRoute(model) === "openai-image";
}

export function imageReferenceImageLimit(model: string) {
  const value = model.trim().toLowerCase();
  const route = imageModelRoute(model);
  if (route === "apimart-image") {
    const capabilities = apimartImageCapabilities(model);
    return capabilities?.hasReferences ? capabilities.maxReferences : 0;
  }
  if (route === "xai-image") {
    return 4;
  }
  if (route === "zhipu-image") return 0;
  if (route === "kie-image") {
    if (value.includes("upscale") || value.includes("remove-background") || value.endsWith("/extend")) return 1;
    if (value.includes("text-to-image") || value.includes("imagen4") || value.includes("z-image")) return 0;
    return value.includes("nano-banana-2") || value.includes("nano-banana-pro") ? 14 : 4;
  }
  if (route === "google-gemini-image") {
    if (isGoogleGemini3ImageModel(value)) {
      return 14;
    }
    if (value === "gemini-2.5-flash-image") {
      return 3;
    }
  }
  if (isOfficialGPTImageModelName(value)) {
    return 10;
  }
  return 4;
}

export function imageOutputCountLimit(model: string) {
  const capabilities = apimartImageCapabilities(model);
  return capabilities && !capabilities.hasCount ? 1 : 15;
}

export function supportsImageStreaming(model: string) {
  if (imageModelRoute(model) === "apimart-image") return false;
  const route = imageModelRoute(model);
  return route === "openai-image" || route === "xai-image";
}

export function supportsImageSize(model: string) {
  return imageModelRoute(model) !== "xai-image" || isOfficialXAIImageModelName(model);
}

export function supportsImageExactDimensions(model: string) {
  return model.trim().toLowerCase() === "gpt-image-2";
}

export function supportsImageAspectRatio(model: string, aspectRatio: string) {
  const route = imageModelRoute(model);
  const value = model.trim().toLowerCase();
  if (route === "apimart-image") return aspectRatio === "" || APIMART_IMAGE_ASPECT_RATIOS.has(aspectRatio);
  if (route === "kie-image") {
    if (value.includes("recraft/") || value.includes("upscale") || value.includes("remove-background") || value.endsWith("/extend")) return aspectRatio === "";
    return aspectRatio === "" || ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "1:4", "1:8", "4:1", "4:5", "5:4", "8:1"].includes(aspectRatio);
  }
  if (route === "zhipu-image") return aspectRatio === "" || aspectRatio === "1:1" || aspectRatio === "16:9" || aspectRatio === "9:16" || aspectRatio === "4:3" || aspectRatio === "3:4";
  if (route === "agnes-image") {
    if (!isAgnesImage21Model(model)) return aspectRatio === "" || aspectRatio === "1:1" || aspectRatio === "16:9" || aspectRatio === "9:16" || aspectRatio === "4:3" || aspectRatio === "3:4";
    return aspectRatio === "" || ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"].includes(aspectRatio);
  }
  if (route === "xai-image") {
    return aspectRatio === "" || (isOfficialXAIImageModelName(model) && XAI_IMAGE_ASPECT_RATIOS.has(aspectRatio));
  }
  if (route === "google-gemini-image") {
    const value = model.trim().toLowerCase();
    const supported = supportsGoogleGeminiExtendedAspectRatios(value)
      ? GOOGLE_GEMINI_IMAGE_ASPECT_RATIOS
      : GOOGLE_GEMINI_STANDARD_ASPECT_RATIOS;
    return aspectRatio === "" || supported.has(aspectRatio);
  }
  return !["1:4", "1:8", "4:1", "4:5", "5:4", "8:1"].includes(aspectRatio) &&
    !XAI_ONLY_IMAGE_ASPECT_RATIOS.has(aspectRatio);
}

export function supportsImageResolution(model: string, resolution: string) {
  const route = imageModelRoute(model);
  const value = model.trim().toLowerCase();
  if (route === "apimart-image") {
    const capabilities = apimartImageCapabilities(model);
    if (!capabilities?.hasResolution) return resolution === "" || resolution === "auto";
    if (resolution === "" || resolution === "auto") return true;
    const levels: Record<string, number> = { "512": 1, "1k": 1, "2k": 2, "4k": 4 };
    const level = levels[resolution.toLowerCase()];
    return Boolean(level && level >= capabilities.minResolution && level <= capabilities.maxResolution);
  }
  if (route === "kie-image") {
    if (value.includes("flux-2") || value.includes("gpt-image-2") || (value.includes("nano-banana-2") && !value.includes("nano-banana-2-lite")) || value.includes("nano-banana-pro") || value.includes("wan/2-7-image") || value.includes("bytedance/seedream-v4")) return ["", "auto", "1k", "2k", "4k", "2K", "4K"].includes(resolution);
    return resolution === "" || resolution === "auto";
  }
  if (route === "zhipu-image") return ["auto", "1080p", "2k", "4k"].includes(resolution);
  if (route === "agnes-image") return ["auto", "1k", "2k", "4k"].includes(resolution);
  if (route === "xai-image") {
    return resolution === "auto" || (isOfficialXAIImageModelName(model) && ["1k", "2k"].includes(resolution));
  }
  if (route !== "google-gemini-image") {
    return ["auto", "1080p", "2k", "4k"].includes(resolution);
  }
  if (isGoogleGeminiFlashLiteImageModel(value) || !isGoogleGemini3ImageModel(value)) {
    return resolution === "auto";
  }
  if (isGoogleGemini31FlashImageModel(value)) {
    return ["auto", "512", "1k", "2k", "4k"].includes(resolution);
  }
  return ["auto", "1k", "2k", "4k"].includes(resolution);
}

export function supportsStructuredImageParameters(model: string) {
  const value = model.trim().toLowerCase();
  const route = imageModelRoute(model);
  return value === "gpt-image-2" || route === "google-gemini-image" || route === "agnes-image" || route === "kie-image" || route === "apimart-image" || isOfficialXAIImageModelName(value);
}

export function supportsImageOutputControls(model: string) {
  const value = model.trim().toLowerCase();
  const apimart = apimartImageCapabilities(model);
  if (apimart) return apimart.hasOutput;
  return imageModelRoute(model) === "openai-image" || value.includes("nano-banana") || value.includes("qwen/") || value.includes("qwen2/") || value === "google/nano-banana" || value === "google/nano-banana-edit";
}

export function supportsImageQuality(model: string) {
  const value = model.trim().toLowerCase();
  const apimart = apimartImageCapabilities(model);
  if (apimart) return apimart.hasQuality;
  return imageModelRoute(model) === "openai-image" || imageModelRoute(model) === "zhipu-image" || imageModelRoute(model) === "agnes-image" || isXAIImage20Model(model) || value.includes("seedream/4.5") || value.includes("seedream/5-") || value.includes("gpt-image/1.5");
}

export function supportsImageQualityValue(model: string, quality: string) {
  if (!quality) {
    return true;
  }
  if (imageModelRoute(model) === "apimart-image") {
    return supportsImageQuality(model) && ["low", "medium", "high"].includes(quality);
  }
  if (imageModelRoute(model) === "xai-image") {
    return isXAIImage20Model(model) && (quality === "low" || quality === "medium");
  }
  if (imageModelRoute(model) === "zhipu-image") return ["low", "medium", "high"].includes(quality);
  if (imageModelRoute(model) === "agnes-image") return ["low", "medium", "high"].includes(quality);
  return supportsImageQuality(model) && ["low", "medium", "high"].includes(quality);
}
