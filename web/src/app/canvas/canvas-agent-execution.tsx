import { Badge } from "@/components/ui/badge";
import { CircleAlert, CircleCheck, Clock, Terminal, Wrench } from "lucide-react";

import { CodeBlock, CodeBlockContent, CodeBlockActions, CodeBlockCopyButton } from "@/components/ui/code-block";
import { Trace } from "@/components/ui/trace";
import { AgentStepIcon } from "@/components/agent/agent-step-icon";
import { AGENT_STEP_STATUS } from "@/components/agent/agent-step-status";
import type { CanvasNode } from "@/services/api/canvas";
import type { CanvasAgentTraceEntry } from "./agent/canvas-agent-types";
import { canvasAgentOperationLabel, canvasAgentTraceDetailLines } from "./agent/canvas-agent-trace";
import { Plan } from "@/components/ai-elements/plan";
import { Terminal as TerminalOutput } from "@/components/ai-elements/terminal";
import { Subagent } from "@/components/ai-elements/subagent";
import { StackTrace } from "@/components/ai-elements/stack-trace";
import { Tool } from "@/components/ai-elements/tool";
import { canvasAgentErrorStack, canvasAgentOperationContext, canvasAgentToolMessage, canvasAgentToolPlan } from "./agent/canvas-agent-presentation";
import { CanvasAgentNodeChip } from "./canvas-agent-node-chip";

export function CanvasAgentExecution({ entry, nodes, running, onFocusNode }: {
  entry: Extract<CanvasAgentTraceEntry, { type: "operation" }>;
  nodes: CanvasNode[];
  running: boolean;
  onFocusNode?: (id: string) => void;
}) {
  const { node, nodeName, workflowName, details: operationDetails } = canvasAgentOperationContext(entry, nodes);
  const detailLines = canvasAgentTraceDetailLines(entry.detail, node, entry);
  const detail = detailLines.join("\n");
  const nodeOperation = Boolean(node && ["create", "generate", "edit"].includes(entry.kind));
  const status = entry.status === "running" && !running ? "waiting" : entry.status;
  const Icon = status === "error" ? CircleAlert : status === "waiting" ? Clock : entry.kind === "command" ? Terminal : status === "running" ? Wrench : CircleCheck;
  const statusLabel = entry.resolvedBy ? "已修正" : AGENT_STEP_STATUS[status].label;
  const nodeLabel = status === "error" ? canvasAgentOperationLabel(entry.label, status) : status === "running" ? entry.kind === "generate" ? "生成中" : entry.kind === "edit" ? "更新节点中" : "创建节点中" : status === "waiting" ? "节点" : entry.kind === "edit" ? "已更新" : entry.kind === "generate" ? "已完成" : "已创建节点";
  const plan = entry.kind === "plan" && status !== "error" ? canvasAgentToolPlan(entry.tool?.input) : undefined;
  const stack = status === "error" ? canvasAgentErrorStack(entry.tool?.output) || canvasAgentErrorStack(detail) : undefined;
  const toolMessage = status === "error" ? canvasAgentToolMessage(entry.tool?.output) || detail : undefined;
  const subagent = entry.subagent && (entry.subagent.agents.length || entry.subagent.prompt || entry.subagent.model) ? entry.subagent : undefined;
  const visibleDetail = !entry.tool || entry.kind === "workflow" && status !== "error" ? detail : "";
  const details = Boolean(entry.terminal || subagent || plan || stack || toolMessage || operationDetails.length || visibleDetail);
  const title = nodeOperation ? nodeLabel : canvasAgentOperationLabel(entry.label, status);
  const target = nodeName && !nodeOperation ? nodeName : workflowName;
  if (plan && status === "success") return <Trace data-agent-operation={entry.id}><Plan {...plan} running={false} /></Trace>;
  return <Trace data-agent-operation={entry.id}>
    <Tool title={target ? `${title} · ${target}` : title} state={status === "running" ? "input-available" : status === "error" ? "output-error" : status === "waiting" ? "pending" : "output-available"} statusLabel={nodeOperation && status === "waiting" ? "待生成" : statusLabel} icon={<AgentStepIcon icon={Icon} status={status} />} expandOnRunning={false} expandOnSuccess={entry.kind === "workflow"}>
      {details ? <>
        {entry.resolvedBy ? <p className="mb-2 text-xs text-muted-foreground">后续操作已恢复，以下保留本次未通过的原始记录。</p> : null}
        {toolMessage ? <p role="status" className="text-sm leading-6 text-destructive">{toolMessage}</p> : null}
        {operationDetails.length ? <div className="mb-2 text-sm leading-6"><p className="text-muted-foreground">{entry.tool?.name === "create_canvas_workflow" ? "创建的节点及依赖" : "执行的节点"}</p><ul className="list-inside list-disc">{operationDetails.map((item, index) => <li key={index} className="break-words">{item}</li>)}</ul></div> : null}
        {entry.terminal ? <TerminalOutput {...entry.terminal} /> : subagent ? <Subagent {...subagent} /> : plan ? <Plan {...plan} running={status === "running"} /> : visibleDetail && visibleDetail !== toolMessage ? <CodeBlock size="sm" variant={status === "error" ? "destructive" : "default"}>
          <CodeBlockActions><CodeBlockCopyButton value={visibleDetail} aria-label="复制工具详情" /></CodeBlockActions>
          <CodeBlockContent wrap className="max-h-48">{visibleDetail}</CodeBlockContent>
        </CodeBlock> : null}
        {stack ? <StackTrace stack={stack} /> : null}
      </> : null}
    </Tool>
    {node && onFocusNode ? <div className="ml-6 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2"><CanvasAgentNodeChip node={node} onFocus={onFocusNode} />{["image", "video", "audio"].includes(node.type) ? <Badge variant="outline">当前：{node.generation_status === "loading" ? "生成中" : node.generation_status === "error" ? "生成失败" : node.url ? "有成品" : "待生成"}</Badge> : null}</div> : null}
  </Trace>;
}
