import { Check, CircleAlert, LoaderCircle, Square } from "lucide-react";
import { VIDEO_CONTRACT_IMPORT_STEPS, type VideoContractImportActivity } from "@/lib/video-contract-agent-progress";
import { cn } from "@/lib/utils";

export function VideoContractImportProgress({ activity, running, error, elapsed }: {
  activity: VideoContractImportActivity;
  running: boolean;
  error: string;
  elapsed: string;
}) {
  const stopped = !running && Boolean(error);
  const StatusIcon = running ? LoaderCircle : stopped ? CircleAlert : Check;
  return (
    <section aria-label="契约生成进度" className="space-y-4 rounded-xl border border-border/80 bg-muted/15 p-4">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>共 {VIDEO_CONTRACT_IMPORT_STEPS.length} 步 · {activity.completedSteps.length} 步已完成</span>
        <span className="shrink-0 tabular-nums">已用时 {elapsed}</span>
      </div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="分析步骤">
        {VIDEO_CONTRACT_IMPORT_STEPS.map((label, index) => {
          const active = activity.step === index;
          const done = activity.completedSteps.includes(index);
          return (
            <li key={label} aria-current={active ? "step" : undefined} className={cn("flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-xs", active ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground")}>
              <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums", active ? "border-primary/40 text-primary" : "border-border", done && "border-emerald-600/25 text-emerald-600")}>
                {done ? <Check className="size-3" aria-label="已完成" /> : index + 1}
              </span>
              <span>{label}</span>
            </li>
          );
        })}
      </ol>
      <div role={stopped ? "alert" : "status"} className="flex items-start gap-2.5 border-t border-border/70 pt-3">
        <StatusIcon className={cn("mt-0.5 size-4 shrink-0", running && "animate-spin text-primary", stopped && "text-destructive")} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">{stopped ? "停在" : "当前"}第 {activity.step + 1} 步 · {VIDEO_CONTRACT_IMPORT_STEPS[activity.step]}</p>
          <p className="break-words text-xs leading-5 text-muted-foreground">{error || activity.message}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{activity.connected ? "已收到服务端进度" : "等待服务端建立连接"}</span>
            {activity.attempt ? <span>模型第 {activity.attempt} 轮{activity.max_attempts ? `（最多 ${activity.max_attempts} 轮）` : ""}</span> : null}
            {activity.request_attempt && activity.request_attempt > 1 ? <span>本轮第 {activity.request_attempt}/{activity.max_request_attempts} 次请求</span> : null}
            {activity.received_characters ? <span>本次请求已接收 {activity.received_characters} 字符</span> : null}
            {stopped ? <span className="inline-flex items-center gap-1"><Square className="size-2.5" />执行已结束</span> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
