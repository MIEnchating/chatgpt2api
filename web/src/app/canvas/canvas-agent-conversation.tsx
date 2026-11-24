import { canvasDocumentValuesEqual } from "./canvas-document-equality";
import { lazy, memo, Suspense, useCallback, useId, useMemo, useState, type ReactNode } from "react";
import type { Components } from "streamdown";
import { ChevronDown, ChevronRight, Download, GitBranch, ListTree, Pencil, Quote, RotateCcw, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { Message, MessageContent, MessageFooter, MessageResponse } from "@/components/ai-elements/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from "@/components/ui/loading-state";
import { CodeBlockCopyButton } from "@/components/ui/code-block";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Checkpoint } from "@/components/ai-elements/checkpoint";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Sources } from "@/components/ai-elements/sources";
import { StackTrace } from "@/components/ai-elements/stack-trace";
import type { CanvasDocument, CanvasNode } from "@/services/api/canvas";
import type { CanvasResourceReference } from "./canvas-resources";
import type { CanvasAgentFeedbackCategory, CanvasAgentFeedbackInput, CanvasAgentTraceEntry, CanvasAgentProtocolMessage, CanvasAssistantMessage, CanvasAssistantReference } from "./agent/canvas-agent-types";
import { canvasAgentTaskGroups } from "./agent/canvas-agent-task-groups";
import type { CanvasAgentTaskGroup } from "./agent/canvas-agent-task-groups";
import { canvasAgentTaskTimings } from "./agent/canvas-agent-timing";
import { canvasAgentTurnDiagnostic, downloadCanvasAgentTurnDiagnostic } from "./agent/canvas-agent-diagnostics";
import { canvasAgentDisplayTraces, canvasAgentErrorStack, canvasAgentLatestTracePlan, canvasAgentOperationContext, canvasAgentResponsePresentation, canvasAgentTraceIndex } from "./agent/canvas-agent-presentation";
import { canvasAgentProtocolUserMessageIndex } from "./agent/canvas-agent-message-links";
import { canvasAgentMessageRunStatus, canvasAgentResultStatusUnknown } from "./agent/canvas-agent-run-state";
import { CanvasAgentTaskProcess } from "./canvas-agent-task-process";
import { CanvasAgentMessageEditor } from "./canvas-agent-message-editor";
import { CanvasAgentExecutionTrace } from "./canvas-agent-execution-trace";
import { CanvasAgentWorkflowProgress } from "./canvas-agent-workflow-run";
import { CanvasAgentNodeChip } from "./canvas-agent-node-chip";
import { CanvasAgentAttachments } from "./canvas-agent-attachments";
import { CanvasAgentPromptContent } from "./canvas-agent-prompt-chip-input";
import { useStableCallback } from "@/lib/use-stable-callback";
import { downloadCanvasDeliverables } from "./canvas-media-download";
import { toast } from "sonner";

const CanvasMovieCard = lazy(() => import("./canvas-movie-card").then((module) => ({ default: module.CanvasMovieCard })));

const ASSISTANT_MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};
const AssistantMarkdown = memo(function AssistantMarkdown({ children, components = ASSISTANT_MARKDOWN_COMPONENTS }: { children: string; components?: Components }) {
  return <MessageResponse components={components}>{children}</MessageResponse>;
});

type SaveMessageFeedback = (messageID: string, version: string, feedback: CanvasAgentFeedbackInput | null) => Promise<void>;

type CanvasAgentConversationProps = { targetMessageID?: string; inheritedMessageCount?: number; onQuote?: (text: string) => void; onBranch?: (message: CanvasAssistantMessage) => void; onFeedback: SaveMessageFeedback; run?: CanvasDocument["agent_run"]; resumable?: boolean; onResume?: () => void; onChooseMedia?: () => void; onFollowUp?: (prompt: string) => void; protocolMessages?: CanvasAgentProtocolMessage[]; editingMessageID?: string; onSaveEdit?: (message: CanvasAssistantMessage, text: string) => void; onCancelEdit?: () => void; onEdit: (message: CanvasAssistantMessage) => void; editDisabled: boolean; pendingQuestion?: string; busy: boolean; messages: CanvasAssistantMessage[]; nodes: CanvasNode[]; onFocusNode?: (nodeID: string) => void; onRetry: (message: CanvasAssistantMessage) => void };

// Draft changes update action closures without rebuilding the unchanged transcript.
export function CanvasAgentConversation(props: CanvasAgentConversationProps) {
  const onEdit = useStableCallback(props.onEdit);
  const onRetry = useStableCallback(props.onRetry);
  const onBranch = useStableCallback((message: CanvasAssistantMessage) => props.onBranch?.(message));
  const onQuote = useStableCallback((text: string) => props.onQuote?.(text));
  const onFeedback = useStableCallback(props.onFeedback);
  const onResume = useStableCallback(() => props.onResume?.());
  const onChooseMedia = useStableCallback(() => props.onChooseMedia?.());
  const onFollowUp = useStableCallback((prompt: string) => props.onFollowUp?.(prompt));
  const onSaveEdit = useStableCallback((message: CanvasAssistantMessage, text: string) => props.onSaveEdit?.(message, text));
  const onCancelEdit = useStableCallback(() => props.onCancelEdit?.());
  const onFocusNode = useStableCallback((nodeID: string) => props.onFocusNode?.(nodeID));
  return <MemoizedCanvasAgentConversation {...props} onQuote={props.onQuote ? onQuote : undefined} onFeedback={onFeedback} onEdit={onEdit} onRetry={onRetry} onBranch={props.onBranch ? onBranch : undefined}
    onResume={props.onResume ? onResume : undefined} onChooseMedia={props.onChooseMedia ? onChooseMedia : undefined} onFollowUp={props.onFollowUp ? onFollowUp : undefined}
    onSaveEdit={props.onSaveEdit ? onSaveEdit : undefined} onCancelEdit={props.onCancelEdit ? onCancelEdit : undefined}
    onFocusNode={props.onFocusNode ? onFocusNode : undefined} />;
}

const MemoizedCanvasAgentConversation = memo(CanvasAgentConversationContent);

function CanvasAgentConversationContent({ targetMessageID, inheritedMessageCount = 0, onBranch, onQuote, onFeedback, run, resumable, onResume, onChooseMedia, onFollowUp, messages, protocolMessages, nodes, onFocusNode, onRetry, onEdit, editDisabled, busy, pendingQuestion, editingMessageID, onSaveEdit, onCancelEdit }: CanvasAgentConversationProps) {
  const nodeByID = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const components = useMemo<Components>(() => ({ ...ASSISTANT_MARKDOWN_COMPONENTS, inlineCode: ({ children, className, node: markdownNode, ...props }) => {
    const node = nodeByID.get(String(children).trim());
    if (!node || className || !onFocusNode || markdownNode?.position?.start.line !== markdownNode?.position?.end.line) return <code className={className} {...props}>{children}</code>;
    return <CanvasAgentNodeChip node={node} onFocus={onFocusNode} />;
  } }), [nodeByID, onFocusNode]);
  const renderTraceText = useCallback((text: string) => <AssistantMarkdown components={components}>{text}</AssistantMarkdown>, [components]);
  const allTasks = useMemo(() => canvasAgentTaskGroups(messages), [messages]);
  const [navigation, setNavigation] = useState<{ source?: string; messageID?: string; firstTaskID?: string }>();
  const [outlineOpen, setOutlineOpen] = useState(false);
  const localNavigation = navigation?.source === targetMessageID ? navigation : undefined;
  const selectedMessageID = localNavigation ? localNavigation.messageID : targetMessageID;
  const firstVisibleTaskIndex = localNavigation?.firstTaskID ? allTasks.findIndex(task => task.id === localNavigation.firstTaskID) : -1;
  const targetIndex = selectedMessageID ? messages.findIndex(message => message.id === selectedMessageID) : -1;
  const targetMessage = targetIndex >= 0 ? messages[targetIndex] : undefined;
  let targetTaskIndex = targetMessage ? allTasks.findIndex(task => task.request?.id === targetMessage.id ||
    task.replies.some(message => message.id === targetMessage.id) || task.steering?.some(message => message.id === targetMessage.id)) : -1;
  if (targetMessage?.questionAnswerFor && targetTaskIndex < 0) {
    const preceding = messages.slice(0, targetIndex).findLast(message => message.role === "user" && !message.questionAnswerFor && !message.steeringAssistantId);
    targetTaskIndex = allTasks.findIndex(task => task.request?.id === preceding?.id);
  }
  const visibleStart = firstVisibleTaskIndex >= 0 ? firstVisibleTaskIndex
    : Math.max(0, Math.min(allTasks.length - 20, targetTaskIndex >= 0 ? targetTaskIndex - 5 : allTasks.length));
  const visibleEnd = Math.min(visibleStart + 20, allTasks.length);
  const tasks = useMemo(() => allTasks.slice(visibleStart, visibleEnd), [allTasks, visibleStart, visibleEnd]);
  const latestAssistantID = messages.findLast((message, index) => index >= inheritedMessageCount && message.role === "assistant")?.id;
  const inheritedIDs = useMemo(() => new Set(messages.slice(0, inheritedMessageCount).map(message => message.id)), [inheritedMessageCount, messages]);
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
    const nextRequest = allTasks[visibleStart + taskIndex + 1]?.request;
    const end = nextRequest ? protocolIndex.get(nextRequest.id) ?? canvasAgentProtocolUserMessageIndex(protocolMessages || [], nextRequest, messages) : (protocolMessages || []).length;
    const presentation = canvasAgentResponsePresentation(start >= 0 ? (protocolMessages || []).slice(start, end >= 0 ? end : start) : []);
    const taskPlan = canvasAgentLatestTracePlan(task.replies.flatMap(reply => displayTraces.get(reply.id) || []));
    return { task, presentation, taskPlan };
  }), [allTasks, visibleStart, tasks, protocolIndex, protocolMessages, messages, displayTraces]);
  return <><div data-agent-history-window={visibleEnd < allTasks.length || undefined} className="flex flex-wrap items-center gap-2">
    {allTasks.length > 1 ? <Dialog open={outlineOpen} onOpenChange={setOutlineOpen}>
      <DialogTrigger asChild><Button type="button" variant="outline" size="sm"><ListTree />对话目录</Button></DialogTrigger>
      <DialogContent onCloseAutoFocus={event => {
        if (localNavigation?.messageID) event.preventDefault();
      }}>
        <DialogHeader><DialogTitle>对话目录</DialogTitle></DialogHeader>
        <ScrollArea className="h-[min(18rem,55dvh)]" contentClassName="grid gap-1">
          {allTasks.map((task, index) => {
            const message = task.request || task.replies[0];
            const preview = message?.text.replace(/\s+/g, " ").trim() || "素材或回复";
            return <Button key={task.id} type="button" variant="ghost" size="sm" className="h-auto min-w-0 justify-start whitespace-normal text-left" onClick={() => {
              setNavigation({ source: targetMessageID, messageID: message?.id });
              setOutlineOpen(false);
            }}>{index + 1}. {Array.from(preview).slice(0, 64).join("")}</Button>;
          })}
        </ScrollArea>
      </DialogContent>
    </Dialog> : null}
    {visibleStart > 0 ? <Button variant="outline" size="sm" onClick={() => setNavigation({ source: targetMessageID, firstTaskID: allTasks[Math.max(0, visibleStart - 20)]?.id })}>更早回合</Button> : null}
    {visibleEnd < allTasks.length ? <>
      <Button variant="outline" size="sm" onClick={() => setNavigation({ source: targetMessageID, firstTaskID: allTasks[visibleEnd]?.id })}>后续回合</Button>
      <Button variant="ghost" size="sm" onClick={() => setNavigation({ source: targetMessageID })}>回到最新</Button>
    </> : null}
  </div>{taskPresentations.map(({ task, presentation, taskPlan }) => <CanvasAgentTaskItem key={task.id} task={task} latestAssistantID={latestAssistantID} run={run} pendingQuestion={pendingQuestion} editingMessageID={editingMessageID} busy={busy} editDisabled={editDisabled} resumable={resumable} onResume={onResume} onChooseMedia={onChooseMedia} onFollowUp={onFollowUp} onRetry={onRetry} onEdit={onEdit} onBranch={onBranch} onQuote={onQuote} onFeedback={onFeedback} inheritedIDs={inheritedIDs} targetMessage={allTasks[targetTaskIndex]?.id === task.id ? targetMessage : undefined} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} nodes={nodes} handleFocusNode={onFocusNode} components={components} renderText={renderTraceText} displayTraces={displayTraces} timings={timings} protocolPresentation={presentation} taskPlan={taskPlan} runStatus={run && run.assistantId === task.replies.at(-1)?.id ? run.status : undefined} />)}</>;

}

function taskUsesCanvasNodes(task: CanvasAgentTaskGroup, displayTraces: ReadonlyMap<string, CanvasAgentTraceEntry[]>) {
  if (task.replies.some(message => message.deliverableNodeIds?.length || message.canvasChanges?.length)) return true;
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

const FEEDBACK_CATEGORIES: Array<{ value: CanvasAgentFeedbackCategory; label: string }> = [
  { value: "task-result", label: "任务结果" },
  { value: "instruction-following", label: "执行指令" },
  { value: "product-interaction", label: "产品交互" },
  { value: "service-stability", label: "服务稳定性" },
  { value: "resource-cost", label: "资源消耗" },
  { value: "security-privacy-permission", label: "安全、隐私或权限" },
  { value: "other", label: "其他" },
];

function CanvasAgentMessageFeedbackControl({ message, disabled, onSave }: { message: CanvasAssistantMessage; disabled: boolean; onSave: SaveMessageFeedback }) {
  const id = useId();
  const [draft, setDraft] = useState<(CanvasAgentFeedbackInput & { version: string })>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const current = message.feedback;
  const currentVersion = current?.version || "";
  const stale = draft !== undefined && draft.version !== currentVersion;
  const noteTooLong = draft?.note !== undefined && new TextEncoder().encode(draft.note).length > 8192;

  function begin(rating: CanvasAgentFeedbackInput["rating"]) {
    setError("");
    setDraft({ rating, note: current?.note || "", category: current?.category, version: currentVersion });
  }

  async function save(withdraw = false) {
    if (!draft || disabled || saving || stale || (!withdraw && noteTooLong)) return;
    const { version, rating, category, note } = draft;
    setError("");
    setSaving(true);
    try {
      await onSave(message.id, version, withdraw ? null : { rating, category, note: note?.trim() || undefined });
      setDraft(undefined);
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存反馈失败");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <Button type="button" size="icon" variant={current?.rating === "positive" ? "secondary" : "ghost"} aria-label="回复有帮助" aria-pressed={current?.rating === "positive"} aria-haspopup="dialog" data-tooltip="回复有帮助" disabled={disabled} onClick={() => begin("positive")}><ThumbsUp /></Button>
    <Button type="button" size="icon" variant={current?.rating === "negative" ? "secondary" : "ghost"} aria-label="回复需要改进" aria-pressed={current?.rating === "negative"} aria-haspopup="dialog" data-tooltip="回复需要改进" disabled={disabled} onClick={() => begin("negative")}><ThumbsDown /></Button>
    {draft ? <Dialog open onOpenChange={open => { if (!open && !saving) setDraft(undefined); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{draft.rating === "positive" ? "回复有帮助" : "回复需要改进"}</DialogTitle><DialogDescription>反馈保存在当前对话中，仅供你查阅。</DialogDescription></DialogHeader>
        <ScrollArea className="min-h-0" contentClassName="grid gap-3">
          <Field>
            <FieldLabel htmlFor={`${id}-category`}>分类</FieldLabel>
            <Select value={draft.category || "none"} disabled={saving} onValueChange={value => setDraft({ ...draft, category: FEEDBACK_CATEGORIES.find(item => item.value === value)?.value })}>
              <SelectTrigger id={`${id}-category`}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">不分类</SelectItem>{FEEDBACK_CATEGORIES.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-note`}>补充说明（可选）</FieldLabel>
            <Textarea id={`${id}-note`} value={draft.note} disabled={saving} aria-invalid={noteTooLong} onChange={event => setDraft({ ...draft, note: event.target.value })} maxLength={8192} />
          </Field>
          {error || noteTooLong || stale ? <p role="alert" className="text-destructive">{stale ? "该消息的反馈已在其他页面更新。你可以保留草稿，基于最新版本继续。" : noteTooLong ? "补充说明最多 8192 字节。" : error}</p> : null}
        </ScrollArea>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => setDraft(undefined)}>取消</Button>
          {stale ? <Button type="button" variant="outline" disabled={saving} onClick={() => {
            setDraft({ ...draft, version: currentVersion });
            setError("");
          }}>基于最新版本继续</Button> : null}
          {current ? <Button type="button" variant="ghost" disabled={disabled || saving || stale} onClick={() => void save(true)}>撤回反馈</Button> : null}
          <Button type="button" disabled={disabled || saving || stale || noteTooLong} onClick={() => void save()}>保存反馈</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog> : null}
  </>;
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
  onFollowUp?: (prompt: string) => void;
  onRetry: (message: CanvasAssistantMessage) => void;
  onEdit: (message: CanvasAssistantMessage) => void;
  onBranch?: (message: CanvasAssistantMessage) => void;
  onQuote?: (text: string) => void;
  onFeedback: SaveMessageFeedback;
  inheritedIDs: ReadonlySet<string>;
  targetMessage?: CanvasAssistantMessage;
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

const CanvasAgentTaskItem = memo(function CanvasAgentTaskItem({ task, latestAssistantID, run, pendingQuestion, editingMessageID, busy, editDisabled, resumable, onResume, onChooseMedia, onFollowUp, onRetry, onEdit, onBranch, onQuote, onFeedback, inheritedIDs, targetMessage, onSaveEdit, onCancelEdit, nodes, handleFocusNode, components, renderText, displayTraces, timings, protocolPresentation, taskPlan }: CanvasAgentTaskItemProps) {
  const [changesOpen, setChangesOpen] = useState(false);
  const ChangesChevron = changesOpen ? ChevronDown : ChevronRight;
  const latest = task.replies.at(-1);
  const isLatest = latest?.id === latestAssistantID;
  const status = latest ? canvasAgentMessageRunStatus(latest, run, Boolean(isLatest && pendingQuestion)) : "interrupted";
  const running = status === "running";
  const diagnostic = useMemo(() => canvasAgentTurnDiagnostic(task.replies), [task.replies]);
  const movieIDs = new Set(task.replies.flatMap(reply => (displayTraces.get(reply.id) || []).flatMap(entry => entry.type === "operation" && entry.tool?.name === "merge_script_videos" && entry.status === "success" && entry.nodeId ? [entry.nodeId] : [])));
  const movies = nodes.filter(node => movieIDs.has(node.id) && node.type === "video" && node.url);
  const deliveries = latest?.deliverableNodeIds?.map(id => nodes.find(node => node.id === id)).filter((node): node is CanvasNode => !!node) || [];
  const changes = latest?.canvasChanges || [];
  const changeSummary = latest?.canvasChangeSummary;
  const canExportDiagnostic = !running && (diagnostic.requests > 0 || diagnostic.operations.length > 0 || status === "error");
  const retryAt = latest && run?.assistantId === latest.id ? run.modelRetryAt : undefined;
  const conclusion = latest && !running && !task.replies.some((message) => message.trace?.some((entry) => entry.type === "question" && entry.question === latest.text)) && !(isLatest && pendingQuestion === latest.text) ? latest : undefined;
  const attachTarget = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    requestAnimationFrame(() => {
      if (!element.isConnected) return;
      element.scrollIntoView({ block: "center" });
      element.focus({ preventScroll: true });
    });
  }, []);
  function renderMessage(message: CanvasAssistantMessage) {
    const targeted = targetMessage?.id === message.id;
    if (message.questionAnswerFor && !targeted) return null;
    const messageRunning = message.status === "thinking" || message.status === "running";
    const isAssistant = message.role === "assistant";
    const errorStack = message.status === "error" ? canvasAgentErrorStack(message.text) : undefined;
    const statusUnknown = message.status === "error" && canvasAgentResultStatusUnknown(message);
    const hideReply = isAssistant && (message.trace?.some((entry) => entry.type === "question" && entry.question === message.text) || pendingQuestion === message.text && message.id === latestAssistantID);
    const editing = message.id === editingMessageID && onSaveEdit && onCancelEdit;
    return <Message key={message.id} ref={targeted ? attachTarget : undefined} tabIndex={targeted ? -1 : undefined} data-agent-message={message.id} from={isAssistant ? "assistant" : "user"}>
      <MessageContent className={isAssistant ? "gap-1.5" : "items-end gap-1.5"}>
      {editing ? <div className="w-full min-w-0"><UserMessageContent message={message} showText={false} /><CanvasAgentMessageEditor key={message.id} text={message.text} disabled={busy} onSave={(text) => onSaveEdit(message, text)} onCancel={onCancelEdit} /></div> : null}
      {!editing && message.text && (!hideReply || targeted) ? isAssistant ? <div className="w-full min-w-0 text-sm leading-6">{message.status === "error" ? <Alert data-agent-status-unknown={statusUnknown || undefined}><AlertTitle className="text-destructive">{statusUnknown ? "执行状态待核实" : "执行未完成"}</AlertTitle><AlertDescription className="whitespace-pre-wrap wrap-anywhere leading-6 text-foreground">{errorStack ? message.text.split("\n")[0] : message.text}</AlertDescription></Alert> : <AssistantMarkdown components={components}>{message.text}</AssistantMarkdown>}{errorStack ? <StackTrace stack={errorStack} /> : null}</div> : <Bubble align="end" variant="muted" className="max-w-[90%]"><BubbleContent><UserMessageContent message={message} showText /></BubbleContent></Bubble> : null}
      {!editing && !messageRunning && message.text && !hideReply ? <MessageFooter className="flex-wrap px-0 [&_button]:size-7">{isAssistant && message.status !== "waiting" && !inheritedIDs.has(message.id) ? <CanvasAgentMessageFeedbackControl message={message} disabled={busy} onSave={onFeedback} /> : null}{onQuote ? <Button type="button" size="icon" variant="ghost" aria-label="引用到输入框" data-tooltip="引用到输入框" onMouseDown={event => event.preventDefault()} onClick={event => {
        const selection = window.getSelection();
        const messageElement = event.currentTarget.closest("[data-agent-message]");
        const selected = selection?.anchorNode && selection.focusNode && messageElement?.contains(selection.anchorNode) && messageElement.contains(selection.focusNode) ? selection.toString().trim() : "";
        onQuote(selected || message.text);
      }}><Quote /></Button> : null}<CodeBlockCopyButton type="button" size="icon" aria-label="复制消息" data-tooltip="复制消息" value={message.text} />{onBranch && !message.questionAnswerFor ? <Button type="button" size="icon" variant="ghost" aria-label="从这里分支" data-tooltip="从这里分支" disabled={busy || editDisabled} onClick={() => onBranch(message)}><GitBranch /></Button> : null}{!isAssistant && !message.questionAnswerFor && !message.steeringAssistantId ? <Button size="icon" variant="ghost" aria-label="编辑消息" data-tooltip="编辑消息" disabled={editDisabled} onClick={() => onEdit(message)}><Pencil /></Button> : null}{isAssistant && message.status === "success" && !pendingQuestion && message.id === latestAssistantID ? <Button size="icon" variant="ghost" aria-label="重试" data-tooltip="重试" disabled={busy} onClick={() => onRetry(message)}><RotateCcw /></Button> : null}</MessageFooter> : null}
      </MessageContent>
    </Message>;
  }
  return <MessageScrollerItem messageId={task.id} scrollAnchor data-agent-task={task.id} className="flex min-w-0 flex-col gap-3">
    {task.request ? renderMessage(task.request) : null}
    {task.steering?.map(renderMessage)}
    {latest ? <div className="grid min-w-0 gap-2">
      {task.replies.flatMap(message => (message.workflowRuns || []).map(workflow => <CanvasAgentWorkflowProgress key={`${message.id}:${workflow.id}`} run={workflow} onFocus={handleFocusNode} />))}
      <div className="grid min-w-0 gap-1">
        <CanvasAgentTaskProcess status={status} timing={timings.get(latest.id) || {}}>
          {protocolPresentation.reasoning.filter(summary => !task.replies.some(message => message.trace?.some(entry => entry.type === "reasoning" && entry.text === summary.text))).map(summary => <Reasoning key={summary.id} text={summary.text} />)}
          {task.replies.map(message => {
            const entries = (displayTraces.get(message.id) || []).filter(entry =>
              !(entry.type === "operation" && entry.workflowRunId && message.workflowRuns?.some(run => run.id === entry.workflowRunId))
              && !(message === conclusion && entry.type === "text" && entry.text === message.text));
            const showText = message !== conclusion && message.text && !message.trace?.some(entry => entry.type === "text" && entry.text === message.text || entry.type === "question" && entry.question === message.text) && !(isLatest && pendingQuestion === message.text);
            const active = message === latest && running;
            if (!entries.length && !showText && !(active && message.activity)) return null;
            return <div key={message.id} data-agent-process-message={message.id} className="min-w-0 space-y-2">
              <CanvasAgentExecutionTrace entries={entries} nodes={nodes} running={active} activity={message.activity} onFocusNode={handleFocusNode} renderText={renderText} />
              {showText ? <div className="text-sm leading-6">{renderText(message.text)}</div> : null}
            </div>;
          })}
        </CanvasAgentTaskProcess>
        {latest.readOnly || diagnostic.requests > 0 || canExportDiagnostic ? <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {latest.readOnly ? <Badge variant="secondary">只读</Badge> : null}
          {diagnostic.requests > 0 ? <span className="text-xs tabular-nums text-muted-foreground">
            {diagnostic.requests} 次模型请求 · {diagnostic.totals.total_tokens.tokens === null ? "Token 未上报" : `${diagnostic.totals.total_tokens.tokens.toLocaleString("zh-CN")} Token`}
            {diagnostic.totals.total_tokens.reported > 0 && diagnostic.totals.total_tokens.reported < diagnostic.requests ? `（${diagnostic.totals.total_tokens.reported}/${diagnostic.requests} 次已上报）` : ""}
          </span> : null}
          {canExportDiagnostic ? <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => downloadCanvasAgentTurnDiagnostic(diagnostic)}><Download />导出回合诊断</Button> : null}
        </div> : null}
      </div>
    </div> : null}
    {targetMessage && targetMessage.id !== task.request?.id && !task.steering?.some(message => message.id === targetMessage.id) && targetMessage.id !== conclusion?.id ? renderMessage(targetMessage) : null}
    {conclusion ? <div data-agent-conclusion className="min-w-0">{renderMessage({ ...conclusion, status: status === "cancelled" || status === "interrupted" ? "waiting" : status, trace: [] })}
      {status === "success" && deliveries.length > 0 ? <div role="group" aria-label="交付成品" className="mt-2 flex flex-wrap gap-2">
        {deliveries.map(node => <CanvasAgentNodeChip key={node.id} node={node} onFocus={handleFocusNode} />)}
        <CanvasAgentDownloadDeliverables ids={latest?.deliverableNodeIds || []} nodes={nodes} />
      </div> : null}
      {status === "success" && latest?.followUpActions?.length && onFollowUp ? <div role="group" aria-label="后续动作" className="mt-2 flex flex-wrap gap-2">
        {latest.followUpActions.map(action => <Button key={`${latest.id}:${action.prompt}`} type="button" size="sm" variant="outline" disabled={busy} onClick={() => onFollowUp(action.prompt)}>{action.title}</Button>)}
      </div> : null}
    </div> : null}
    {retryAt && Number.isFinite(Date.parse(retryAt)) ? <p className="text-xs text-muted-foreground" role="status">
      {running ? "预计重试时间" : "最早可继续时间"} · <time dateTime={retryAt}>{new Date(retryAt).toLocaleTimeString("zh-CN")}</time>
    </p> : null}
    {!running && changes.length > 0 ? <Collapsible open={changesOpen} onOpenChange={setChangesOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-auto min-h-8 w-full justify-start whitespace-normal px-1 text-left">
          <ChangesChevron aria-hidden="true" />
          <span className="flex flex-1 flex-wrap items-baseline gap-x-2">
            <span>本轮改动（{changeSummary?.total ?? changes.length}）</span>
            {changeSummary ? <span className="text-xs text-muted-foreground">新增 {changeSummary.added} · 修改 {changeSummary.updated} · 删除 {changeSummary.removed}</span> : null}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="grid gap-1 px-2 py-1 text-sm">
          {changes.map(change => {
            const node = change.kind === "node" && change.action !== "removed" ? nodes.find(item => item.id === change.id) : undefined;
            const action = { added: "新增", updated: "修改", removed: "删除" }[change.action];
            return <li key={`${change.kind}:${change.id}`} className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-muted-foreground">{action}{change.kind === "node" ? "节点" : "连线"}</span>
              {node ? <CanvasAgentNodeChip node={node} onFocus={handleFocusNode} /> : <span className="min-w-0 break-words">{change.label}</span>}
            </li>;
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible> : null}
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
  && canvasDocumentValuesEqual(prev.task.steering, next.task.steering)
  && canvasDocumentValuesEqual(prev.targetMessage, next.targetMessage)
  && prev.onBranch === next.onBranch
  && prev.onQuote === next.onQuote
  && prev.onFeedback === next.onFeedback
  && prev.task.replies.length === next.task.replies.length
  && prev.task.replies.every((message, index) => canvasDocumentValuesEqual(message, next.task.replies[index]) && prev.inheritedIDs.has(message.id) === next.inheritedIDs.has(message.id))
  && prev.latestAssistantID === next.latestAssistantID && prev.pendingQuestion === next.pendingQuestion
  && prev.editingMessageID === next.editingMessageID && prev.busy === next.busy
  && prev.editDisabled === next.editDisabled && prev.resumable === next.resumable
  && next.task.replies.every(reply => canvasDocumentValuesEqual(prev.displayTraces.get(reply.id), next.displayTraces.get(reply.id))
    && canvasDocumentValuesEqual(prev.timings.get(reply.id), next.timings.get(reply.id)))
  && canvasDocumentValuesEqual(prev.protocolPresentation, next.protocolPresentation)
  && canvasDocumentValuesEqual(prev.taskPlan, next.taskPlan)
  && prev.runStatus === next.runStatus
  && (prev.runStatus === undefined || prev.run?.modelRetryAt === next.run?.modelRetryAt)
  && prev.onEdit === next.onEdit && prev.onRetry === next.onRetry
  && prev.onSaveEdit === next.onSaveEdit && prev.onCancelEdit === next.onCancelEdit
  && prev.onResume === next.onResume && prev.onChooseMedia === next.onChooseMedia
  && prev.onFollowUp === next.onFollowUp
  && prev.handleFocusNode === next.handleFocusNode && taskNodeRenderingEqual(prev, next));

const UserMessageContent = memo(function UserMessageContent({ message, showText = true }: { message: CanvasAssistantMessage; showText?: boolean }) {
  const references = useMemo(() => message.references?.filter((item) => item.source !== "attachment").map(assistantToPromptReference) || [], [message.references]);
  return <><CanvasAgentAttachments attachments={message.references?.filter((item) => item.source === "attachment") || []} />{showText ? <CanvasAgentPromptContent value={message.text} references={references} /> : null}</>;
});

function CanvasAgentDownloadDeliverables({ ids, nodes }: { ids: string[]; nodes: CanvasNode[] }) {
  const [downloading, setDownloading] = useState(false);
  async function download() {
    setDownloading(true);
    try {
      await downloadCanvasDeliverables(ids, nodes);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载成品失败");
    } finally {
      setDownloading(false);
    }
  }
  return <Button type="button" variant="outline" size="sm" disabled={downloading} onClick={() => void download()}><Download />{downloading ? "准备下载…" : "下载本轮成品"}</Button>;
}

function assistantToPromptReference(reference: CanvasAssistantReference): CanvasResourceReference {
  const kind = reference.type === "video" ? "video" : reference.type === "audio" ? "audio" : reference.type === "text" ? "text" : "image";
  return { id: reference.id, nodeID: reference.id, kind, label: reference.label || reference.title, title: reference.title, previewURL: reference.dataUrl || reference.url, text: reference.text, active: true };
}
