import { useRef, useState } from "react";
import { useAgentExecution } from "@/components/agent/use-agent-execution";
import { Confirmation } from "@/components/ai-elements/confirmation";
import { RunStatus } from "@/components/ai-elements/run-status";
import { Task } from "@/components/ai-elements/task";
import { Tool, ToolDetails, type ToolState } from "@/components/ai-elements/tool";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputFooter, PromptInputSubmit } from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { InputGroupTextarea } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TraceLine, TraceTitle } from "@/components/ui/trace";
import { httpRequest } from "@/lib/request";
import { resumeAgentExecution } from "@/lib/agent-executions";
import type { StudioAgentResult } from "@/lib/studio-agent";

export function StudioAgentProcess({ runId, needsResult, onResume }: { runId: string; needsResult: boolean; onResume: () => void }) {
  const { run, error, refresh } = useAgentExecution<StudioAgentResult>("studio", false, () => undefined, runId);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const question = run?.status === "waiting" ? run.result?.question : undefined;
  async function resume() {
    if (pendingRef.current || question && !answer.trim()) return;
    pendingRef.current = true;
    setBusy(true); setActionError("");
    try {
      if (question) {
        await httpRequest(`/api/agent-runs?id=${encodeURIComponent(runId)}`, { method: "POST", body: { callId: question.callId, answer: answer.trim() } });
        setAnswer("");
      } else await resumeAgentExecution(runId);
      onResume(); refresh();
    } catch (failure) { setActionError(failure instanceof Error ? failure.message : "继续任务失败"); }
    finally { pendingRef.current = false; setBusy(false); }
  }
  if (!run) return error ? <Alert variant="destructive"><AlertDescription>{error}<Button size="sm" variant="outline" onClick={refresh}>重新读取</Button></AlertDescription></Alert> : null;
  return <section aria-label="智能生成执行过程" className="min-w-0 space-y-3">
    <RunStatus status={run.status} description={run.error}>
      {run.status === "success" && needsResult ? <Button size="sm" variant="outline" onClick={onResume}>读取已完成结果</Button> : null}
      {!["running", "success"].includes(run.status) && !question ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void resume()}>继续任务</Button> : null}
    </RunStatus>
    {run.events.length ? <Task status={run.status} timingLabel="更新于" timing={new Date(run.updatedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" })}>
      {run.events.filter(event => event.stage !== "generating").map((event, index) => {
        const key = String(event.sequence ?? index);
        const text = typeof event.message === "string" ? event.message : "处理任务";
        if (event.stage === "assistant") return <Message key={key} from="assistant"><MessageContent><MessageResponse>{text}</MessageResponse></MessageContent></Message>;
        if (event.stage !== "tool") return <TraceLine key={key} status={event.status === "error" ? "error" : undefined}><TraceTitle className="whitespace-pre-wrap break-words">{text}</TraceTitle></TraceLine>;
        let state: ToolState = "pending";
        if (event.status === "error") state = "output-error";
        else if (event.status === "success") state = "output-available";
        else if (event.status === "running") {
          if (run.status === "running") state = "input-available";
          else if (run.status !== "waiting") state = "output-denied";
        }
        return <Tool key={key} title={text} state={state} statusLabel={state === "output-denied" ? run.status === "cancelled" ? "已停止" : "已中断" : undefined}>
          {event.input !== undefined || event.output !== undefined ? <ToolDetails name={typeof event.tool === "string" ? event.tool : ""} input={event.input} output={event.output} /> : null}
        </Tool>;
      })}
    </Task> : null}
    {question ? <Confirmation title={question.text} busy={busy}>
      <form className="flex w-full min-w-0 flex-col gap-2" onSubmit={event => { event.preventDefault(); void resume(); }}>
        <PromptInput>
          <InputGroupTextarea value={answer} onChange={event => setAnswer(event.target.value)} aria-label="回答 Agent" maxLength={12000} disabled={busy} />
          <PromptInputFooter>
            <PromptInputSubmit type="submit" size="sm" disabled={busy || !answer.trim()} aria-busy={busy}>{busy ? <Spinner aria-hidden="true" /> : null}回答并继续</PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
      </form>
    </Confirmation> : null}
    {error || actionError ? <Alert variant="destructive"><AlertDescription>{actionError || error}</AlertDescription></Alert> : null}
  </section>;
}
