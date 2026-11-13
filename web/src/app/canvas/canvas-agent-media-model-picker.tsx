import { useState } from "react";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Box } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ModelPicker } from "@/components/model-picker";
import { TooltipHint } from "@/components/ui/tooltip";

export type CanvasAgentMediaModels = Record<"image" | "video", {
  value: string;
  options: string[];
  onChange: (model: string) => void;
}>;

export function CanvasAgentMediaModelPicker({ models, disabled }: { models: CanvasAgentMediaModels; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <TooltipHint content="图片 / 视频模型">
      <span className="inline-flex shrink-0"><PopoverTrigger asChild><Button type="button" size="icon" variant="ghost" aria-label="图片和视频模型" className="shrink-0"><Box className="size-[18px]" /></Button></PopoverTrigger></span>
    </TooltipHint>
    {open ? <PopoverContent side="top" align="center" aria-label="媒体模型设置" className="w-[min(320px,calc(100vw-2rem))]"><ScrollArea data-slot="popover-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
      <div className="space-y-4">
        <div><h3 className="text-sm font-semibold">图片 / 视频模型</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">用于 Agent 接下来创建的图片和视频节点。</p></div>
        {(["image", "video"] as const).map((kind) => {
          const config = models[kind];
          const label = kind === "image" ? "图片模型" : "视频模型";
          return <div key={kind} className="space-y-1.5">
            <Label htmlFor={`canvas-agent-${kind}-model`} className="text-xs font-medium">{label}</Label>
            <ModelPicker id={`canvas-agent-${kind}-model`} label={label} value={config.value} options={config.options} onValueChange={config.onChange} disabled={disabled} placeholder={`暂无可用${label}`} />
          </div>;
        })}
      </div>
    </ScrollArea></PopoverContent> : null}
  </Popover>;
}
