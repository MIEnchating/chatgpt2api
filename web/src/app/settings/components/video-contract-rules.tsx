import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { VideoModelContractRule, VideoModelContractRuleField } from "@/lib/video-model-contracts";

const FIELDS: { value: VideoModelContractRuleField; label: string }[] = [
  { value: "first_frame", label: "首帧图片" }, { value: "last_frame", label: "尾帧图片" },
  { value: "reference_image", label: "参考图片" }, { value: "reference_video", label: "参考视频" }, { value: "reference_audio", label: "参考音频" },
  { value: "generate_audio", label: "生成音频" }, { value: "size", label: "画幅比例" }, { value: "resolution", label: "清晰度" },
  { value: "duration", label: "视频时长" }, { value: "watermark", label: "水印" },
];
const FORCE_FIELDS = FIELDS.filter((field) => ["duration", "size", "resolution", "generate_audio", "watermark"].includes(field.value));
const fieldLabel = (value: string) => FIELDS.find((field) => field.value === value)?.label || value;
const displayValue = (value: string | undefined) => value === "true" ? "开启" : value === "false" ? "关闭" : value || "…";

function RuleFieldSelect({ value, onChange, disabled, id, options = FIELDS }: {
  value: string; onChange: (value: VideoModelContractRuleField) => void; disabled: boolean; id?: string; options?: typeof FIELDS;
}) {
  return <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as VideoModelContractRuleField)}><SelectTrigger id={id} className="h-10"><SelectValue /></SelectTrigger><SelectContent>{options.map((field) => <SelectItem key={field.value} value={field.value}>{field.label}</SelectItem>)}</SelectContent></Select>;
}

function RuleValue({ field, value, disabled, onChange, id }: {
  field: string; value: string; disabled: boolean; onChange: (value: string) => void; id?: string;
}) {
  if (field === "generate_audio" || field === "watermark") return <Select value={value} disabled={disabled} onValueChange={onChange}><SelectTrigger id={id} className="h-10"><SelectValue placeholder="选择开关状态" /></SelectTrigger><SelectContent><SelectItem value="true">开启</SelectItem><SelectItem value="false">关闭</SelectItem></SelectContent></Select>;
  if (field === "duration") return <NumberInput id={id} min={1} max={3600} value={value} disabled={disabled} suffix="秒" onValueChange={onChange} />;
  return <Input id={id} value={value} disabled={disabled} placeholder={field === "size" ? "例如 16:9" : field === "resolution" ? "例如 1080p" : "填写需要匹配的值"} onChange={(event) => onChange(event.target.value)} />;
}

function RuleAssignments({ kind, values, disabled, onChange }: {
  kind: "limits" | "force"; values: Partial<Record<VideoModelContractRuleField, string | number>>; disabled: boolean;
  onChange: (values: Partial<Record<VideoModelContractRuleField, string | number>>) => void;
}) {
  const options = kind === "force" ? FORCE_FIELDS : FIELDS;
  const available = options.filter((field) => values[field.value] === undefined);
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{kind === "force" ? "自动设为指定值" : "素材数量上限"}</span><Button type="button" variant="ghost" size="sm" disabled={disabled || available.length === 0} onClick={() => {
      const field = available[0]?.value;
      if (field) onChange({ ...values, [field]: kind === "limits" ? 1 : field === "duration" ? "5" : field === "size" ? "16:9" : field === "resolution" ? "720p" : "true" });
    }}><Plus className="size-3.5" />添加</Button></div>
    {Object.entries(values).map(([field, value]) => <div key={field} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
      <RuleFieldSelect value={field} disabled={disabled} options={options.filter((item) => item.value === field || values[item.value] === undefined)} onChange={(next) => { const updated = { ...values }; delete updated[field as VideoModelContractRuleField]; updated[next] = kind === "limits" ? value : next === "generate_audio" || next === "watermark" ? "true" : next === "duration" ? "5" : ""; onChange(updated); }} />
      {kind === "limits" ? <NumberInput aria-label={`${fieldLabel(field)}条件上限`} min={0} max={80} value={value} disabled={disabled} suffix="个" onValueChange={(next) => onChange({ ...values, [field]: Number(next) || 0 })} /> : <RuleValue field={field} value={String(value)} disabled={disabled} onChange={(next) => onChange({ ...values, [field]: next })} />}
      <Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label={`删除${fieldLabel(field)}${kind === "limits" ? "数量上限" : "固定值"}`} onClick={() => { const next = { ...values }; delete next[field as VideoModelContractRuleField]; onChange(next); }}><Trash2 className="size-3.5" /></Button>
    </div>)}
  </div>;
}

export function ContractRuleEditor({ disabled, index, onChange, onRemove, rule }: {
  disabled: boolean; index: number; onChange: (rule: VideoModelContractRule) => void; onRemove: () => void; rule: VideoModelContractRule;
}) {
  const actions = [
    rule.require?.length ? `必须提供${rule.require.map(fieldLabel).join("、")}` : "",
    rule.require_any?.length ? `${rule.require_any.map(fieldLabel).join("、")}至少提供一项` : "",
    rule.forbid?.length ? `不能同时使用${rule.forbid.map(fieldLabel).join("、")}` : "",
    ...Object.entries(rule.limits || {}).map(([field, value]) => `${fieldLabel(field)}最多 ${value} 个`),
    ...Object.entries(rule.force_values || {}).map(([field, value]) => `${fieldLabel(field)}设为${displayValue(value)}`),
    rule.ui?.show?.length ? `显示${rule.ui.show.map(fieldLabel).join("、")}` : "",
    rule.ui?.hide?.length ? `隐藏${rule.ui.hide.map(fieldLabel).join("、")}` : "",
    rule.ui?.disable?.length ? `锁定${rule.ui.disable.map(fieldLabel).join("、")}` : "",
  ].filter(Boolean);
  const summary = `当${fieldLabel(rule.when.field)}${rule.when.operator === "present" ? "已提供或开启" : `为${displayValue(rule.when.value)}`}时，${actions.join("；") || "请选择执行动作"}。`;
  return (
    <details data-video-contract-rule className="group/rule overflow-hidden rounded-lg border border-border/70 bg-background" open>
      <summary className="flex cursor-pointer list-none items-center gap-3 bg-muted/25 px-4 py-3 [&::-webkit-details-marker]:hidden"><span className="text-xs font-medium text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><p className="min-w-0 flex-1 text-sm leading-6">{summary}</p><ChevronDown className="size-4 shrink-0 text-muted-foreground group-open/rule:rotate-180" /></summary>
      <div className="space-y-4 border-t border-border/60 p-4">
        <div className="grid items-start gap-3 sm:grid-cols-3">
          <Field><FieldLabel htmlFor={`rule-${index}-field`}>当这个参数</FieldLabel><RuleFieldSelect id={`rule-${index}-field`} value={rule.when.field} disabled={disabled} onChange={(field) => onChange({ ...rule, when: { field, operator: "present" } })} /></Field>
          <Field><FieldLabel htmlFor={`rule-${index}-operator`}>满足条件</FieldLabel><Select value={rule.when.operator} disabled={disabled} onValueChange={(operator) => onChange({ ...rule, when: { ...rule.when, operator: operator as "present" | "equals", value: operator === "equals" ? "" : undefined } })}><SelectTrigger id={`rule-${index}-operator`} className="h-10"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="present">已提供或开启</SelectItem><SelectItem value="equals">等于指定值</SelectItem></SelectContent></Select></Field>
          {rule.when.operator === "equals" ? <Field><FieldLabel htmlFor={`rule-${index}-value`}>指定值</FieldLabel><RuleValue id={`rule-${index}-value`} field={rule.when.field} value={rule.when.value || ""} disabled={disabled} onChange={(value) => onChange({ ...rule, when: { ...rule.when, value } })} /></Field> : null}
        </div>
        <div className="space-y-3 rounded-lg bg-muted/25 p-3">
          <p className="text-xs font-semibold">则检查以下要求 <span className="font-normal text-muted-foreground">· 按需选择，可留空</span></p>
          <div className="grid gap-3 sm:grid-cols-2">
            {([ ["require", "必须同时提供"], ["require_any", "至少提供一项"], ["forbid", "不能同时使用"] ] as const).map(([key, label]) => <Field key={key}><FieldLabel>{label}</FieldLabel><MultiSelect collapseTags={false} value={rule[key] || []} options={FIELDS} disabled={disabled} placeholder="选择参数" onValueChange={(values) => onChange({ ...rule, [key]: values })} /></Field>)}
          </div>
        </div>
        <details className="group/extra rounded-lg border border-border/60" open={Object.keys(rule.limits || {}).length > 0 || Object.keys(rule.force_values || {}).length > 0 || undefined}>
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium">限制数量或自动设置参数<ChevronDown className="size-3.5 group-open/extra:rotate-180" /></summary>
          <div className="space-y-3 border-t border-border/60 p-3">
            <p className="text-xs leading-5 text-muted-foreground">例如有参考视频时最多上传 1 张参考图；或特定清晰度下固定为接口支持的时长。固定值会改变实际请求，请使用模型支持的值。</p>
            <RuleAssignments kind="limits" values={rule.limits || {}} disabled={disabled} onChange={(limits) => onChange({ ...rule, limits: limits as VideoModelContractRule["limits"] })} />
            <RuleAssignments kind="force" values={rule.force_values || {}} disabled={disabled} onChange={(force_values) => onChange({ ...rule, force_values: force_values as VideoModelContractRule["force_values"] })} />
          </div>
        </details>
        <details className="group/ui rounded-lg border border-border/60" open={Boolean(rule.ui?.show?.length || rule.ui?.hide?.length || rule.ui?.disable?.length) || undefined}>
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-medium">调整创作面板中的控件<ChevronDown className="size-3.5 group-open/ui:rotate-180" /></summary>
          <div className="grid gap-3 border-t border-border/60 p-3 sm:grid-cols-2">
            <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">只影响显示和可编辑状态。隐藏参数不会禁止提交；需要禁止时，请同时配置“不能同时使用”。</p>
            {([ ["show", "显示"], ["hide", "隐藏"], ["disable", "锁定编辑"] ] as const).map(([key, label]) => <Field key={key}><FieldLabel>{label}</FieldLabel><MultiSelect collapseTags={false} value={rule.ui?.[key] || []} options={FIELDS} disabled={disabled} placeholder="选择参数" onValueChange={(values) => onChange({ ...rule, ui: { ...rule.ui, [key]: values } })} /></Field>)}
          </div>
        </details>
        <Field><FieldLabel htmlFor={`rule-${index}-message`}>不满足要求时，向用户提示</FieldLabel><Input id={`rule-${index}-message`} value={rule.message} disabled={disabled} placeholder="例如：添加尾帧前请先上传首帧图片" onChange={(event) => onChange({ ...rule, message: event.target.value })} /></Field>
        {!disabled ? <div className="flex justify-end"><Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={onRemove}><Trash2 className="size-3.5" />删除规则</Button></div> : null}
      </div>
    </details>
  );
}
