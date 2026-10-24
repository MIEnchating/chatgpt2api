import { useState } from "react";
import { ChevronDown, ArrowRight } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { VideoModelContract } from "@/lib/video-model-contracts";

type RequestKey = Exclude<keyof VideoModelContract["request"], "duration_value_type" | "reference_value_type">;

export function ContractRequestEditor({ contract, generation, disabled, onChange, onGenerationChange }: {
  contract: VideoModelContract;
  generation: VideoModelContract["generation"];
  disabled: boolean;
  onChange: (update: (contract: VideoModelContract) => void) => void;
  onGenerationChange: (generation: VideoModelContract["generation"]) => void;
}) {
  const { transport, request } = contract;
  const [overrideDriver, setOverrideDriver] = useState<string | null>(null);
  const customProtocol = contract.driver === "custom-video";
  const customPaths = customProtocol || Boolean(transport.create_path || transport.query_path) || overrideDriver === contract.driver;
  const profiles = [contract, ...(contract.model_profiles || [])];
  const supports = (field: "first_frame" | "last_frame" | "image" | "video" | "audio") => profiles.some((profile) => profile.generation.modes.some((mode) => mode.materials[field].max > 0));
  const mappings: { key: RequestKey; label: string; example: string; placeholder: string; supported: boolean }[] = [
    { key: "duration_field", label: "视频时长", example: request.duration_value_type === "number" ? "5" : '"5"', placeholder: "duration", supported: true },
    { key: "aspect_ratio_field", label: "画幅比例", example: '"16:9"', placeholder: "aspect_ratio", supported: true },
    { key: "resolution_field", label: "清晰度", example: '"720p"', placeholder: "resolution", supported: true },
    { key: "generate_audio_field", label: "生成音频", example: "true", placeholder: "generate_audio", supported: profiles.some((profile) => profile.capability.audio_control !== "none") },
    { key: "watermark_field", label: "水印开关", example: "false", placeholder: "watermark", supported: profiles.some((profile) => profile.capability.watermark) },
    { key: "first_frame_field", label: "首帧图片", example: '"https://example.com/first.png"', placeholder: "first_frame_url", supported: supports("first_frame") },
    { key: "last_frame_field", label: "尾帧图片", example: '"https://example.com/last.png"', placeholder: "last_frame_url", supported: supports("last_frame") },
    { key: "reference_images_field", label: "参考图片", example: '["https://example.com/ref.png"]', placeholder: "reference_images", supported: supports("image") },
    { key: "reference_videos_field", label: "参考视频", example: '["https://example.com/ref.mp4"]', placeholder: "reference_videos", supported: supports("video") },
    { key: "reference_audios_field", label: "参考音频", example: '["https://example.com/ref.mp3"]', placeholder: "reference_audios", supported: supports("audio") },
  ];
  const renderMapping = (item: typeof mappings[number]) => <div key={item.key} className="grid items-start gap-2 border-t border-border/60 py-3 first:border-t-0 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
    <FieldLabel htmlFor={`video-contract-${item.key}`} className="sm:pt-2.5">{item.label}</FieldLabel>
    <div className="min-w-0 space-y-1.5"><Input id={`video-contract-${item.key}`} className="font-mono text-xs" value={request[item.key]} disabled={disabled} placeholder={`例如 ${item.placeholder}`} onChange={(event) => onChange((next) => { next.request[item.key] = event.target.value; })} /><div className="flex items-start gap-1.5 text-[11px] leading-5 text-muted-foreground"><ArrowRight className="mt-1 size-3 shrink-0" /><code className="break-all">{request[item.key] ? `${request[item.key]} = ${item.example}` : "未设置自定义字段"}</code></div></div>
  </div>;
  return <div className="space-y-5">
    <div className="space-y-3 rounded-lg bg-muted/30 p-4 text-xs leading-5">
      <p className="font-medium">什么时候需要配置？</p>
      <p className="text-muted-foreground">例如用户选择 5 秒，但接口要求 <code className="text-foreground">duration</code>，就把“视频时长”对应字段填为 duration。接口要求嵌套参数时，可填 <code className="text-foreground">metadata.duration</code>。</p>
      <p className="text-muted-foreground">首帧传给 <code className="text-foreground">image_url</code>、参考视频传给 <code className="text-foreground">reference_videos</code>，也是同样的配置方式。具体字段和素材结构以当前接口协议为准，可在右侧“请求与响应模拟”中验证。</p>
    </div>
    <div className="space-y-4 rounded-lg border border-border/70 p-4">
      <h4 className="text-sm font-semibold">1. 接口路径</h4>
      <p className="text-xs leading-5 text-muted-foreground">{customProtocol ? "自定义协议没有默认接口，请按上游文档填写提交和查询路径。" : "内置协议会自动选择提交和查询接口，通常无需配置。只有上游网关使用不同路径时，才需要自定义。"} 上游服务地址在渠道中配置。</p>
      {!customProtocol ? <label className="flex items-center gap-2 text-sm"><Checkbox checked={customPaths} disabled={disabled} onCheckedChange={(checked) => {
        setOverrideDriver(checked ? contract.driver : null);
        if (!checked) onChange((next) => { next.transport.create_path = ""; next.transport.query_path = ""; });
      }} />自定义接口路径</label> : null}
      {customPaths ? <div className="grid gap-4 sm:grid-cols-2">
        <Field><FieldLabel htmlFor="video-contract-create-path">提交接口路径（必填）</FieldLabel><Input id="video-contract-create-path" value={transport.create_path} disabled={disabled} required placeholder="例如 /v1/videos" onChange={(event) => onChange((next) => { next.transport.create_path = event.target.value; })} /><FieldDescription>以 / 开头，相对于渠道的上游服务地址。</FieldDescription></Field>
        <Field><FieldLabel htmlFor="video-contract-query-path">查询接口路径（必填）</FieldLabel><Input id="video-contract-query-path" value={transport.query_path} disabled={disabled} required placeholder="例如 /v1/videos/{task_id}" onChange={(event) => onChange((next) => { next.transport.query_path = event.target.value; })} /><FieldDescription>{"必须包含 {task_id}，系统会替换为任务编号。提交和查询路径需同时填写。"}</FieldDescription></Field>
      </div> : <p className="rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">正在使用内置协议接口</p>}
      {!customProtocol && customPaths ? <p className="text-xs leading-5 text-muted-foreground">填写后将覆盖内置接口路径，请确认上游仍接受当前协议的请求格式。关闭此选项会清空自定义路径，恢复协议默认接口。</p> : null}
    </div>
    <div className="rounded-lg border border-border/70 p-4">
      <h4 className="text-sm font-semibold">2. 参数对应哪个上游字段</h4>
      <p className="mt-1 mb-3 text-xs leading-5 text-muted-foreground">左侧是创作参数，右侧填写接口接收它的字段名。下方展示字段和值的对应关系；这些设置由本契约所有模型共用。</p>
      {mappings.filter((item) => item.supported).map(renderMapping)}
      <div className="border-t border-border/60 pt-4">
        <Field><FieldLabel htmlFor="video-contract-duration-value-type">时长的发送格式</FieldLabel><Select value={request.duration_value_type} disabled={disabled} onValueChange={(value) => onChange((next) => { next.request.duration_value_type = value as "number" | "string"; })}><SelectTrigger id="video-contract-duration-value-type" className="h-10"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="number">数字：5</SelectItem><SelectItem value="string">文本："5"</SelectItem></SelectContent></Select><FieldDescription>只影响接口数据格式，不改变视频时长。接口若严格检查类型，填错会导致请求失败；按接口文档选择 number 或 string。</FieldDescription></Field>
      </div>
      {mappings.some((item) => !item.supported) ? <details className="group mt-4 border-t border-border/60 pt-3"><summary className="flex cursor-pointer list-none items-center justify-between text-xs text-muted-foreground">未启用能力的字段（保留原配置）<ChevronDown className="size-3.5 group-open:rotate-180" /></summary><div className="mt-2">{mappings.filter((item) => !item.supported).map(renderMapping)}</div></details> : null}
    </div>
    <Field><FieldLabel>参考素材值格式</FieldLabel><Select value={request.reference_value_type || "array"} disabled={disabled} onValueChange={(value) => onChange(next => { next.request.reference_value_type = value as "array" | "scalar"; })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="array">URL 数组</SelectItem><SelectItem value="scalar">单个 URL 字符串（合计最多一份）</SelectItem></SelectContent></Select></Field>
    <details className="group rounded-lg border border-border/70" open={Boolean(request.generation_mode_field) || undefined}>
      <summary className="flex cursor-pointer list-none items-center justify-between p-4 text-sm font-semibold">接口是否要求生成方式参数<ChevronDown className="size-4 group-open:rotate-180" /></summary>
      <div className="space-y-4 border-t border-border/60 p-4">
        <p className="text-xs leading-5 text-muted-foreground">只有接口要求传入 mode 等参数时才填写。例如纯文本生成发送 text-to-video，上传首帧时发送 image-to-video。这里只设置接口值，不需要额外定义显示名称。</p>
        <Field><FieldLabel htmlFor="video-contract-generation_mode_field">区分生成方式的字段（选填）</FieldLabel><Input id="video-contract-generation_mode_field" value={request.generation_mode_field} disabled={disabled} placeholder="例如 mode；接口不需要时留空" onChange={(event) => onChange((next) => { next.request.generation_mode_field = event.target.value; })} /></Field>
        {request.generation_mode_field ? <div className="grid gap-3 sm:grid-cols-2">{generation.modes.map((mode, index) => <Field key={mode.id}><FieldLabel htmlFor={`generation-value-${index}`}>{mode.kind === "text" ? "文生视频时发送" : mode.kind === "image" ? "使用首尾帧时发送" : "使用参考素材时发送"}</FieldLabel><Input id={`generation-value-${index}`} value={mode.request_value} disabled={disabled} onChange={(event) => onGenerationChange({ ...generation, modes: generation.modes.map((item, i) => i === index ? { ...item, request_value: event.target.value } : item) })} /><FieldDescription>当前模型能力配置的接口值</FieldDescription></Field>)}</div> : null}
      </div>
    </details>
    <div className="space-y-4 rounded-lg border border-border/70 p-4">
      <h4 className="text-sm font-semibold">3. 上传素材如何发送</h4>
      <Field><FieldLabel htmlFor="video-contract-local-material">平台暂存的图片、视频与音频</FieldLabel><Select value={transport.local_material} disabled={disabled} onValueChange={(value) => onChange((next) => { next.transport.local_material = value as "url" | "multipart"; if (value === "url") delete next.transport.multipart_fields; if (value === "multipart" && !next.transport.multipart_file_field) next.transport.multipart_file_field = "input_reference[]"; })}><SelectTrigger id="video-contract-local-material" className="h-10"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="url">发送可访问的素材网址</SelectItem><SelectItem value="multipart">上传文件（multipart）</SelectItem></SelectContent></Select><FieldDescription>大多数接口接收素材网址。仅当上游要求上传文件时，选择 multipart。</FieldDescription></Field>
      {transport.local_material === "multipart" ? <>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={Boolean(transport.multipart_fields && Object.keys(transport.multipart_fields).length)} disabled={disabled} onCheckedChange={checked => onChange(next => {
          if (checked) { next.transport.multipart_fields = { first_frame: "image_url", last_frame: "end_image_url", reference_image: "reference_images", reference_video: "reference_videos", reference_audio: "reference_audios" }; next.transport.multipart_file_field = ""; }
          else { delete next.transport.multipart_fields; next.transport.multipart_file_field = "input_reference[]"; }
        })} />按素材类型配置不同文件字段</label>
        {transport.multipart_fields && Object.keys(transport.multipart_fields).length > 0 ? Object.entries(transport.multipart_fields).map(([role, field]) => <Field key={role}><FieldLabel>{({first_frame:"首帧",last_frame:"尾帧",reference_image:"参考图片",reference_video:"参考视频",reference_audio:"参考音频"} as Record<string,string>)[role]}</FieldLabel><Input value={field} disabled={disabled} onChange={event => onChange(next => { next.transport.multipart_fields = {...next.transport.multipart_fields, [role]:event.target.value}; })} /></Field>) : <Field><FieldLabel htmlFor="video-contract-multipart-field">接收文件的表单字段</FieldLabel><Input id="video-contract-multipart-field" value={transport.multipart_file_field} disabled={disabled} placeholder="例如 input_reference[]" onChange={(event) => onChange((next) => { next.transport.multipart_file_field = event.target.value; })} /></Field>}
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={transport.multipart_repeatable} disabled={disabled} onCheckedChange={(checked) => onChange((next) => { next.transport.multipart_repeatable = Boolean(checked); })} />多个文件使用相同字段名逐个发送</label>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={transport.multipart_mixed_urls} disabled={disabled} onCheckedChange={(checked) => onChange((next) => { next.transport.multipart_mixed_urls = Boolean(checked); })} />允许本地文件与外部素材网址一起提交</label>
      </> : null}
    </div>
  </div>;
}
