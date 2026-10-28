import { ScrollArea } from "@/components/ui/scroll-area";
import { useEffect, useRef, useState } from "react";
import { CanvasAgentAnswerInput } from "../canvas-agent-answer-input";
import { useCanvasAgentRecommendationCountdown } from "../use-canvas-agent-recommendation-countdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CanvasCodexAnswer, CanvasCodexApproval } from "./canvas-codex-agent";

type PendingApproval = CanvasCodexApproval & { resolve: (answer: CanvasCodexAnswer) => void };
export function useCanvasCodexApproval() {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const pendingRef = useRef<PendingApproval | null>(null);
  const countdown = useCanvasAgentRecommendationCountdown({ scope: pending, enabled: Boolean(pending?.questions?.length && pending.questions.every((question) => question.options?.[0]?.label.trim())), onAccept: () => {
    if (!pending || pendingRef.current !== pending || !pending.questions) return;
    settle({ accepted: true, answers: Object.fromEntries(pending.questions.map((question) => [question.id, question.options![0].label.trim()])) });
  } });
  function settle(answer: CanvasCodexAnswer) { countdown.stop(); const current = pendingRef.current; pendingRef.current = null; setPending(null); current?.resolve(answer); }
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
  const dialog = <Dialog open={!!pending} onOpenChange={(open) => !open && settle({ accepted: false })}><DialogContent className="max-h-[85dvh] sm:max-w-xl"><DialogHeader><DialogTitle>{pending?.title || "Codex 请求确认"}</DialogTitle><DialogDescription>确认当前请求后，Codex 才会继续操作。</DialogDescription></DialogHeader>
    {countdown.seconds !== null ? <p role="timer" className="text-xs tabular-nums text-muted-foreground">{countdown.seconds} 秒后采用推荐</p> : null}
    {pending?.questions ? pending.questions.map((question) => <fieldset key={question.id} className="space-y-2"><legend className="text-sm font-medium">{question.question}</legend><CanvasAgentAnswerInput options={question.options || []} value={answers[question.id] || ""} onChange={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))} onSelect={(value) => {
      const next = { ...answers, [question.id]: value };
      setAnswers(next);
      if (pending.questions?.every((item) => next[item.id]?.trim())) settle({ accepted: true, answers: next });
    }} onInteract={countdown.stop} label={question.question} /></fieldset>) : <ScrollArea className="max-h-80 rounded bg-muted text-xs" viewClass="whitespace-pre-wrap break-all p-3" tag="pre">{pending?.details}</ScrollArea>}
    <DialogFooter><Button variant="outline" onClick={() => settle({ accepted: false })}>拒绝</Button><Button disabled={!!pending?.questions?.some((question) => !answers[question.id]?.trim())} onClick={() => settle({ accepted: true, answers })}>确认</Button></DialogFooter>
  </DialogContent></Dialog>;
  return { ask, dialog };
}
