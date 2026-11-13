export type RelayModelPricing = {
  currency: "USD";
  group?: string;
  group_ratio?: number;
  reference?: boolean;
  mode: "per_second" | "per_request" | "per_token" | "dynamic" | "unavailable";
  rates: { label: string; amount: number; unit: "second" | "request" | "million_tokens" | "count" | "credit" }[];
};

export type ModelPriceQuote = { tokenName: string; displayName: string; text: string };
export type ModelPriceQuotes = Record<string, ModelPriceQuote[]>;

export function hydrateModelPriceQuotes(current: ModelPriceQuotes, cached: ModelPriceQuotes): ModelPriceQuotes {
  const hydrated: ModelPriceQuotes = Object.create(null);
  for (const model of new Set([...Object.keys(cached), ...Object.keys(current)])) {
    const quotes = current[model] || [];
    const tokens = new Set(quotes.map((quote) => quote.tokenName));
    hydrated[model] = [...quotes, ...(cached[model] || []).filter((quote) => !tokens.has(quote.tokenName))];
  }
  return hydrated;
}

export function mergeModelPriceQuotes(current: ModelPriceQuotes, updated: ModelPriceQuotes, refreshedTokenNames: string[]): ModelPriceQuotes {
  const refreshed = new Set(refreshedTokenNames);
  const merged: ModelPriceQuotes = Object.create(null);
  for (const model of new Set([...Object.keys(current), ...Object.keys(updated)])) {
    const quotes = [...(current[model] || []).filter((quote) => !refreshed.has(quote.tokenName)), ...(updated[model] || [])];
    if (quotes.length) merged[model] = quotes;
  }
  return merged;
}

export function formatModelPricing(pricing?: RelayModelPricing, error?: string): string {
  if (!pricing) return error || "未提供定价";
  if (pricing.mode === "unavailable") return "未提供定价";
  if (pricing.mode === "dynamic" && !pricing.rates?.length) return "动态计费 · 按实际用量";
  if (pricing.currency !== "USD" || !pricing.rates?.length) return "未提供定价";
  const units = { second: "秒", request: "次", million_tokens: "百万 tokens", count: "个", credit: "计费单位" };
  if (pricing.rates.some((rate) => !Number.isFinite(rate.amount) || rate.amount < 0 || !units[rate.unit])) return "未提供定价";
  const labels = pricing.rates.map((rate) => {
    if (rate.unit === "second") return rate.label.replace(/ · seconds?$/i, "");
    if (rate.unit === "count") return rate.label.replace(/ · count$/i, "");
    return rate.label;
  });
  const conditions: string[] = [];
  const simplified: string[] = [];
  let field = "";
  for (const [index, label] of labels.entries()) {
    const prefix = conditions.map((condition) => `非(${condition})`).join(" 且 ");
    const remaining = prefix ? label.startsWith(`${prefix} 且 `) ? label.slice(prefix.length + 3) : label === prefix ? "" : null : label;
    if (remaining === null) break;
    if (!remaining && conditions.length && index === labels.length - 1) { simplified.push("其他"); continue; }
    const match = /^([\w.]+) = ([^()]+)$/.exec(remaining);
    if (!match || (field && field !== match[1]) || conditions.includes(remaining)) break;
    field = match[1];
    conditions.push(remaining);
    simplified.push(remaining);
  }
  return pricing.rates.map((rate) => {
    const amount = rate.amount.toLocaleString("en-US", { maximumSignificantDigits: 8, useGrouping: false });
    const index = pricing.rates.indexOf(rate);
    const displayLabel = rate.unit === "second" ? rate.label.replace(/ · seconds?$/i, "") : rate.label;
    let label = pricing.mode === "dynamic" && simplified.length === pricing.rates.length && conditions.length > 1
      ? simplified[index] : pricing.rates.length === 1 && /^(base|standard)$/i.test(labels[index]) ? "" : displayLabel.replace(/^base · /i, "");
    if ((rate.unit === "second" && /^seconds?$/i.test(label)) || (rate.unit === "count" && /^count$/i.test(label))) label = "";
    label = label.replace(/\bresolution\s*=\s*([\w.-]+)/gi, "分辨率 $1");
    return `${label ? `${label} ` : ""}$${amount}/${units[rate.unit]}`;
  }).join(pricing.mode === "dynamic" ? "\n" : " · ");
}

export function modelPriceQuotesFromResponses(responses: {
  tokenName: string;
  displayName: string;
  pricing_error?: string;
  data?: { id?: string; pricing?: RelayModelPricing }[] | null;
}[]): ModelPriceQuotes {
  const quotes: ModelPriceQuotes = Object.create(null);
  for (const response of responses) {
    for (const item of response.data || []) {
      const model = item.id?.trim();
      if (!model) continue;
      const list = quotes[model] ||= [];
      if (!list.some((quote) => quote.tokenName === response.tokenName)) {
        list.push({ tokenName: response.tokenName, displayName: response.displayName, text: formatModelPricing(item.pricing, response.pricing_error) });
      }
    }
  }
  return quotes;
}
