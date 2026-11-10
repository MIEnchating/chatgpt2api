import { Conversation } from "@/components/ai-elements/conversation";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import type { VideoContractAgentDetail } from "@/lib/api";
import { videoContractToolLabels, videoContractToolSummary } from "@/lib/video-contract-agent-display";
import { ChainOfThought } from "@/components/ai-elements/chain-of-thought";
import { Tool, ToolDetails, type ToolState } from "@/components/ai-elements/tool";
import { Message, MessageContent, MessageHeader, MessageResponse } from "@/components/ai-elements/message";
import { Trace, TraceDescription, TraceLine, TraceTitle } from "@/components/ui/trace";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AGENT_STEP_STATUS } from "@/components/agent/agent-step-status";

function entryState(entry: VideoContractAgentDetail, running: boolean): { state: ToolState; label: string } {
  if (entry.status === "failed") return { state: "output-error", label: AGENT_STEP_STATUS.error.label };
  if (entry.status === "partial") return { state: "output-error", label: AGENT_STEP_STATUS.partial.label };
  if (entry.status === "running") return running ? { state: "input-available", label: AGENT_STEP_STATUS.running.label } : { state: "output-denied", label: AGENT_STEP_STATUS.interrupted.label };
  return { state: "output-available", label: AGENT_STEP_STATUS.success.label };
}

export function VideoContractAgentDetails({ entries, running }: { entries: VideoContractAgentDetail[]; running: boolean }) {
  const hasEntries = entries.length > 0;
  if (!hasEntries) return null;
  const latest = entries.at(-1);
  return <section aria-label="执行详情" className="min-w-0">
    <ChainOfThought title="执行记录" active={running} failed={latest?.status === "failed" || latest?.status === "partial"} completed={entries.filter(entry => entry.status === "completed").length} total={entries.length}>
      <Conversation aria-label="执行输出" className="h-[min(24rem,45dvh)] flex-none" contentClassName="p-1">
      {entries.map(entry => {
        const { state, label } = entryState(entry, running);
        const title = entry.kind === "model" ? (entry.round ? `模型第 ${entry.round} 轮` : "模型回复") : entry.kind === "correction" ? "工具格式纠正" : videoContractToolLabels[entry.name] || entry.name;
        const attempt = entry.request_attempt ? <p className="text-xs">第 {entry.request_attempt} 次请求</p> : null;
        const error = entry.error ? <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap break-words">{entry.error}</AlertDescription></Alert> : null;
        if (entry.kind === "model") return <MessageScrollerItem key={entry.id} messageId={entry.id}>
          <Message from="assistant" aria-busy={state === "input-available"}>
            <MessageContent>
              <MessageHeader className="flex-wrap gap-2 px-0"><span>{title}</span><span role="status">{label}</span></MessageHeader>
              {attempt}
              <MessageResponse>{entry.output || entry.summary || (state === "input-available" ? "正在接收回复…" : "本轮未返回文本")}</MessageResponse>
              {error}
            </MessageContent>
          </Message>
        </MessageScrollerItem>;
        if (entry.kind === "correction") return <MessageScrollerItem key={entry.id} messageId={entry.id}>
          <Trace>
            <TraceLine status={state === "input-available" ? "running" : state === "output-error" ? "error" : state === "output-denied" ? "pending" : undefined}><TraceTitle>{title}</TraceTitle><TraceDescription>{label}</TraceDescription></TraceLine>
            {attempt}
            {entry.output || entry.summary ? <MessageResponse>{entry.output || entry.summary}</MessageResponse> : null}
            {error}
          </Trace>
        </MessageScrollerItem>;
        return <MessageScrollerItem key={entry.id} messageId={entry.id}><Tool title={title} state={state} statusLabel={label}>
          {attempt}
          <p className="mb-2 break-words text-sm">{videoContractToolSummary(entry)}</p>
          <ToolDetails name={entry.name} input={entry.input} output={entry.output} />
          {error}
        </Tool></MessageScrollerItem>;
      })}
      </Conversation>
    </ChainOfThought>
  </section>;
}
