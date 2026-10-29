import { CircleAlert, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CanvasAssistantSession } from "./agent/canvas-agent-types";
import type { CanvasDocument } from "@/services/api/canvas";

export function CanvasAgentResumeNotice({ session, run, busy, onResume }: {
  session: CanvasAssistantSession;
  run?: CanvasDocument["agent_run"];
  busy: boolean;
  onResume: () => void;
}) {
  const latest = session.messages.findLast((message) => message.role === "assistant");
  const matchingRun = run?.sessionId === session.id && run.assistantId === latest?.id ? run : undefined;
  if (busy || !latest || session.agentState.pendingQuestion) return null;
  const failed = latest.status === "error" || matchingRun?.status === "error";
  const interrupted = matchingRun?.status === "interrupted";
  const incomplete = latest.status === "waiting" && session.agentState.plan?.steps.some((step) => step.status === "pending" || step.status === "in_progress");
  if (!failed && !interrupted && !incomplete) return null;
  const reason = matchingRun?.error || (failed ? latest.text : "");
  return <div data-agent-resume-notice role="status" className="mb-2 shrink-0 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs">
    <div className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" /><div className="min-w-0 flex-1"><p className="font-medium">{failed ? "任务遇到错误，尚未完成" : interrupted ? "服务重启，任务已暂停" : "任务已暂停，仍有步骤未完成"}</p>{reason ? <p className="mt-1 max-h-20 overflow-auto break-words leading-5 text-muted-foreground">{reason}</p> : null}<p className="mt-1 leading-5 text-muted-foreground">已有结果已保留，继续时会先核对执行记录和剩余步骤。</p></div></div>
    <Button type="button" size="sm" variant="outline" className="mt-2 w-full" onClick={onResume}><Play className="size-3.5" />继续未完成任务</Button>
  </div>;
}
