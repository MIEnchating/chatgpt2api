import { ModelPicker } from "@/components/model-picker";

export function CanvasAgentModelPicker({ model, models, disabled, codex, onChange }: {
  model: string;
  models: { value: string; label: string }[];
  disabled: boolean;
  codex: boolean;
  onChange: (model: string) => void;
}) {
  return <ModelPicker value={model} options={models} onValueChange={onChange} label="Agent 对话模型"
    disabled={disabled} placeholder={codex ? "请先连接 Codex" : "暂无可用模型"} className="w-auto max-w-[min(10rem,35vw)] shrink-0" />;
}
