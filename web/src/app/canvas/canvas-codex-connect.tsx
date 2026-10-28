import { copyClipboardText } from "@/lib/clipboard-text";
import { useEffect, useState } from "react";
import { ChevronDown, Copy, LoaderCircle, Plug, Settings2, ShieldCheck, Terminal, Unplug, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { useCanvasCodexAgent } from "./agent/canvas-codex-agent";

export function CanvasCodexConnect({ agent, busy, open, onOpenChange }: {
  agent: ReturnType<typeof useCanvasCodexAgent>;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:3210");
  const [token, setToken] = useState("");
  const selectedModel = agent.models.find((item) => item.model === agent.model);
  const startCommand = `node canvas-agent/server.mjs --origin ${window.location.origin}`;
  const status = agent.connecting ? "连接中" : agent.connected ? "已连接" : agent.error ? "连接异常" : "未连接";

  useEffect(() => { if (agent.connected) onOpenChange(false); }, [agent.connected, onOpenChange]);

  const copyText = (value: string, message: string) => {
    void copyClipboardText(value).then(() => toast.success(message)).catch((error: Error) => toast.error(error.message));
  };

  return <section aria-label="Codex 连接设置" className="shrink-0 border-b px-3 py-2.5">
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Codex 连接与模型设置" className="flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-2 text-left transition-colors hover:border-brand/30 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", agent.connected ? "bg-brand-soft text-brand" : "bg-muted text-muted-foreground")}>
            {agent.connecting ? <LoaderCircle className="size-4 animate-spin" /> : <Terminal className="size-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-xs font-medium">
              本地 Codex
              <span className={cn("inline-flex items-center gap-1 text-[10px] font-normal", agent.error ? "text-destructive" : "text-muted-foreground")} role="status">
                <span className={cn("size-1.5 rounded-full", agent.connecting ? "animate-pulse bg-brand" : agent.connected ? "bg-emerald-500" : agent.error ? "bg-destructive" : "bg-muted-foreground/50")} />{status}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" title={agent.connected ? selectedModel?.displayName || agent.model : undefined}>
              {agent.connected ? `${selectedModel?.displayName || agent.model} · ${agent.effort}` : agent.error ? "点击查看详情并重新连接" : "连接后即可协作编辑画布"}
            </span>
          </span>
          {agent.connected ? <Settings2 className="size-3.5 shrink-0 text-muted-foreground" /> : <span className="shrink-0 text-xs font-medium text-brand">配置<ChevronDown className="ml-1 inline size-3" /></span>}
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label="Codex 配置" side="bottom" align="end" className="w-[min(360px,calc(100vw-2rem))] p-4">
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">{agent.connected ? "模型与连接" : "连接 Codex"}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{agent.connected ? "设置当前对话使用的模型与思考强度" : "使用本机的 Codex，在当前画布中创作"}</p>
          </div>
          <Button type="button" size="icon" variant="ghost" className="size-7 rounded-md" aria-label="关闭 Codex 配置" onClick={() => onOpenChange(false)}><X className="size-3.5" /></Button>
        </div>
        {!agent.connected ? <form className="space-y-3.5" onSubmit={(event) => {
          event.preventDefault();
          if (busy || agent.connecting || !token.trim()) return;
          const secret = token;
          setToken("");
          void agent.connect(endpoint, secret);
        }}>
          <div className="space-y-1.5">
            <label htmlFor="canvas-codex-endpoint" className="text-xs font-medium">服务地址</label>
            <Input id="canvas-codex-endpoint" className="h-9 font-mono text-xs sm:text-xs" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} disabled={agent.connecting} placeholder="http://127.0.0.1:3210" spellCheck={false} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="canvas-codex-connection-token" className="text-xs font-medium">连接密钥</label>
            <Input id="canvas-codex-connection-token" className="h-9 text-xs sm:text-xs" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={agent.connecting} placeholder="粘贴终端显示的密钥" aria-describedby="canvas-codex-token-description" />
          </div>
          <p id="canvas-codex-token-description" className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><ShieldCheck className="size-3.5 shrink-0" />密钥仅用于当前页面</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="h-9 flex-1" disabled={busy || agent.connecting || !token.trim()}>{agent.connecting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}{agent.connecting ? "正在连接…" : "连接 Codex"}</Button>
            {agent.connecting ? <Button type="button" size="sm" variant="outline" className="h-9" onClick={agent.disconnect}>取消</Button> : null}
          </div>
          <details className="group border-t border-border pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><Terminal className="size-3.5" />如何启动本地服务<ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" /></summary>
            <div className="mt-3 space-y-2.5 text-xs leading-5 text-muted-foreground">
              <p>安装 Codex CLI 并运行 <code className="text-foreground">codex login</code>，然后在项目目录执行：</p>
              <div className="overflow-hidden rounded-lg border bg-muted/40">
                <div className="flex items-center justify-between border-b px-2.5 py-1"><span className="text-[10px]">终端命令</span><Button type="button" size="icon" variant="ghost" className="size-6" aria-label="复制启动命令" onClick={() => copyText(startCommand, "已复制启动命令")}><Copy className="size-3" /></Button></div>
                <code className="block select-all break-all p-2.5 font-mono text-[11px] text-foreground">{startCommand}</code>
              </div>
              <p>端口已占用时，用 <code>--port</code> 指定空闲端口，并同步修改服务地址。</p>
            </div>
          </details>
        </form> : <div className="space-y-4">
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2.5">
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="canvas-codex-model" className="text-xs font-medium">模型</label>
              <Select value={agent.model} onValueChange={agent.setModel} disabled={busy}><SelectTrigger id="canvas-codex-model" className="h-9 text-xs"><SelectValue /></SelectTrigger><SelectContent>{agent.models.map((model) => <SelectItem key={model.id} value={model.model}>{model.displayName}</SelectItem>)}</SelectContent></Select>
            </div>
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="canvas-codex-effort" className="text-xs font-medium">思考强度</label>
              <Select value={agent.effort} onValueChange={agent.setEffort} disabled={busy}><SelectTrigger id="canvas-codex-effort" className="h-9 text-xs"><SelectValue /></SelectTrigger><SelectContent>{selectedModel?.supportedReasoningEfforts.map((item) => <SelectItem key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</SelectItem>)}</SelectContent></Select>
            </div>
          </div>
          <div className="rounded-lg border bg-muted/25 p-3">
            <p className="text-xs font-medium">MCP 画布连接</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">外部 MCP 修改画布时，需在此页面确认。配置方法见 canvas-agent/README.md。</p>
            <Button type="button" size="sm" variant="outline" className="mt-2 w-full text-xs" onClick={() => copyText(agent.sessionId, "已复制 MCP 画布连接 ID")}><Copy className="size-3.5" />复制连接 ID</Button>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 border-t pt-3">
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={endpoint}>{endpoint}</span>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={agent.disconnect}><Unplug className="size-3.5" />断开</Button>
          </div>
        </div>}
        {agent.error ? <p className="mt-3 break-words rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert">{agent.error}</p> : null}
      </PopoverContent>
    </Popover>
  </section>;
}
