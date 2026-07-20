export function resolveCanvasImageModel(
  defaultModel: unknown,
  imageModels: unknown,
  fallback = "gpt-image-2",
) {
  const configuredModels = Array.isArray(imageModels)
    ? imageModels
    : String(imageModels ?? "").split(",");
  const candidates = [defaultModel, ...configuredModels, fallback];
  for (const candidate of candidates) {
    const model = String(candidate ?? "").trim();
    if (model && model.toLowerCase() !== "auto") {
      return model;
    }
  }
  return fallback;
}
