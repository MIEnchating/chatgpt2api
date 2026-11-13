import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { TooltipHint } from "@/components/ui/tooltip";
import { useEffect, useState, type ComponentProps } from "react";
import { Brain, ImagePlus, Settings2, Waves } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { CanvasAgentConfig } from "./agent/canvas-agent-types";

export function CanvasAgentRunSettings({ config, mode, busy, onChange }: {
  config: CanvasAgentConfig;
  mode: "native" | "codex";
  busy: boolean;
  onChange: (patch: Partial<CanvasAgentConfig>) => void;
}) {
  const [open, setOpen] = useState(false); /* Close for good when a run starts so the dialog cannot reopen after it ends. */ useEffect(() => { if (busy) setOpen(false); }, [busy]);
  const protocol = config.textApiMode || "responses";
  const supportsReasoning = protocol === "responses";

  return <>
    <TooltipHint content={"运行设置"}><Button type="button" size="icon" variant="ghost" aria-label="运行设置" aria-haspopup="dialog" aria-expanded={open && !busy}  disabled={busy} onClick={() => setOpen(true)}><Settings2  /></Button></TooltipHint>
    {open && !busy ? <Dialog open onOpenChange={setOpen}>
      <DialogContent className="w-[min(460px,calc(100vw-2rem))] sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center"><Settings2 className="size-5 text-primary" />运行设置</DialogTitle>
          <DialogDescription>调整 Agent 的创作方式，修改后自动保存。</DialogDescription>
        </DialogHeader><ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
        <div className="space-y-3">
          <Card aria-label="媒体生成" className="gap-0 p-0">
            <RunSetting icon={ImagePlus} label="自动生成媒体" description="关闭后先创建节点，由你确认生成。" id="canvas-agent-auto-generate" checked={config.autoGenerateMedia === true} disabled={busy} onCheckedChange={(checked) => onChange({ autoGenerateMedia: checked })} />
          </Card>
          {mode === "native" ? <Card aria-label="模型响应" className="overflow-hidden gap-0 p-0">
            <div className="flex items-center justify-between gap-2 bg-muted/30 px-3 py-2.5">
              <span id="canvas-agent-text-protocol-label" className="shrink-0 text-xs font-medium">请求协议</span>
              <RadioGroup value={protocol} onValueChange={(value) => onChange({ textApiMode: value as "chat" | "responses", ...(value === "chat" ? { textReasoningEnabled: false } : {}) })} disabled={busy} aria-labelledby="canvas-agent-text-protocol-label" className="flex w-auto">
                {(["chat", "responses"] as const).map((value) => <Label key={value} className="flex items-center gap-1.5 text-xs">
                  <RadioGroupItem value={value} />{value === "chat" ? "Chat" : "Responses"}
                </Label>)}
              </RadioGroup>
            </div>
            <div className="border-t border-border/70">
              <RunSetting icon={Waves} label="流式响应" description="分段接收响应，完成后展示并执行工具。" id="canvas-agent-streaming" checked={config.textStreaming === true} disabled={busy} onCheckedChange={(checked) => onChange({ textStreaming: checked })} />
            </div>
            <div className="border-t border-border/70">
              <RunSetting icon={Brain} label="深入思考" description={supportsReasoning ? "让模型充分推理，再规划和执行任务。" : "切换到 Responses 协议后可开启。"} id="canvas-agent-reasoning" checked={config.textReasoningEnabled === true && supportsReasoning} disabled={busy || !supportsReasoning} onCheckedChange={(checked) => onChange({ textReasoningEnabled: checked })} />
            </div>
          </Card> : null}
        </div>
        </ScrollArea><DialogFooter><Button type="button" onClick={() => setOpen(false)}>完成</Button></DialogFooter>
      </DialogContent>
    </Dialog> : null}
  </>;
}

function RunSetting({ icon: Icon, label, description, id, ...props }: {
  icon: typeof Settings2;
  label: string;
  description: string;
  id: string;
} & Pick<ComponentProps<typeof Switch>, "checked" | "disabled" | "onCheckedChange">) {
  return <div className="flex items-start gap-2.5 p-3">
    <Icon className={cn("mt-0.5 size-3.5 shrink-0", props.disabled ? "text-muted-foreground/50" : "text-muted-foreground")} />
    <div className="min-w-0 flex-1">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <Label htmlFor={id} className={cn("text-xs font-medium", props.disabled ? "cursor-default text-muted-foreground" : "cursor-pointer")}>{label}</Label>
        <Switch id={id} aria-label={label} aria-describedby={`${id}-description`} {...props} />
      </div>
      <p id={`${id}-description`} className="mt-1 text-[11px] leading-[18px] text-muted-foreground">{description}</p>
    </div>
  </div>;
}
