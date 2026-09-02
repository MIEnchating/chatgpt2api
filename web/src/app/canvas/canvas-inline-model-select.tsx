import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function CanvasInlineModelSelect({ value, models, label, onChange, className }: {
  value: string;
  models: readonly string[];
  label: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const options = Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
  const selectedValue = options.includes(value) ? value : "";
  return (
    <div data-canvas-inline-model className={cn("flex min-w-0 flex-1 items-center", className)}>
      <Select value={selectedValue} disabled={options.length === 0} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="h-8 min-w-0 flex-1 rounded-lg border-0 bg-muted/55 px-2.5 text-xs shadow-none hover:bg-muted focus:ring-0">
          <SelectValue placeholder={options.length ? "选择模型" : "暂无可用模型"} />
        </SelectTrigger>
        <SelectContent>{options.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}
