import { canvasDocumentValuesEqual } from "./canvas-document-equality";
import { lazy, memo, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";
import type { Components } from "streamdown";
import { Pencil, RotateCcw, Sparkles } from "lucide-react";
import { Message, MessageContent, MessageFooter, MessageResponse } from "@/components/ai-elements/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
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
import { canvasAgentDisplayTraces, canvasAgentErrorStack, canvasAgentLatestTracePlan, canvasAgentOperationContext, canvasAgentResponsePresentation, canvasAgentTraceIndex } from "./agent/canvas-agent-presentation";
import { canvasAgentProtocolUserMessageIndex } from "./agent/canvas-agent-message-links";
import { canvasAgentMessageRunStatus, canvasAgentResultStatusUnknown } from "./agent/canvas-agent-run-state";
import { CanvasAgentTaskProcess } from "./canvas-agent-task-process";
import { CanvasAgentMessageEditor } from "./canvas-agent-message-editor";
import { CanvasAgentExecutionTrace } from "./canvas-agent-execution-trace";
import { CanvasAgentNodeChip } from "./canvas-agent-node-chip";
import { CanvasAgentAttachments } from "./canvas-agent-attachments";
import { CanvasAgentPromptContent } from "./canvas-agent-prompt-chip-input";
import { useStableCallback } from "@/lib/use-stable-callback";

const CanvasMovieCard = lazy(() => import("./canvas-movie-card").then((module) => ({ default: module.CanvasMovieCard })));

const ASSISTANT_MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};
const AssistantMarkdown = memo(function AssistantMarkdown({ children, components = ASSISTANT_MARKDOWN_COMPONENTS }: { children: string; components?: Components }) {
  return <MessageResponse components={components}>{children}</MessageResponse>;
});

type CanvasAgentConversationProps = { run?: CanvasDocument["agent_run"]; resumable?: boolean; onResume?: () => void; onChooseMedia?: () => void; protocolMessages?: CanvasAgentProtocolMessage[]; editingMessageID?: string; onSaveEdit?: (message: CanvasAssistantMessage, text: string) => void; onCancelEdit?: () => void; onEdit: (message: CanvasAssistantMessage) => void; editDisabled: boolean; pendingQuestion?: string; busy: boolean; messages: CanvasAssistantMessage[]; nodes: CanvasNode[]; onFocusNode?: (nodeID: string) => void; onRetry: (message: CanvasAssistantMessage) => void };

// Draft changes update action closures without rebuilding the unchanged transcript.
export function CanvasAgentConversation(props: CanvasAgentConversationProps) {
  const onEdit = useStableCallback(props.onEdit);
  const onRetry = useStableCallback(props.onRetry);
  const onResume = useStableCallback(() => props.onResume?.());
  const onChooseMedia = useStableCallback(() => props.onChooseMedia?.());
  const onSaveEdit = useStableCallback((message: CanvasAssistantMessage, text: string) => props.onSaveEdit?.(message, text));
  const onCancelEdit = useStableCallback(() => props.onCancelEdit?.());
  const onFocusNode = useStableCallback((nodeID: string) => props.onFocusNode?.(nodeID));
  return <MemoizedCanvasAgentConversation {...props} onEdit={onEdit} onRetry={onRetry}
    onResume={props.onResume ? onResume : undefined} onChooseMedia={props.onChooseMedia ? onChooseMedia : undefined}
    onSaveEdit={props.onSaveEdit ? onSaveEdit : undefined} onCancelEdit={props.onCancelEdit ? onCancelEdit : undefined}
    onFocusNode={props.onFocusNode ? onFocusNode : undefined} />;
}

const MemoizedCanvasAgentConversation = memo(CanvasAgentConversationContent);

function CanvasAgentConversationContent({ run, resumable, onResume, onChooseMedia, messages, protocolMessages, nodes, onFocusNode, onRetry, onEdit, editDisabled, busy, pendingQuestion, editingMessageID, onSaveEdit, onCancelEdit }: CanvasAgentConversationProps) {
  const nodeByID = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const components = useMemo<Components>(() => ({ ...ASSISTANT_MARKDOWN_COMPONENTS, inlineCode: ({ children, className, node: markdownNode, ...props }) => {
    const node = nodeByID.get(String(children).trim());
    if (!node || className || !onFocusNode || markdownNode?.position?.start.line !== markdownNode?.position?.end.line) return <code className={className} {...props}>{children}</code>;
    return <CanvasAgentNodeChip node={node} onFocus={onFocusNode} />;
  } }), [nodeByID, onFocusNode]);
  const renderTraceText = useCallback((text: string) => <AssistantMarkdown components={components}>{text}</AssistantMarkdown>, [components]);
  const allTasks = useMemo(() => canvasAgentTaskGroups(messages), [messages]);
  const [firstVisibleTaskID, setFirstVisibleTaskID] = useState(() => allTasks[Math.max(0, allTasks.length - 20)]?.id);
  const firstVisibleTaskIndex = firstVisibleTaskID ? allTasks.findIndex(task => task.id === firstVisibleTaskID) : 0;
  const visibleStart = firstVisibleTaskIndex >= 0 ? firstVisibleTaskIndex : Math.max(0, allTasks.length - 20);
  const tasks = useMemo(() => allTasks.slice(visibleStart), [allTasks, visibleStart]);
  const latestAssistantID = messages.findLast((message) => message.role === "assistant")?.id;
  const protocolIndex = useMemo(() => {
    const indexes = new Map<string, number>();
    (protocolMessages || []).forEach((message, index) => { if (message.role === "user" && message.messageID && !indexes.has(message.messageID)) indexes.set(message.messageID, index); });
    return indexes;
  }, [protocolMessages]);
  const displayTraces = useMemo(() => {
    const display = new Map<string, CanvasAgentTraceEntry[]>();
    const index = canvasAgentTraceIndex(protocolMessages || [], tasks.flatMap(task => task.replies.flatMap(reply => reply.trace || [])));
    for (const task of tasks) {
      const entries = canvasAgentDisplayTraces(task.replies.flatMap(reply => reply.trace || []), protocolMessages || [], index);
      const byID = new Map(entries.map(entry => [entry.id, entry]));
      for (const reply of task.replies) display.set(reply.id, (reply.trace || []).map(entry => byID.get(entry.id) || entry));
    }
    return display;
  }, [tasks, protocolMessages]);
  const timings = useMemo(() => canvasAgentTaskTimings(messages), [messages]);
  const taskPresentations = useMemo(() => tasks.map((task, taskIndex) => {
    const start = task.request ? protocolIndex.get(task.request.id) ?? canvasAgentProtocolUserMessageIndex(protocolMessages || [], task.request, messages) : -1;
    const nextRequest = tasks[taskIndex + 1]?.request;
    const end = nextRequest ? protocolIndex.get(nextRequest.id) ?? canvasAgentProtocolUserMessageIndex(protocolMessages || [], nextRequest, messages) : (protocolMessages || []).length;
    const presentation = canvasAgentResponsePresentation(start >= 0 ? (protocolMessages || []).slice(start, end >= 0 ? end : start) : []);
    const taskPlan = canvasAgentLatestTracePlan(task.replies.flatMap(reply => displayTraces.get(reply.id) || []));
    return { task, presentation, taskPlan };
  }), [tasks, protocolIndex, protocolMessages, messages, displayTraces]);
  return <>{visibleStart > 0 ? <Button variant="outline" size="sm" aria-label="加载更早对话" onClick={() => setFirstVisibleTaskID(allTasks[Math.max(0, visibleStart - 20)]?.id)}>加载更早对话（剩余 {visibleStart} 段）</Button> : null}{taskPresentations.map(({ task, presentation, taskPlan }) => <CanvasAgentTaskItem key={task.id} task={task} latestAssistantID={latestAssistantID} run={run} pendingQuestion={pendingQuestion} editingMessageID={editingMessageID} busy={busy} editDisabled={editDisabled} resumable={resumable} onResume={onResume} onChooseMedia={onChooseMedia} onRetry={onRetry} onEdit={onEdit} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} nodes={nodes} handleFocusNode={onFocusNode} components={components} renderText={renderTraceText} displayTraces={displayTraces} timings={timings} protocolPresentation={presentation} taskPlan={taskPlan} runStatus={run && run.assistantId === task.replies.at(-1)?.id ? run.status : undefined} />)}</>;

}

function taskUsesCanvasNodes(task: CanvasAgentTaskGroup, displayTraces: ReadonlyMap<string, CanvasAgentTraceEntry[]>) {
  if ([task.request, ...task.replies].some(message => message?.text.includes("`"))) return true;
  return task.replies.some(reply => (displayTraces.get(reply.id) || []).some(entry => {
    if (entry.type === "text") return entry.text.includes("`");
    if (entry.type !== "operation") return false;
    return Boolean(canvasAgentOperationContext(entry, []).nodeId) || entry.tool?.name === "run_canvas_workflow" || entry.tool?.name === "merge_script_videos";
  }));
}

function taskNodeRenderingEqual(prev: CanvasAgentTaskItemProps, next: CanvasAgentTaskItemProps) {
  if (prev.nodes === next.nodes) return prev.components === next.components && prev.renderText === next.renderText;
  return !taskUsesCanvasNodes(next.task, next.displayTraces);
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
  timings: ReadonlyMap<string, { elapsedMs?: number; processingStartedAt?: number }>;
  runStatus?: NonNullable<CanvasDocument["agent_run"]>["status"];
  protocolPresentation: ReturnType<typeof canvasAgentResponsePresentation>;
  taskPlan: ReturnType<typeof canvasAgentLatestTracePlan>;
};

const CanvasAgentTaskItem = memo(function CanvasAgentTaskItem({ task, latestAssistantID, run, pendingQuestion, editingMessageID, busy, editDisabled, resumable, onResume, onChooseMedia, onRetry, onEdit, onSaveEdit, onCancelEdit, nodes, handleFocusNode, components, renderText, displayTraces, timings, protocolPresentation, taskPlan }: CanvasAgentTaskItemProps) {
  const latest = task.replies.at(-1);
  const isLatest = latest?.id === latestAssistantID;
  const status = latest ? canvasAgentMessageRunStatus(latest, run, Boolean(isLatest && pendingQuestion)) : "interrupted";
  const running = status === "running";
  const movieIDs = new Set(task.replies.flatMap(reply => (displayTraces.get(reply.id) || []).flatMap(entry => entry.type === "operation" && entry.tool?.name === "merge_script_videos" && entry.status === "success" && entry.nodeId ? [entry.nodeId] : [])));
  const movies = nodes.filter(node => movieIDs.has(node.id) && node.type === "video" && node.url);
  const conclusion = latest && !running && !task.replies.some((message) => message.trace?.some((entry) => entry.type === "question" && entry.question === latest.text)) && !(isLatest && pendingQuestion === latest.text) ? latest : undefined;
  function renderMessage(message: CanvasAssistantMessage) {
    if (message.questionAnswerFor) return null;
    const messageRunning = message.status === "thinking" || message.status === "running";
    const isAssistant = message.role === "assistant";
    const errorStack = message.status === "error" ? canvasAgentErrorStack(message.text) : undefined;
    const statusUnknown = message.status === "error" && canvasAgentResultStatusUnknown(message);
    const hideReply = isAssistant && (message.trace?.some((entry) => entry.type === "question" && entry.question === message.text) || pendingQuestion === message.text && message.id === latestAssistantID);
    const editing = message.id === editingMessageID && onSaveEdit && onCancelEdit;
    return <Message key={message.id} data-agent-message={message.id} from={isAssistant ? "assistant" : "user"}>
      <MessageContent className={!isAssistant ? "items-end" : undefined}>
      {editing ? <div className="w-full min-w-0"><UserMessageContent message={message} showText={false} /><CanvasAgentMessageEditor key={message.id} text={message.text} disabled={busy} onSave={(text) => onSaveEdit(message, text)} onCancel={onCancelEdit} /></div> : null}
      {!editing && message.text && !hideReply ? isAssistant ? <div className="w-full min-w-0 text-sm leading-6">{message.status === "error" ? <Alert variant="destructive" data-agent-status-unknown={statusUnknown || undefined}><AlertTitle>{statusUnknown ? "执行状态待核实" : "执行未完成"}</AlertTitle><AlertDescription className="whitespace-pre-wrap break-words">{errorStack ? message.text.split("\n")[0] : message.text}</AlertDescription></Alert> : <AssistantMarkdown components={components}>{message.text}</AssistantMarkdown>}{errorStack ? <StackTrace stack={errorStack} /> : null}</div> : <Bubble align="end" variant="muted" className="max-w-[90%]"><BubbleContent><UserMessageContent message={message} showText /></BubbleContent></Bubble> : null}
      {!editing && !messageRunning && message.text && !hideReply ? <MessageFooter><CodeBlockCopyButton type="button" size="icon" aria-label="复制消息" data-tooltip="复制消息" value={message.text} />{!isAssistant && !message.questionAnswerFor ? <Button size="icon" variant="ghost" aria-label="编辑消息" data-tooltip="编辑消息" disabled={editDisabled} onClick={() => onEdit(message)}><Pencil /></Button> : null}{isAssistant && message.status === "success" && !pendingQuestion && message.id === latestAssistantID ? <Button size="icon" variant="ghost" aria-label="重试" data-tooltip="重试" disabled={busy} onClick={() => onRetry(message)}><RotateCcw /></Button> : null}</MessageFooter> : null}
      </MessageContent>
    </Message>;
  }
  return <MessageScrollerItem messageId={task.id} scrollAnchor data-agent-task={task.id} className="flex min-w-0 flex-col gap-4">
    {task.request ? renderMessage(task.request) : null}
    {latest ? <CanvasAgentTaskProcess status={status} timing={timings.get(latest.id) || {}}>{protocolPresentation.reasoning.map(summary => <Reasoning key={summary.id} text={summary.text} />)}{task.replies.map((message) => { const entries = (displayTraces.get(message.id) || []).filter((entry) => !(message === conclusion && entry.type === "text" && entry.text === message.text)); const showText = message !== conclusion && message.text && !message.trace?.some((entry) => entry.type === "text" && entry.text === message.text || entry.type === "question" && entry.question === message.text) && !(isLatest && pendingQuestion === message.text); const active = message === latest && running; if (!entries.length && !showText && !(active && message.activity)) return null; return <div key={message.id} data-agent-process-message={message.id} className="min-w-0 space-y-2"><CanvasAgentExecutionTrace entries={entries} nodes={nodes} running={active} activity={message.activity} onFocusNode={handleFocusNode} renderText={renderText} />{showText ? <div className="text-sm leading-6">{renderText(message.text)}</div> : null}</div>; })}</CanvasAgentTaskProcess> : null}
    {conclusion ? <div data-agent-conclusion className="min-w-0">{renderMessage({ ...conclusion, status: status === "cancelled" || status === "interrupted" ? "waiting" : status, trace: [] })}</div> : null}
    {isLatest && latest && !canvasAgentResultStatusUnknown(latest) && !running && !pendingQuestion && (resumable && onResume || status === "error" || status === "interrupted" || status === "cancelled") ? <div className="flex flex-wrap items-center gap-2" data-agent-retry-actions><Button type="button" size="sm" disabled={busy} onClick={() => resumable && onResume ? onResume() : onRetry(latest)}><RotateCcw />{status === "waiting" ? "继续未完成任务" : "重试"}</Button>{taskPlan?.steps.some(step => step.status === "deferred") && onChooseMedia ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onChooseMedia}><Sparkles />生成暂缓节点</Button> : null}</div> : null}
    {!running ? movies.map(movie => {
      const project = nodes.find(script => script.script_project?.merged_video_node_id === movie.id)?.script_project;
      return <Suspense key={movie.id} fallback={<LoadingState label="正在加载成片" compact />}><CanvasMovieCard node={movie} historical={!project} outdated={project?.merged_video_outdated} onFocus={handleFocusNode} /></Suspense>;
    }) : null}
    <Sources sources={protocolPresentation.sources} />
    {task.request?.agentStateBefore && latest && !running ? <Checkpoint disabled={editDisabled} editing={editingMessageID === task.request.id} onEdit={() => onEdit(task.request!)} /> : null}
  </MessageScrollerItem>;
}, (prev, next) => prev.task.id === next.task.id
  && canvasDocumentValuesEqual(prev.task.request, next.task.request)
  && prev.task.replies.length === next.task.replies.length
  && prev.task.replies.every((message, index) => canvasDocumentValuesEqual(message, next.task.replies[index]))
  && prev.latestAssistantID === next.latestAssistantID && prev.pendingQuestion === next.pendingQuestion
  && prev.editingMessageID === next.editingMessageID && prev.busy === next.busy
  && prev.editDisabled === next.editDisabled && prev.resumable === next.resumable
  && next.task.replies.every(reply => canvasDocumentValuesEqual(prev.displayTraces.get(reply.id), next.displayTraces.get(reply.id))
    && canvasDocumentValuesEqual(prev.timings.get(reply.id), next.timings.get(reply.id)))
  && canvasDocumentValuesEqual(prev.protocolPresentation, next.protocolPresentation)
  && canvasDocumentValuesEqual(prev.taskPlan, next.taskPlan)
  && prev.runStatus === next.runStatus && prev.onEdit === next.onEdit && prev.onRetry === next.onRetry
  && prev.onSaveEdit === next.onSaveEdit && prev.onCancelEdit === next.onCancelEdit
  && prev.onResume === next.onResume && prev.onChooseMedia === next.onChooseMedia
  && prev.handleFocusNode === next.handleFocusNode && taskNodeRenderingEqual(prev, next));

const UserMessageContent = memo(function UserMessageContent({ message, showText = true }: { message: CanvasAssistantMessage; showText?: boolean }) {
  const references = useMemo(() => message.references?.filter((item) => item.source !== "attachment").map(assistantToPromptReference) || [], [message.references]);
  return <><CanvasAgentAttachments attachments={message.references?.filter((item) => item.source === "attachment") || []} />{showText ? <CanvasAgentPromptContent value={message.text} references={references} /> : null}</>;
});

function assistantToPromptReference(reference: CanvasAssistantReference): CanvasResourceReference {
  const kind = reference.type === "video" ? "video" : reference.type === "audio" ? "audio" : reference.type === "text" ? "text" : "image";
  return { id: reference.id, nodeID: reference.id, kind, label: reference.label || reference.title, title: reference.title, previewURL: reference.dataUrl || reference.url, text: reference.text, active: true };
}
