export type ModelGroups = { overrides: Record<string, string>; order: string[] };

export function automaticModelGroup(model: string): string {
  const name = model.toLowerCase();
  if (/^ch\d+-sd-/.test(name) || /(^|[\s/:_-])(seedance|jimeng|即梦)([\s/:_.-]|$)/i.test(name)) return "即梦 / Seedance";
  if (/(^|[\s/:_-])(minimax|hailuo)([\s/:_.-]|$)/i.test(name)) return "MiniMax / 海螺";
  return (model.split(/[/:_-]/, 1)[0]?.trim() || "其他").toUpperCase();
}

export function groupModelsByFamily<T extends { value: string }>(options: readonly T[], config?: ModelGroups): { name: string; options: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const option of options) {
    const family = config?.overrides?.[option.value]?.trim() || automaticModelGroup(option.value);
    const items = groups.get(family) || [];
    items.push(option);
    groups.set(family, items);
  }
  const result = Array.from(groups, ([name, items]) => ({ name, options: items }));
  const positions = new Map(config?.order?.map((name, index) => [name, index]));
  return result.sort((a, b) => (positions.get(a.name) ?? Infinity) - (positions.get(b.name) ?? Infinity));
}

export function resolveModelGroupConfig(models: readonly string[], config?: ModelGroups): ModelGroups {
  return {
    overrides: config?.overrides || {},
    order: groupModelsByFamily(models.map((value) => ({ value })), config).map((group) => group.name),
  };
}

export function renameModelGroup(models: readonly string[], config: ModelGroups, name: string, newName: string): ModelGroups {
  const target = newName.trim();
  if (!target || target === name) return config;
  const groups = groupModelsByFamily(models.map((value) => ({ value })), config);
  const group = groups.find((item) => item.name === name);
  if (!group) return config;
  const overrides = { ...config.overrides };
  for (const { value } of group.options) overrides[value] = target;
  return {
    overrides,
    order: Array.from(new Set(groups.map((item) => item.name === name ? target : item.name))),
  };
}
