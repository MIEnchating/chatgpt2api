import { useEffect, useState } from "react";
import { ModelPicker } from "@/components/model-picker";
import { fetchRelayModels } from "@/lib/api";
import { formatModelPricing } from "@/lib/model-pricing";
import { useRelayTokenPreferences } from "@/lib/use-relay-token-preferences";

export function CreationModelSelector({ kind, value, options, isDisabled, onChange, onOpen }: {
  kind: "image" | "video";
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  isDisabled: (model: string) => boolean;
  onChange: (model: string) => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const { tokenNames, modelsByToken } = useRelayTokenPreferences();
  const namesKey = JSON.stringify(tokenNames[kind]);
  const currentLabel = options.find((option) => option.value === value)?.label || "暂无可用模型";

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const names = JSON.parse(namesKey) as string[];
    setQuotes({});
    setLoading(true);
    void Promise.all(names.map(async (name) => {
        try {
          return { name, response: await fetchRelayModels({ tokenName: name, includePricing: "cached", signal: controller.signal }) };
        } catch {
          return { name, response: null };
        }
      })).then((responses) => {
      if (controller.signal.aborted) return;
      const next: Record<string, string[]> = Object.create(null);
      for (const { name, response } of responses) {
        const items = new Map((response?.data || []).map((item) => [item.id?.trim().toLowerCase(), item]));
        for (const model of modelsByToken[name] || []) {
          const item = items.get(model.trim().toLowerCase());
          const text = response ? item ? formatModelPricing(item.pricing, response.pricing_error) : "未获取价格" : "价格获取失败";
          const prices = next[model.toLowerCase()] ||= [];
          if (!prices.includes(text)) prices.push(text);
        }
      }
      setQuotes(next);
      setLoading(false);
    });
    return () => controller.abort();
  }, [open, namesKey, modelsByToken]);

  return <ModelPicker value={value} options={options} onValueChange={onChange}
    label={`选择模型，当前 ${currentLabel}`} className="w-auto max-w-36 shrink sm:max-w-72"
    isModelDisabled={isDisabled}
    onOpenChange={(next) => { setOpen(next); if (next) onOpen(); }}
    renderDescription={(model) => loading ? "正在获取价格…" : quotes[model.toLowerCase()]?.length
      ? quotes[model.toLowerCase()].map((quote) => <div className="whitespace-pre-line" key={quote}>{quote}</div>)
      : "未提供定价"} />;
}
