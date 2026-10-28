import { useRef, useState } from "react";
import { Bot, Check, LoaderCircle, Plug, Terminal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

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
    <PopoverTrigger asChild>
      <Button type="button" size="icon" variant="ghost" title="引擎与连接" aria-label="引擎与连接" className={cn("size-8 rounded-full data-[state=open]:bg-muted", mode === "codex" && connected && "text-brand")}><Plug /></Button>
    </PopoverTrigger>
    <PopoverContent side="bottom" align="end" sideOffset={10} aria-label="引擎与连接" className="w-[min(320px,calc(100vw-2rem))] p-0" onCloseAutoFocus={(event) => {
      if (!configureAfterCloseRef.current) return;
      // Hand off after this focus scope closes so it cannot dismiss the next popover.
      event.preventDefault();
      configureAfterCloseRef.current = false;
      onConfigure();
    }}>
      <div className="flex items-start gap-3 border-b border-border/60 p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><Plug className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">引擎与连接</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">选择协助你创作的 Agent</p>
        </div>
        <Button type="button" size="icon" variant="ghost" className="size-7 rounded-full" aria-label="关闭引擎与连接" onClick={() => setOpen(false)}><X className="size-3.5" /></Button>
      </div>
      <div className="space-y-2 p-3" role="group" aria-label="Agent 引擎">
        {([
          { value: "native", label: "内置 Agent", description: "使用已配置的模型，直接在画布中创作", icon: Bot },
          { value: "codex", label: "本地 Codex", description: "连接本地 Codex，协作编辑当前画布", icon: Terminal },
        ] as const).map(({ value, label, description, icon: Icon }) => <button key={value} type="button" aria-pressed={mode === value} disabled={disabled} onClick={() => onModeChange(value)} className={cn("flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", mode === value ? "border-brand/40 bg-brand-soft/50" : "border-border/70 hover:bg-muted/60")}>
          <Icon className={cn("mt-0.5 size-4 shrink-0", mode === value ? "text-brand" : "text-muted-foreground")} />
          <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{label}</span><span className="mt-1 block text-[11px] leading-5 text-muted-foreground">{description}</span></span>
          <span className="mt-0.5 size-4 shrink-0">{mode === value ? <Check className="size-4 text-brand" /> : null}</span>
        </button>)}
        {disabled ? <p className="px-1 text-[11px] leading-5 text-muted-foreground">当前任务结束后可切换引擎。</p> : null}
      </div>
      {mode === "codex" ? <div className="space-y-3 border-t border-border/60 bg-muted/20 p-4">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">连接状态</span>
          <span role="status" className={cn("flex items-center gap-1.5", error && !connected && "text-destructive")}>
            {connecting ? <LoaderCircle className="size-3 animate-spin" /> : <span className={cn("size-1.5 rounded-full", connected ? "bg-emerald-500" : error ? "bg-destructive" : "bg-muted-foreground/50")} />}{status}
          </span>
        </div>
        <Button type="button" variant="secondary" className="h-9 w-full rounded-lg text-xs" onClick={() => { configureAfterCloseRef.current = true; setOpen(false); }}><Plug className="size-3.5" />{connected ? "管理 Codex 连接" : "配置 Codex 连接"}</Button>
      </div> : null}
    </PopoverContent>
  </Popover>;
}
