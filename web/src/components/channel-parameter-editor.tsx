import { Spinner } from "@/components/ui/spinner";
import { CodeBlock, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { useMemo, useRef, useState } from "react";
import { Check, FileCode2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { validateParameterTranslation } from "@/lib/api";

const variables = ["model", "prompt", "size", "aspectRatio", "quality", "count", "images", "resolution", "seconds", "mode", "negativePrompt", "generateAudio", "watermark", "videos", "audios", "firstFrame", "lastFrame", "voice", "audioFormat", "speed", "instructions"];
export const parameterTranslationHelp = `配置为 JavaScript 对象字面量，外层为 { headers, models, poll }。models 的键必须为实际模型名称，每项包含一种 HTTP 请求方法（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS），以及 result、error 和可选 poll。空配置或空模型对象使用原有接口；命中规则后失败不会改走其他协议。\n请求对象支持 url、headers、params、body、format 和 responseType。format：json、formData、urlencoded、raw；responseType：json、text、blob、arraybuffer。表单素材 URL 不会自动转换为文件。相对 url 追加到 Base URL 路径，不自动补 /v1。默认 Bearer 鉴权；自定义鉴权可使用 {channelKey} 占位符。\nresult/error 可使用点分字段路径（数组例如 data.0.url）或同步函数。poll 包含查询请求、taskId、status、success、failure、progress；查询地址支持 {taskId}。success/failure 为状态值数组。任务提交后修改规则不影响正在执行的请求；临时查询错误不会重复提交。\n可用变量：${variables.join(", ")}。images/videos/audios 为 URL 或 Data URL 数组。视频面板能力仍由视频模型契约配置。规则在服务端执行，不提供网络、文件、进程或模块 API。`;

function example(kind: "image" | "video" | "audio", model: string) {
  const body = kind === "audio" ? "{ model, input: prompt, voice, response_format: audioFormat, speed }" : kind === "video" ? "{ model, prompt, seconds, size, images, first_frame: firstFrame, last_frame: lastFrame }" : "{ model, prompt, n: count, size, images }";
  return `{\n  models: {\n    ${JSON.stringify(model)}: {\n      POST: { url: "/${kind === "audio" ? "audio/speech" : kind === "video" ? "videos" : "images/generations"}", body: ${body}${kind === "audio" ? ', responseType: "blob"' : ""} },${kind === "image" ? '\n      result: "data",' : ""}${kind === "video" ? '\n      poll: {\n        GET: { url: "/videos/{taskId}" },\n        taskId: "id", status: "status",\n        success: ["completed"], failure: ["failed", "cancelled"], progress: "progress"\n      }' : ""}\n    }\n  }\n}`;
}

export function ChannelParameterEditor({ value, onChange, baseURL, models = [], kind = "image", disabled = false }: {
  value: string; onChange: (value: string) => void; baseURL: string; models?: string[]; kind?: "image" | "video" | "audio"; disabled?: boolean;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState(false);
  const highlighted = useMemo(() => preview ? value.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:true|false|null|undefined|return|const|let)\b|\b\d+(?:\.\d+)?\b)/g).map((token, index) => <span key={index} className={/^["']/.test(token) ? "text-emerald-600 dark:text-emerald-400" : /^(?:true|false|null|undefined|return|const|let)$/.test(token) ? "text-violet-600 dark:text-violet-400" : /^\d/.test(token) ? "text-blue-600 dark:text-blue-400" : undefined}>{token}</span>) : null, [preview, value]);
  async function validate() {
    setChecking(true);
    try { const result = await validateParameterTranslation(value); toast.success(result.models.length ? `配置有效，匹配 ${result.models.length} 个模型` : "空规则，将使用原有接口"); }
    catch (error) { toast.error(error instanceof Error ? error.message : "校验失败"); }
    finally { setChecking(false); }
  }
  function insert(variable: string) {
    const input = editor.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    onChange(value.slice(0, start) + variable + value.slice(end));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + variable.length, start + variable.length); });
  }
  return <Card className="grid min-w-0 gap-3 p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">自定义参数转换</span>
      <div className="flex flex-wrap gap-1">
        <Button type="button" size="sm" variant="ghost" disabled={disabled || Boolean(value.trim())} onClick={() => onChange(example(kind, models[0] || "填写实际模型名称"))}><FileCode2 />插入示例</Button>
        <CodeBlockCopyButton size="sm" value={`Base URL：${baseURL}\n模型列表：${models.join(", ") || "请填写实际模型名称"}\n\n${parameterTranslationHelp}\n\n结构示例：\n${example(kind, models[0] || "model-name")}`}>复制说明</CodeBlockCopyButton>
      </div>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">按实际模型名称转换图片、视频或音频请求。留空使用原有接口，保存时校验语法。</p>
    <Textarea ref={editor} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="min-h-52 font-mono" spellCheck={false} maxLength={128 * 1024} aria-label="渠道参数转换规则" placeholder={'{ models: {} }'} />
    <Collapsible  open={preview} onOpenChange={setPreview}><CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-start whitespace-normal cursor-pointer h-auto min-h-8">高亮预览</Button></CollapsibleTrigger><CollapsibleContent forceMount className="data-[state=closed]:hidden">{preview ? <ScrollAreaRoot data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden mt-2 max-h-64 max-w-full font-mono" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-x-contain"><CodeBlock><CodeBlockContent wrap>{highlighted}</CodeBlockContent></CodeBlock></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot> : null}</CollapsibleContent></Collapsible>
    <Collapsible ><CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-start whitespace-normal cursor-pointer h-auto min-h-8">插入变量与配置说明</Button></CollapsibleTrigger><CollapsibleContent forceMount className="data-[state=closed]:hidden"><div className="mt-2 flex flex-wrap gap-1">{variables.map((variable) => <Button key={variable} type="button" size="sm" variant="outline" className="min-h-8 max-w-full whitespace-normal break-all font-mono h-auto min-h-7" disabled={disabled} onClick={() => insert(variable)}>{variable}</Button>)}</div><p className="mt-3 whitespace-pre-wrap break-words leading-6">{parameterTranslationHelp}</p></CollapsibleContent></Collapsible>
    <Button type="button" size="sm" variant="outline" className="justify-self-start" disabled={disabled || checking} onClick={() => void validate()}>{checking ? <Spinner /> : <Check />}校验配置</Button>
  </Card>;
}
