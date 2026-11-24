import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import type { CanvasAgentWorkflowRun } from "./agent/canvas-agent-types";

const labels = {
  success: "已完成", error: "失败", interrupted: "已中断",
  waiting: "等待依赖", skipped: "未执行", changed: "画布已变化",
};

export function CanvasAgentWorkflowProgress({ run, onFocus }: {
  run: CanvasAgentWorkflowRun;
  onFocus?: (nodeID: string) => void;
}) {
  const [open, setOpen] = useState(run.status !== "success");
  const Chevron = open ? ChevronDown : ChevronRight;
  const total = run.members.length;
  const completed = run.members.filter(member => member.status === "success").length;
  return (
    <Card size="sm" className="min-w-0 gap-0 py-1" data-agent-workflow-run={run.id}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-auto min-h-9 w-full justify-start whitespace-normal text-left">
            <Chevron aria-hidden="true" />
            <span className="flex-1">工作流进度</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{completed}/{total}</span>
            <Badge variant={run.status === "error" ? "destructive" : "secondary"}>{run.status === "running" ? "运行中" : labels[run.status]}</Badge>
          </Button>
        </CollapsibleTrigger>
        <CardContent className="py-1.5">
          <Progress value={total ? (completed / total) * 100 : 0} aria-label="工作流完成进度" getValueLabel={() => `已完成 ${completed} 项，共 ${total} 项`} />
        </CardContent>
        <CollapsibleContent>
          <CardContent>
            <ul className="divide-y">
              {run.members.map(member => {
                const progress = member.status === "running" && member.progress !== undefined ? Math.round(member.progress) : undefined;
                return <li key={member.nodeId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 py-1.5">
                  {onFocus ? <Button type="button" size="sm" variant="ghost" className="h-auto min-w-0 justify-start whitespace-normal px-1 text-left wrap-anywhere" onClick={() => onFocus(member.nodeId)}>{member.title}</Button> : <span className="px-1 wrap-anywhere">{member.title}</span>}
                  <Badge variant={member.status === "error" ? "destructive" : "outline"}>
                    {member.status === "running" ? (progress === undefined ? "生成中" : `生成中 ${progress}%`) : labels[member.status]}
                  </Badge>
                  {progress !== undefined ? <Progress className="col-span-2" value={progress} aria-label={`${member.title}生成进度`} /> : null}
                </li>;
              })}
            </ul>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
