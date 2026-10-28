import { ScrollArea } from "@/components/ui/scroll-area";
import { useState } from "react";
import { Check, ChevronDown, Circle, CircleHelp, Clock, LoaderCircle, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CanvasAgentAnswerInput } from "./canvas-agent-answer-input";
import { useCanvasAgentRecommendationCountdown } from "./use-canvas-agent-recommendation-countdown";
import type { CanvasAgentPlan, CanvasAgentQuestion } from "./agent/canvas-agent-types";

export function CanvasAgentQuestionRecord({ question, answer, cancelled }: { question: string; answer?: string; cancelled?: boolean }) {
  return <details data-agent-question-record open className="group/question w-full min-w-0 text-sm">
    <summary className="flex w-fit cursor-pointer list-none items-center gap-2 py-1 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden"><MessageSquare className="size-4" />{answer || cancelled ? "已询问" : "等待回答"}<ChevronDown className="size-3.5 transition-transform group-open/question:rotate-180" /></summary>
    <div className="mt-2 rounded-xl border border-border px-3 py-2.5 leading-6"><p className="whitespace-pre-wrap break-words text-muted-foreground">{question}</p>{answer || cancelled ? <p className="whitespace-pre-wrap break-words font-medium">{cancelled ? "已取消" : answer}</p> : null}</div>
  </details>;
}

export function CanvasAgentPlanProgress({ plan }: { plan?: CanvasAgentPlan }) {
  if (!plan) return null;
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const deferred = plan.steps.filter((step) => step.status === "deferred").length;
  return <details className="mb-2 shrink-0 rounded-lg bg-muted/30 px-3 py-2 text-xs" aria-label="Agent 执行计划">
    <summary className="cursor-pointer text-muted-foreground">执行计划 · {completed}/{plan.steps.length - deferred}{deferred ? ` · ${deferred} 项暂缓` : ""}{plan.steps.find((step) => step.status === "in_progress") ? ` · ${plan.steps.find((step) => step.status === "in_progress")!.title}` : ""}</summary>
    <ScrollArea className="mt-2 max-h-36" viewClass="space-y-2" viewportClassName="overscroll-contain pr-2">
      <ol className="space-y-2">{plan.steps.map((step) => <li key={step.id} className="flex items-start gap-2"><span className="mt-0.5 shrink-0" aria-label={{ pending: "待处理", in_progress: "进行中", completed: "已完成", deferred: "暂缓" }[step.status]}>{step.status === "completed" ? <Check className="size-3.5 text-brand" /> : step.status === "deferred" ? <Clock className="size-3.5 text-muted-foreground" /> : step.status === "in_progress" ? <Circle className="size-3.5 fill-brand/30 text-brand" /> : <Circle className="size-3.5 text-muted-foreground" />}</span><span className="min-w-0 break-words leading-5">{step.title}{step.status === "deferred" ? <span className="ml-2 text-muted-foreground">暂缓</span> : null}</span></li>)}</ol>
    </ScrollArea>
  </details>;
}

export function CanvasAgentQuestionCard({ question, busy, active, onAnswer, onCancel }: {
  question: CanvasAgentQuestion;
  busy: boolean;
  active: boolean;
  onAnswer: (answer: string) => void;
  onCancel?: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const recommended = question.options[0]?.trim();
  const countdown = useCanvasAgentRecommendationCountdown({ scope: question.id, enabled: active && !busy && Boolean(recommended), onAccept: () => {
    if (recommended) { setAnswer(recommended); onAnswer(recommended); }
  } });
  return <form aria-label="Agent 等待回答" className="flex min-h-0 flex-col rounded-xl border border-border bg-card p-3" onSubmit={(event) => { event.preventDefault(); if (answer.trim() && !busy) { countdown.stop(); onAnswer(answer.trim()); } }}>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-brand"><span className="flex items-center gap-2"><CircleHelp className="size-4" />{question.kind === "confirmation" ? "需要你确认" : "需要你补充信息"}</span>{countdown.seconds !== null ? <span role="timer" className="text-[11px] font-normal tabular-nums text-muted-foreground">{countdown.seconds} 秒后采用推荐</span> : null}</div>
    <ScrollArea className="min-h-0 max-h-[40cqh]" viewportClassName="pr-1">
    <p className="mt-2 text-sm leading-5">{question.question}</p>
    <div className="mt-3"><CanvasAgentAnswerInput options={question.options.map((label) => ({ label }))} value={answer} onChange={setAnswer} onSelect={onAnswer} onInteract={countdown.stop} disabled={busy} /></div>
    </ScrollArea>
    <div className="mt-3 flex justify-end gap-2">{onCancel ? <Button type="button" size="sm" variant="ghost" className="mr-auto" disabled={busy} onClick={() => { countdown.stop(); onCancel(); }}>取消</Button> : null}<Button type="submit" size="sm" disabled={busy || !answer.trim()}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}继续</Button></div>
  </form>;
}
