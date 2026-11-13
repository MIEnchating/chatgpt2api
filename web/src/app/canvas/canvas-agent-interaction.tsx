import { Spinner } from "@/components/ui/spinner";
import { Confirmation } from "@/components/ai-elements/confirmation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { CanvasAgentAnswerInput } from "./canvas-agent-answer-input";

import type { CanvasAgentQuestion } from "./agent/canvas-agent-types";

export function CanvasAgentQuestionRecord({ question, answer, cancelled }: { question: string; answer?: string; cancelled?: boolean }) {
  return <Message from="user" data-agent-question-record><MessageContent>
    <Bubble align="end" variant="muted" className="max-w-[84%]">
    <BubbleContent className="w-full space-y-1.5">
      <p data-agent-question-prompt className="whitespace-pre-wrap break-words text-muted-foreground">{question}</p>
      {answer ? <p data-agent-question-answer className="whitespace-pre-wrap font-medium text-foreground">{answer}</p> : cancelled ? <p className="text-foreground">已取消</p> : <p className="text-muted-foreground">等待回答</p>}
    </BubbleContent>
    </Bubble>
  </MessageContent></Message>;
}

export function CanvasAgentQuestionCard({ question, busy, active: _active, onAnswer, onCancel }: {
  question: CanvasAgentQuestion;
  busy: boolean;
  active: boolean;
  onAnswer: (answer: string) => boolean;
  onCancel?: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    if (!busy) { submitting.current = false; setSubmitted(false); }
  }, [busy]);
  const sending = busy || submitted;
  function respond(value: string) {
    if (busy || submitting.current || !value.trim()) return;
    submitting.current = true;
    try {
      if (onAnswer(value.trim())) setSubmitted(true);
      else submitting.current = false;
    } catch (error) {
      submitting.current = false;
      throw error;
    }
  }
  return <ScrollAreaRoot data-agent-question-scroll data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full shrink flex-col overflow-hidden max-h-[45cqh]" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0 pr-2">
    <Confirmation title={question.kind === "confirmation" ? "需要确认" : "问题"} confirmation={question.kind === "confirmation"} busy={sending} actions={onCancel ? <Button type="button" size="icon-xs" variant="ghost" aria-label="关闭问题" disabled={sending} onClick={onCancel}><X /></Button> : null}>
    <div className="w-full min-w-0 px-3 pb-1">
    {question.reason ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{question.reason}</p> : null}
    <p className="mt-2 whitespace-pre-wrap break-words text-sm font-medium leading-6">{question.question}</p>
    <div className="mt-3"><CanvasAgentAnswerInput options={question.options.map((label) => ({ label }))} value={answer} onChange={setAnswer} onSelect={respond} disabled={sending} actions={<>
      {onCancel ? <Button type="button" variant="ghost" disabled={sending} onClick={onCancel}>取消</Button> : null}
      <Button type="button" onClick={() => respond(answer)} aria-busy={sending} disabled={sending || !answer.trim()}>{sending ? <Spinner aria-hidden="true" /> : <ArrowRight />}发送</Button>
    </>} /></div>
    </div></Confirmation>
    </div></ScrollAreaViewport><ScrollBar /></ScrollAreaRoot>;
}
