import { memo, useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { Components } from "streamdown";
import { Pencil, RotateCcw, Sparkles } from "lucide-react";
import { Message, MessageContent, MessageFooter, MessageResponse } from "@/components/ai-elements/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import { TooltipHint } from "@/components/ui/tooltip";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Checkpoint } from "@/components/ai-elements/checkpoint";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Sources } from "@/components/ai-elements/sources";
import { StackTrace } from "@/components/ai-elements/stack-trace";
import type { CanvasDocument, CanvasNode } from "@/services/api/canvas";
import type { CanvasResourceReference } from "./canvas-resources";
import type { CanvasAgentTraceEntry, CanvasAgentProtocolMessage, CanvasAssistantMessage, CanvasAssistantReference } from "./agent/canvas-agent-types";
import { canvasAgentTaskGroups } from "./agent/canvas-agent-task-groups";
import type { CanvasAgentTaskGroup } from "./agent/canvas-agent-task-groups";
import { canvasAgentTaskTimings } from "./agent/canvas-agent-timing";
import { canvasAgentDisplayTraces, canvasAgentErrorStack, canvasAgentLatestTracePlan, canvasAgentResponsePresentation, canvasAgentTraceIndex } from "./agent/canvas-agent-presentation";
import { canvasAgentProtocolUserMessageIndex } from "./agent/canvas-agent-message-links";
import { canvasAgentMessageRunStatus } from "./agent/canvas-agent-run-state";
import { CanvasAgentTaskProcess } from "./canvas-agent-task-process";
import { CanvasAgentMessageEditor } from "./canvas-agent-message-editor";
import { CanvasAgentExecutionTrace } from "./canvas-agent-execution-trace";
import { CanvasAgentNodeChip } from "./canvas-agent-node-chip";
import { CanvasAgentAttachments } from "./canvas-agent-attachments";
import { CanvasAgentPromptChipInput } from "./canvas-agent-prompt-chip-input";

const ASSISTANT_MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};
const AssistantMarkdown = memo(function AssistantMarkdown({ children, components = ASSISTANT_MARKDOWN_COMPONENTS }: { children: string; components?: Components }) {
  return <MessageResponse components={components}>{children}</MessageResponse>;
});

export function CanvasAgentConversation({ run, resumable, onResume, onChooseMedia, messages, protocolMessages, nodes, onFocusNode, onRetry, onEdit, editDisabled, busy, pendingQuestion, editingMessageID, onSaveEdit, onCancelEdit }: { run?: CanvasDocument["agent_run"]; resumable?: boolean; onResume?: () => void; onChooseMedia?: () => void; protocolMessages?: CanvasAgentProtocolMessage[]; editingMessageID?: string; onSaveEdit?: (message: CanvasAssistantMessage, text: string) => void; onCancelEdit?: () => void; onEdit: (message: CanvasAssistantMessage) => void; editDisabled: boolean; pendingQuestion?: string; busy: boolean; messages: CanvasAssistantMessage[]; nodes: CanvasNode[]; onFocusNode?: (nodeID: string) => void; onRetry: (message: CanvasAssistantMessage) => void }) {
  const focusNodeRef = useRef(onFocusNode);
  useLayoutEffect(() => { focusNodeRef.current = onFocusNode; }, [onFocusNode]);
  // Keep history renderers stable while canvas viewport callbacks change.
  const focusNode = useCallback((nodeID: string) => focusNodeRef.current?.(nodeID), []);
  const handleFocusNode = onFocusNode ? focusNode : undefined;
  const components = useMemo<Components>(() => ({ ...ASSISTANT_MARKDOWN_COMPONENTS, inlineCode: ({ children, className, node: markdownNode, ...props }) => {
    const node = nodes.find((item) => item.id === String(children).trim());
    if (!node || className || !handleFocusNode || markdownNode?.position?.start.line !== markdownNode?.position?.end.line) return <code className={className} {...props}>{children}</code>;
    return <CanvasAgentNodeChip node={node} onFocus={handleFocusNode} />;
  } }), [nodes, handleFocusNode]);
  const renderTraceText = useCallback((text: string) => <AssistantMarkdown components={components}>{text}</AssistantMarkdown>, [components]);
  const tasks = useMemo(() => canvasAgentTaskGroups(messages), [messages]);
  const latestAssistantID = messages.findLast((message) => message.role === "assistant")?.id;
  const protocolIndex = useMemo(() => {
    const indexes = new Map<string, number>();
    (protocolMessages || []).forEach((message, index) => { if (message.role === "user" && message.messageID && !indexes.has(message.messageID)) indexes.set(message.messageID, index); });
    return indexes;
  }, [protocolMessages]);
  const displayTraces = useMemo(() => {
    const display = new Map<string, CanvasAgentTraceEntry[]>();
    const index = canvasAgentTraceIndex(protocolMessages || []);
    for (const task of tasks) {
      const entries = canvasAgentDisplayTraces(task.replies.flatMap(reply => reply.trace || []), protocolMessages || [], index);
      const byID = new Map(entries.map(entry => [entry.id, entry]));
      for (const reply of task.replies) display.set(reply.id, (reply.trace || []).map(entry => byID.get(entry.id) || entry));
    }
    return display;
  }, [tasks, protocolMessages]);
  const timings = canvasAgentTaskTimings(messages);
  return <>{tasks.map((task, taskIndex) => {
    const start = task.request ? protocolIndex.get(task.request.id) ?? canvasAgentProtocolUserMessageIndex(protocolMessages || [], task.request, messages) : -1;
    const nextRequest = tasks[taskIndex + 1]?.request;
    const end = nextRequest ? protocolIndex.get(nextRequest.id) ?? canvasAgentProtocolUserMessageIndex(protocolMessages || [], nextRequest, messages) : (protocolMessages || []).length;
    const presentation = canvasAgentResponsePresentation(start >= 0 ? (protocolMessages || []).slice(start, end >= 0 ? end : start) : []);
    const taskPlan = canvasAgentLatestTracePlan(task.replies.flatMap(reply => displayTraces.get(reply.id) || []));
    const displaySignature = task.replies.map((reply) => `${reply.id}:${traceListSignature(displayTraces.get(reply.id) || [])}`).join("|");
    const timingSignature = task.replies.map((reply) => `${reply.id}:${timingSignatureFor(timings.get(reply.id))}`).join("|");
    return <CanvasAgentTaskItem key={task.id} task={task} latestAssistantID={latestAssistantID} run={run} pendingQuestion={pendingQuestion} editingMessageID={editingMessageID} busy={busy} editDisabled={editDisabled} resumable={resumable} onResume={onResume} onChooseMedia={onChooseMedia} onRetry={onRetry} onEdit={onEdit} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} nodes={nodes} handleFocusNode={handleFocusNode} components={components} renderText={renderTraceText} displayTraces={displayTraces} displaySignature={displaySignature} timings={timings} timingSignature={timingSignature} protocolPresentation={presentation} presentationSignature={responsePresentationSignature(presentation)} taskPlan={taskPlan} taskPlanSignature={planSignature(taskPlan)} runSignature={runSignature(run)} />;
  })}</>;

}

function messageSignature(message?: CanvasAssistantMessage) {
  if (!message) return "";
  return JSON.stringify([
    message.id,
    message.role,
    message.status,
    message.text,
    message.activity || "",
    message.elapsedMs,
    message.processingStartedAt,
    message.questionAnswerFor || "",
    (message.trace || []).map(traceSignature),
    (message.references || []).map((reference) => [reference.id, reference.type, reference.title, reference.label, reference.url, reference.dataUrl, reference.text]),
  ]);
}

function traceSignature(entry: CanvasAgentTraceEntry) {
  if (entry.type === "text") return [entry.id, entry.type, entry.text];
  if (entry.type === "reasoning") return [entry.id, entry.type, entry.text, entry.isStreaming];
  if (entry.type === "question") return [entry.id, entry.type, entry.question, entry.answer, entry.cancelled];
  return [
    entry.id,
    entry.type,
    entry.kind,
    entry.label,
    entry.status,
    entry.detail,
    entry.resolvedBy,
    entry.nodeId,
    entry.terminal,
    entry.subagent,
    entry.tool?.name,
    entry.tool?.input,
    entry.tool?.output,
  ];
}

function traceListSignature(entries: readonly CanvasAgentTraceEntry[]) {
  return JSON.stringify(entries.map(traceSignature));
}

function timingSignatureFor(timing?: { elapsedMs?: number; processingStartedAt?: number }) {
  return timing ? `${timing.elapsedMs || 0}:${timing.processingStartedAt || 0}` : "";
}

function runSignature(run?: CanvasDocument["agent_run"]) {
  return run ? JSON.stringify([run.id, run.sessionId, run.assistantId, run.status, run.updatedAt, run.error || "", run.toolResult]) : "";
}

function responsePresentationSignature(presentation: ReturnType<typeof canvasAgentResponsePresentation>) {
  return JSON.stringify([
    presentation.reasoning.map((item) => [item.id, item.text]),
    presentation.sources.map((item) => [item.url, item.title]),
  ]);
}

function planSignature(plan: ReturnType<typeof canvasAgentLatestTracePlan>) {
  return plan ? JSON.stringify([plan.explanation, plan.steps.map((step) => [step.id, step.title, step.status])]) : "";
}

type CanvasAgentTaskItemProps = {
  task: CanvasAgentTaskGroup;
  latestAssistantID?: string;
  run?: CanvasDocument["agent_run"];
  pendingQuestion?: string;
  editingMessageID?: string;
  busy: boolean;
  editDisabled: boolean;
  resumable?: boolean;
  onResume?: () => void;
  onChooseMedia?: () => void;
  onRetry: (message: CanvasAssistantMessage) => void;
  onEdit: (message: CanvasAssistantMessage) => void;
  onSaveEdit?: (message: CanvasAssistantMessage, text: string) => void;
  onCancelEdit?: () => void;
  nodes: CanvasNode[];
  handleFocusNode?: (nodeID: string) => void;
  components: Components;
  renderText: (text: string) => ReactNode;
  displayTraces: ReadonlyMap<string, CanvasAgentTraceEntry[]>;
  displaySignature: string;
  timings: ReadonlyMap<string, { elapsedMs?: number; processingStartedAt?: number }>;
  timingSignature: string;
  runSignature: string;
  protocolPresentation: ReturnType<typeof canvasAgentResponsePresentation>;
  presentationSignature: string;
  taskPlan: ReturnType<typeof canvasAgentLatestTracePlan>;
  taskPlanSignature: string;
};

const CanvasAgentTaskItem = memo(function CanvasAgentTaskItem({ task, latestAssistantID, run, pendingQuestion, editingMessageID, busy, editDisabled, resumable, onResume, onChooseMedia, onRetry, onEdit, onSaveEdit, onCancelEdit, nodes, handleFocusNode, components, renderText, displayTraces, timings, protocolPresentation, taskPlan }: CanvasAgentTaskItemProps) {
  const latest = task.replies.at(-1);
  const isLatest = latest?.id === latestAssistantID;
  const status = latest ? canvasAgentMessageRunStatus(latest, run, Boolean(isLatest && pendingQuestion)) : "interrupted";
  const running = status === "running";
  const conclusion = latest && !running && !task.replies.some((message) => message.trace?.some((entry) => entry.type === "question" && entry.question === latest.text)) && !(isLatest && pendingQuestion === latest.text) ? latest : undefined;
  function renderMessage(message: CanvasAssistantMessage) {
    if (message.questionAnswerFor) return null;
    const messageRunning = message.status === "thinking" || message.status === "running";
    const isAssistant = message.role === "assistant";
    const errorStack = message.status === "error" ? canvasAgentErrorStack(message.text) : undefined;
    const hideReply = isAssistant && (message.trace?.some((entry) => entry.type === "question" && entry.question === message.text) || pendingQuestion === message.text && message.id === latestAssistantID);
    const editing = message.id === editingMessageID && onSaveEdit && onCancelEdit;
    return <Message key={message.id} data-agent-message={message.id} from={isAssistant ? "assistant" : "user"}>
      <MessageContent className={!isAssistant ? "items-end" : undefined}>
      {editing ? <div className="w-full min-w-0"><UserMessageContent message={message} showText={false} /><CanvasAgentMessageEditor key={message.id} text={message.text} disabled={busy} onSave={(text) => onSaveEdit(message, text)} onCancel={onCancelEdit} /></div> : null}
      {!editing && message.text && !hideReply ? isAssistant ? <div className="w-full min-w-0 text-sm leading-6">{message.status === "error" ? <Alert variant="destructive"><AlertTitle>执行未完成</AlertTitle><AlertDescription className="whitespace-pre-wrap break-words">{errorStack ? message.text.split("\n")[0] : message.text}</AlertDescription></Alert> : <AssistantMarkdown components={components}>{message.text}</AssistantMarkdown>}{errorStack ? <StackTrace stack={errorStack} /> : null}</div> : <Bubble align="end" variant="muted" className="max-w-[90%]"><BubbleContent><UserMessageContent message={message} showText /></BubbleContent></Bubble> : null}
      {!editing && !messageRunning && message.text && !hideReply ? <MessageFooter><TooltipHint content="复制消息"><CodeBlockCopyButton type="button" size="icon" aria-label="复制消息" value={message.text} /></TooltipHint>{!isAssistant && !message.questionAnswerFor ? <TooltipHint content="编辑消息"><Button size="icon" variant="ghost" aria-label="编辑消息" disabled={editDisabled} onClick={() => onEdit(message)}><Pencil /></Button></TooltipHint> : null}{isAssistant && message.status === "success" && !pendingQuestion && message.id === latestAssistantID ? <TooltipHint content="重试"><Button size="icon" variant="ghost" aria-label="重试" disabled={busy} onClick={() => onRetry(message)}><RotateCcw /></Button></TooltipHint> : null}</MessageFooter> : null}
      </MessageContent>
    </Message>;
  }
  return <MessageScrollerItem messageId={task.id} scrollAnchor data-agent-task={task.id} className="flex min-w-0 flex-col gap-4">
    {task.request ? renderMessage(task.request) : null}
    {latest ? <CanvasAgentTaskProcess status={status} timing={timings.get(latest.id) || {}}>{protocolPresentation.reasoning.map(summary => <Reasoning key={summary.id} text={summary.text} />)}{task.replies.map((message) => { const entries = (displayTraces.get(message.id) || []).filter((entry) => !(message === conclusion && entry.type === "text" && entry.text === message.text)); const showText = message !== conclusion && message.text && !message.trace?.some((entry) => entry.type === "text" && entry.text === message.text || entry.type === "question" && entry.question === message.text) && !(isLatest && pendingQuestion === message.text); const active = message === latest && running; if (!entries.length && !showText && !(active && message.activity)) return null; return <div key={message.id} data-agent-process-message={message.id} className="min-w-0 space-y-2"><CanvasAgentExecutionTrace entries={entries} nodes={nodes} running={active} activity={message.activity} onFocusNode={handleFocusNode} renderText={renderText} />{showText ? <div className="text-sm leading-6">{renderText(message.text)}</div> : null}</div>; })}</CanvasAgentTaskProcess> : null}
    {conclusion ? <div data-agent-conclusion className="min-w-0">{renderMessage({ ...conclusion, status: status === "cancelled" || status === "interrupted" ? "waiting" : status, trace: [] })}</div> : null}
    {isLatest && latest && !running && !pendingQuestion && (resumable && onResume || status === "error" || status === "interrupted" || status === "cancelled") ? <div className="flex flex-wrap items-center gap-2" data-agent-retry-actions><Button type="button" size="sm" disabled={busy} onClick={() => resumable && onResume ? onResume() : onRetry(latest)}><RotateCcw />{status === "waiting" ? "继续未完成任务" : "重试"}</Button>{taskPlan?.steps.some(step => step.status === "deferred") && onChooseMedia ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onChooseMedia}><Sparkles />生成暂缓节点</Button> : null}</div> : null}
    <Sources sources={protocolPresentation.sources} />
    {task.request?.agentStateBefore && latest && !running ? <Checkpoint editing={editingMessageID === task.request.id} onEdit={() => onEdit(task.request!)} /> : null}
  </MessageScrollerItem>;
}, (prev, next) => prev.task.id === next.task.id && prev.task.request?.id === next.task.request?.id && messageSignature(prev.task.request) === messageSignature(next.task.request) && prev.task.replies.length === next.task.replies.length && prev.task.replies.every((message, index) => messageSignature(message) === messageSignature(next.task.replies[index])) && prev.latestAssistantID === next.latestAssistantID && prev.pendingQuestion === next.pendingQuestion && prev.editingMessageID === next.editingMessageID && prev.busy === next.busy && prev.editDisabled === next.editDisabled && prev.resumable === next.resumable && prev.nodes === next.nodes && prev.displaySignature === next.displaySignature && prev.timingSignature === next.timingSignature && prev.presentationSignature === next.presentationSignature && prev.taskPlanSignature === next.taskPlanSignature && runSignature(prev.run) === runSignature(next.run));

const UserMessageContent = memo(function UserMessageContent({ message, showText = true }: { message: CanvasAssistantMessage; showText?: boolean }) {
  const references = useMemo(() => message.references?.filter((item) => item.source !== "attachment").map(assistantToPromptReference) || [], [message.references]);
  return <><CanvasAgentAttachments attachments={message.references?.filter((item) => item.source === "attachment") || []} />{showText ? <CanvasAgentPromptChipInput value={message.text} references={references} onChange={() => undefined} readOnly /> : null}</>;
});

function assistantToPromptReference(reference: CanvasAssistantReference): CanvasResourceReference {
  const kind = reference.type === "video" ? "video" : reference.type === "audio" ? "audio" : reference.type === "text" ? "text" : "image";
  return { id: reference.id, nodeID: reference.id, kind, label: reference.label || reference.title, title: reference.title, previewURL: reference.dataUrl || reference.url, text: reference.text, active: true };
}
