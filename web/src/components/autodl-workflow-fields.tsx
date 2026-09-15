import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchAutoDLWorkflows, isAutoDLRelay, type AutoDLWorkflow } from "@/services/api/autodl";

export type AutoDLWorkflowInputs = Record<string, string | number | boolean>;

const parameterLabels: Record<string, string> = {
  duration: "时长（秒）", audio_duration: "音频时长（秒）", resolution: "清晰度与画幅", seed: "随机种子",
  first_frame: "首帧图片", last_frame: "尾帧图片", prompt_simple: "音色参考音频", emo_ref_audio: "情感参考音频",
  emo_control_method: "情感控制方式", emo_afraid: "恐惧", emo_angry: "愤怒", emo_calm: "平静", emo_disgusted: "厌恶",
  emo_happy: "开心", emo_melancholic: "低落", emo_sad: "悲伤", emo_surprised: "惊讶", emo_random: "随机情感",
};

export function AutoDLWorkflowFields({ tokenName, model, value, onChange, disabled = false, children }: {
  tokenName: string;
  model: string;
  value: AutoDLWorkflowInputs;
  onChange: (value: AutoDLWorkflowInputs) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const [workflow, setWorkflow] = useState<AutoDLWorkflow | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setWorkflow(null);
    setError("");
    setLoading(false);
    setActive(null);
    if (!tokenName.startsWith("__custom_relay__:") || !model) { setActive(false); return () => controller.abort(); }
    void (async () => {
      try {
        const enabled = await isAutoDLRelay(tokenName, controller.signal);
        if (controller.signal.aborted) return;
        setActive(enabled);
        if (!enabled) return;
        setLoading(true);
        const { items } = await fetchAutoDLWorkflows(tokenName, model, controller.signal);
        if (!controller.signal.aborted) setWorkflow(items[0] || null);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取工作流参数失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [tokenName, model]);
  if (!tokenName.startsWith("__custom_relay__:") || active === false) return children;
  if (loading) return <p className="text-xs text-muted-foreground">正在读取 AutoDL 工作流参数…</p>;
  if (error) return <p role="alert" className="text-xs text-destructive">{error}</p>;
  if (!workflow) return null;
  const update = (key: string, next: string | number | boolean | undefined) => {
    const fields = { ...value };
    if (next === undefined || next === "") delete fields[key];
    else fields[key] = next;
    onChange(fields);
  };
  return <div className="grid gap-3 rounded-lg border p-3">
    <div className="text-sm font-medium">{workflow.name || workflow.uuid}</div>
    <p className="text-xs text-muted-foreground">{workflow.kind === "video" ? "参数来自工作流规则。提示词、时长与参考素材使用画布和视频设置中的值。" : "参数来自工作流规则。提示词与连线音频会自动传入；音频也可填写公开 URL。"}</p>
    {Object.entries(workflow.input_rules || {}).filter(([key]) => key !== "prompt" && key !== "prompt_text" && !(workflow.kind === "video" && (key === "duration" || /^(first_frame|last_frame|ref_image(?:_\d+)?|ref_audio(?:_\d+)?|ref_video(?:_\d+)?)$/.test(key)))).map(([key, rule]) => {
      const mediaRule = ["image", "audio", "video"].includes(rule.type);
      const current = value[key] ?? (mediaRule ? undefined : rule.default);
      return <label key={key} className="grid gap-1 text-xs">
        <span>{parameterLabels[key] || key}{rule.required ? " *" : ""}</span>
        {rule.type === "boolean" ? <Checkbox disabled={disabled} checked={current === true} onCheckedChange={(checked) => update(key, checked === true)} />
          : rule.options?.length ? <Select value={typeof current === "string" ? current : ""} disabled={disabled} onValueChange={(next) => update(key, next)}><SelectTrigger><SelectValue placeholder="选择参数值" /></SelectTrigger><SelectContent>{rule.options.map((item) => <SelectItem key={item.label} value={item.label}>{item.label}</SelectItem>)}</SelectContent></Select>
            : <Input disabled={disabled} type={["integer", "number", "float"].includes(rule.type) ? "number" : mediaRule ? "url" : "text"} min={rule.min} max={rule.max} minLength={rule.min_length} maxLength={rule.max_length} placeholder={mediaRule ? "https:// 或通过连线提供素材" : undefined} step={rule.type === "integer" ? 1 : "any"} value={typeof current === "string" || typeof current === "number" ? current : ""} onChange={(event) => update(key, event.target.value === "" ? undefined : ["integer", "number", "float"].includes(rule.type) ? Number(event.target.value) : event.target.value)} />}
      </label>;
    })}
  </div>;
}
