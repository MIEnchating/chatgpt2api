import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CanvasCodexAnswer, CanvasCodexApproval } from "./canvas-codex-agent";

type PendingApproval = CanvasCodexApproval & { resolve: (answer: CanvasCodexAnswer) => void };
export function useCanvasCodexApproval() {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const pendingRef = useRef<PendingApproval | null>(null);
  function settle(answer: CanvasCodexAnswer) { const current = pendingRef.current; pendingRef.current = null; setPending(null); current?.resolve(answer); }
  useEffect(() => () => { pendingRef.current?.resolve({ accepted: false }); pendingRef.current = null; }, []);
  function ask(approval: CanvasCodexApproval, signal: AbortSignal): Promise<CanvasCodexAnswer> {
    if (signal.aborted) return Promise.resolve({ accepted: false });
    pendingRef.current?.resolve({ accepted: false });
    return new Promise((resolve) => {
      const cancel = () => { if (pendingRef.current === request) { pendingRef.current = null; setPending(null); } request.resolve({ accepted: false }); };
      const request: PendingApproval = { ...approval, resolve: (answer) => { signal.removeEventListener("abort", cancel); resolve(answer); } };
      pendingRef.current = request; setPending(request); setAnswers({});
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  const dialog = <Dialog open={!!pending} onOpenChange={(open) => !open && settle({ accepted: false })}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{pending?.title || "Codex 请求确认"}</DialogTitle><DialogDescription>确认当前请求后，Codex 才会继续操作。</DialogDescription></DialogHeader>
    {pending?.questions ? pending.questions.map((question) => <fieldset key={question.id} className="space-y-2"><legend className="text-sm font-medium">{question.question}</legend>{question.options?.map((option) => <Button key={option.label} size="sm" variant={answers[question.id] === option.label ? "secondary" : "outline"} className="mr-2 h-auto whitespace-normal py-2 text-left" title={option.description} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}>{option.label}</Button>)}<input aria-label={question.question} className="h-9 w-full rounded border bg-background px-2 text-sm" placeholder="输入补充信息" value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} /></fieldset>) : <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{pending?.details}</pre>}
    <DialogFooter><Button variant="outline" onClick={() => settle({ accepted: false })}>拒绝</Button><Button disabled={!!pending?.questions?.some((question) => !answers[question.id]?.trim())} onClick={() => settle({ accepted: true, answers })}>确认</Button></DialogFooter>
  </DialogContent></Dialog>;
  return { ask, dialog };
}
