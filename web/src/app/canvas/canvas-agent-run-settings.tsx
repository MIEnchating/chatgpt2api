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
    <Button type="button" size="icon" variant="ghost" aria-label="运行设置" title="运行设置" aria-haspopup="dialog" aria-expanded={open && !busy} className="size-8 rounded-full" disabled={busy} onClick={() => setOpen(true)}><Settings2 className="size-4" /></Button>
    <Dialog open={open && !busy} onOpenChange={setOpen}>
      <DialogContent className="w-[min(460px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Settings2 className="size-5 text-brand" />运行设置</DialogTitle>
          <DialogDescription>调整 Agent 的创作方式，修改后自动保存。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <section aria-label="媒体生成" className="rounded-xl border border-border/70 bg-muted/20">
            <RunSetting icon={ImagePlus} label="自动生成媒体" description="关闭后先创建节点，由你确认生成。" id="canvas-agent-auto-generate" checked={config.autoGenerateMedia === true} disabled={busy} onCheckedChange={(checked) => onChange({ autoGenerateMedia: checked })} />
          </section>
          {mode === "native" ? <section aria-label="模型响应" className="overflow-hidden rounded-xl border border-border/70">
            <div className="flex items-center justify-between gap-2 bg-muted/30 px-3 py-2.5">
              <span id="canvas-agent-text-protocol-label" className="shrink-0 text-xs font-medium">请求协议</span>
              <div role="radiogroup" aria-labelledby="canvas-agent-text-protocol-label" className="grid min-w-0 grid-cols-2 gap-0.5 rounded-lg border border-border/60 bg-muted/60 p-0.5">
                {(["chat", "responses"] as const).map((value) => <label key={value} className="relative min-w-0 cursor-pointer">
                  <input type="radio" name="canvas-agent-text-protocol" value={value} checked={protocol === value} disabled={busy} onChange={() => onChange({ textApiMode: value, ...(value === "chat" ? { textReasoningEnabled: false } : {}) })} className="peer sr-only" />
                  <span className="flex h-7 items-center justify-center rounded-md px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground peer-checked:bg-background peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-50">{value === "chat" ? "Chat" : "Responses"}</span>
                </label>)}
              </div>
            </div>
            <div className="border-t border-border/70">
              <RunSetting icon={Waves} label="流式响应" description="分段接收响应，完成后展示并执行工具。" id="canvas-agent-streaming" checked={config.textStreaming === true} disabled={busy} onCheckedChange={(checked) => onChange({ textStreaming: checked })} />
            </div>
            <div className="border-t border-border/70">
              <RunSetting icon={Brain} label="深入思考" description={supportsReasoning ? "让模型充分推理，再规划和执行任务。" : "切换到 Responses 协议后可开启。"} id="canvas-agent-reasoning" checked={config.textReasoningEnabled === true && supportsReasoning} disabled={busy || !supportsReasoning} onCheckedChange={(checked) => onChange({ textReasoningEnabled: checked })} />
            </div>
          </section> : null}
        </div>
        <DialogFooter><Button type="button" onClick={() => setOpen(false)}>完成</Button></DialogFooter>
      </DialogContent>
    </Dialog>
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
        <label htmlFor={id} className={cn("text-xs font-medium", props.disabled ? "cursor-default text-muted-foreground" : "cursor-pointer")}>{label}</label>
        <Switch id={id} aria-label={label} aria-describedby={`${id}-description`} {...props} />
      </div>
      <p id={`${id}-description`} className="mt-1 text-[11px] leading-[18px] text-muted-foreground">{description}</p>
    </div>
  </div>;
}
