export type ImageModelRoute = "openai-image" | "google-gemini-image" | "xai-image";

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

function isGoogleGeminiImageModelName(value: string) {
  return GOOGLE_GEMINI_IMAGE_MODELS.has(value);
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
  if (XAI_IMAGE_MODELS.has(value)) {
    return "xai-image";
  }
  if (isGoogleGeminiImageModelName(value)) {
    return "google-gemini-image";
  }
  return "openai-image";
}

export function supportsImageEditing(model: string) {
  const route = imageModelRoute(model);
  return route === "openai-image" || route === "google-gemini-image";
}

export function supportsImageMask(model: string) {
  return imageModelRoute(model) === "openai-image";
}

export function imageReferenceImageLimit(model: string) {
  const value = model.trim().toLowerCase();
  const route = imageModelRoute(model);
  if (route === "xai-image") {
    // The current NewAPI xAI adaptor does not forward image edit inputs.
    return 0;
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
  return isOfficialGPTImageModelName(model.trim().toLowerCase()) ? 10 : 4;
}

export function supportsImageStreaming(model: string) {
  return imageModelRoute(model) === "openai-image";
}

export function supportsImageSize(model: string) {
  return imageModelRoute(model) !== "xai-image" || isOfficialXAIImageModelName(model);
}

export function supportsImageExactDimensions(model: string) {
  return model.trim().toLowerCase() === "gpt-image-2";
}

export function supportsImageAspectRatio(model: string, aspectRatio: string) {
  const route = imageModelRoute(model);
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
  if (route === "xai-image") {
    return resolution === "auto" || (isOfficialXAIImageModelName(model) && ["1k", "2k"].includes(resolution));
  }
  if (route !== "google-gemini-image") {
    return ["auto", "1080p", "2k", "4k"].includes(resolution);
  }

  const value = model.trim().toLowerCase();
  if (isGoogleGeminiFlashLiteImageModel(value) || !isGoogleGemini3ImageModel(value)) {
    return resolution === "auto";
  }
  if (isGoogleGemini31FlashImageModel(value)) {
    return ["auto", "512", "1k", "2k", "4k"].includes(resolution);
  }
  return ["auto", "1k", "2k", "4k"].includes(resolution);
}

export function usesOfficialImageRoute(model: string) {
  return imageModelRoute(model) !== "google-gemini-image";
}

export function usesCodexImageRoute(model: string) {
  void model;
  return false;
}

export function supportsStructuredImageParameters(model: string) {
  const value = model.trim().toLowerCase();
  const route = imageModelRoute(model);
  return value === "gpt-image-2" || route === "google-gemini-image" || isOfficialXAIImageModelName(value);
}

export function supportsImageOutputControls(model: string) {
  return imageModelRoute(model) === "openai-image";
}

export function supportsImageQuality(model: string) {
  return imageModelRoute(model) === "openai-image" || isXAIImage20Model(model);
}

export function supportsImageQualityValue(model: string, quality: string) {
  if (!quality) {
    return true;
  }
  if (imageModelRoute(model) === "xai-image") {
    return isXAIImage20Model(model) && (quality === "low" || quality === "medium");
  }
  return supportsImageQuality(model) && ["low", "medium", "high"].includes(quality);
}
