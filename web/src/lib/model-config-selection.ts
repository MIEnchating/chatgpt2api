export function configuredModelNames(value: unknown): string[] {
  const items = Array.isArray(value) ? value : String(value ?? "").split(",");
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of items) {
    const model = String(item ?? "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

export function resolveConfiguredModel(
  configuredModels: unknown,
  ...preferredModels: unknown[]
): string {
  const models = configuredModelNames(configuredModels);
  for (const preferred of preferredModels) {
    const candidate = String(preferred ?? "").trim();
    if (models.includes(candidate)) return candidate;
  }
  return models[0] || "";
}
