import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { TooltipHint } from "@/components/ui/tooltip";
import { useRef, useState } from "react";
import { Bot, Check, Plug, Terminal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription, PopoverTrigger } from "@/components/ui/popover";

export function CanvasAgentEnginePicker({ mode, disabled, connected, connecting, error, onModeChange, onConfigure }: {
  mode: "native" | "codex";
  disabled: boolean;
  connected: boolean;
  connecting: boolean;
  error: boolean;
  onModeChange: (mode: "native" | "codex") => void;
  onConfigure: () => void;
}) {
  const [open, setOpen] = useState(false);
  const configureAfterCloseRef = useRef(false);
  const status = connecting ? "连接中" : connected ? "已连接" : error ? "连接异常" : "未连接";

  return <Popover open={open} onOpenChange={setOpen}>
    <TooltipHint content={"引擎与连接"}><span className="inline-flex shrink-0"><PopoverTrigger asChild><Button type="button" size="icon" variant="ghost" aria-label="引擎与连接" ><Plug /></Button></PopoverTrigger></span></TooltipHint>
    <PopoverContent side="bottom" align="end" sideOffset={10} aria-label="引擎与连接" className="w-[min(320px,calc(100vw-2rem))]" onCloseAutoFocus={(event) => {
      if (!configureAfterCloseRef.current) return;
      // Hand off after this focus scope closes so it cannot dismiss the next popover.
      event.preventDefault();
      configureAfterCloseRef.current = false;
      onConfigure();
    }}>
      {open ? <ScrollArea data-slot="popover-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
      <PopoverHeader className="flex-row items-start gap-3 px-3 pt-3">
        <div className="min-w-0 flex-1">
          <PopoverTitle>引擎与连接</PopoverTitle>
          <PopoverDescription>选择协助你创作的 Agent</PopoverDescription>
        </div>
        <Button type="button" size="icon" variant="ghost"  aria-label="关闭引擎与连接" onClick={() => setOpen(false)}><X  /></Button>
      </PopoverHeader>
      <div className="space-y-2 p-3" role="group" aria-label="Agent 引擎">
        {([
          { value: "native", label: "内置 Agent", description: "使用已配置的模型，直接在画布中创作", icon: Bot },
          { value: "codex", label: "本地 Codex", description: "连接本地 Codex，协作编辑当前画布", icon: Terminal },
        ] as const).map(({ value, label, description, icon: Icon }) => <Toggle variant="outline" key={value} type="button" pressed={mode === value} disabled={disabled} onClick={() => onModeChange(value)} className="flex w-full items-start text-left justify-start h-auto min-h-8 whitespace-normal py-2">
          <Icon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{label}</span><span className="mt-1 block text-[11px] leading-5 text-muted-foreground">{description}</span></span>
          <span className="mt-0.5 size-4 shrink-0">{mode === value ? <Check /> : null}</span>
        </Toggle>)}
        {disabled ? <p className="px-1 text-[11px] leading-5 text-muted-foreground">当前任务结束后可切换引擎。</p> : null}
      </div>
      {mode === "codex" ? <div className="space-y-3 border-t p-3">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">连接状态</span>
          <Badge role="status" variant={error && !connected ? "destructive" : "secondary"}>
            {connecting ? <Spinner /> : null}{status}
          </Badge>
        </div>
        <Button type="button" variant="secondary" className="w-full" onClick={() => { configureAfterCloseRef.current = true; setOpen(false); }}><Plug  />{connected ? "管理 Codex 连接" : "配置 Codex 连接"}</Button>
      </div> : null}
    </ScrollArea> : null}</PopoverContent>
  </Popover>;
}
