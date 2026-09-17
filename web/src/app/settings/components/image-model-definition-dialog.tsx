"use client";

import { useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { imageAdapterDefaults, imageProtocolLabels, type ImageAdapterProtocol, type ImageModelDefinition } from "@/lib/image-model-definitions";
import { imageModelRoute } from "@/lib/image-model-capabilities";

export function ImageModelDefinitionDialog({ model, definition, onClose, onChange }: {
  model: string;
  definition?: ImageModelDefinition;
  onClose: () => void;
  onChange: (definition?: ImageModelDefinition) => void;
}) {
  const [draft, setDraft] = useState(() => {
    const route = imageModelRoute(model);
    return definition || imageAdapterDefaults(route === "google-gemini-image" || route === "xai-image" ? route : "openai-image");
  });
  const [ratios, setRatios] = useState(draft.aspect_ratios.join(", "));
  const [error, setError] = useState("");
  function selectProtocol(protocol: ImageAdapterProtocol) {
    const next = imageAdapterDefaults(protocol);
    setDraft(next);
    setRatios(next.aspect_ratios.join(", "));
    setError("");
  }
  function apply() {
    const aspectRatios = [...new Set(ratios.split(/[,，\s]+/).filter(Boolean))];
    if (aspectRatios.some((value) => !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value) || value.split(":").some((part) => !(Number(part) > 0 && Number(part) <= 100)))) {
      setError("画幅比例格式应为 1:1、16:9，数值须大于 0 且不超过 100");
      return;
    }
    if (!Number.isInteger(draft.max_reference_images) || draft.max_reference_images < 0 || draft.max_reference_images > 100 || !Number.isInteger(draft.max_output_count) || draft.max_output_count < 1 || draft.max_output_count > 15) {
      setError("参考图数量应为 0-100，单次生成数量应为 1-15");
      return;
    }
    onChange({ ...draft, aspect_ratios: aspectRatios, mask: draft.mask && draft.max_reference_images > 0 });
    onClose();
  }
  function toggleValue(key: "resolutions" | "quality_values", value: string, checked: boolean) {
    setDraft((current) => ({ ...current, [key]: checked ? [...current[key], value] : current[key].filter((item) => item !== value) }));
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>图片模型协议与能力</DialogTitle>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{model}</p>
        </DialogHeader>
        <div className="grid min-w-0 gap-5 py-2">
          <div className="grid gap-2">
            <label htmlFor="image-adapter-protocol" className="text-sm font-medium">调用协议</label>
            <Select value={draft.protocol} onValueChange={(value) => selectProtocol(value as ImageAdapterProtocol)}>
              <SelectTrigger id="image-adapter-protocol" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(imageProtocolLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <label htmlFor="image-adapter-ratios" className="text-sm font-medium">画幅比例</label>
            <Input id="image-adapter-ratios" value={ratios} onChange={(event) => setRatios(event.target.value)} placeholder="1:1, 16:9, 9:16" />
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">分辨率</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-3">{["512", "1k", "2k", "4k", ...(draft.protocol === "openai-image" ? ["1080p"] : [])].map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm"><Checkbox checked={draft.resolutions.includes(value)} onCheckedChange={(checked) => toggleValue("resolutions", value, checked === true)} />{value.toUpperCase()}</label>
            ))}</div>
          </fieldset>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2"><label htmlFor="image-adapter-references" className="text-sm font-medium">最多参考图</label><Input id="image-adapter-references" type="number" min={0} max={100} value={draft.max_reference_images} onChange={(event) => setDraft({ ...draft, max_reference_images: event.target.valueAsNumber })} /></div>
            <div className="grid gap-2"><label htmlFor="image-adapter-count" className="text-sm font-medium">单次最多生成</label><Input id="image-adapter-count" type="number" min={1} max={15} value={draft.max_output_count} onChange={(event) => setDraft({ ...draft, max_output_count: event.target.valueAsNumber })} /></div>
          </div>
          {draft.protocol !== "google-gemini-image" ? <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">质量档位</legend>
            <div className="flex flex-wrap gap-5">{[["low", "低"], ["medium", "中"], ["high", "高"]].map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm"><Checkbox checked={draft.quality_values.includes(value)} onCheckedChange={(checked) => toggleValue("quality_values", value, checked === true)} />{label}</label>
            ))}</div>
          </fieldset> : null}
          <div className="grid grid-cols-2 gap-3 border-t border-border pt-4">
            {([
              ["streaming", "流式输出", draft.protocol !== "google-gemini-image"],
              ["mask", "遮罩编辑", draft.protocol === "openai-image" && draft.max_reference_images > 0],
              ["output_controls", "输出格式与压缩", draft.protocol === "openai-image"],
              ["exact_dimensions", "精确像素尺寸", draft.protocol === "openai-image"],
            ] as const).filter(([, , enabled]) => enabled).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm"><Checkbox checked={draft[key]} onCheckedChange={(checked) => setDraft({ ...draft, [key]: checked === true })} />{label}</label>
            ))}
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => { onChange(undefined); onClose(); }}><RotateCcw className="size-4" />恢复内置配置</Button>
          <Button onClick={apply}><Save className="size-4" />应用配置</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
