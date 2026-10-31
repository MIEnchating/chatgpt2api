import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Code2, LoaderCircle, MessageSquare, Square } from "lucide-react";
import type { VideoContractAgentDetail } from "@/lib/api";
import { videoContractToolLabels, videoContractToolSummary } from "@/lib/video-contract-agent-display";
import { cn } from "@/lib/utils";
import { AGENT_STEP_STATUS } from "@/components/agent/agent-step-status";
import { AgentDisclosureButton } from "@/components/agent/agent-disclosure";
import { AgentStepIcon } from "@/components/agent/agent-step-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function statusLabel(entry: VideoContractAgentDetail, running: boolean) {
  if (entry.status === "failed") return AGENT_STEP_STATUS.error.label;
  if (entry.status === "partial") return AGENT_STEP_STATUS.partial.label;
  if (entry.status === "running") return running ? AGENT_STEP_STATUS.running.label : AGENT_STEP_STATUS.interrupted.label;
  return AGENT_STEP_STATUS.success.label;
}

export function VideoContractAgentDetails({ entries, running }: { entries: VideoContractAgentDetail[]; running: boolean }) {
  const [open, setOpen] = useState(running);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [rawTab, setRawTab] = useState<"input" | "output">("output");
  const rootRef = useRef<HTMLElement>(null);
  const followOutputRef = useRef(true);
  const selected = entries.find(entry => entry.id === selectedID);
  const hasEntries = entries.length > 0;

  useEffect(() => { if (running) setOpen(true); }, [running]);

  useEffect(() => {
    const viewport = rootRef.current?.closest('[data-slot="dialog-body"]')?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const onScroll = () => { followOutputRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 64; };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [open, running, hasEntries]);

  useEffect(() => {
    if (!running || !open || selectedID || !followOutputRef.current) return;
    const viewport = rootRef.current?.closest('[data-slot="dialog-body"]')?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]');
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
  }, [entries, open, running, selectedID]);

  if (!hasEntries) return null;

  return (
    <>
      <section ref={rootRef} aria-label="执行详情" className="min-w-0 border-t border-border/70 pt-3">
        <AgentDisclosureButton expanded={open} onToggle={() => setOpen(value => !value)} className="py-1">
          <span className="font-medium">执行记录</span>
          <span className="flex-1">{entries.length} 条</span>
        </AgentDisclosureButton>
        {open ? <ol className="mt-2 divide-y divide-border/40" aria-label="执行记录列表">
          {entries.map(entry => {
            const pending = running && entry.status === "running";
            const interrupted = !running && entry.status === "running";
            const failed = entry.status === "failed";
            const Icon = pending ? LoaderCircle : failed || entry.status === "partial" || entry.kind === "correction" ? CircleAlert : interrupted ? Square : entry.kind === "model" ? MessageSquare : Check;
            const label = entry.kind === "model" ? (entry.round ? `模型第 ${entry.round} 轮` : "模型回复") : entry.kind === "correction" ? "工具格式纠正" : videoContractToolLabels[entry.name] || entry.name;
            return (
              <li key={entry.id} className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-2 py-3">
                <AgentStepIcon icon={Icon} status={pending ? "running" : failed ? "error" : entry.status === "partial" ? "partial" : interrupted ? "interrupted" : "success"} />
                <div className="min-w-0 space-y-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-xs font-medium">{label}</span>
                    {entry.kind === "model" && entry.request_attempt ? <span className="text-[11px] text-muted-foreground">第 {entry.request_attempt} 次请求</span> : null}
                    <span className={cn("text-[11px]", failed ? "text-destructive" : "text-muted-foreground")}>{statusLabel(entry, running)}</span>
                    {entry.kind === "tool" && (entry.input || entry.output) ? <button type="button" aria-label={`查看${label}的原始数据`} className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setRawTab(entry.output ? "output" : "input"); setSelectedID(entry.id); }}><Code2 className="size-3" />原始数据</button> : null}
                  </div>
                  {entry.kind === "tool" ? <p className={cn("break-words text-xs leading-5 [overflow-wrap:anywhere]", failed ? "text-destructive" : "text-muted-foreground")}>{videoContractToolSummary(entry)}</p> : entry.output || !entry.error ? <p className="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">{entry.output || entry.summary || (pending ? "正在接收回复…" : "本轮未返回文本")}{pending ? <span className="ml-1 inline-block h-3.5 w-1 animate-pulse bg-foreground/60 align-[-2px]" aria-label="正在接收" /> : null}</p> : null}
                  {entry.error ? <p className="whitespace-pre-wrap break-words text-xs leading-5 text-destructive [overflow-wrap:anywhere]">{entry.error}</p> : null}
                </div>
              </li>
            );
          })}
        </ol> : null}
      </section>
      <Dialog open={Boolean(selected)} onOpenChange={value => { if (!value) setSelectedID(null); }}>
        <DialogContent className="z-[70] w-[min(calc(100%-2rem),48rem)]" overlayClassName="z-[60]">
          <DialogHeader>
            <DialogTitle>{selected ? videoContractToolLabels[selected.name] || selected.name : "工具调用"} · 原始数据</DialogTitle>
            <DialogDescription>查看本次工具调用的参数和返回内容，敏感值已由服务端隐藏。</DialogDescription>
            <div className="flex gap-2 pt-2" role="group" aria-label="原始数据类型">
              <Button variant={rawTab === "input" ? "secondary" : "ghost"} size="sm" aria-pressed={rawTab === "input"} onClick={() => setRawTab("input")}>调用参数</Button>
              <Button variant={rawTab === "output" ? "secondary" : "ghost"} size="sm" aria-pressed={rawTab === "output"} onClick={() => setRawTab("output")}>执行结果</Button>
            </div>
          </DialogHeader>
          <pre className="min-w-0 whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-4 font-mono text-xs leading-6 [overflow-wrap:anywhere]">{selected?.[rawTab] || (rawTab === "input" ? "无调用参数" : "暂无执行结果")}</pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
