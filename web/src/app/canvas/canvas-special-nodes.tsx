import { lazy, Suspense, useEffect, useState } from "react";
import type { ComponentProps, MouseEvent as ReactMouseEvent } from "react";
import { AudioLines, Image as ImageIcon, LoaderCircle, SlidersHorizontal, Upload } from "lucide-react";

import { AutoDLWorkflowFields } from "@/components/autodl-workflow-fields";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fetchGrokTTSVoices, type GrokTTSVoice } from "@/lib/api";
import type { CanvasNode } from "@/services/api/canvas";
import { CanvasImageParameterPopover } from "@/app/canvas/canvas-image-parameters";
import { CanvasInlineModelSelect } from "@/app/canvas/canvas-inline-model-select";
import { CanvasPromptLibrary } from "@/app/canvas/canvas-prompt-library";
import { CanvasResourceMentionTextarea } from "@/app/canvas/canvas-resource-mention-textarea";
import type { CanvasResourceReference } from "@/app/canvas/canvas-resources";
import { CanvasGenerationFooter } from "@/app/canvas/canvas-generation-footer";
import { CanvasParameterPopover } from "@/app/canvas/canvas-parameter-popover";
import { CanvasNodeInputToolbar } from "@/app/canvas/canvas-node-input-toolbar";
import { PromptTextareaFrame } from "@/components/generation/prompt-textarea-frame";
import {
  AUDIO_FORMAT_OPTIONS,
  AUDIO_VOICE_OPTIONS,
  GEMINI_TTS_VOICE_OPTIONS,
  GLM_TTS_FORMAT_OPTIONS,
  GLM_TTS_VOICE_OPTIONS,
  GROK_TTS_FORMAT_OPTIONS,
  GROK_TTS_LANGUAGE_OPTIONS,
  MIMO_TTS_FORMAT_OPTIONS,
  MIMO_TTS_VOICE_OPTIONS,
  canvasAudioProvider,
  type CanvasAudioReference,
} from "@/app/canvas/canvas-audio";
// Load the panorama viewer lazily so @photo-sphere-viewer/core ships in its own chunk.
const LazyCanvasPanoramaViewer = lazy(() => import("@/app/canvas/canvas-panorama-viewer").then((module) => ({ default: module.CanvasPanoramaViewer })));

export function CanvasPanoramaViewer(props: ComponentProps<typeof LazyCanvasPanoramaViewer>) {
  return (
    <Suspense fallback={<LoadingState label="正在加载全景图" className="min-h-0" />}>
      <LazyCanvasPanoramaViewer {...props} />
    </Suspense>
  );
}

export function CanvasSpecialNodeContent({ node, onPanoramaOpen, onPanoramaMoveStart }: { node: CanvasNode; onPanoramaOpen?: () => void; onPanoramaMoveStart?: (event: ReactMouseEvent<HTMLButtonElement>) => void }) {
  if (node.type === "audio") {
    return <div className="flex size-full flex-col items-center justify-center gap-3 bg-card px-4 text-center"><span className="grid size-12 shrink-0 place-items-center rounded-xl bg-violet-500/12 text-violet-600 dark:text-violet-300"><AudioLines className="size-6" /></span>{node.url ? <audio aria-label={node.title || "画布音频"} data-canvas-no-pan data-canvas-no-zoom src={node.url} controls preload="metadata" className="w-full min-w-0" onMouseDown={(event) => event.stopPropagation()} /> : <><p className="text-xs text-muted-foreground">空音频节点</p><p className="text-[11px] text-muted-foreground/70">可上传音频，或添加文字合成语音</p></>}</div>;
  }
  if (node.type === "panorama") {
    return node.url ? <CanvasPanoramaViewer src={node.url} alt={node.title || "全景图"} proxyGeneratedPanorama={Boolean(node.task_id && !node.storage_key)} onMoveStart={onPanoramaMoveStart} onOpen={onPanoramaOpen} /> : <div className="flex size-full flex-col items-center justify-center gap-3 bg-muted/35 px-4 text-center text-muted-foreground"><span className="grid size-12 place-items-center rounded-xl bg-cyan-500/12 text-cyan-600 dark:text-cyan-300"><ImageIcon className="size-5" /></span><span className="text-xs">空全景图节点</span><span className="text-[11px] text-muted-foreground/70">描述场景，生成可沉浸浏览的 360° 全景图</span></div>;
  }
  return null;
}

export function CanvasAudioPromptPanel({ node, mentionReferences, onReferenceSelect, models, audioReferences, relayTokenName, running, busy, uploading, canGenerate, onChange, onPromptChange, onUpload, onGenerate, onStop }: { node: CanvasNode; mentionReferences: readonly CanvasResourceReference[]; onReferenceSelect: (reference: CanvasResourceReference) => void; models: string[]; audioReferences: CanvasAudioReference[]; relayTokenName: string; running: boolean; busy: boolean; uploading: boolean; canGenerate: boolean; onChange: (patch: Partial<CanvasNode>) => void; onPromptChange: (value: string, commit?: boolean) => void; onUpload: () => void; onGenerate: () => void; onStop: () => void }) {
  const [prompt, setPrompt] = useState(node.prompt || "");
  const model = node.generation_audio_model || models[0] || "";
  useEffect(() => setPrompt(node.prompt || ""), [node.id, node.prompt]);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <PromptTextareaFrame className="min-h-0 flex-1">
        <CanvasResourceMentionTextarea references={mentionReferences} onReferenceSelect={onReferenceSelect} value={prompt} onChange={(value) => { setPrompt(value); onPromptChange(value); }} onBlur={() => onPromptChange(prompt, true)} placeholder="输入需要合成的旁白、对白或音频内容" containerClassName="min-h-full" className="min-h-full resize-none overflow-hidden border-0 bg-transparent px-1 py-1 text-sm leading-6 shadow-none focus-visible:ring-0" />
      </PromptTextareaFrame>
      <CanvasNodeInputToolbar action={<CanvasGenerationFooter running={running} disabled={!running && (busy || !canGenerate)} onGenerate={onGenerate} onStop={onStop} />}>
        <CanvasInlineModelSelect value={model} models={models} label="音频模型" onChange={(value) => onChange({ generation_audio_model: value })} />
        <CanvasParameterPopover icon={<SlidersHorizontal />} label="音频参数"><div className="space-y-3"><CanvasAudioSettingsFields node={node} models={models} audioReferences={audioReferences} relayTokenName={relayTokenName} onChange={onChange} showModel={false} /></div></CanvasParameterPopover>
        <CanvasPromptLibrary onSelect={(value) => { setPrompt(value); onPromptChange(value, true); }} />
        <button type="button" aria-label={node.url ? "替换音频" : "上传音频"} title={node.url ? "替换音频" : "上传音频"} disabled={uploading || running} onClick={onUpload} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted disabled:opacity-50">{uploading ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}</button>
      </CanvasNodeInputToolbar>
    </div>
  );
}

export function CanvasAudioSettingsFields({ node, models, audioReferences, relayTokenName, onChange, showModel = true }: { node: CanvasNode; models: string[]; audioReferences: CanvasAudioReference[]; relayTokenName: string; onChange: (patch: Partial<CanvasNode>) => void; showModel?: boolean }) {
  const model = node.generation_audio_model || models[0] || "";
  const provider = canvasAudioProvider(model);
  const cloneNodeID = node.generation_audio_mimo_voice_clone_node_id || (audioReferences.length === 1 ? audioReferences[0].nodeID : "");
  return (
    <>
      {showModel ? <label className="grid gap-1 text-xs"><span className="text-muted-foreground">模型</span><Select value={models.includes(model) ? model : ""} disabled={models.length === 0} onValueChange={(value) => onChange({ generation_audio_model: value })}><SelectTrigger><SelectValue placeholder={models.length ? "选择模型" : "暂无可用模型"} /></SelectTrigger><SelectContent>{models.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></label> : null}
      <AutoDLWorkflowFields tokenName={relayTokenName} model={model} value={node.generation_workflow_inputs || {}} onChange={(generation_workflow_inputs) => onChange({ generation_workflow_inputs })}>
      {provider === "gemini" ? <AudioSelect label="声音" value={node.generation_audio_gemini_voice || "Kore"} options={GEMINI_TTS_VOICE_OPTIONS} onChange={(value) => onChange({ generation_audio_gemini_voice: value })} /> : null}
      {provider === "glm" ? <><AudioSelect label="声音" value={node.generation_audio_glm_voice || "tongtong"} options={GLM_TTS_VOICE_OPTIONS} onChange={(value) => onChange({ generation_audio_glm_voice: value })} /><div className="grid grid-cols-2 gap-2"><AudioSelect label="格式" value={node.generation_audio_glm_format || "wav"} options={GLM_TTS_FORMAT_OPTIONS} onChange={(value) => onChange({ generation_audio_glm_format: value as "wav" | "pcm" })} /><AudioSpeedInput label="语速" value={node.generation_audio_glm_speed || 1} min={0.5} max={2} onChange={(value) => onChange({ generation_audio_glm_speed: value })} /></div></> : null}
      {provider === "grok" ? <><GrokTTSVoiceSelect model={model} relayTokenName={relayTokenName} value={node.generation_audio_grok_voice || "eve"} onChange={(value) => onChange({ generation_audio_grok_voice: value })} /><AudioSelect label="语言" value={node.generation_audio_grok_language || "auto"} options={GROK_TTS_LANGUAGE_OPTIONS} onChange={(value) => onChange({ generation_audio_grok_language: value })} /><div className="grid grid-cols-2 gap-2"><AudioSelect label="格式" value={node.generation_audio_grok_format || "mp3"} options={GROK_TTS_FORMAT_OPTIONS} onChange={(value) => onChange({ generation_audio_grok_format: value as "mp3" | "wav" })} /><AudioSpeedInput label="语速" value={node.generation_audio_grok_speed || 1} min={0.7} max={1.5} onChange={(value) => onChange({ generation_audio_grok_speed: value })} /></div></> : null}
      {provider.startsWith("mimo-") ? <>{provider === "mimo-preset" ? <AudioSelect label="声音" value={node.generation_audio_mimo_voice || "冰糖"} options={MIMO_TTS_VOICE_OPTIONS} onChange={(value) => onChange({ generation_audio_mimo_voice: value })} /> : null}{provider === "mimo-design" ? <label className="grid gap-1 text-xs"><span className="text-muted-foreground">音色描述</span><Textarea value={node.generation_audio_mimo_voice_design_prompt || ""} onChange={(event) => onChange({ generation_audio_mimo_voice_design_prompt: event.target.value })} rows={3} placeholder="例如：年轻女性，声音清亮自然，有亲和力。" /></label> : null}{provider === "mimo-clone" ? <AudioSelect label="参考音频" value={cloneNodeID} options={audioReferences.map((reference) => ({ value: reference.nodeID, label: reference.title }))} placeholder={audioReferences.length ? "选择已连接音频" : "暂无已连接音频节点"} onChange={(value) => onChange({ generation_audio_mimo_voice_clone_node_id: value })} /> : null}<AudioSelect label="格式" value={node.generation_audio_mimo_format || "wav"} options={MIMO_TTS_FORMAT_OPTIONS} onChange={(value) => onChange({ generation_audio_mimo_format: value as "wav" | "mp3" })} />{provider === "mimo-preset" || provider === "mimo-clone" ? <label className="grid gap-1 text-xs"><span className="text-muted-foreground">声音指令</span><Textarea value={node.generation_audio_instructions || ""} onChange={(event) => onChange({ generation_audio_instructions: event.target.value })} rows={3} placeholder="例如：语速轻快，语气兴奋，结尾略微上扬。" /></label> : null}</> : null}
      {provider === "openai" ? <><div className="grid grid-cols-2 gap-2"><AudioSelect label="声音" value={node.generation_audio_voice || "alloy"} options={AUDIO_VOICE_OPTIONS} onChange={(value) => onChange({ generation_audio_voice: value })} /><AudioSelect label="格式" value={node.generation_audio_format || "mp3"} options={AUDIO_FORMAT_OPTIONS} onChange={(value) => onChange({ generation_audio_format: value as NonNullable<CanvasNode["generation_audio_format"]> })} /></div><AudioSpeedInput label="语速" value={node.generation_audio_speed || 1} min={0.25} max={4} onChange={(value) => onChange({ generation_audio_speed: value })} /><label className="grid gap-1 text-xs"><span className="text-muted-foreground">声音指令</span><Textarea value={node.generation_audio_instructions || ""} onChange={(event) => onChange({ generation_audio_instructions: event.target.value })} rows={3} placeholder="例如：自然、温暖、适合旁白。" /></label></> : null}
      </AutoDLWorkflowFields>
    </>
  );
}

function GrokTTSVoiceSelect({ model, relayTokenName, value, onChange }: { model: string; relayTokenName: string; value: string; onChange: (value: string) => void }) {
  const [voices, setVoices] = useState<GrokTTSVoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void fetchGrokTTSVoices(model, relayTokenName)
      .then((items) => { if (active) setVoices(items); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "音色读取失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [model, relayTokenName, reload]);
  const options = voices.map((voice) => ({ value: voice.voice_id, label: voice.name || voice.voice_id }));
  if (value && !options.some((option) => option.value === value)) options.unshift({ value, label: value });
  return <label className="grid gap-1 text-xs"><span className="text-muted-foreground">声音</span><Select value={value || "eve"} onValueChange={onChange} onOpenChange={(open) => { if (open && error) setReload((current) => current + 1); }}><SelectTrigger><SelectValue placeholder={loading ? "正在读取音色…" : "选择声音"} /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}{!options.length ? <SelectItem value="eve">{loading ? "正在读取音色…" : error || "暂无可用音色"}</SelectItem> : null}</SelectContent></Select>{error ? <span className="text-[11px] text-destructive">{error}</span> : null}</label>;
}

function AudioSelect({ label, value, options, placeholder, onChange }: { label: string; value: string; options: readonly (string | { value: string; label: string })[]; placeholder?: string; onChange: (value: string) => void }) {
  const normalizedOptions = options.map((option) => typeof option === "string" ? { value: option, label: option } : option);
  return <label className="grid min-w-0 gap-1 text-xs"><span className="text-muted-foreground">{label}</span><Select value={value || undefined} onValueChange={onChange}><SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent>{normalizedOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></label>;
}

function AudioSpeedInput({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value || 1));
  useEffect(() => setDraft(String(value || 1)), [value]);
  return <label className="grid gap-1 text-xs"><span className="text-muted-foreground">{label}</span><Input type="number" min={min} max={max} step={0.05} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { const number = Number(draft); const normalized = Number.isFinite(number) ? Math.max(min, Math.min(max, Number(number.toFixed(2)))) : 1; setDraft(String(normalized)); onChange(normalized); }} /></label>;
}

export function CanvasPanoramaPromptPanel({ node, mentionReferences, onReferenceSelect, imageModel, imageModels, running, busy, uploading, canGenerate, onChange, onPromptChange, onUpload, onGenerate, onStop }: { node: CanvasNode; mentionReferences: readonly CanvasResourceReference[]; onReferenceSelect: (reference: CanvasResourceReference) => void; imageModel: string; imageModels: string[]; running: boolean; busy: boolean; uploading: boolean; canGenerate: boolean; onChange: (patch: Partial<CanvasNode>) => void; onPromptChange: (value: string, commit?: boolean) => void; onUpload: () => void; onGenerate: () => void; onStop: () => void }) {
  const prompt = node.panorama_source_prompt ?? node.prompt ?? "";
  const selectedModel = node.generation_model?.trim() || imageModel;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <PromptTextareaFrame className="min-h-0 flex-1">
        <CanvasResourceMentionTextarea references={mentionReferences} onReferenceSelect={onReferenceSelect} value={prompt} onChange={onPromptChange} onBlur={(event) => onPromptChange(event.target.value, true)} placeholder="描述一个完整的 360 度环境，包括前后左右、地面与天空" containerClassName="min-h-full" className="min-h-full resize-none overflow-hidden border-0 bg-transparent px-1 py-1 text-sm leading-6 shadow-none focus-visible:ring-0" />
      </PromptTextareaFrame>
      <CanvasNodeInputToolbar action={<CanvasGenerationFooter running={running} disabled={!running && (busy || !canGenerate || !imageModels.includes(selectedModel))} onGenerate={onGenerate} onStop={onStop} />}>
        <CanvasInlineModelSelect value={selectedModel} models={imageModels} label="全景图模型" onChange={(value) => onChange({ generation_model: value, generation_size: "2:1" })} />
        <CanvasImageParameterPopover node={{ ...node, generation_size: "2:1" }} imageModel={imageModel} imageModels={imageModels} onChange={(patch) => onChange({ ...patch, generation_size: "2:1" })} showModel={false} showSize={false} />
        <CanvasPromptLibrary onSelect={(value) => onPromptChange(value, true)} />
        <button type="button" aria-label="替换图片" title="替换图片" disabled={uploading || running} onClick={onUpload} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted disabled:opacity-50">{uploading ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}</button>
      </CanvasNodeInputToolbar>
    </div>
  );
}

export function SpecialNodeLoading() {
  return <div className="absolute inset-0 grid place-items-center bg-black/35 text-white"><LoaderCircle className="size-7 animate-spin" /></div>;
}
