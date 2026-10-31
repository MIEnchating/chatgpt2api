import { ScrollArea } from "@/components/ui/scroll-area";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, Circle, CircleHelp, Clock, LoaderCircle, MessageSquare, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CanvasAgentAnswerInput } from "./canvas-agent-answer-input";

import type { CanvasAgentPlan, CanvasAgentQuestion } from "./agent/canvas-agent-types";

export function CanvasAgentQuestionRecord({ question, answer, cancelled }: { question: string; answer?: string; cancelled?: boolean }) {
  return <details data-agent-question-record open className="group/question w-full min-w-0 text-sm">
    <summary className="flex w-fit cursor-pointer list-none items-center gap-2 py-1 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden"><MessageSquare className="size-4" />{answer || cancelled ? "已询问" : "等待回答"}<ChevronDown className="size-3.5 transition-transform group-open/question:rotate-180" /></summary>
    <div className="mt-2 rounded-xl border border-border/60 px-3 py-2.5 leading-6"><p className="whitespace-pre-wrap break-words text-muted-foreground">{question}</p>{answer || cancelled ? <p className="whitespace-pre-wrap break-words font-medium">{cancelled ? "已取消" : answer}</p> : null}</div>
  </details>;
}

export function CanvasAgentPlanProgress({ plan, running = false }: { plan?: CanvasAgentPlan; running?: boolean }) {
  const [dismissedPlan, setDismissedPlan] = useState("");
  const planKey = JSON.stringify(plan);
  useEffect(() => { if (running) setDismissedPlan(""); }, [running]);
  if (!plan) return null;
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const deferred = plan.steps.filter((step) => step.status === "deferred").length;
  const executing = running && plan.steps.some((step) => step.status === "in_progress");
  const complete = plan.steps.length > 0 && completed + deferred === plan.steps.length && !running;
  if (complete && dismissedPlan === planKey) return null;
  return <div className="relative shrink-0" data-agent-plan><details className="group/plan mb-2 shrink-0 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5 pr-9 text-xs" aria-label="Agent 执行计划">
    <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">{executing ? <LoaderCircle data-agent-plan-loading className="size-3.5 shrink-0 animate-spin text-brand" /> : <Sparkles className="size-3.5 shrink-0 text-brand" />}<span className="min-w-0 flex-1 truncate font-medium">{plan.steps.find((step) => step.status === "in_progress")?.title || (completed === plan.steps.length - deferred ? "计划已完成" : "接下来的安排")}</span><span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{completed}/{plan.steps.length - deferred}</span><ChevronDown className="size-3 transition-transform group-open/plan:rotate-180" /></summary>
    <div className="mt-2 flex gap-1" aria-label={`已完成 ${completed} 项，共 ${plan.steps.length - deferred} 项`}>{plan.steps.map((step) => <span key={step.id} className={`h-1 min-w-0 flex-1 rounded-full ${step.status === "completed" ? "bg-brand" : step.status === "in_progress" ? executing ? "bg-brand/45 motion-safe:animate-pulse" : "bg-brand/45" : "bg-border/70"}`} />)}</div>
    <ScrollArea native className="mt-2 max-h-36" viewClass="space-y-2" viewportClassName="overscroll-contain pr-2">
      <ol className="space-y-2">{plan.steps.map((step) => <li key={step.id} className="flex items-start gap-2"><span className="mt-0.5 shrink-0" aria-label={step.status === "in_progress" && !running ? "待继续" : { pending: "待处理", in_progress: "进行中", completed: "已完成", deferred: "暂缓" }[step.status]}>{step.status === "completed" ? <Check className="size-3.5 text-brand" /> : step.status === "deferred" ? <Clock className="size-3.5 text-muted-foreground" /> : step.status === "in_progress" ? running ? <LoaderCircle className="size-3.5 animate-spin text-brand" /> : <Circle className="size-3.5 fill-brand/30 text-brand" /> : <Circle className="size-3.5 text-muted-foreground" />}</span><span className="min-w-0 break-words leading-5">{step.title}{step.status === "deferred" ? <span className="ml-2 text-muted-foreground">暂缓</span> : null}</span></li>)}</ol>
    </ScrollArea>
  </details>{complete ? <button type="button" aria-label="关闭已完成计划" title="关闭已完成计划" className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setDismissedPlan(planKey)}><X className="size-3.5" /></button> : null}</div>;
}

export function CanvasAgentQuestionCard({ question, busy, active: _active, onAnswer, onCancel }: {
  question: CanvasAgentQuestion;
  busy: boolean;
  active: boolean;
  onAnswer: (answer: string) => boolean;
  onCancel?: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [submittedAnswer, setSubmittedAnswer] = useState("");
  const submitting = useRef(false);
  useEffect(() => {
    if (!busy) { submitting.current = false; setSubmittedAnswer(""); }
  }, [busy]);
  function respond(value: string) {
    if (busy || submitting.current || !value.trim()) return;
    submitting.current = true;
    setAnswer(value.trim());
    try {
      if (onAnswer(value.trim())) setSubmittedAnswer(value.trim());
      else submitting.current = false;
    } catch (error) {
      submitting.current = false;
      throw error;
    }
  }
  if (submittedAnswer) return <div data-agent-answer-submitted role="status" className="flex min-w-0 items-center gap-2 px-1 py-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 shrink-0 animate-spin" /><span className="shrink-0">正在继续</span><span className="min-w-0 truncate" title={submittedAnswer}>已回答：{submittedAnswer}</span></div>;
  const isWorkflowReview = question.purpose === "workflow_review";
  const isMediaGeneration = question.purpose === "media_generation";
  const title = isWorkflowReview ? "先审核系列提示词" : isMediaGeneration ? "准备开始生成" : question.kind === "confirmation" ? "这一步，由你决定" : "先对齐一个细节";
  const subtitle = isWorkflowReview ? "检查并确认后，Agent 才会提交生成" : isMediaGeneration ? "确认后提交媒体任务，也可以暂缓" : question.kind === "confirmation" ? "确认后继续执行" : "你的选择，会决定接下来的创作";
  return <form aria-label="Agent 等待回答" className="relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-brand/20 bg-gradient-to-b from-brand-soft/50 via-card to-card shadow-[0_4px_24px_-12px_var(--color-brand)]" onSubmit={(event) => { event.preventDefault(); respond(answer); }}>
    <div className="flex shrink-0 items-center gap-2.5 px-3 pb-1 pt-3"><span className="grid size-8 place-items-center rounded-xl bg-brand/10 text-brand"><CircleHelp className="size-4" /></span><div><p className="text-xs font-semibold">{title}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{subtitle}</p></div></div>
    <ScrollArea native data-agent-question-scroll className="min-h-0 max-h-[40cqh]" viewportClassName="px-3 pr-5">
    <p className="mt-2 text-sm font-medium leading-6">{question.question}</p>
    {question.reason ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{question.reason}</p> : null}
    {question.options.length ? <p className="mt-2 text-[11px] text-muted-foreground">点击一个选项即可回答并继续</p> : null}
    <div className="mt-3"><CanvasAgentAnswerInput options={question.options.map((label) => ({ label }))} value={answer} onChange={setAnswer} onSelect={respond} disabled={busy} /></div>
    </ScrollArea>
    <div className="flex shrink-0 items-center justify-end gap-2 p-3 pt-2">{onCancel ? <Button type="button" size="sm" variant="ghost" className="mr-auto" disabled={busy} onClick={() => { onCancel(); }}>取消本次请求</Button> : null}{(!question.options.length || answer.trim()) ? <Button type="submit" size="sm" disabled={busy || !answer.trim()}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}发送回答<ArrowRight className="size-3.5" /></Button> : null}</div>
  </form>;
}
