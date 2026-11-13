import { Spinner } from "@/components/ui/spinner";
import { RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LoadingState } from "@/components/ui/loading-state";
import { RunStatus } from "@/components/ai-elements/run-status";
import { Task } from "@/components/ai-elements/task";
import { Trace, TraceLine, TraceTitle } from "@/components/ui/trace";
import { useAgentExecution } from "./use-agent-execution";
import type { AgentExecutionDomain } from "@/lib/agent-executions";

export function AgentExecutionRecovery<TResult>({ domain, busy, activeID, onResult }: { domain: AgentExecutionDomain; busy: boolean; activeID?: string; onResult: (result: TResult) => void }) {
  const { run, loading, action, error, refresh, stop, continueRun } = useAgentExecution(domain, busy && !activeID, onResult, busy ? activeID : undefined);
  if (busy && !activeID) return null;
  if (!run) {
    if (error) return <Alert variant="destructive"><AlertDescription>{error}<Button variant="outline" size="sm" onClick={refresh}>重新读取进度</Button></AlertDescription></Alert>;
    return busy ? <LoadingState label="正在连接任务进度" className="min-h-0 py-3" /> : null;
  }
  const active = action !== "idle";
  const event = run.events.at(-1);
  return <section data-agent-execution-recovery className="min-w-0 space-y-3" aria-label="后台任务">
    <RunStatus status={run.status} stopping={action === "stopping"} title={run.status === "success" ? "已保存的 Agent 草稿" : undefined} description={error || run.error || (typeof event?.message === "string" ? event.message : undefined)}>
      {run.status === "running" ? <Button type="button" size="sm" variant="outline" disabled={action === "stopping"} onClick={stop}><Square />停止</Button> : null}
      {!busy ? <Button type="button" size="sm" disabled={active || loading} onClick={continueRun}>{active ? <Spinner /> : <RotateCcw />}{run.status === "success" ? "查看草稿" : run.status === "running" ? "查看进度" : "继续任务"}</Button> : null}
      {error ? <Button type="button" size="sm" variant="outline" disabled={active} onClick={refresh}>重新读取进度</Button> : null}
    </RunStatus>
    {run.events.length ? <Task status={run.status} timingLabel="更新于" timing={new Date(run.updatedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" })}>
      <Trace role="list" aria-label="后台执行记录">{run.events.map((entry, index) => <TraceLine key={index} role="listitem"><TraceTitle className="whitespace-pre-wrap break-words">{typeof entry.message === "string" ? entry.message : typeof entry.type === "string" ? entry.type : "任务进度已保存"}</TraceTitle></TraceLine>)}</Trace>
    </Task> : null}
  </section>;
}
