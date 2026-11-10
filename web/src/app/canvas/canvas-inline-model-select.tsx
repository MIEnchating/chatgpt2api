import { ModelPicker } from "@/components/model-picker";
import { cn } from "@/lib/utils";

export function CanvasInlineModelSelect({ value, models, label, onChange, className }: {
  value: string;
  models: readonly string[];
  label: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return <div data-canvas-inline-model className={cn("flex min-w-0 flex-1 items-center", className)}>
    <ModelPicker value={value} options={models} label={label} onValueChange={onChange} className="w-auto max-w-full" />
  </div>;
}
