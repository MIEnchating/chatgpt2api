import { useState } from "react";
import { ChevronDown, ImagePlus, Link2, Music, Video } from "lucide-react";
import { ReferenceFileUpload } from "@/components/generation/reference-file-upload";
import { ReferenceMediaCard } from "@/components/generation/reference-media-card";
import { ImageParameterLabel } from "@/components/generation/image-parameter-ui";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/services/api/canvas";
import type { CanvasConfigInput } from "./canvas-config-inputs";

export type VideoReferenceSlot = "image" | "last-frame" | "video" | "audio";
type Material = {
  slot: VideoReferenceSlot;
  label: string;
  hint: string;
  help: string;
  accept: string;
  url: string;
  visible: boolean;
  disabled: boolean;
  nodeID?: string;
};

export function CanvasVideoReferences({ node, inputs, mode, supportsMultimodal, supportsLastFrame, materials, uploading, onChange, onUpload }: {
  node: CanvasNode;
  inputs: readonly CanvasConfigInput[];
  mode: "first-frame" | "reference";
  supportsMultimodal: boolean;
  supportsLastFrame: boolean;
  materials: Material[];
  uploading: VideoReferenceSlot | "";
  onChange: (patch: Partial<CanvasNode>) => void;
  onUpload: (slot: VideoReferenceSlot, file: File) => Promise<void>;
}) {
  const [linksOpen, setLinksOpen] = useState(false);
  const images = inputs.filter(input => input.type === "image" && input.url);
  const visibleMaterials = materials.filter(material => material.visible);
  const frameMode = mode === "first-frame";
  function changeURL(slot: VideoReferenceSlot, url: string) {
    const values = url ? [url] : [];
    onChange(slot === "last-frame" ? { generation_video_last_frame_url: url, generation_video_last_frame_node_id: undefined }
      : slot === "image" ? { generation_video_reference_image_urls: values, ...(frameMode ? { generation_video_first_frame_node_id: undefined } : {}) }
        : slot === "video" ? { generation_video_reference_urls: values } : { generation_video_reference_audio_urls: values });
  }
  return <div data-canvas-reference-materials className="space-y-4">
    {supportsMultimodal ? <div className="grid grid-cols-2 gap-1 rounded-xl border border-border/60 bg-muted/30 p-1" role="group" aria-label="参考模式">
      {([['first-frame', supportsLastFrame ? '首尾帧' : '首帧'], ['reference', '多模态参考']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => onChange({ generation_video_reference_mode: value })} className={cn("flex h-8 items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-colors", mode === value ? "bg-card text-foreground shadow-sm ring-1 ring-border/60" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>{value === "first-frame" ? <ImagePlus className="size-3.5" /> : <Video className="size-3.5" />}{label}</button>)}
    </div> : null}
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium">{frameMode ? "画面衔接" : "参考素材"}</span>
      <button type="button" aria-expanded={linksOpen} onClick={() => setLinksOpen(open => !open)} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><Link2 className="size-3" />链接<ChevronDown className={cn("size-3 transition-transform", linksOpen && "rotate-180")} /></button>
    </div>
    <div className={cn("grid items-start gap-3", frameMode ? "grid-cols-2" : "grid-cols-[repeat(auto-fit,minmax(104px,1fr))]")}>
      {visibleMaterials.map(material => {
        const kind = material.slot === "last-frame" ? "image" : material.slot;
        const bound = images.find(input => input.nodeID === material.nodeID);
        const url = bound?.url || material.url;
        const isFrame = frameMode && (material.slot === "image" || material.slot === "last-frame");
        const icon = kind === "image" ? <ImagePlus className="size-5" /> : kind === "video" ? <Video className="size-5" /> : <Music className="size-5" />;
        return <section key={material.slot} data-reference-slot={material.slot} className="min-w-0 space-y-2 rounded-xl border border-border/60 bg-muted/15 p-2.5">
          <div className="flex items-center justify-between gap-1 [&_button]:size-4 [&_span]:whitespace-nowrap"><ImageParameterLabel help={material.help}>{material.label}</ImageParameterLabel>{isFrame ? <span className="text-[10px] text-muted-foreground">{url ? "已添加" : material.slot === "image" ? "起始" : "结束"}</span> : null}</div>
          {url ? <ReferenceMediaCard thumbnailOnly kind={kind} src={url} label={material.label} removeDisabled={material.disabled} onRemove={() => changeURL(material.slot, "")} /> : <ReferenceFileUpload showLabel={false} icon={icon} label={`上传${material.label}`} hint={material.hint} accept={material.accept} loading={uploading === material.slot} disabled={material.disabled || Boolean(uploading)} onFiles={async files => { await onUpload(material.slot, files[0]); }} />}
          {isFrame && images.length > 0 ? <Select value={material.nodeID || "__upload__"} disabled={material.disabled} onValueChange={id => onChange(material.slot === "last-frame" ? { generation_video_last_frame_node_id: id === "__upload__" ? undefined : id } : { generation_video_first_frame_node_id: id === "__upload__" ? undefined : id })}><SelectTrigger aria-label={`选择${material.label}节点`} className="h-7 border-0 bg-transparent px-1 text-[11px] shadow-none"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__upload__">上传图片或粘贴链接</SelectItem>{images.map(input => <SelectItem key={input.nodeID} value={input.nodeID}>{input.title}</SelectItem>)}</SelectContent></Select> : null}
          {linksOpen ? <Input aria-label={`${material.label}链接`} type="url" value={material.url} disabled={material.disabled} onChange={event => changeURL(material.slot, event.target.value)} placeholder="https://…" className="h-8 min-w-0 rounded-lg px-2 text-xs shadow-none" /> : null}
        </section>;
      })}
    </div>
    <label className="flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-[11px] text-muted-foreground"><span>排除上游文本</span><Checkbox checked={Boolean(node.exclude_upstream_text)} onCheckedChange={checked => onChange({ exclude_upstream_text: checked === true })} /></label>
  </div>;
}
