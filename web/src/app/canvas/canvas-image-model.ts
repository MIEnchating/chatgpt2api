import { configuredModelNames, resolveConfiguredModel } from "@/lib/model-config-selection";

export function resolveCanvasImageModel(
  defaultModel: unknown,
  imageModels: unknown,
) {
  const configuredModels = configuredModelNames(imageModels)
    .filter((model) => model.toLowerCase() !== "auto");
  return resolveConfiguredModel(configuredModels, defaultModel);
}
