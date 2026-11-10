import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert } from "@/components/ui/alert";
import { ItemMedia } from "@/components/ui/item";
import { Card } from "@/components/ui/card";
import { CodeBlock, CodeBlockHeader, CodeBlockTitle, CodeBlockActions, CodeBlockCopyButton, CodeBlockContent } from "@/components/ui/code-block";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { PasswordInput } from "@/components/password-input";
import { useEffect, useState } from "react";
import { ChevronDown, Plug, Settings2, ShieldCheck, Terminal, Unplug, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { useCanvasCodexAgent } from "./agent/canvas-codex-agent";
import { ModelPicker } from "@/components/model-picker";

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

  return <section aria-label="Codex 连接设置" className="shrink-0 border-b px-3 py-2.5">
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" type="button" aria-label="Codex 连接与模型设置" className="flex w-full min-w-0 items-center text-left justify-start h-auto min-h-8 whitespace-normal py-2">
          <ItemMedia variant="icon" className="grid size-8 shrink-0 place-items-center">
            {agent.connecting ? <Spinner /> : <Terminal  />}
          </ItemMedia>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-xs font-medium">
              本地 Codex
              <Badge variant={agent.error ? "destructive" : "secondary"} role="status">{status}</Badge>
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" title={agent.connected ? selectedModel?.displayName || agent.model : undefined}>
              {agent.connected ? `${selectedModel?.displayName || agent.model} · ${agent.effort}` : agent.error ? "点击查看详情并重新连接" : "连接后即可协作编辑画布"}
            </span>
          </span>
          {agent.connected ? <Settings2 className="shrink-0 text-muted-foreground" /> : <span className="shrink-0 text-xs font-medium text-primary">配置<ChevronDown className="ml-1 inline" /></span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Codex 配置" side="bottom" align="end" className="max-h-(--radix-popover-content-available-height) w-[min(360px,calc(100vw-2rem))]"><ScrollArea data-slot="popover-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">{agent.connected ? "模型与连接" : "连接 Codex"}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{agent.connected ? "设置当前对话使用的模型与思考强度" : "使用本机的 Codex，在当前画布中创作"}</p>
          </div>
          <Button type="button" size="icon" variant="ghost"  aria-label="关闭 Codex 配置" onClick={() => onOpenChange(false)}><X  /></Button>
        </div>
        {!agent.connected ? <form className="space-y-3.5" onSubmit={(event) => {
          event.preventDefault();
          if (busy || agent.connecting || !token.trim()) return;
          const secret = token;
          setToken("");
          void agent.connect(endpoint, secret);
        }}>
          <div className="space-y-1.5">
            <Label htmlFor="canvas-codex-endpoint" className="text-xs font-medium">服务地址</Label>
            <Input id="canvas-codex-endpoint" className="font-mono" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} disabled={agent.connecting} placeholder="http://127.0.0.1:3210" spellCheck={false} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="canvas-codex-connection-token" className="text-xs font-medium">连接密钥</Label>
            <PasswordInput id="canvas-codex-connection-token"  inputClassName="text-xs sm:text-xs" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={agent.connecting} placeholder="粘贴终端显示的密钥" aria-describedby="canvas-codex-token-description" />
          </div>
          <p id="canvas-codex-token-description" className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><ShieldCheck className="size-3.5 shrink-0" />密钥仅用于当前页面</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="flex-1" disabled={busy || agent.connecting || !token.trim()}>{agent.connecting ? <Spinner /> : <Plug  />}{agent.connecting ? "正在连接…" : "连接 Codex"}</Button>
            {agent.connecting ? <Button type="button" size="sm" variant="outline"  onClick={agent.disconnect}>取消</Button> : null}
          </div>
          <Collapsible className="group">
            <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-start whitespace-normal flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden h-auto min-h-8"><Terminal  />如何启动本地服务<ChevronDown className="ml-auto transition-transform group-data-[state=open]:rotate-180" /></Button></CollapsibleTrigger><CollapsibleContent forceMount className="data-[state=closed]:hidden">
            <div className="mt-3 space-y-2.5 text-xs leading-5 text-muted-foreground">
              <p>安装 Codex CLI 并运行 <code className="text-foreground">codex login</code>，然后在项目目录执行：</p>
              <CodeBlock size="sm">
                <CodeBlockHeader><CodeBlockTitle>终端命令</CodeBlockTitle><CodeBlockActions><CodeBlockCopyButton value={startCommand} aria-label="复制启动命令" /></CodeBlockActions></CodeBlockHeader>
                <CodeBlockContent wrap>{startCommand}</CodeBlockContent>
              </CodeBlock>
              <p>端口已占用时，用 <code>--port</code> 指定空闲端口，并同步修改服务地址。</p>
            </div>
          </CollapsibleContent></Collapsible>
        </form> : <div className="space-y-4">
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2.5">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="canvas-codex-model" className="text-xs font-medium">模型</Label>
              <ModelPicker id="canvas-codex-model" label="Codex 模型" value={agent.model} options={agent.models.map((model) => ({ value: model.model, label: model.displayName }))} onValueChange={agent.setModel} disabled={busy} />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="canvas-codex-effort" className="text-xs font-medium">思考强度</Label>
              <Select value={agent.effort} onValueChange={agent.setEffort} disabled={busy}><SelectTrigger id="canvas-codex-effort" ><SelectValue /></SelectTrigger><SelectContent>{selectedModel?.supportedReasoningEfforts.map((item) => <SelectItem key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</SelectItem>)}</SelectContent></Select>
            </div>
          </div>
          <Card className="p-3 gap-0">
            <p className="text-xs font-medium">MCP 画布连接</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">外部 MCP 修改画布时，需在此页面确认。配置方法见 canvas-agent/README.md。</p>
            <CodeBlockCopyButton size="sm" variant="outline" className="mt-2 w-full" value={agent.sessionId}>复制连接 ID</CodeBlockCopyButton>
          </Card>
          <div className="flex min-w-0 items-center justify-between gap-2 border-t pt-3">
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={endpoint}>{endpoint}</span>
            <Button type="button" size="sm" variant="ghost"  onClick={agent.disconnect}><Unplug  />断开</Button>
          </div>
        </div>}
        {agent.error ? <Alert variant="destructive" role="alert">{agent.error}</Alert> : null}
      </ScrollArea></PopoverContent>
    </Popover>
  </section>;
}
