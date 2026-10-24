import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import type { VideoModelParameter, VideoParameterValues } from "@/lib/video-model-contracts";

const explanations: Record<string, string> = {
  seed: "随机种子；填写相同值有助于复现结果，留空由上游决定。",
  callback_url: "上游完成后通知的 HTTP(S) 地址；使用页面轮询时可以留空。",
  prompt_enhance: "允许上游优化提示词。",
  prompt_extend: "允许上游扩展提示词。",
  prompt_expansion_mode: "提示词扩展策略；按模型提供的选项选择。",
  aspect_ratio: "画面的宽高比例，与像素尺寸和清晰度分别设置。",
};

export function VideoParameterInputs({ parameters, value, onChange }: { parameters: VideoModelParameter[]; value: VideoParameterValues; onChange: (value: VideoParameterValues) => void }) {
  const set = (name: string, next: string | number | boolean | undefined) => {
    const copy = { ...value };
    if (next === undefined) delete copy[name]; else copy[name] = next;
    onChange(copy);
  };
  return <div className="grid gap-4">{parameters.map(parameter => {
    const current = Object.hasOwn(value, parameter.name) ? value[parameter.name] : parameter.default;
    const choices = parameter.type === "boolean" ? ["true", "false"] : parameter.enum;
    return <Field key={parameter.name}><FieldLabel htmlFor={`video-parameter-${parameter.name}`}>{parameter.label}{parameter.required ? " *" : "（选填）"}</FieldLabel>
      {choices?.length ? <Select value={current == null ? "__unset__" : String(current)} onValueChange={next => set(parameter.name, next === "__unset__" ? undefined : parameter.type === "boolean" ? next === "true" : next)}><SelectTrigger id={`video-parameter-${parameter.name}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__unset__">{parameter.required ? "请选择" : "使用默认行为"}</SelectItem>{choices.map(choice => <SelectItem key={choice} value={choice}>{parameter.type === "boolean" ? choice === "true" ? "开启" : "关闭" : choice}</SelectItem>)}</SelectContent></Select>
        : <Input id={`video-parameter-${parameter.name}`} type={parameter.type === "string" ? "text" : "number"} value={current == null ? "" : String(current)} min={parameter.minimum ?? undefined} max={parameter.maximum ?? undefined} step={parameter.type === "integer" ? 1 : "any"} maxLength={parameter.max_length || undefined} onChange={event => set(parameter.name, event.target.value === "" ? undefined : parameter.type === "string" ? event.target.value : Number(event.target.value))} />}
      {explanations[parameter.name] ? <FieldDescription>{explanations[parameter.name]}</FieldDescription> : null}
    </Field>;
  })}</div>;
}
