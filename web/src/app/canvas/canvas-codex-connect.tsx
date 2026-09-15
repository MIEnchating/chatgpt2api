import { useEffect, useState } from "react";
import { ChevronDown, Copy, LoaderCircle, Plug, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { useCanvasCodexAgent } from "./agent/canvas-codex-agent";

export function CanvasCodexConnect({ agent, busy }: { agent: ReturnType<typeof useCanvasCodexAgent>; busy: boolean }) {
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:3210");
  const [token, setToken] = useState("");
  const [expanded, setExpanded] = useState(!agent.connected);
  const selectedModel = agent.models.find((item) => item.model === agent.model);

  useEffect(() => { setExpanded(!agent.connected); }, [agent.connected]);

  return <section aria-label="Codex 连接设置" className="flex min-h-0 max-h-[45%] flex-col border-b bg-muted/15">
    <button type="button" aria-expanded={expanded} aria-controls="canvas-codex-connection-content" className="flex h-10 shrink-0 items-center justify-between gap-2 px-3 text-left text-xs font-medium outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => setExpanded((value) => !value)}>
      <span className="flex min-w-0 items-center gap-2"><Plug className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{agent.connected ? "Codex 已连接 · 模型与 MCP" : "连接本地 Codex"}</span></span>
      <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
    </button>
    {expanded ? <ScrollArea id="canvas-codex-connection-content" className="min-h-0 flex-1" maxHeight="min(22rem,36cqh)" viewportClassName="px-3 pb-3">
    <div className="space-y-4">
      {!agent.connected ? <>
        <label className="block space-y-2 text-xs font-medium"><span>本地服务地址</span><Input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} disabled={agent.connecting} placeholder="http://127.0.0.1:3210" /></label>
        <div className="space-y-2">
          <label htmlFor="canvas-codex-connection-token" className="text-xs font-medium">连接密钥</label>
          <Input id="canvas-codex-connection-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={agent.connecting} placeholder="输入终端显示的密钥" aria-describedby="canvas-codex-token-description" />
          <p id="canvas-codex-token-description" className="text-xs leading-5 text-muted-foreground">密钥仅用于当前页面。</p>
        </div>
        <div className="flex gap-2"><Button size="sm" disabled={busy || agent.connecting || !token.trim()} onClick={() => { const secret = token; setToken(""); void agent.connect(endpoint, secret); }}>{agent.connecting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}连接</Button>{agent.connecting ? <Button size="sm" variant="outline" onClick={agent.disconnect}>取消连接</Button> : null}</div>
        <details className="group border-t border-border pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" />启动本地服务</summary>
          <div className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
            <p>安装 Codex CLI 并运行 <code>codex login</code>，然后在项目目录执行：</p>
            <code className="block select-all break-all rounded-md bg-muted p-2.5 font-mono text-[11px] text-foreground">node canvas-agent/server.mjs --origin {window.location.origin}</code>
            <p>端口已占用时，用 <code>--port</code> 指定空闲端口并修改上方地址。</p>
          </div>
        </details>
      </> : <>
        <div className="space-y-2">
          <label htmlFor="canvas-codex-model" className="text-xs font-medium">模型</label>
          <Select value={agent.model} onValueChange={agent.setModel} disabled={busy}><SelectTrigger id="canvas-codex-model"><SelectValue /></SelectTrigger><SelectContent>{agent.models.map((model) => <SelectItem key={model.id} value={model.model}>{model.displayName}</SelectItem>)}</SelectContent></Select>
        </div>
        <div className="space-y-2">
          <label htmlFor="canvas-codex-effort" className="text-xs font-medium">思考强度</label>
          <Select value={agent.effort} onValueChange={agent.setEffort} disabled={busy}><SelectTrigger id="canvas-codex-effort"><SelectValue /></SelectTrigger><SelectContent>{selectedModel?.supportedReasoningEfforts.map((item) => <SelectItem key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</SelectItem>)}</SelectContent></Select>
        </div>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(agent.sessionId).then(() => toast.success("已复制 MCP 画布连接 ID")).catch(() => toast.error("复制失败")); }}><Copy className="size-3.5" />复制 MCP 连接 ID</Button><Button size="sm" variant="ghost" onClick={agent.disconnect}><Unplug className="size-3.5" />断开</Button></div>
        <p className="text-xs leading-5 text-muted-foreground">外部 MCP 修改画布时需在此页面确认。配置方法见 canvas-agent/README.md。</p>
      </>}
      {agent.error ? <p className="break-words text-xs leading-5 text-destructive" role="alert">{agent.error}</p> : null}
    </div>
    </ScrollArea> : null}
  </section>;
}
