
import { FieldSet, FieldLegend } from "@/components/ui/field";
import { Confirmation } from "@/components/ai-elements/confirmation";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useEffect, useRef, useState } from "react";
import { CanvasAgentAnswerInput } from "../canvas-agent-answer-input";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CanvasCodexAnswer, CanvasCodexApproval } from "./canvas-codex-agent";

type PendingApproval = CanvasCodexApproval & { resolve: (answer: CanvasCodexAnswer) => void };
export function useCanvasCodexApproval() {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const pendingRef = useRef<PendingApproval | null>(null);
  function settle(answer: CanvasCodexAnswer) { const current = pendingRef.current; pendingRef.current = null; setPending(null); current?.resolve(answer); }
  useEffect(() => () => { pendingRef.current?.resolve({ accepted: false }); pendingRef.current = null; }, []);
  function ask(approval: CanvasCodexApproval, signal: AbortSignal): Promise<CanvasCodexAnswer> {
    if (signal.aborted) return Promise.resolve({ accepted: false });
    pendingRef.current?.resolve({ accepted: false });
    return new Promise((resolve) => {
      const cancel = () => { if (pendingRef.current === request) { pendingRef.current = null; setPending(null); } request.resolve({ accepted: false }); };
      const request: PendingApproval = { ...approval, resolve: (answer) => { signal.removeEventListener("abort", cancel); resolve(answer); } };
      pendingRef.current = request; setPending(request); setAnswers({}); setDrafts({});
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  const dialog = pending ? (
    <Dialog open={!!pending} onOpenChange={(open) => !open && settle({ accepted: false })}>
      <DialogContent className="max-h-[85dvh] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{pending?.questions ? pending.title : "Codex 请求确认"}</DialogTitle>
          <DialogDescription>
            确认当前请求后，Codex 才会继续操作。
            {pending?.questions ? "你也可以直接输入自己的答案。" : "请先核对下方操作详情。"}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea data-slot="dialog-body" className="min-h-0 min-w-0 flex-1" contentClassName="grid gap-4 py-1">
          {pending?.questions ? <>
            {pending.description ? (
              <ScrollArea className="max-h-56" contentClassName="whitespace-pre-wrap break-words p-3">
                {pending.description}
              </ScrollArea>
            ) : null}
            {pending.questions.map((question) => (
              <FieldSet key={question.id} className="space-y-2">
                <FieldLegend variant="label">{question.question}</FieldLegend>
                <CanvasAgentAnswerInput
                  options={question.options || []}
                  value={drafts[question.id] || ""}
                  onChange={(value) => {
                    setDrafts((current) => ({ ...current, [question.id]: value }));
                    setAnswers((current) => ({ ...current, [question.id]: value }));
                  }}
                  onSelect={(value) => {
                    const next = { ...answers, [question.id]: value };
                    setAnswers(next);
                    if (pending.questions?.every((item) => next[item.id]?.trim())) {
                      settle({ accepted: true, answers: next });
                    }
                  }}
                  label={question.question}
                />
              </FieldSet>
            ))}
          </> : (
            <Confirmation
              confirmation
              title={pending?.title || "确认当前操作"}
              actions={<>
                <Button type="button" size="sm" variant="outline" onClick={() => settle({ accepted: false })}>拒绝</Button>
                <Button type="button" size="sm" onClick={() => settle({ accepted: true, answers })}>确认</Button>
              </>}
            >
              <div className="w-full min-w-0 space-y-3">
                {pending?.description ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{pending.description}</p> : null}
                <ScrollArea className="max-h-80">
                  <CodeBlock><CodeBlockContent wrap>{pending?.details}</CodeBlockContent></CodeBlock>
                </ScrollArea>
              </div>
            </Confirmation>
          )}
        </ScrollArea>
        {pending?.questions ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => settle({ accepted: false })}>拒绝</Button>
            <Button type="button" disabled={pending.questions.some((question) => !answers[question.id]?.trim())} onClick={() => settle({ accepted: true, answers })}>确认</Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  ) : null;
  return { ask, dialog };
}
