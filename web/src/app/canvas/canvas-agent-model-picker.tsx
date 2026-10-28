import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TooltipHint } from "@/components/ui/tooltip";

export function CanvasAgentModelPicker({ model, models, disabled, codex, onChange }: {
  model: string;
  models: { value: string; label: string }[];
  disabled: boolean;
  codex: boolean;
  onChange: (model: string) => void;
}) {
  const selected = models.find((item) => item.value === model);
  return <Select value={selected?.value || ""} onValueChange={onChange} disabled={disabled || !models.length}>
    <TooltipHint content={selected ? `对话模型：${selected.label}` : codex ? "连接 Codex 后选择模型" : "选择对话模型"}>
      <SelectTrigger aria-label="Agent 对话模型" className="h-8 w-auto min-w-0 max-w-40 shrink gap-1 rounded-full border-0 bg-muted/60 px-2.5 text-xs shadow-none [&_[data-slot=select-icon]]:size-3">
        <SelectValue placeholder={models.length ? "选择模型" : codex ? "请先连接 Codex" : "暂无可用模型"} />
      </SelectTrigger>
    </TooltipHint>
    <SelectContent side="top" align="start">{models.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
  </Select>;
}
