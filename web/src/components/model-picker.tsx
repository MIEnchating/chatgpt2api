import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { ModelSelector, ModelSelectorContent, ModelSelectorEmpty, ModelSelectorGroup, ModelSelectorInput, ModelSelectorItem, ModelSelectorList, ModelSelectorName, ModelSelectorTrigger } from "@/components/ai-elements/model-selector";
import { Button } from "@/components/ui/button";
import { groupModelsByFamily, resolveModelGroupConfig } from "@/lib/model-groups";
import { cn } from "@/lib/utils";
import { fetchModelConfig } from "@/lib/api";
import type { ModelGroups } from "@/lib/model-groups";

type ModelOption = string | { value: string; label: string };

export function ModelPicker({ id, label, value, options, onValueChange, disabled = false, placeholder = "暂无可用模型", className, isModelDisabled, renderDescription, onOpenChange }: {
  id?: string;
  label: string;
  value: string;
  options: readonly ModelOption[];
  onValueChange: (model: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  isModelDisabled?: (model: string) => boolean;
  renderDescription?: (model: string) => ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [groupConfig, setGroupConfig] = useState<ModelGroups>();
  const models = useMemo(() => {
    const unique = new Map<string, { value: string; label: string }>();
    for (const option of options) {
      const model = typeof option === "string" ? { value: option.trim(), label: option.trim() } : option;
      if (model.value && !unique.has(model.value)) unique.set(model.value, model);
    }
    return Array.from(unique.values());
  }, [options]);
  const groups = useMemo(() => groupModelsByFamily(models, groupConfig), [models, groupConfig]);
  const selected = models.find((model) => model.value === value);
  const unavailable = disabled || models.length === 0;

  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void fetchModelConfig().then(({ config }) => {
      if (!active) return;
      setGroupConfig(resolveModelGroupConfig([
        ...config.text_models, ...config.image_models, ...config.video_models, ...config.audio_models,
      ], config.model_groups));
    }).catch(() => {});
    return () => { active = false; };
  }, [open]);

  function changeOpen(next: boolean) {
    if (next && unavailable) return;
    setOpen(next);
    onOpenChange?.(next);
  }

  return <ModelSelector open={open && !unavailable} onOpenChange={changeOpen}>
    <ModelSelectorTrigger asChild>
      <Button id={id} type="button" variant="outline" size="sm" disabled={unavailable} aria-label={label} className={cn("w-full min-w-0 justify-between", className)}>
        <ModelSelectorName>{selected?.label || (models.length ? "选择模型" : placeholder)}</ModelSelectorName>
        <ChevronDown />
      </Button>
    </ModelSelectorTrigger>
    {open && !unavailable ? <ModelSelectorContent title={label}>
      <ModelSelectorInput placeholder="搜索模型…" aria-label="搜索模型" />
      <ModelSelectorList>
        <ModelSelectorEmpty>没有找到模型</ModelSelectorEmpty>
        {groups.map((group) => <ModelSelectorGroup key={group.name} heading={group.name}>
          {group.options.map((model) => <ModelSelectorItem key={model.value} value={model.value} keywords={[model.label, group.name]} disabled={isModelDisabled?.(model.value)} data-checked={model.value === value}
            onSelect={() => {
              if (unavailable || isModelDisabled?.(model.value)) return;
              onValueChange(model.value);
              changeOpen(false);
            }}>
            <div className="min-w-0 flex-1">
              <ModelSelectorName className="block" title={model.label}>{model.label}</ModelSelectorName>
              {renderDescription ? <div className="break-words text-xs text-muted-foreground">{renderDescription(model.value)}</div> : null}
            </div>
          </ModelSelectorItem>)}
        </ModelSelectorGroup>)}
      </ModelSelectorList>
    </ModelSelectorContent> : null}
  </ModelSelector>;
}
