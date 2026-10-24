import { FileText, ImagePlus, Info, Link2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { getVideoModeMaterials, VIDEO_MATERIALS, setVideoMaterialSupport, updateVideoMaterialRange } from "@/lib/video-contract-editor";
import type { VideoModelContract, VideoModelGenerationMode } from "@/lib/video-model-contracts";
import { cn } from "@/lib/utils";

export function ContractMaterialsEditor({ generation, disabled, onChange }: {
  generation: VideoModelContract["generation"];
  disabled: boolean;
  onChange: (generation: VideoModelContract["generation"]) => void;
}) {
  const updateMode = (mode: VideoModelGenerationMode) => onChange({
    ...generation, modes: generation.modes.map((item) => item.kind === mode.kind ? mode : item),
  });
  const choices = [
    { key: "text" as const, label: "文生视频", description: "只输入提示词即可生成" },
    { key: "first_frame" as const, label: "首尾帧生成", description: "首帧必填；尾帧默认允许上传" },
    { key: "image" as const, label: "参考图片", description: "提供人物、物体或画面风格参考" },
    { key: "video" as const, label: "参考视频", description: "提供动作、镜头或已有视频参考" },
    { key: "audio" as const, label: "参考音频", description: "提供声音、节奏或对白参考" },
  ];
  return (
    <div className="space-y-4" data-video-contract-generation>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {choices.map((item) => {
          const checked = item.key === "text" ? generation.modes.some((mode) => mode.kind === "text") : generation.modes.some((mode) => mode.materials[item.key as keyof typeof mode.materials].max > 0);
          return (
            <label key={item.key} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors", checked ? "border-primary/35 bg-primary/5" : "border-border/70 bg-background hover:bg-muted/40", disabled && "cursor-default opacity-70")}>
              <Checkbox className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(setVideoMaterialSupport(generation, item.key, Boolean(value)))} />
              <span className="min-w-0"><span className="block text-sm font-medium">{item.label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{item.description}</span></span>
            </label>
          );
        })}
      </div>
      {generation.modes.length === 0 ? <p role="alert" className="text-xs text-destructive">请至少选择一种模型实际支持的能力。</p> : null}
      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />首尾帧用于指定视频的开始和结束画面。启用尾帧后，首帧会自动设为必填；尾帧默认可选。</p>
      {generation.modes.filter((mode) => mode.kind !== "text").map((mode) => {
        const active = VIDEO_MATERIALS.filter((item) => mode.materials[item.key].max > 0);
        const visible = getVideoModeMaterials(mode);
        const minTotal = active.reduce((sum, item) => sum + mode.materials[item.key].min, 0);
        const maxTotal = Math.min(80, active.reduce((sum, item) => sum + mode.materials[item.key].max, 0));
        const totalFloor = Math.max(minTotal, ...active.map((item) => mode.materials[item.key].max));
        return (
          <section key={mode.kind} data-video-contract-mode className="overflow-hidden rounded-lg border border-border/70 bg-background">
            <div className="flex items-start gap-3 border-b border-border/60 bg-muted/25 px-4 py-3">
              {mode.kind === "image" ? <ImagePlus className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0"><h3 className="text-sm font-medium">{mode.kind === "image" ? "首尾帧生成设置" : "参考素材设置"}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{mode.kind === "image" ? "首帧始终作为必填起点；尾帧默认允许上传，也可以设置为必填。" : "选择模型接受的素材类型，再设置每类素材的数量范围。"}</p></div>
            </div>
            <div className="divide-y divide-border/60 px-4">
              {visible.map((item) => mode.kind === "image" ? (
                <div key={item.key} className="grid items-center gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div><p className="text-sm font-medium">{item.label}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{item.key === "first_frame" ? "指定视频开场画面；尾帧启用后首帧会自动必填。" : "指定视频结束画面；上传尾帧时需要同时提供首帧。"}</p></div>
                  {item.key === "first_frame" ? <label className="flex items-center gap-2 text-sm"><Checkbox checked={mode.materials.first_frame.min === 1} disabled={disabled || mode.materials.last_frame.max > 0} onCheckedChange={(value) => updateMode(updateVideoMaterialRange(mode, "first_frame", "min", value ? 1 : 0))} />{mode.materials.last_frame.max > 0 ? "尾帧生成需要首帧" : "每次生成都要求首帧"}</label> : <div className="flex flex-wrap items-center gap-x-5 gap-y-2"><label className="flex items-center gap-2 text-sm"><Checkbox checked={mode.materials.last_frame.max > 0} disabled={disabled} onCheckedChange={(value) => onChange(setVideoMaterialSupport(generation, "last_frame", Boolean(value)))} />允许上传尾帧</label>{mode.materials.last_frame.max > 0 ? <label className="flex items-center gap-2 text-sm text-muted-foreground"><Checkbox checked={mode.materials.last_frame.min === 1} disabled={disabled} onCheckedChange={(value) => updateMode(updateVideoMaterialRange(mode, "last_frame", "min", value ? 1 : 0))} />每次生成都要求尾帧</label> : null}</div>}
                </div>
              ) : (
                <div key={item.key} className="grid items-center gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div><p className="text-sm font-medium">{item.label}</p><p className="mt-1 text-xs text-muted-foreground">{item.max === 1 ? "最多 1 张" : item.description}</p></div>
                  <div className="grid grid-cols-2 gap-2">
                    {(["min", "max"] as const).map((bound) => <Field key={bound} className="gap-1.5"><FieldLabel htmlFor={`material-${item.key}-${bound}`} className="text-xs text-muted-foreground">{bound === "min" ? "至少" : "最多"}</FieldLabel><NumberInput id={`material-${item.key}-${bound}`} aria-label={`${item.label}${bound === "min" ? "至少" : "最多"}数量`} min={bound === "min" ? 0 : 1} max={item.max} suffix="个" value={mode.materials[item.key][bound]} disabled={disabled} onValueChange={(value) => updateMode(updateVideoMaterialRange(mode, item.key, bound, bound === "max" ? Math.max(1, Number(value)) : Number(value)))} /></Field>)}
                  </div>
                </div>
              ))}
              {mode.kind === "reference" && active.length > 1 ? (
                <div className="grid items-center gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div><p className="text-sm font-medium">素材合计上限</p><p className="mt-1 text-xs leading-5 text-muted-foreground">多个参考素材类型一起使用时，限制总上传数量。</p></div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field className="gap-1.5"><FieldLabel htmlFor={`total-${mode.kind}-min`} className="text-xs text-muted-foreground">最少</FieldLabel><NumberInput id={`total-${mode.kind}-min`} min={minTotal} max={mode.materials.total.max} value={mode.materials.total.min} disabled={disabled} onValueChange={(value) => updateMode({ ...mode, materials: { ...mode.materials, total: { ...mode.materials.total, min: Math.max(minTotal, Math.min(mode.materials.total.max, Number(value) || 0)) } } })} /></Field>
                    <Field className="gap-1.5"><FieldLabel htmlFor={`total-${mode.kind}-max`} className="text-xs text-muted-foreground">最多</FieldLabel><NumberInput id={`total-${mode.kind}-max`} min={Math.max(totalFloor, mode.materials.total.min)} max={maxTotal} value={mode.materials.total.max} disabled={disabled} onValueChange={(value) => updateMode({ ...mode, materials: { ...mode.materials, total: { ...mode.materials.total, max: Math.max(totalFloor, mode.materials.total.min, Math.min(maxTotal, Number(value) || 0)) } } })} /></Field>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        );
      })}
      <div className="flex items-start gap-2 rounded-lg bg-muted/35 p-3 text-xs leading-5 text-muted-foreground"><FileText className="mt-0.5 size-3.5 shrink-0" /><p>首帧、尾帧已支持。带时间点的多张关键帧尚未接入：它需要独立的时间轴数据和上游适配，不能用“参考图片”代替。</p></div>
    </div>
  );
}
