import { Box } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TooltipHint } from "@/components/ui/tooltip";

export type CanvasAgentMediaModels = Record<"image" | "video", {
  value: string;
  options: string[];
  onChange: (model: string) => void;
}>;

export function CanvasAgentMediaModelPicker({ models, disabled }: { models: CanvasAgentMediaModels; disabled: boolean }) {
  return <Popover>
    <TooltipHint content="图片 / 视频模型">
      <PopoverTrigger asChild><Button type="button" size="icon" variant="ghost" aria-label="图片和视频模型" className="size-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground @max-[320px]/agent:size-7"><Box className="size-[18px]" /></Button></PopoverTrigger>
    </TooltipHint>
    <PopoverContent side="top" align="center" aria-label="媒体模型设置" className="w-[min(320px,calc(100vw-2rem))] p-4">
      <div className="space-y-4">
        <div><h3 className="text-sm font-semibold">图片 / 视频模型</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">用于 Agent 接下来创建的图片和视频节点。</p></div>
        {(["image", "video"] as const).map((kind) => {
          const config = models[kind];
          const label = kind === "image" ? "图片模型" : "视频模型";
          return <div key={kind} className="space-y-1.5">
            <label htmlFor={`canvas-agent-${kind}-model`} className="text-xs font-medium">{label}</label>
            <Select value={config.options.includes(config.value) ? config.value : ""} onValueChange={config.onChange} disabled={disabled || !config.options.length}>
              <SelectTrigger id={`canvas-agent-${kind}-model`} className="h-9 text-xs"><SelectValue placeholder={config.options.length ? "选择模型" : `暂无可用${label}`} /></SelectTrigger>
              <SelectContent>{config.options.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
            </Select>
          </div>;
        })}
      </div>
    </PopoverContent>
  </Popover>;
}
