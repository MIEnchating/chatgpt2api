import { Plus, Trash2 } from "lucide-react";

import type { CanvasConfigInput } from "./canvas-config-inputs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supportsKlingElements, supportsKlingShotType, supportsVideoFrameReferences, klingOmniVariant } from "@/lib/video-model-capabilities";
import type { CanvasNode } from "@/services/api/canvas";

const EMPTY_NODE_ID = "__none__";

export function CanvasVideoNodeBindings({ node, inputs, onChange }: {
  node: CanvasNode;
  inputs: readonly CanvasConfigInput[];
  onChange: (patch: Partial<CanvasNode>) => void;
}) {
  const model = node.generation_video_model || "";
  const imageInputs = inputs.filter((input) => input.type === "image" && input.url);
  const textInputs = inputs.filter((input) => input.type === "text" && input.text);
  const mediaInputs = inputs.filter((input) => input.type !== "text" && input.url);
  const klingAdvanced = supportsKlingElements(model);
  const klingVariant = klingOmniVariant(model);
  const showsKlingFrames = klingAdvanced && (!klingVariant || klingVariant === "image-to-video");
  const showsNamedFrames = !klingAdvanced && supportsVideoFrameReferences(model);
  const frameIDs = node.generation_video_kling_image_node_ids || [];
  const multiPrompts = node.generation_video_kling_multi_prompt?.length
    ? node.generation_video_kling_multi_prompt
    : [{ text_node_id: "", duration: "1" }];
  const elements = node.generation_video_kling_element_list?.length
    ? node.generation_video_kling_element_list
    : [{ name: "", description: "", node_ids: [] }];
  const showsCustomPrompts = Boolean(node.generation_video_multi_shot)
    && (!supportsKlingShotType(model) || node.generation_video_shot_type === "customize");

  const updateMultiPrompt = (index: number, patch: { text_node_id?: string; duration?: string }) => {
    onChange({
      generation_video_kling_multi_prompt: multiPrompts.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    });
  };
  const updateElement = (index: number, patch: { name?: string; description?: string; node_ids?: string[] }) => {
    onChange({
      generation_video_kling_element_list: elements.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    });
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/80 bg-muted/15 p-3">
      <label className="flex items-center justify-between gap-3 text-xs">
        <span>排除上游文本</span>
        <Checkbox checked={Boolean(node.exclude_upstream_text)} onCheckedChange={(checked) => onChange({ exclude_upstream_text: checked === true })} />
      </label>

      {showsNamedFrames ? (
        <div className="grid grid-cols-2 gap-2">
          <NodeSelect label="首帧" value={node.generation_video_first_frame_node_id || ""} inputs={imageInputs} onChange={(nodeID) => onChange({ generation_video_first_frame_node_id: nodeID || undefined })} />
          <NodeSelect label="尾帧" value={node.generation_video_last_frame_node_id || ""} inputs={imageInputs} onChange={(nodeID) => onChange({ generation_video_last_frame_node_id: nodeID || undefined })} />
        </div>
      ) : null}

      {showsKlingFrames ? (
        <div className="grid grid-cols-2 gap-2">
          <NodeSelect label="首帧" value={frameIDs[0] || ""} inputs={imageInputs} onChange={(nodeID) => onChange({ generation_video_kling_image_node_ids: [nodeID, frameIDs[1]].filter(Boolean) })} />
          <NodeSelect label="尾帧" value={frameIDs[1] || ""} inputs={imageInputs} onChange={(nodeID) => onChange({ generation_video_kling_image_node_ids: [frameIDs[0], nodeID].filter(Boolean) })} />
        </div>
      ) : null}

      {klingAdvanced && showsCustomPrompts ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between text-xs font-medium">
            <span>分镜提示词</span>
            <Button type="button" size="icon" variant="outline" className="size-8" title="新增分镜提示词" onClick={() => onChange({ generation_video_kling_multi_prompt: [...multiPrompts, { text_node_id: "", duration: "1" }] })}><Plus className="size-3.5" /></Button>
          </div>
          {multiPrompts.map((item, index) => (
            <div key={index} className="grid grid-cols-[minmax(0,1fr)_4.5rem_2rem] items-end gap-2">
              <NodeSelect label={`分镜 ${index + 1}`} value={item.text_node_id || ""} inputs={textInputs} onChange={(nodeID) => updateMultiPrompt(index, { text_node_id: nodeID })} />
              <label className="grid gap-1 text-[11px] text-muted-foreground"><span>秒数</span><Input type="number" min={1} max={15} value={item.duration || "1"} onChange={(event) => updateMultiPrompt(index, { duration: event.target.value })} className="h-9 px-2 text-xs" /></label>
              <Button type="button" size="icon" variant="ghost" className="size-8 text-destructive" disabled={multiPrompts.length <= 1} title="删除分镜提示词" onClick={() => onChange({ generation_video_kling_multi_prompt: multiPrompts.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 className="size-3.5" /></Button>
            </div>
          ))}
        </section>
      ) : null}

      {klingAdvanced ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between text-xs font-medium">
            <span>元素列表</span>
            <Button type="button" size="icon" variant="outline" className="size-8" disabled={elements.length >= 3} title="新增元素" onClick={() => onChange({ generation_video_kling_element_list: [...elements, { name: "", description: "", node_ids: [] }] })}><Plus className="size-3.5" /></Button>
          </div>
          {elements.map((item, index) => {
            const selectedIDs = item.node_ids || [];
            return (
              <div key={index} className="space-y-2 rounded-lg border border-border/70 bg-background/60 p-2.5">
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2">
                  <Input value={item.name || ""} onChange={(event) => updateElement(index, { name: event.target.value })} placeholder="元素名称" className="h-9 text-xs" />
                  <Input value={item.description || ""} onChange={(event) => updateElement(index, { description: event.target.value })} placeholder="元素描述" className="h-9 text-xs" />
                  <Button type="button" size="icon" variant="ghost" className="size-8 text-destructive" disabled={elements.length <= 1} title="删除元素" onClick={() => onChange({ generation_video_kling_element_list: elements.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 className="size-3.5" /></Button>
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {mediaInputs.length ? mediaInputs.map((input) => {
                    const checked = selectedIDs.includes(input.nodeID);
                    const disabled = !checked && selectedIDs.length >= 4;
                    return <label key={input.nodeID} className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs"><Checkbox checked={checked} disabled={disabled} onCheckedChange={(next) => updateElement(index, { node_ids: next === true ? [...selectedIDs, input.nodeID] : selectedIDs.filter((nodeID) => nodeID !== input.nodeID) })} /><span className="truncate">{input.title}</span><span className="ml-auto text-[10px] text-muted-foreground">{mediaTypeLabel(input.type)}</span></label>;
                  }) : <p className="col-span-2 text-[11px] text-muted-foreground">暂无已连接素材</p>}
                </div>
              </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}

function mediaTypeLabel(type: CanvasConfigInput["type"]) {
  if (type === "image") return "图片";
  if (type === "video") return "视频";
  if (type === "audio") return "音频";
  return "文本";
}

function NodeSelect({ label, value, inputs, onChange }: {
  label: string;
  value: string;
  inputs: readonly CanvasConfigInput[];
  onChange: (nodeID: string) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
      <span>{label}</span>
      <Select value={value || EMPTY_NODE_ID} onValueChange={(next) => onChange(next === EMPTY_NODE_ID ? "" : next)}>
        <SelectTrigger className="h-9 min-w-0 px-2 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={EMPTY_NODE_ID}>不指定</SelectItem>
          {inputs.map((input) => <SelectItem key={input.nodeID} value={input.nodeID}>{input.title}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  );
}
