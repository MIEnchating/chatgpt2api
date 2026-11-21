import { Card } from "@/components/ui/card";
import { Plan, type PlanStep } from "@/components/ai-elements/plan";
import { RunStatus } from "@/components/ai-elements/run-status";
import { useNow } from "@/lib/use-now";
import { VIDEO_CONTRACT_IMPORT_STEPS, type VideoContractImportActivity } from "@/lib/video-contract-agent-progress";

function ImportElapsedTime({ running, startedAt, endedAt }: { running: boolean; startedAt: number; endedAt: number }) {
  const now = useNow(running);
  const seconds = Math.max(0, Math.floor(((running ? now : endedAt) - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  const elapsed = minutes > 0 ? `${minutes}分${String(remaining).padStart(2, "0")}秒` : `${remaining}秒`;
  return <span className="tabular-nums">已用时 {elapsed}</span>;
}

export function VideoContractImportProgress({ activity, running, error, startedAt, endedAt }: {
  activity: VideoContractImportActivity;
  running: boolean;
  error: string;
  startedAt: number;
  endedAt: number;
}) {
  const complete = VIDEO_CONTRACT_IMPORT_STEPS.every((_, index) => activity.completedSteps.includes(index));
  const status = running ? "running" : error ? "error" : complete ? "success" : "interrupted";
  const steps: PlanStep[] = VIDEO_CONTRACT_IMPORT_STEPS.map((title, index) => ({
    id: String(index), title,
    status: activity.completedSteps.includes(index) ? "completed" : running && activity.step === index ? "in_progress" : "pending",
  }));
  return <Card aria-label="契约生成进度" className="gap-3 p-4">
    <RunStatus status={status} description={error || activity.message} />
    <Plan steps={steps} explanation="" running={running} />
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <ImportElapsedTime running={running} startedAt={startedAt} endedAt={endedAt} />
      <span>{activity.connected ? "已收到服务端进度" : "等待服务端建立连接"}</span>
      {activity.attempt ? <span>模型第 {activity.attempt} 轮{activity.max_attempts ? `（最多 ${activity.max_attempts} 轮）` : ""}</span> : null}
      {activity.request_attempt && activity.request_attempt > 1 ? <span>本轮第 {activity.request_attempt}/{activity.max_request_attempts} 次请求</span> : null}
      {activity.received_characters ? <span>本次请求已接收 {activity.received_characters} 字符</span> : null}
    </div>
  </Card>;
}
