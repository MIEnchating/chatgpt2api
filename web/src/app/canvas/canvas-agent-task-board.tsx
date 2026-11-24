import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LoadingState } from "@/components/ui/loading-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipButton } from "@/components/ui/tooltip";
import type { CanvasAgentTextTask } from "./agent/canvas-agent-types";
import { canvasAgentTextTaskRows } from "./agent/canvas-agent-sessions";
import { fetchCanvasAgentTextTask, type CanvasAgentTextTaskDetail, type CanvasNode } from "@/services/api/canvas";
import { Check, ChevronRight, Circle, Clock3, ListChecks, ListCollapse, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

const taskStatus = {
  pending: { label: "待领取", icon: Circle, variant: "outline" as const },
  blocked: { label: "受阻", icon: TriangleAlert, variant: "outline" as const },
  in_progress: { label: "起草中", icon: Clock3, variant: "secondary" as const },
  drafted: { label: "待审核", icon: Clock3, variant: "secondary" as const },
  completed: { label: "已完成", icon: Check, variant: "default" as const },
  interrupted: { label: "已中断", icon: RotateCcw, variant: "outline" as const },
  failed: { label: "需重试", icon: TriangleAlert, variant: "destructive" as const },
};

export function CanvasAgentTaskBoard({
  projectID,
  sessionID,
  documentRevision,
  tasks,
  nodes,
  onFocusNode,
}: {
  projectID: string;
  sessionID: string;
  documentRevision: number;
  tasks?: Record<string, CanvasAgentTextTask>;
  nodes: CanvasNode[];
  onFocusNode?: (nodeID: string) => void;
}) {
  const [selectedID, setSelectedID] = useState("");
  const items = canvasAgentTextTaskRows(tasks ?? {}, nodes);
  const selected = items.find(({ task }) => task.id === selectedID);
  if (items.length === 0) return null;

  const active = items.filter(item => item.status !== "completed").length;
  const completed = items.length - active;

  return (
    <Collapsible defaultOpen={active > 0} className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="group/canvas-task-board h-auto w-full min-w-0 justify-start gap-2 px-1 py-1.5 text-left">
          <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]/canvas-task-board:rotate-90" />
          <ListChecks className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">编辑任务</span>
          <Badge variant={active ? "secondary" : "outline"} className="tabular-nums">{completed}/{items.length}</Badge>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">
        <ul className="grid gap-1">
          {items.map(({ task, node, shotIndex, editable, blockers, status: displayStatus }) => {
            const status = taskStatus[displayStatus];
            const Icon = status.icon;
            const title = node?.title || task.key;
            const shotLabel = shotIndex >= 0 ? `镜头 ${shotIndex + 1}` : "镜头已移除";
            const target = task.shotId ? `${title} · ${shotLabel}` : title;
            const row = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{target}</span>
                  <span className="block truncate text-xs text-muted-foreground">{task.question}</span>
                  {displayStatus === "blocked" && !editable ? <span className="block truncate text-xs text-muted-foreground">目标暂不可编辑</span> : null}
                  {blockers.length > 0 ? <span className="block truncate text-xs text-muted-foreground">等待 {blockers.map(id => tasks?.[id]?.key).join("、")}</span> : null}
                  {task.status === "drafted" ? <span className="block truncate text-xs text-muted-foreground">提案已保存 · 修订 {task.revision}</span> : null}
                </span>
                <Badge variant={status.variant} className="shrink-0"><Icon />{status.label}</Badge>
              </>
            );
            return (
              <li key={task.id} className="flex min-w-0 items-start gap-1">
                {node && onFocusNode ? <Button type="button" variant="ghost" size="sm" className="h-auto min-h-8 min-w-0 flex-1 justify-start whitespace-normal px-2 py-1.5 text-left" onClick={() => onFocusNode(task.nodeId)}>{row}</Button>
                  : <div className="flex min-h-8 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm">{row}</div>}
                <TooltipButton type="button" tooltip="任务详情" aria-label={`查看 ${target} 的任务详情`} aria-haspopup="dialog" className="shrink-0" onClick={() => setSelectedID(task.id)}><ListCollapse /></TooltipButton>
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
      {selected && tasks ? <Dialog open onOpenChange={open => { if (!open) setSelectedID(""); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="wrap-anywhere">{selected.node?.title || selected.task.key}{selected.shotIndex >= 0 ? ` · 镜头 ${selected.shotIndex + 1}` : ""}</DialogTitle>
            <DialogDescription>{taskStatus[selected.status].label} · 修订 {selected.task.revision}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0" contentClassName="space-y-3">
            <p className="whitespace-pre-wrap wrap-anywhere">{selected.task.question}</p>
            {selected.task.dependsOn.length > 0 ? <ul aria-label="依赖任务" className="space-y-1">
              {selected.task.dependsOn.map(id => <li key={id} className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 wrap-anywhere">{tasks[id].key}</span>
                <Badge variant="outline">{selected.blockers.includes(id) ? "等待" : "已满足"}</Badge>
              </li>)}
            </ul> : null}
            {selected.task.status === "drafted" ? <TaskProposal key={`${selected.task.id}:${selected.task.revision}:${documentRevision}`} projectID={projectID} sessionID={sessionID} task={selected.task} /> : null}
          </ScrollArea>
        </DialogContent>
      </Dialog> : null}
    </Collapsible>
  );
}

function TaskProposal({ projectID, sessionID, task }: {
  projectID: string;
  sessionID: string;
  task: CanvasAgentTextTask;
}) {
  const [detail, setDetail] = useState<CanvasAgentTextTaskDetail>();
  const [error, setError] = useState("");
  const [read, setRead] = useState(0);
  const { id, revision } = task;
  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined);
    setError("");
    fetchCanvasAgentTextTask(projectID, sessionID, id, revision, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch(error => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取提案失败");
      });
    return () => controller.abort();
  }, [projectID, sessionID, id, revision, read]);
  if (error) return <Alert variant="destructive">
    <AlertDescription><p>{error}</p><Button type="button" size="sm" variant="outline" onClick={() => setRead(value => value + 1)}>重新读取</Button></AlertDescription>
  </Alert>;
  if (!detail) return <LoadingState compact label="正在读取已保存的提案" />;
  if (detail.proposalStatus !== "current") return <Alert><AlertDescription>提案已失效，请基于当前画布重新起草。</AlertDescription></Alert>;
  return <section aria-label="待提交提案">
    <h3 className="font-medium">待提交提案</h3>
    <p className="whitespace-pre-wrap wrap-anywhere">{detail.content || "空白内容"}</p>
  </section>;
}
