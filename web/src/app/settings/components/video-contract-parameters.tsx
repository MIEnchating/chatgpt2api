import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { VideoModelContract, VideoModelParameter } from "@/lib/video-model-contracts";

export function ContractParametersEditor({ capability, disabled, onChange }: { capability: VideoModelContract["capability"]; disabled: boolean; onChange: (capability: VideoModelContract["capability"]) => void }) {
  const parameters = capability.parameters || [];
  const update = (index: number, patch: Partial<VideoModelParameter>) => onChange({...capability, parameters: parameters.map((item, i) => i === index ? {...item, ...patch} : item)});
  return <div className="space-y-4">
    <p className="text-xs leading-5 text-muted-foreground">附加参数分别随模型保存。随机种子、回调地址、提示词增强和独立宽高比都在这里声明；没有默认值的选填参数不会发送。</p>
    {parameters.map((parameter, index) => <div key={index} className="space-y-3 rounded-lg border p-3">
      <div className="grid gap-3 sm:grid-cols-2">{([['name','参数标识'],['label','中文名称'],['field','上游字段路径']] as const).map(([key,label]) => <Field key={key}><FieldLabel>{label}</FieldLabel><Input disabled={disabled} value={parameter[key]} onChange={event => update(index,{[key]:event.target.value})} /></Field>)}
        <Field><FieldLabel>类型</FieldLabel><Select disabled={disabled} value={parameter.type} onValueChange={type => update(index,{type: type as VideoModelParameter['type'], default: null, enum: [], minimum: null, maximum: null, format: "", max_length: 0})}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{[['string','文本'],['integer','整数'],['number','数值'],['boolean','开关']].map(([value,label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field>
        <ParameterDefault key={`${parameter.type}:${JSON.stringify(parameter.default)}`} parameter={parameter} disabled={disabled} onChange={value => update(index,{default:value})} />
        {parameter.type === 'string' ? <><Field><FieldLabel>可选值（逗号分隔）</FieldLabel><Input disabled={disabled} defaultValue={parameter.enum?.join(', ')} onBlur={event => update(index,{enum:event.target.value.split(/[,，]/).map(v=>v.trim()).filter(Boolean)})} /></Field><Field><FieldLabel>最长字符数（0 为不限制）</FieldLabel><Input type="number" min={0} disabled={disabled} value={parameter.max_length || 0} onChange={event => update(index,{max_length:Number(event.target.value)})} /></Field><label className="flex items-center gap-2 text-sm"><Checkbox disabled={disabled} checked={parameter.format === 'uri'} onCheckedChange={checked => update(index,{format:checked ? 'uri' : ''})} />必须是 HTTP(S) 地址</label></> : null}
        {parameter.type === 'number' || parameter.type === 'integer' ? (['minimum','maximum'] as const).map(key => <Field key={key}><FieldLabel>{key === 'minimum' ? '最小值' : '最大值'}（留空为未限制）</FieldLabel><Input type="number" disabled={disabled} value={parameter[key] ?? ''} onChange={event => update(index,{[key]:event.target.value === '' ? null : Number(event.target.value)})} /></Field>) : null}
      </div>
      <label className="flex items-center gap-2 text-sm"><Checkbox disabled={disabled} checked={parameter.required} onCheckedChange={checked => update(index,{required:Boolean(checked)})} />必填参数</label>
      <Field><FieldLabel>适用模式（不勾选表示所有模式）</FieldLabel><div className="flex flex-wrap gap-3">{(['text','image','reference'] as const).map(mode => <label key={mode} className="flex items-center gap-2 text-xs"><Checkbox disabled={disabled} checked={parameter.modes?.includes(mode) || false} onCheckedChange={checked => update(index,{modes:checked ? [...(parameter.modes || []),mode] : parameter.modes?.filter(item=>item!==mode)})} />{({text:'文生',image:'首尾帧',reference:'参考素材'})[mode]}</label>)}</div></Field>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange({...capability,parameters:parameters.filter((_,i)=>i!==index)})}>删除参数</Button>
    </div>)}
    <Button type="button" variant="outline" size="sm" disabled={disabled || parameters.length >= 32} onClick={() => onChange({...capability,parameters:[...parameters,{name:'',label:'',field:'',type:'string',required:false}]})}>添加附加参数</Button>
    <div className="space-y-3 rounded-lg border p-3"><label className="flex items-center gap-2 text-sm"><Checkbox disabled={disabled} checked={Boolean(capability.seconds_range)} onCheckedChange={checked => onChange({...capability, seconds: checked ? [] : [capability.default_seconds], seconds_range:checked ? {min:1,max:null,step:1} : null})} />使用时长范围</label>
      {capability.seconds_range ? <div className="grid grid-cols-3 gap-3">{(['min','max','step'] as const).map(key=><Field key={key}><FieldLabel>{({min:'最短秒数',max:'最长秒数（可空）',step:'步长'})[key]}</FieldLabel><Input type="number" min={1} disabled={disabled} value={capability.seconds_range?.[key] ?? ''} onChange={event=>onChange({...capability,seconds_range:{...capability.seconds_range!,[key]:event.target.value === '' && key === 'max' ? null : Number(event.target.value)}})} /></Field>)}</div> : null}
    </div>
    <div className="space-y-3 rounded-lg border p-3"><p className="text-sm font-medium">提示词约束</p><label className="flex items-center gap-2 text-sm"><Checkbox disabled={disabled} checked={capability.prompt?.required ?? true} onCheckedChange={checked=>onChange({...capability,prompt:{min_length:0,max_length:0,...capability.prompt,required:Boolean(checked)}})} />必须填写提示词</label><div className="grid grid-cols-2 gap-3">{(['min_length','max_length'] as const).map(key=><Field key={key}><FieldLabel>{key === 'min_length' ? '最短字符数' : '最长字符数（0 为不限制）'}</FieldLabel><Input type="number" min={0} disabled={disabled} value={capability.prompt?.[key] || 0} onChange={event=>onChange({...capability,prompt:{required:true,min_length:0,max_length:0,...capability.prompt,[key]:Number(event.target.value)}})} /></Field>)}</div></div>
  </div>;
}

function ParameterDefault({parameter,disabled,onChange}:{parameter:VideoModelParameter;disabled:boolean;onChange:(value:string|number|boolean|null)=>void}) {
  const [text,setText] = useState(parameter.default == null ? '' : String(parameter.default));
  return <Field><FieldLabel>客户端默认值（留空不设置）</FieldLabel>{parameter.type === 'boolean' ? <Select disabled={disabled} value={text || '__unset__'} onValueChange={value=>onChange(value === '__unset__' ? null : value === 'true')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__unset__">不设置</SelectItem><SelectItem value="true">开启</SelectItem><SelectItem value="false">关闭</SelectItem></SelectContent></Select> : <Input disabled={disabled} type={parameter.type === 'string' ? 'text' : 'number'} value={text} onChange={event=>setText(event.target.value)} onBlur={()=>onChange(text === '' ? null : parameter.type === 'string' ? text : Number(text))} />}</Field>;
}
