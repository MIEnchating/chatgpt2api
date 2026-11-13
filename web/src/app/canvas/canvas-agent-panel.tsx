import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { LoadingState } from "@/components/ui/loading-state";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { CanvasAgentSessionConflictError } from "./canvas-document-merge";
import { CanvasAgentConversation } from "./canvas-agent-conversation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ItemMedia , Item } from "@/components/ui/item";
import { Card } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { Input } from "@/components/ui/input";
import { TooltipHint } from "@/components/ui/tooltip";
import { isCanvasAgentConversation } from "./agent/canvas-agent-conversation";
import { CanvasAgentQueuedMessages } from "./canvas-agent-message-queue";
import { Context } from "@/components/ai-elements/context";
import { useCanvasAgentTokenEstimate } from "./use-canvas-agent-token-estimate";
import { CONTEXT_COMPACTION_RATIO, contextTokenBudget, DEFAULT_CANVAS_AGENT_CONTEXT_WINDOW_TOKENS, estimateCanvasAgentTokens } from "./agent/canvas-agent-memory";
import { canvasAgentCanResume, canvasAgentComposerAction, canvasAgentNextQueuedMessage, canvasAgentConsumeQueuedMessage, MAX_AGENT_QUEUED_MESSAGES, mergeCanvasAgentMessageQueues } from "./agent/canvas-agent-message-queue";
import { canvasAgentTaskGroups } from "./agent/canvas-agent-task-groups";
import { canvasAgentResultStatusUnknown } from "./agent/canvas-agent-run-state";
import { setCanvasAgentProcessing } from "./agent/canvas-agent-timing";
import { isCanvasAgentSession, parseCanvasAgentSessions } from "./agent/canvas-agent-sessions";
import { canvasAgentHistorySummaries } from "./agent/canvas-agent-history";
import { answerBackendWorkflowReview, CanvasAgentStopError, CanvasAgentObservationError, runBackendCanvasAgent, runBackendCanvasTool, stopCanvasAgentRun } from "./agent/canvas-agent-backend";
import { useStableCallback } from "@/lib/use-stable-callback";
import { useContentStableNodes } from "@/app/canvas/use-content-stable-nodes";
import { Conversation } from "@/components/ai-elements/conversation";
import { Confirmation } from "@/components/ai-elements/confirmation";
import { PromptInput, PromptInputFooter, PromptInputSubmit } from "@/components/ai-elements/prompt-input";
import { CanvasAgentAssetMenu } from "./canvas-agent-composer";
import { CanvasAgentQuestionCard } from "./canvas-agent-interaction";
import { canvasAgentMediaGenerationQuestion, canvasAgentQuestionMediaChoice, canvasAgentUserMediaChoice, resolveCanvasAgentQuestion } from "./agent/canvas-agent-interaction";
import { updateCanvasAgentQuestionTrace, upsertCanvasAgentOperationTrace, upsertCanvasAgentTrace } from "./agent/canvas-agent-trace";
import { canvasAgentEditBranch, canvasAgentReplyTarget, canvasAgentProtocolUserMessageIndex } from "./agent/canvas-agent-message-links";
import { pendingCanvasAgentReferences } from "./agent/canvas-agent-reference";
import { useCanvasAgentPanelDrag } from "./use-canvas-agent-panel-drag";
import { useCanvasAgentAttachments } from "./use-canvas-agent-attachments";
import { canvasAgentSessionAttachments, canvasAgentImageURL, hydrateCanvasAgentAttachment } from "./agent/canvas-agent-attachments";
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { ArrowUp, Bot, Pencil, History, Clock, Minus, MessageCirclePlus, PanelRight, PanelsTopLeft, Plug, Sparkles, Pause, Play, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { buildAllCanvasResourceReferences, type CanvasResourceReference } from "@/app/canvas/canvas-resources";
import { CanvasAgentRunSettings } from "@/app/canvas/canvas-agent-run-settings";
import { CanvasAgentSkillPicker } from "@/app/canvas/canvas-agent-skill-picker";
import { fetchAgentSkills } from "@/services/api/agent-skills";
import { CanvasAgentPromptChipInput } from "@/app/canvas/canvas-agent-prompt-chip-input";
import { useCanvasCodexApproval } from "@/app/canvas/agent/use-canvas-codex-approval";
import { CanvasCodexConnect } from "@/app/canvas/canvas-codex-connect";
import { useCanvasCodexAgent } from "@/app/canvas/agent/canvas-codex-agent";
import { createCanvasAgentState, canvasAgentWaitingReason, type RunCanvasAgentInput } from "@/app/canvas/agent/canvas-agent-runtime";
import {
  abortCanvasAgentRun,
  beginCanvasAgentRunEpoch,
  claimCanvasAgentRun,
  createCanvasAgentRunLifecycle,
  invalidateCanvasAgentRunLifecycle,
  isCurrentCanvasAgentRun,
  mountCanvasAgentRunLifecycle,
  releaseCanvasAgentRun,
} from "@/app/canvas/agent/canvas-agent-run-gate";
import type { CanvasAgentContext } from "@/app/canvas/agent/canvas-agent-context";
import type { CanvasAgentAction, CanvasAgentToolResult } from "@/app/canvas/agent/canvas-agent-tools";
import type { CanvasAgentConfig, CanvasAgentMessageQueue, CanvasAssistantMessage, CanvasAssistantReference, CanvasAssistantSession } from "@/app/canvas/agent/canvas-agent-types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { CANVAS_AGENT_WIDTH } from "./canvas-workspace-layout";
import { CanvasAgentMediaModelPicker, type CanvasAgentMediaModels } from "./canvas-agent-media-model-picker";
import { CanvasAgentModelPicker } from "./canvas-agent-model-picker";
import { CanvasAgentEnginePicker } from "./canvas-agent-engine-picker";
import { useRelayTokenPreferences } from "@/lib/use-relay-token-preferences";
import { cn } from "@/lib/utils";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import type { CanvasNode, CanvasDocument, CanvasAgentSessionSummary } from "@/services/api/canvas";

export type { CanvasAgentAction, CanvasAgentToolResult } from "@/app/canvas/agent/canvas-agent-tools";

function createSession(): CanvasAssistantSession {
  const now = new Date().toISOString();
  return { id: nanoid(), title: "新对话", messages: [], agentState: createCanvasAgentState(), protocolMessages: [], createdAt: now, updatedAt: now };
}

type PendingDeleteConfirmation = { title: string; resolve: (confirmed: boolean) => void };
type CanvasAgentSubmitResult = "started" | "empty" | "busy" | "missing-model" | "missing-key";
type CanvasAgentSubmitOptions = {
  retryAssistantID?: string;
  queuedMessageID?: string;
  preserveDraft?: boolean;
  editUserMessageID?: string;
  mediaGenerationChoice?: "generate" | "defer";
  notifyMissingConfiguration?: boolean;
  onUserMessageCommitted?: () => void;
};
type CanvasAgentInitialRequest = { prompt: string; references: CanvasAssistantReference[] };
type InitialRequestBlockerNotice = {
  request: CanvasAgentInitialRequest;
  reason: "missing-model" | "missing-key";
};

const CanvasAgentAssetPicker = lazy(() => import("./canvas-asset-picker").then((module) => ({ default: module.CanvasAssetPicker })));

type CanvasAgentPanelProps = {
  backendRun?: CanvasDocument["agent_run"];
  syncError?: string;
  historyConflict?: boolean;
  resolvingHistoryConflict?: boolean;
  onResolveHistoryConflict: () => void;
  onSyncError: (message: string) => void;
  onLocalObservationChange: (observing: boolean) => void;
  onBackendDocument: (document: CanvasDocument) => void;
  open: boolean;
  nodes: CanvasNode[];
  selectedNodeIDs: string[];
  referenceNodeClick: { nodeID: string | null; version: number };
  model: string;
  models: string[];
  onModelChange: (model: string) => void;
  mediaModels: CanvasAgentMediaModels;
  configuredSystemPrompt?: string;
  initialSessions: CanvasAssistantSession[];
  sessionSummaries: CanvasAgentSessionSummary[];
  onLoadSession: (sessionID: string, signal?: AbortSignal) => Promise<CanvasAssistantSession>;
  initialActiveSessionID?: string;
  initialRequest?: CanvasAgentInitialRequest | null;
  agentConfig: CanvasAgentConfig;
  displayMode: "floating" | "docked";
  onDisplayModeChange: (mode: "floating" | "docked") => void;
  getAgentContext: (state: CanvasAssistantSession["agentState"]) => CanvasAgentContext;
  onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionID: string, deletedSessionIDs?: string[]) => void;
  onPersist: () => Promise<void>;
  onAgentConfigChange: (patch: Partial<CanvasAgentConfig>) => void;
  onExecuteAction: (action: CanvasAgentAction, messageReferenceNodeIDs: string[], execution?: { onProgress?: (result: CanvasAgentToolResult) => void; waitForMedia?: boolean; generateMedia?: boolean; attachments?: CanvasAssistantReference[]; signal?: AbortSignal }) => Promise<CanvasAgentToolResult>;
  onInitialRequestConsumed?: () => void;
  onFocusNode?: (nodeID: string) => void;
  onClose: () => void;
};

// Keep viewport updates outside the conversation tree without freezing event handlers.
export function CanvasAgentPanel(props: CanvasAgentPanelProps) {
  const onBackendDocument = useStableCallback(props.onBackendDocument);
  const onModelChange = useStableCallback(props.onModelChange);
  const onDisplayModeChange = useStableCallback(props.onDisplayModeChange);
  const getAgentContext = useStableCallback(props.getAgentContext);
  const onSessionsChange = useStableCallback(props.onSessionsChange);
  const onLoadSession = useStableCallback(props.onLoadSession);
  const onPersist = useStableCallback(props.onPersist);
  const onResolveHistoryConflict = useStableCallback(props.onResolveHistoryConflict);
  const onAgentConfigChange = useStableCallback(props.onAgentConfigChange);
  const onExecuteAction = useStableCallback(props.onExecuteAction);
  const onInitialRequestConsumed = useStableCallback((...args: Parameters<NonNullable<CanvasAgentPanelProps["onInitialRequestConsumed"]>>) => props.onInitialRequestConsumed?.(...args));
  const onFocusNode = useStableCallback((...args: Parameters<NonNullable<CanvasAgentPanelProps["onFocusNode"]>>) => props.onFocusNode?.(...args));
  const onClose = useStableCallback(props.onClose);
  const onImageModelChange = useStableCallback(props.mediaModels.image.onChange);
  const onVideoModelChange = useStableCallback(props.mediaModels.video.onChange);
  const { value: image, options: imageOptions } = props.mediaModels.image;
  const { value: video, options: videoOptions } = props.mediaModels.video;
  const mediaModels = useMemo(() => ({
    image: { value: image, options: imageOptions, onChange: onImageModelChange },
    video: { value: video, options: videoOptions, onChange: onVideoModelChange },
  }), [image, imageOptions, video, videoOptions, onImageModelChange, onVideoModelChange]);
  return <MemoizedCanvasAgentPanel {...props} mediaModels={mediaModels} onLoadSession={onLoadSession} onResolveHistoryConflict={onResolveHistoryConflict}
    onBackendDocument={onBackendDocument} onModelChange={onModelChange} onDisplayModeChange={onDisplayModeChange} getAgentContext={getAgentContext} onSessionsChange={onSessionsChange} onPersist={onPersist} onAgentConfigChange={onAgentConfigChange} onExecuteAction={onExecuteAction} onInitialRequestConsumed={props.onInitialRequestConsumed ? onInitialRequestConsumed : undefined} onFocusNode={props.onFocusNode ? onFocusNode : undefined} onClose={onClose} />;
}

function areCanvasAgentPanelPropsEqual(previous: CanvasAgentPanelProps, next: CanvasAgentPanelProps) {
  if (previous.syncError !== next.syncError) return false;
  if (previous.historyConflict !== next.historyConflict || previous.resolvingHistoryConflict !== next.resolvingHistoryConflict) return false;
  const previousRunning = previous.backendRun?.status === "running";
  const nextRunning = next.backendRun?.status === "running";
  if (previous.open !== next.open || previous.displayMode !== next.displayMode || previous.model !== next.model || previous.models !== next.models || previous.initialSessions !== next.initialSessions || previous.sessionSummaries !== next.sessionSummaries || previous.initialActiveSessionID !== next.initialActiveSessionID || previous.initialRequest !== next.initialRequest || previous.agentConfig !== next.agentConfig || previous.configuredSystemPrompt !== next.configuredSystemPrompt || previous.mediaModels.image.value !== next.mediaModels.image.value || previous.mediaModels.image.options !== next.mediaModels.image.options || previous.mediaModels.video.value !== next.mediaModels.video.value || previous.mediaModels.video.options !== next.mediaModels.video.options || previousRunning !== nextRunning) return false;
  if (previousRunning || nextRunning) {
    if (previous.backendRun?.updatedAt !== next.backendRun?.updatedAt || previous.backendRun?.sessionId !== next.backendRun?.sessionId) return false;
  }
  // Geometry and selection change every drag frame; a hidden idle panel keeps its draft locally.
  if (!next.open && !previousRunning && !nextRunning) return true;
  return previous.nodes === next.nodes && previous.selectedNodeIDs === next.selectedNodeIDs && previous.referenceNodeClick === next.referenceNodeClick && previous.backendRun === next.backendRun;
}

const MemoizedCanvasAgentPanel = memo(CanvasAgentPanelContent, areCanvasAgentPanelPropsEqual);

function CanvasAgentPanelContent({ backendRun, syncError, historyConflict, resolvingHistoryConflict, onResolveHistoryConflict, onSyncError, onLocalObservationChange, onBackendDocument, open, nodes: liveNodes, selectedNodeIDs, referenceNodeClick, model, models, onModelChange, mediaModels, configuredSystemPrompt, initialSessions, sessionSummaries, onLoadSession, initialActiveSessionID, initialRequest, agentConfig, displayMode, onDisplayModeChange, getAgentContext, onSessionsChange, onPersist, onAgentConfigChange, onExecuteAction, onInitialRequestConsumed, onFocusNode, onClose }: CanvasAgentPanelProps) {
  const { isReady: relayPreferencesReady, tokenNameForModel } = useRelayTokenPreferences();
  const relayTokenName = model ? tokenNameForModel("text", model) : "";
  const [initialSession] = useState(createSession);
  const sessions = useMemo(() => initialSessions.length ? initialSessions : [initialSession], [initialSession, initialSessions]);
  const activeSessionID = initialActiveSessionID && sessions.some((item) => item.id === initialActiveSessionID) ? initialActiveSessionID : sessions[0].id;
  const [input, setInput] = useState("");
  const [editingUserMessageID, setEditingUserMessageID] = useState("");
  const draftAttachments = useCanvasAgentAttachments(activeSessionID);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const authSession = getCachedAuthSession();
  const [localBusy, setBusy] = useState(false);
  useEffect(() => { onLocalObservationChange(localBusy); return () => onLocalObservationChange(false); }, [localBusy, onLocalObservationChange]);
  const [pausing, setPausing] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyAbortRef = useRef<AbortController | null>(null);
  const busy = localBusy || backendRun?.status === "running" || pausing || historyLoading;
  const [codexSettingsOpen, setCodexSettingsOpen] = useState(false);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [checkedSessionIDs, setCheckedSessionIDs] = useState<string[]>([]);
  const [deleteSessionIDs, setDeleteSessionIDs] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteConfirmation | null>(null);
  const [composerReferenceNodeIDs, setComposerReferenceNodeIDs] = useState<string[]>([]);
  const [removedReferenceNodeIDs, setRemovedReferenceNodeIDs] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelDrag = useCanvasAgentPanelDrag(panelRef, open && displayMode === "floating");
  const abortRef = useRef<AbortController | null>(null);
  const runLifecycleRef = useRef(createCanvasAgentRunLifecycle());
  const pendingDeleteRef = useRef<PendingDeleteConfirmation | null>(null);
  const consumedReferenceNodeClickVersionRef = useRef(0);
  const consumedInitialRequestRef = useRef<typeof initialRequest>(null);
  const initialRequestRef = useRef(initialRequest);
  const initialRequestBlockerNoticeRef = useRef<InitialRequestBlockerNotice | null>(null);
  const onInitialRequestConsumedRef = useRef(onInitialRequestConsumed);
  const submitInitialRequestRef = useRef<(prompt: string, references: CanvasAssistantReference[], onUserMessageCommitted: () => void) => CanvasAgentSubmitResult>(() => "empty");
  const sessionsRef = useRef(sessions);
  function acceptBackendSnapshot(document: CanvasDocument) {
    const incoming = parseCanvasAgentSessions(document.agent_sessions);
    const merged = parseCanvasAgentSessions(mergeCanvasAgentMessageQueues([], sessionsRef.current, incoming));
    onBackendDocument(document);
    sessionsRef.current = merged;
  }
  const activeSessionIDRef = useRef(activeSessionID);
  // Node geometry changes every drag frame; derived data below only needs node content.
  const nodes = useContentStableNodes(liveNodes);
  const nodesRef = useRef(liveNodes);
  const selectedNodeIDsRef = useRef(selectedNodeIDs);
  nodesRef.current = liveNodes;
  selectedNodeIDsRef.current = selectedNodeIDs;
  initialRequestRef.current = initialRequest;
  onInitialRequestConsumedRef.current = onInitialRequestConsumed;
  const activeSession = sessions.find((item) => item.id === activeSessionID) || sessions[0];
  const agentMode = activeSession.engine || "native";
  const latestAssistantMessage = activeSession.messages.findLast((message) => message.role === "assistant");
  const activeRun = backendRun?.sessionId === activeSession.id ? backendRun : undefined;
  const currentTaskProtocol = useMemo(() => {
    const request = canvasAgentTaskGroups(activeSession.messages).at(-1)?.request;
    if (!request) return [];
    const start = canvasAgentProtocolUserMessageIndex(activeSession.protocolMessages, request, activeSession.messages);
    return start >= 0 ? activeSession.protocolMessages.slice(start) : [];
  }, [activeSession.messages, activeSession.protocolMessages]);
  const mediaWaitingReason = canvasAgentWaitingReason({ ...activeSession.agentState, mediaGenerationDeferred: false }, currentTaskProtocol, nodes.map((node) => ({ id: node.id, status: node.generation_status })), latestAssistantMessage?.status);
  const conversationReply = activeSession.messages.findLast((message) => message.role === "assistant")?.interactionMode === "conversation";
  const needsMediaChoice = !conversationReply && !busy && !activeSession.agentState.pendingQuestion && !activeSession.agentState.mediaGenerationDeferred && mediaWaitingReason.startsWith("待手动生成");
  const statusNeedsReview = canvasAgentResultStatusUnknown(latestAssistantMessage);
  const resumable = !statusNeedsReview && !needsMediaChoice && canvasAgentCanResume(activeSession, backendRun);
  const hasDraft = Boolean(input.trim() || draftAttachments.attachments.length);
  const composerAction = canvasAgentComposerAction({ busy, hasDraft, resumable, queued: Boolean(activeSession.messageQueue?.messages.length), waitingForAnswer: Boolean(activeSession.agentState.pendingQuestion) || needsMediaChoice });
  const composerActionLabel = { send: "发送", enqueue: "加入消息队列", pause: "暂停执行", resume: resumable ? "继续未完成任务" : "继续消息队列" }[composerAction];
  const queueDispatchRef = useRef<() => void>(() => {});
  const [canvasId] = useState(() => getAgentContext(activeSession.agentState).project.id);
  const codexApproval = useCanvasCodexApproval();
  const codex = useCanvasCodexAgent({ canvasId, savedModel: agentConfig.codexModel, savedEffort: agentConfig.codexEffort, onSettingsChange: onAgentConfigChange, onDisconnect: (reason) => { abortCanvasAgentRun(abortRef, reason); settleDeleteConfirmation(false); }, executeAction: executeExternalAction, ask: codexApproval.ask });
  const contextEstimate = useMemo(() => {
    const context = getAgentContext(activeSession.agentState);
    return {
      input: { messages: activeSession.protocolMessages, summary: activeSession.contextCheckpoint, context },
      nodeCount: context.project.nodeCount ?? nodes.length,
    };
    // The stable callback reads current canvas selection, content and generation settings.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession.agentState, activeSession.protocolMessages, activeSession.contextCheckpoint, getAgentContext, nodes, selectedNodeIDs, model, mediaModels.image.value, mediaModels.video.value, agentConfig]);
  const contextUsage = agentMode === "native" && activeSession.contextUsage?.model === model ? activeSession.contextUsage : undefined;
  const tokenEstimate = useCanvasAgentTokenEstimate(open && !contextUsage ? contextEstimate.input : undefined);
  const contextInfo = useMemo(() => {
    const usage = contextUsage;
    const estimate = tokenEstimate.tokens === undefined ? undefined : tokenEstimate.tokens + (input ? estimateCanvasAgentTokens(input) : 0);
    const limit = agentConfig.contextWindowTokens && Number.isSafeInteger(agentConfig.contextWindowTokens) && agentConfig.contextWindowTokens > 1 ? agentConfig.contextWindowTokens : DEFAULT_CANVAS_AGENT_CONTEXT_WINDOW_TOKENS;
    return { tokens: usage?.inputTokens ?? usage?.usedTokens ?? estimate, error: usage ? undefined : tokenEstimate.error, measured: usage?.inputTokens !== undefined, limit, compacting: Boolean(usage?.compacting && busy), reported: Boolean(usage), rows: [
      { label: "统计来源", value: usage?.inputTokens !== undefined ? "上游实际用量" : usage ? "上游输入估算" : tokenEstimate.error ? "估算失败" : estimate === undefined ? "正在估算" : "本地输入估算" },
      { label: "上限来源", value: "配置值" },
      ...(agentMode === "native" ? [{ label: "自动压缩阈值", value: `${CONTEXT_COMPACTION_RATIO * 100}% · ${contextTokenBudget(limit).toLocaleString()} tokens` }, { label: "压缩状态", value: usage?.compacting && busy ? "正在压缩" : activeSession.contextCheckpoint ? "已有摘要" : "尚未压缩" }] : []),
      { label: "模型", value: (agentMode === "codex" ? codex.model : model) || "未选择" }, { label: "对话记录", value: `${activeSession.messages.length} 条` },
      { label: "画布节点", value: `${contextEstimate.nodeCount} 个` }, { label: "引用素材", value: `${composerReferenceNodeIDs.length + draftAttachments.attachments.length} 个` },
      { label: "上下文摘要", value: activeSession.contextCheckpoint ? "已保留" : "暂无" },
    ] };
  }, [contextEstimate, contextUsage, tokenEstimate.tokens, tokenEstimate.error, activeSession.contextCheckpoint, activeSession.messages.length, agentConfig.contextWindowTokens, busy, input, model, agentMode, codex.model, composerReferenceNodeIDs.length, draftAttachments.attachments.length]);
  const historySessions = useMemo(() => canvasAgentHistorySummaries({ agent_session_summaries: sessionSummaries, agent_sessions: sessions }).filter(item => item.message_count > 0), [sessionSummaries, sessions]);
  const selectedNodeKey = useMemo(() => [...selectedNodeIDs].sort().join(","), [selectedNodeIDs]);
  const resourceReferences = useMemo(() => buildAllCanvasResourceReferences(nodes), [nodes]);
  const resourceReferenceByID = useMemo(() => new Map(resourceReferences.map((reference) => [reference.nodeID, reference])), [resourceReferences]);
  const pendingReferences = useMemo(() => {
    const clickedNodeID = referenceNodeClick.version > consumedReferenceNodeClickVersionRef.current ? referenceNodeClick.nodeID : null;
    return pendingCanvasAgentReferences(resourceReferences, selectedNodeIDs, clickedNodeID, composerReferenceNodeIDs, removedReferenceNodeIDs);
  }, [composerReferenceNodeIDs, referenceNodeClick, removedReferenceNodeIDs, resourceReferences, selectedNodeIDs]);

  useEffect(() => {
    sessionsRef.current = sessions;
    activeSessionIDRef.current = activeSessionID;
  }, [activeSessionID, sessions]);

  useEffect(() => {
    if (!editingUserMessageID) return;
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      const target = [...(panel?.querySelectorAll<HTMLElement>("[data-agent-message]") || [])]
        .find((element) => element.dataset.agentMessage === editingUserMessageID);
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.querySelector<HTMLElement>("[data-agent-message-editor] textarea")?.focus({ preventScroll: true });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [editingUserMessageID]);

  useEffect(() => {
    setRemovedReferenceNodeIDs(new Set());
  }, [selectedNodeKey]);

  useEffect(() => {
    setComposerReferenceNodeIDs((current) => current.filter((nodeID) => resourceReferenceByID.has(nodeID)));
  }, [resourceReferenceByID]);

  useEffect(() => {
    const lifecycle = runLifecycleRef.current;
    mountCanvasAgentRunLifecycle(lifecycle);
    const stopForSessionChange = () => { invalidateCanvasAgentRunLifecycle(lifecycle); abortCanvasAgentRun(abortRef); settleDeleteConfirmation(false); setBusy(false); };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, stopForSessionChange);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, stopForSessionChange);
      invalidateCanvasAgentRunLifecycle(lifecycle);
      abortCanvasAgentRun(abortRef, "canvas-detached");
      historyAbortRef.current?.abort("canvas-detached");
      historyAbortRef.current = null;
      pendingDeleteRef.current?.resolve(false);
      pendingDeleteRef.current = null;
    };
  }, []);

  async function executeExternalAction(action: CanvasAgentAction, signal: AbortSignal) {
    if (abortRef.current || busy || activeSession.agentState.pendingQuestion) return { ok: false, code: "agent_busy", message: "请先完成当前对话或待回答问题，再执行 MCP 操作" };
    if (!["get_node", "list_workflows", "get_workflow", "save_workflow", "run_saved_workflow", "create_canvas_workflow", "run_canvas_workflow", "create_primary_script_node", "create_script_node", "update_script_node", "confirm_script_node"].includes(action.name)) return onExecuteAction(action, [], { waitForMedia: false });
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    const runSignal = AbortSignal.any([signal, controller.signal]);
    const sessionID = activeSession.id;
    const assistantID = nanoid();
    const requestText = `外部工具：${action.name}`;
    commit(sessionsRef.current.map((session) => session.id !== sessionID ? session : {
      ...session, messages: [...session.messages, { id: assistantID, role: "assistant", text: requestText, status: "running" }], updatedAt: new Date().toISOString(),
    }));
    const stopTiming = () => commit(sessionsRef.current.map((session) => session.id !== sessionID ? session : {
      ...session, messages: session.messages.map((message) => message.id === assistantID ? setCanvasAgentProcessing(message, false) : message), updatedAt: new Date().toISOString(),
    }));
    const acceptDocument = (document: CanvasDocument) => {
      if (controller.signal.reason === "canvas-detached") return;
      acceptBackendSnapshot(document);
    };
    try {
      await onPersist();
      runSignal.throwIfAborted();
      const context = getAgentContext(activeSession.agentState);
      const { result, document } = await runBackendCanvasTool(canvasId, {
        id: action.id, sessionId: sessionID, assistantId: assistantID, userMessageId: "", userText: requestText,
        model: "", relayTokenName: "", apiMode: "responses", stream: false, reasoningEnabled: false,
        generation: context.generation,
        relayTokens: { image: tokenNameForModel("image", context.generation.imageModel), audio: tokenNameForModel("audio", context.generation.audioModel) },
        videoRelayTokens: Object.fromEntries(mediaModels.video.options.map((model) => [model, tokenNameForModel("video", model)])),
        references: canvasAgentSessionAttachments(activeSession.messages, []), selectedNodeIds: context.selectedNodeIds, skillIds: [], resume: false, editPreviousRequest: false,
      }, action, acceptDocument, runSignal, error => {
        if (controller.signal.reason !== "canvas-detached") onSyncError(error.message);
      });
      runSignal.throwIfAborted();
      const prompts = document.agent_run?.toolResult?.reviewPrompts as Record<string, string> | undefined;
      if (result.requiresUserReview && prompts && Object.keys(prompts).length) {
        stopTiming();
        await onPersist();
        const response = await codexApproval.ask({
          title: "审核系列提示词", details: "", description: document.nodes.filter((node) => node.id in prompts).map((node) => `${node.title}\n${node.prompt}`).join("\n\n"),
          questions: [{ id: action.id, question: "是否确认这些提示词并允许生成？", options: [{ label: "确认审核并生成（推荐）" }, { label: "暂不生成，继续修改" }] }],
        }, runSignal);
        runSignal.throwIfAborted();
        const reviewed = await answerBackendWorkflowReview(canvasId, sessionID, prompts, response.accepted ? response.answers?.[action.id] || "" : "");
        acceptDocument(reviewed.document);
        return { ...result, userAnswer: response.accepted ? response.answers?.[action.id] || "" : "用户取消审核" };
      }
      return result;
    } finally {
      if (controller.signal.reason !== "canvas-detached") {
        stopTiming();
        await onPersist().catch((error) => toast.error(error instanceof Error ? error.message : "执行记录保存失败"));
      }
      if (releaseCanvasAgentRun(abortRef, controller)) setBusy(false);
    }
  }

  function settleDeleteConfirmation(confirmed: boolean) {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    pendingDeleteRef.current = null;
    setPendingDelete(null);
    pending.resolve(confirmed);
  }

  function commit(next: CanvasAssistantSession[], nextActiveID = activeSessionIDRef.current, deletedSessionIDs?: string[]) {
    sessionsRef.current = next;
    activeSessionIDRef.current = nextActiveID;
    onSessionsChange(next, nextActiveID, deletedSessionIDs);
  }

  function changeAgentMode(engine: "native" | "codex") {
    if (busy || abortRef.current || activeSession.agentState.pendingQuestion || engine === agentMode) return;
    commit(sessionsRef.current.map((session) => session.id === activeSessionIDRef.current ? { ...session, engine, updatedAt: new Date().toISOString() } : session));
  }

  function updateSessionForRun(sessionID: string, runEpoch: number, updater: (value: CanvasAssistantSession) => CanvasAssistantSession) {
    if (!isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) return false;
    let found = false;
    const next = sessionsRef.current.map((item) => {
      if (item.id !== sessionID) return item;
      found = true;
      return updater(item);
    });
    if (!found) return false;
    commit(next);
    return true;
  }

  function newSession() {
    if (busy || abortRef.current) return;
    draftAttachments.clear();
    setInput("");
    setEditingUserMessageID("");
    setComposerReferenceNodeIDs([]);
    setRemovedReferenceNodeIDs(new Set());
    if (activeSession && !activeSession.messages.length) {
      setView("chat");
      return commit(sessionsRef.current, activeSession.id);
    }
    const next = { ...createSession(), engine: agentMode, activeSkillIds: [] };
    commit([next, ...sessionsRef.current], next.id);
    setView("chat");
  }

  function removeSessions(sessionIDs: string[]) {
    if (busy) return;
    const next = sessionsRef.current.filter((item) => !sessionIDs.includes(item.id));
    if (!next.length) {
      const replacement = createSession();
      commit([replacement], replacement.id, sessionIDs);
    } else {
      commit(next, sessionIDs.includes(activeSessionIDRef.current) ? next[0].id : activeSessionIDRef.current, sessionIDs);
    }
    if (sessionIDs.includes(activeSessionID)) { setInput(""); setEditingUserMessageID(""); draftAttachments.clear(); setComposerReferenceNodeIDs([]); setRemovedReferenceNodeIDs(new Set()); }
    setCheckedSessionIDs((current) => current.filter((sessionID) => !sessionIDs.includes(sessionID)));
  }

  async function openHistorySession(id: string, title?: string) {
    if (busy || abortRef.current) return;
    historyAbortRef.current?.abort("history-replaced");
    const controller = new AbortController();
    historyAbortRef.current = controller;
    setHistoryLoading(true);
    try {
      const loaded = await onLoadSession(id, controller.signal);
      if (title !== undefined) {
        const renamed = { ...loaded, title, updatedAt: new Date().toISOString() };
        commit([...sessionsRef.current.filter(item => item.id !== id), renamed]);
        return;
      }
      setInput(""); setEditingUserMessageID(""); draftAttachments.clear(); setComposerReferenceNodeIDs([]); setRemovedReferenceNodeIDs(new Set());
      commit([loaded], id);
      setView("chat");
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) toast.error(error instanceof Error ? error.message : "历史对话加载失败");
    } finally {
      if (historyAbortRef.current === controller) {
        historyAbortRef.current = null;
        setHistoryLoading(false);
      }
    }
  }

  function submit(nextText = input, savedReferences?: CanvasAssistantReference[], referenceNodeIDs = composerReferenceNodeIDs, options: CanvasAgentSubmitOptions = {}): CanvasAgentSubmitResult {
    if (draftAttachments.uploading || busy || abortRef.current) return "busy";
    const attached = savedReferences ? [] : draftAttachments.attachments;
    const text = nextText.trim() || (attached.length ? "请查看这些附件" : "");
    if (!text || !activeSession) return "empty";
    const editedUserMessage = options.editUserMessageID
      ? activeSession.messages.find((message) => message.id === options.editUserMessageID && message.role === "user" && !message.questionAnswerFor)
      : undefined;
    if (options.editUserMessageID && !editedUserMessage) return "empty";
    const editBranch = editedUserMessage ? canvasAgentEditBranch(activeSession, editedUserMessage) : undefined;
    if (options.editUserMessageID && !editBranch) {
      toast.error("无法定位这条消息对应的历史请求，请重新打开对话后再试");
      return "empty";
    }
    const retryAssistantMessage = options.retryAssistantID
      ? activeSession.messages.find((message) => message.id === options.retryAssistantID && message.role === "assistant")
      : undefined;
    if (options.retryAssistantID && !retryAssistantMessage) return "empty";
    if (agentMode === "codex" && (!codex.connected || !codex.model)) {
      if (options.notifyMissingConfiguration !== false) toast.error("请先连接本地 Codex 并选择模型");
      return "missing-model";
    }
    if (agentMode === "native" && !model) {
      if (options.notifyMissingConfiguration !== false) toast.error("请先配置文本模型");
      return "missing-model";
    }
    if (agentMode === "native" && !relayTokenName) {
      if (options.notifyMissingConfiguration !== false) toast.error("请先在个人中心选择文本生成密钥");
      return "missing-key";
    }
    const controller = claimCanvasAgentRun(abortRef);
    if (!controller) return "busy";
    const mediaState = editBranch?.agentState || activeSession.agentState;
    let generateMedia = options.mediaGenerationChoice ? options.mediaGenerationChoice === "generate" : mediaState.mediaGenerationDeferred === undefined ? undefined : !mediaState.mediaGenerationDeferred;
    if (!options.mediaGenerationChoice && (!mediaState.pendingQuestion || !mediaState.pendingQuestion.purpose) && canvasAgentUserMediaChoice(text) === "generate") generateMedia = true;
    const mediaGenerationChoice = generateMedia === undefined ? options.mediaGenerationChoice : generateMedia ? "generate" : "defer";
    const runEpoch = beginCanvasAgentRunEpoch(runLifecycleRef.current);
    const sessionID = activeSession.id;
    const editedProtocolMessages = editBranch?.protocolMessages || activeSession.protocolMessages;
    const accountKey = getCachedAuthSession()?.key;
    setBusy(true);
    const assistantID = options.retryAssistantID || nanoid();
    const submittedUserID = editedUserMessage?.id || nanoid();
    const replyTarget = retryAssistantMessage ? canvasAgentReplyTarget(activeSession.messages, retryAssistantMessage) : undefined;
    const answeredQuestion = activeSession.agentState.pendingQuestion;
    const userMessage: CanvasAssistantMessage = { id: submittedUserID, role: "user", text, ...(answeredQuestion ? { questionAnswerFor: answeredQuestion.id } : {}), ...(!answeredQuestion ? { agentStateBefore: editBranch?.agentState || structuredClone(activeSession.agentState), contextCheckpointBefore: editBranch ? editBranch.contextCheckpoint : activeSession.contextCheckpoint } : {}), status: "success" };
    const conversationOnly = isCanvasAgentConversation(text) && !activeSession.agentState.pendingQuestion && !referenceNodeIDs.length && !attached.length && !savedReferences?.length && !(activeSession.activeSkillIds ?? agentConfig.activeSkillIds ?? []).length && !options.mediaGenerationChoice;
    const preparingMessage: CanvasAssistantMessage = { id: assistantID, role: "assistant", replyToMessageID: replyTarget?.id || submittedUserID, text: "", ...(conversationOnly ? { interactionMode: "conversation" as const } : {}), trace: retryAssistantMessage?.trace || [], elapsedMs: retryAssistantMessage?.elapsedMs || 0, processingStartedAt: Date.now(), status: "thinking", activity: options.retryAssistantID ? "正在恢复原对话" : attached.length || referenceNodeIDs.length || savedReferences?.length ? "正在读取引用素材" : undefined };
    updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, engine: agentMode, resumeAssistantMessageId: undefined, messages: options.retryAssistantID ? current.messages.map((message) => message.id === assistantID ? preparingMessage : message) : [...current.messages.map((message) => answeredQuestion ? { ...message, trace: updateCanvasAgentQuestionTrace(message.trace, answeredQuestion.id, { answer: text, cancelled: false }) } : message), ...(options.editUserMessageID ? [] : [userMessage]), preparingMessage] }));
    void (async () => {
      try {
        const selectedSkillIDs = activeSession.activeSkillIds ?? agentConfig.activeSkillIds ?? [];
        const availableSkills = selectedSkillIDs.length ? (await fetchAgentSkills(false, controller.signal)).items : [];
        const activeSkills = selectedSkillIDs.map((id) => {
          const skill = availableSkills.find((item) => item.id === id && item.enabled);
          if (!skill) throw new Error("所选 Skill 已删除或停用，请重新选择");
          return skill;
        });
        const referenceSignal = agentMode === "codex" ? controller.signal : undefined;
        const currentReferences = savedReferences
          ? await hydrateSavedReferences(nodesRef.current, savedReferences, resourceReferenceByID, referenceSignal)
          : [...await referencesForNodeIDs(nodesRef.current, referenceNodeIDs, resourceReferenceByID, referenceSignal), ...await Promise.all(attached.map((item) => referenceSignal ? hydrateCanvasAgentAttachment(item, referenceSignal) : item))];
        const references = [...new Map(currentReferences.map((reference) => [reference.id, reference])).values()];
        const sessionAttachments = canvasAgentSessionAttachments(activeSession.messages, references);
        if (controller.signal.aborted || getCachedAuthSession()?.key !== accountKey || !isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) throw new DOMException("请求已取消", "AbortError");
        const messageReferenceNodeIDs = references.filter((reference) => reference.source !== "attachment").map((reference) => reference.id);
        const now = new Date().toISOString();
        const committedUserMessage = { ...userMessage, references: references.map((item) => ({ ...item, dataUrl: undefined })) };
        if (!updateSessionForRun(sessionID, runEpoch, (current) => {
          const editIndex = options.editUserMessageID ? current.messages.findIndex((message) => message.id === options.editUserMessageID) : -1;
          const messages = options.retryAssistantID ? current.messages
            : editIndex >= 0 ? [...current.messages.slice(0, editIndex), committedUserMessage, preparingMessage]
              : [...current.messages.filter((message) => message.id !== assistantID && message.id !== submittedUserID).map((message) => answeredQuestion ? { ...message, trace: updateCanvasAgentQuestionTrace(message.trace, answeredQuestion.id, { answer: text, cancelled: false }) } : message), committedUserMessage, preparingMessage];
          return { ...current, ...(options.queuedMessageID ? { messageQueue: canvasAgentConsumeQueuedMessage(current.messageQueue, options.queuedMessageID) } : current.messageQueue ? { messageQueue: { ...current.messageQueue, paused: false } } : {}), ...(options.editUserMessageID || agentMode === "native" ? { codexThreadId: undefined, codexServiceId: undefined } : {}), title: current.messages.some((message) => message.role === "user" && message.id !== submittedUserID) ? current.title : text.slice(0, 18) || "新对话", messages, protocolMessages: options.editUserMessageID ? editedProtocolMessages : current.protocolMessages, agentState: options.editUserMessageID ? editBranch!.agentState : current.agentState, contextCheckpoint: options.editUserMessageID ? editBranch!.contextCheckpoint : current.contextCheckpoint, updatedAt: now };
        })) throw new DOMException("请求已取消", "AbortError");
        if (!options.editUserMessageID && !options.preserveDraft) {
          setInput(current => current === nextText ? "" : current);
          draftAttachments.remove(attached.map((item) => item.id));
          setComposerReferenceNodeIDs(current => current.filter(id => !referenceNodeIDs.includes(id)));
          setRemovedReferenceNodeIDs(current => new Set([...current, ...referenceNodeIDs]));
        }
        setEditingUserMessageID("");
        options.onUserMessageCommitted?.();
        if (agentMode === "native") {
          await onPersist();
          controller.signal.throwIfAborted();
          const context = getAgentContext(activeSession.agentState);
          await runBackendCanvasAgent(context.project.id, {
            id: nanoid(), sessionId: sessionID, assistantId: assistantID, userMessageId: submittedUserID,
            userText: text, model, relayTokenName, configuredSystemPrompt,
            apiMode: agentConfig.textApiMode || "responses", stream: agentConfig.textStreaming === true,
            reasoningEnabled: agentConfig.textReasoningEnabled === true, generation: generateMedia ? { ...context.generation, autoGenerateMedia: true } : context.generation,
            relayTokens: { image: tokenNameForModel("image", context.generation.imageModel), audio: tokenNameForModel("audio", context.generation.audioModel) },
            videoRelayTokens: Object.fromEntries(mediaModels.video.options.map((model) => [model, tokenNameForModel("video", model)])),
            references, selectedNodeIds: context.selectedNodeIds, skillIds: selectedSkillIDs,
            resume: Boolean(options.retryAssistantID), editPreviousRequest: Boolean(options.editUserMessageID), mediaGenerationChoice,
          }, (document) => {
            if (!isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) return;
            acceptBackendSnapshot(document);
          }, controller.signal, error => {
            if (isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch) && controller.signal.reason !== "canvas-detached") onSyncError(error.message);
          });
          return;
        }
        let lastToolDocument: CanvasDocument | undefined;
        const acceptToolDocument = (document: CanvasDocument) => {
          if (!isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) return;
          acceptBackendSnapshot(document);
          lastToolDocument = document;
        };
        const runInput: RunCanvasAgentInput = {
          conversationOnly,
          model,
          relayTokenName,
          configuredSystemPrompt,
          apiMode: agentConfig.textApiMode || "responses",
          stream: agentConfig.textStreaming === true,
          reasoningEnabled: (agentConfig.textApiMode || "responses") === "responses" && agentConfig.textReasoningEnabled === true,
          activeSkills,
          contextCheckpoint: editBranch ? editBranch.contextCheckpoint : activeSession.contextCheckpoint,
          initialState: options.editUserMessageID ? { ...editBranch!.agentState, pendingModelTaskId: undefined } : activeSession.agentState,
          protocolMessages: options.editUserMessageID ? editedProtocolMessages : activeSession.protocolMessages,
          protocolMessageID: options.editUserMessageID ? editedUserMessage!.id : submittedUserID,
          userText: text,
          resume: Boolean(options.retryAssistantID || options.editUserMessageID),
          editPreviousRequest: Boolean(options.editUserMessageID),
          mediaGenerationChoice,
          onMediaGenerationChoice: (choice) => { generateMedia = choice === "generate"; },
          onWorkflowReviewAnswer: async (answer) => {
            if (!lastToolDocument || controller.signal.aborted) throw new Error("审核记录已变化，请重新读取工作流");
            await onPersist();
            const prompts = lastToolDocument.agent_run?.toolResult?.reviewPrompts as Record<string, string> | undefined;
            const { document } = await answerBackendWorkflowReview(canvasId, sessionID, prompts || {}, answer);
            acceptToolDocument(document);
            const reviewed = (document.agent_sessions || []).filter(isCanvasAgentSession).find((item) => item.id === sessionID);
            if (!reviewed) throw new Error("审核会话已失效");
            generateMedia = reviewed.agentState.mediaGenerationDeferred === false;
            return reviewed.agentState;
          },
          references,
          getContext: (state) => {
            const context = getAgentContext(state);
            return generateMedia === undefined ? context : { ...context, generation: { ...context.generation, autoGenerateMedia: generateMedia } };
          },
          persist: onPersist,
          executeAction: async (action) => {
            if (controller.signal.aborted || !isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) return { ok: false, code: "run_stale", message: "画布已切换，当前执行已停止" };
            if (action.name !== "delete_node") {
              await onPersist();
              if (controller.signal.aborted) throw new DOMException("操作已取消", "AbortError");
              const currentState = sessionsRef.current.find((item) => item.id === sessionID)?.agentState || mediaState;
              const context = getAgentContext(currentState);
              const { result, document } = await runBackendCanvasTool(canvasId, {
                id: action.id, sessionId: sessionID, assistantId: assistantID, userMessageId: submittedUserID,
                userText: text, model: codex.model, relayTokenName,
                apiMode: agentConfig.textApiMode || "responses", stream: false, reasoningEnabled: false,
                generation: context.generation,
                relayTokens: { image: tokenNameForModel("image", context.generation.imageModel), audio: tokenNameForModel("audio", context.generation.audioModel) },
                videoRelayTokens: Object.fromEntries(mediaModels.video.options.map((model) => [model, tokenNameForModel("video", model)])),
                references: sessionAttachments, selectedNodeIds: context.selectedNodeIds, skillIds: [],
                resume: Boolean(options.retryAssistantID), editPreviousRequest: false,
                ...(generateMedia === undefined ? {} : { mediaGenerationChoice: generateMedia ? "generate" : "defer" }),
              }, action, acceptToolDocument, controller.signal, error => {
                if (isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch) && controller.signal.reason !== "canvas-detached") onSyncError(error.message);
              });
              const updatedSession = (document.agent_sessions || []).filter(isCanvasAgentSession).find((item) => item.id === sessionID);
              return { ...result, ...(updatedSession ? { agentState: updatedSession.agentState } : {}) };
            }
            const nodeIDs = Array.isArray(action.arguments.nodeIds) ? action.arguments.nodeIds as string[] : [typeof action.arguments.nodeId === "string" ? action.arguments.nodeId : ""];
            const deletionSnapshot = JSON.stringify(nodesRef.current);
            const deletionTitle = nodeIDs.map(id => nodesRef.current.find(node => node.id === id)?.title || "未命名节点").join("、");
            updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantID ? setCanvasAgentProcessing(message, false) : message) }));
            const confirmed = await new Promise<boolean>((resolve) => {
              const pending = { title: deletionTitle, resolve };
              pendingDeleteRef.current = pending;
              setPendingDelete(pending);
            });
            if (controller.signal.aborted || !isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) return { ok: false, code: "run_stale", message: "画布已切换，当前执行已停止" };
            updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantID ? setCanvasAgentProcessing(message, true) : message) }));
            if (confirmed && JSON.stringify(nodesRef.current) !== deletionSnapshot) return { ok: false, code: "canvas_changed", message: "画布已变化，请重新核对整批删除范围" };
            return confirmed ? onExecuteAction(action, messageReferenceNodeIDs) : { ok: false, code: "delete_cancelled", message: "用户取消删除，原节点已保留" };
          },
          signal: controller.signal,
          onEvent: (event) => updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantID ? { ...setCanvasAgentProcessing(message, event.status === "thinking" || event.status === "running"), status: event.status, activity: event.label } : message), updatedAt: new Date().toISOString() })),
          onTrace: (entry) => updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantID ? { ...message, trace: entry.type === "operation" ? upsertCanvasAgentOperationTrace(message.trace, entry) : upsertCanvasAgentTrace(message.trace, entry) } : message), updatedAt: new Date().toISOString() })),
          onCheckpoint: (checkpoint) => updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, agentState: checkpoint.state, protocolMessages: checkpoint.protocolMessages, contextCheckpoint: checkpoint.contextCheckpoint, activeSkillIds: selectedSkillIDs, updatedAt: new Date().toISOString() })),
        };
        const result = await codex.run({ ...runInput, codexThreadId: options.editUserMessageID ? undefined : activeSession.codexThreadId, codexServiceId: options.editUserMessageID ? undefined : activeSession.codexServiceId, onThread: (codexThreadId, codexServiceId) => updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, codexThreadId, codexServiceId })) });
        updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, agentState: result.state, protocolMessages: result.protocolMessages, contextCheckpoint: result.contextCheckpoint, activeSkillIds: selectedSkillIDs, messages: current.messages.map((message) => message.id === assistantID ? { ...setCanvasAgentProcessing(message, false), text: result.reply, status: result.state.pendingQuestion || canvasAgentWaitingReason(result.state, result.protocolMessages, nodesRef.current.map((node) => ({ id: node.id, status: node.generation_status }))) || ("waiting" in result && result.waiting) ? "waiting" : "success", activity: undefined } : message), updatedAt: new Date().toISOString() }));
      } catch (error) {
        if (error instanceof CanvasAgentSessionConflictError) {
          updateSessionForRun(sessionID, runEpoch, current => ({ ...current,
            messages: current.messages.map(message => message.id === assistantID ? {
              ...setCanvasAgentProcessing(message, false), status: "waiting", activity: undefined,
              text: "对话在两处发生修改，执行已暂停。请先保留两份对话，再继续。",
            } : message),
          }));
          return;
        }
        if (error instanceof CanvasAgentObservationError) {
          if (isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch) && controller.signal.reason !== "canvas-detached") {
            onSyncError(error.message);
            toast.error(error.message);
          }
          return;
        }
        if (error instanceof CanvasAgentStopError) {
          setPausing(false);
          toast.error(error.message);
          return;
        }
        const stopped = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
        const currentRun = isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch);
        if (assistantID && currentRun && controller.signal.reason !== "canvas-detached") updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, agentState: stopped ? { ...current.agentState, pendingModelTaskId: undefined } : current.agentState, messages: current.messages.map((message) => message.id === assistantID ? { ...setCanvasAgentProcessing(message, false), text: stopped ? "已停止继续执行。已经创建的节点和已经提交的媒体任务会保留。" : error instanceof Error ? error.message : "Agent 执行失败", status: stopped ? "waiting" : "error", activity: undefined } : answeredQuestion && current.agentState.pendingQuestion?.id === answeredQuestion.id ? { ...message, trace: updateCanvasAgentQuestionTrace(message.trace, answeredQuestion.id, { answer: undefined }) } : message), updatedAt: new Date().toISOString() }));
        if (!stopped && currentRun) toast.error(error instanceof Error ? error.message : "Agent 执行失败");
      } finally {
        if (agentMode === "codex" && isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch) && controller.signal.reason !== "canvas-detached") {
          const saving = onPersist();
          if (releaseCanvasAgentRun(abortRef, controller)) setBusy(false);
          await saving.catch((error) => toast.error(error instanceof Error ? error.message : "执行记录保存失败"));
        } else {
          if (releaseCanvasAgentRun(abortRef, controller)) setBusy(false);
        }
      }
    })();
    return "started";
  }

  function updateMessageQueue(update: (queue: CanvasAgentMessageQueue) => CanvasAgentMessageQueue) {
    commit(sessionsRef.current.map(session => session.id === activeSessionIDRef.current ? { ...session, messageQueue: update(session.messageQueue || { paused: false, messages: [] }) } : session));
  }

  function pauseExecution(steering = false) {
    if (pausing) return;
    if (!steering) updateMessageQueue(queue => ({ ...queue, paused: true, steeringId: undefined }));
    setPausing(true);
    settleDeleteConfirmation(false);
    const aborted = abortCanvasAgentRun(abortRef);
    if (!aborted && backendRun?.status === "running") void stopCanvasAgentRun(canvasId, backendRun.id).then(({ document }) => onBackendDocument(document)).catch(error => { setPausing(false); toast.error(error.message); });
    void onPersist().catch(error => toast.error(error instanceof Error ? error.message : "队列保存失败"));
  }

  function sendDraft(prompt = input, referenceIDs = composerReferenceNodeIDs) {
    if (!busy) return submit(prompt, undefined, referenceIDs, {});
    if (pausing || draftAttachments.uploading) return "busy";
    const text = prompt.trim() || (draftAttachments.attachments.length ? "请查看这些附件" : "");
    if (!text) return "empty";
    const current = sessionsRef.current.find(session => session.id === activeSessionIDRef.current);
    if ((current?.messageQueue?.messages.length || 0) >= MAX_AGENT_QUEUED_MESSAGES) { toast.info(`最多排队 ${MAX_AGENT_QUEUED_MESSAGES} 条消息`); return "busy"; }
    const referenceMap = new Map(referenceIDs.flatMap(id => { const node = nodesRef.current.find(item => item.id === id); return node ? [[id, { id, type: node.type, title: node.title || node.type, url: node.url, storageKey: node.storage_key, mimeType: node.mime_type, text: node.prompt } as CanvasAssistantReference] as const] : []; }));
    const queued = { id: nanoid(), text, createdAt: new Date().toISOString(), references: [...referenceMap.values(), ...draftAttachments.attachments.map(item => ({ ...item, dataUrl: undefined }))] };
    updateMessageQueue(queue => ({ ...queue, messages: [...queue.messages, queued] }));
    setInput(""); draftAttachments.clear(); setComposerReferenceNodeIDs([]); setRemovedReferenceNodeIDs(new Set(selectedNodeIDsRef.current));
    void onPersist().catch(error => toast.error(error instanceof Error ? error.message : "队列保存失败，消息仍保留在当前页面"));
    return "queued";
  }

  function steerQueuedMessage(id: string) {
    if (activeSession.agentState.pendingQuestion) { toast.info("请先回答或取消当前问题，再引导对话"); return; }
    updateMessageQueue(queue => {
      const message = queue.messages.find(item => item.id === id);
      return message ? { paused: false, steeringId: id, messages: [message, ...queue.messages.filter(item => item.id !== id)] } : queue;
    });
    if (busy) pauseExecution(true);
  }

  function handleComposerAction() {
    if (composerAction === "pause") return pauseExecution();
    if (composerAction === "send" || composerAction === "enqueue") return void sendDraft();
    if (activeSession.agentState.pendingQuestion) return;
    updateMessageQueue(queue => ({ ...queue, paused: false }));
    if (resumable) {
      const latest = activeSession.messages.findLast(message => message.role === "assistant");
      if (latest) retryMessage(latest);
    } else {
      const next = activeSession.messageQueue?.messages[0];
      if (next) submit(next.text, next.references, [], { queuedMessageID: next.id, preserveDraft: true });
    }
  }

  queueDispatchRef.current = () => {
    if (busy || abortRef.current || draftAttachments.uploading || agentMode === "native" && !relayPreferencesReady || agentMode === "codex" && !codex.connected) return;
    const next = canvasAgentNextQueuedMessage(activeSession, activeRun);
    if (!next) return;
    const result = submit(next.text, next.references, [], { queuedMessageID: next.id, preserveDraft: true, notifyMissingConfiguration: false });
    if (result === "missing-model" || result === "missing-key") {
      updateMessageQueue(queue => ({ ...queue, paused: true, steeringId: undefined }));
      toast.error(result === "missing-key" ? "请先选择文本生成密钥，再继续消息队列" : "请先配置模型，再继续消息队列");
    }
  };
  useEffect(() => { if (pausing && !localBusy && backendRun?.status !== "running") setPausing(false); }, [pausing, localBusy, backendRun?.status]);
  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => { if (!disposed) queueDispatchRef.current(); });
    return () => { disposed = true; };
  }, [activeSession.id, activeSession.messageQueue, activeSession.messages, activeSession.agentState.pendingQuestion, activeRun?.status, activeRun?.assistantId, busy, agentMode, relayPreferencesReady, model, relayTokenName, codex.connected, codex.model, draftAttachments.uploading]);

  function cancelQuestion() {
    if (backendRun?.status === "waiting" && backendRun.sessionId === activeSession.id) {
      void stopCanvasAgentRun(canvasId, backendRun.id).then(({ document }) => onBackendDocument(document)).catch((error) => toast.error(error.message));
      return;
    }
    if (busy || abortRef.current || !activeSession.agentState.pendingQuestion) return;
    const resolved = resolveCanvasAgentQuestion(activeSession.agentState, activeSession.protocolMessages, "", true);
    commit(sessionsRef.current.map((session) => session.id === activeSessionID ? {
      ...session, agentState: resolved.state, protocolMessages: resolved.protocolMessages,
      messages: [...session.messages.map((message) => ({ ...message, trace: updateCanvasAgentQuestionTrace(message.trace, activeSession.agentState.pendingQuestion!.id, { cancelled: true }) })), { id: nanoid(), role: "assistant", text: "已取消本次请求，已完成的内容保留。", status: "success" }], updatedAt: new Date().toISOString(),
    } : session));
  }

  function retryMessage(message: CanvasAssistantMessage, mediaGenerationChoice?: "generate" | "defer", preserveDraft = false) {
    if (activeSession.agentState.pendingQuestion) { toast.info("请先回答当前问题，或取消本次请求"); return false; }
    const index = activeSession.messages.findIndex((item) => item.id === message.id);
    const userMessage = canvasAgentReplyTarget(activeSession.messages, message) || activeSession.messages.slice(0, index).findLast((item) => item.role === "user");
    return userMessage ? submit(userMessage.text, userMessage.references, [], { retryAssistantID: message.id, mediaGenerationChoice, preserveDraft }) === "started" : false;
  }

  function editUserMessage(message: CanvasAssistantMessage) {
    if (message.role !== "user" || message.questionAnswerFor) return;
    if (busy) { toast.info("当前任务仍在运行，请等待停止后再编辑"); return; }
    if (activeSession.agentState.pendingQuestion) { toast.info("请先回答或取消当前问题，再编辑并继续"); return; }
    setEditingUserMessageID(message.id);
  }

  function cancelMessageEdit() {
    if (!busy) setEditingUserMessageID("");
  }

  function chooseMediaGeneration(answer: string) {
    const message = activeSession.messages.findLast((item) => item.role === "assistant");
    if (!message) return false;
    if (answer === "立即生成" || answer === "暂不生成，继续规划") return retryMessage(message, answer === "立即生成" ? "generate" : "defer");
    else {
      const references = activeSession.messages.findLast((item) => item.role === "user")?.references;
      const mediaGenerationChoice = canvasAgentQuestionMediaChoice({ id: "media-generation", purpose: "media_generation", kind: "confirmation", question: "要生成这些节点吗？", reason: "", request: "", options: [] }, answer);
      return submit(answer, references, [], { mediaGenerationChoice }) === "started";
    }
  }

  submitInitialRequestRef.current = (prompt, references, onUserMessageCommitted) => {
    return submit(prompt, references, [], { notifyMissingConfiguration: false, onUserMessageCommitted });
  };

  useEffect(() => {
    if ((agentMode === "native" && !relayPreferencesReady) || !initialRequest || consumedInitialRequestRef.current === initialRequest) return;
    const result = submitInitialRequestRef.current(initialRequest.prompt, initialRequest.references, () => {
      if (initialRequestRef.current !== initialRequest) return;
      consumedInitialRequestRef.current = initialRequest;
      initialRequestBlockerNoticeRef.current = null;
      onInitialRequestConsumedRef.current?.();
    });
    if (result !== "missing-model" && result !== "missing-key") {
      if (result === "started") initialRequestBlockerNoticeRef.current = null;
      return;
    }
    const previous = initialRequestBlockerNoticeRef.current;
    if (previous?.request === initialRequest && previous.reason === result) return;
    initialRequestBlockerNoticeRef.current = { request: initialRequest, reason: result };
    toast.error(result === "missing-model" ? (agentMode === "codex" ? "请先连接本地 Codex 并选择模型" : "请先配置文本模型") : "请先在个人中心选择文本生成密钥");
  }, [agentMode, busy, codex.connected, codex.model, initialRequest, model, relayPreferencesReady, relayTokenName]);

  return <>
    {open && displayMode === "floating" ? <button
      type="button"
      data-canvas-agent-backdrop
      style={{ bottom: "var(--canvas-dock-clearance)" }}
      className="pointer-events-auto absolute inset-0 z-30 bg-slate-950/20 backdrop-blur-[1px] md:hidden"
      aria-label="关闭 Agent"
      onClick={onClose}
    /> : null}
    <Card role="complementary"
    ref={panelRef}
    aria-label="Agent 对话面板"
    aria-hidden={!open}
    inert={!open}
    data-canvas-agent-panel
    data-display-mode={displayMode}
    data-state={open ? "open" : "closed"}
    className={cn("absolute z-40 flex min-h-0 flex-col overflow-hidden [container-name:agent] [container-type:size] motion-reduce:!transition-none p-0 gap-0", displayMode === "docked"
    ? "top-0 bottom-[var(--canvas-agent-docked-bottom)] right-0" : "bottom-[var(--canvas-agent-bottom)] right-3 max-w-[calc(100%-1.5rem)] h-[min(880px,calc(100%-var(--canvas-agent-bottom)-1rem))] sm:right-4 sm:max-w-[calc(100%-2rem)] [@media(max-height:540px)]:fixed [@media(max-height:540px)]:h-[min(880px,calc(100dvh-var(--canvas-dock-clearance)-2rem))] [@media(max-height:540px)]:bottom-[calc(var(--canvas-dock-clearance)+1rem)] [@media(max-height:540px)]:z-[45]")}
    style={{
      width: displayMode === "docked" ? "var(--canvas-agent-width)" : `min(${CANVAS_AGENT_WIDTH}px, calc(100% - 12px))`,
      transform: open ? "translateX(0)" : "translateX(calc(100% + 16px))",
      translate: panelDrag.translate,
      opacity: open ? 1 : 0,
      pointerEvents: open ? "auto" : "none",
      transition: panelDrag.dragging ? "none" : "transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease",
    }}
  >
    <header
      data-canvas-agent-drag-handle
      title={displayMode === "floating" ? "拖动移动面板，方向键微调" : undefined}
      aria-label={displayMode === "floating" ? "移动 Agent 面板" : undefined}
      tabIndex={displayMode === "floating" ? 0 : undefined}
      onPointerDown={panelDrag.startDrag}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const direction = ({ ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] } as Record<string, number[]>)[event.key];
        if (!direction || displayMode !== "floating") return;
        event.preventDefault();
        event.stopPropagation();
        panelDrag.moveBy(direction[0], direction[1]);
      }}
      className={cn("flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-3", displayMode === "floating" && "touch-none select-none cursor-grab", panelDrag.dragging && "cursor-grabbing")}>
      <ItemMedia variant="icon" className="grid size-8 shrink-0 place-items-center"><Bot className="size-4" /></ItemMedia>
      <div className="min-w-0 flex-1"><span title={view === "history" ? "历史对话" : activeSession.title || "Agent"} className="block truncate text-sm font-semibold">{view === "history" ? "历史对话" : activeSession.title || "Agent"}</span><span className="block truncate text-[10px] leading-4 text-muted-foreground">{view === "history" ? "回顾你的创作过程" : "画布创作助手"}</span></div>
      <div data-canvas-agent-toolbar role="group" aria-label="Agent 工具栏" className="ml-auto flex shrink-0 items-center gap-0.5 @max-[320px]/agent:[&_button]:size-7">
        <TooltipHint content={"新对话"}><Button size="icon"  variant="ghost" aria-label="新对话" disabled={busy} onClick={newSession}><MessageCirclePlus /></Button></TooltipHint>
        <TooltipHint content={view === "history" ? "返回对话" : "历史记录"}><Button size="icon"  variant={view === "history" ? "secondary" : "ghost"} aria-label={view === "history" ? "返回对话" : "历史记录"} onClick={() => setView((current) => current === "history" ? "chat" : "history")}><Clock /></Button></TooltipHint>
        <CanvasAgentRunSettings config={agentConfig} mode={agentMode} busy={busy} onChange={(patch) => {
          if (typeof patch.autoGenerateMedia === "boolean") commit(sessionsRef.current.map((session) => session.id === activeSession.id ? { ...session, agentState: { ...session.agentState, mediaGenerationDeferred: undefined } } : session));
          onAgentConfigChange(patch);
        }} />
        <CanvasAgentEnginePicker
          mode={agentMode}
          disabled={busy || Boolean(activeSession.agentState.pendingQuestion)}
          connected={codex.connected}
          connecting={codex.connecting}
          error={Boolean(codex.error)}
          onModeChange={changeAgentMode}
          onConfigure={() => setCodexSettingsOpen(true)}
        />
        <TooltipHint content={displayMode === "docked" ? "切换为悬浮" : "切换为停靠"}><span className="inline-flex shrink-0"><Toggle size="sm"   aria-label={displayMode === "docked" ? "切换为悬浮" : "切换为停靠"} pressed={displayMode === "docked"} onMouseDown={(event) => event.preventDefault()} onClick={() => onDisplayModeChange(displayMode === "docked" ? "floating" : "docked")}>{displayMode === "docked" ? <PanelsTopLeft /> : <PanelRight />}</Toggle></span></TooltipHint>
        <TooltipHint content={"收起对话"}><Button size="icon"  variant="ghost" aria-label="收起 Agent" onClick={onClose}><Minus /></Button></TooltipHint>
      </div>
    </header>
    {historyConflict ? <Alert className="shrink-0" data-agent-history-conflict><AlertTitle>同一对话在两处发生修改</AlertTitle><AlertDescription><p>本页修改尚未保存，另一处记录已保留。将本页版本另存为新对话后，可以分别查看和继续。</p><Button type="button" size="sm" variant="outline" className="mt-2" disabled={busy || resolvingHistoryConflict} onClick={onResolveHistoryConflict}>{resolvingHistoryConflict ? "正在保存两份对话" : "保留两份对话"}</Button></AlertDescription></Alert> : syncError ? <Alert variant="destructive" className="shrink-0" data-agent-sync-error><AlertTitle>Agent 进度暂未同步</AlertTitle><AlertDescription><p>{syncError}</p><p>已保留最近记录，正在重新读取原任务进度。</p></AlertDescription></Alert> : null}
    {agentMode === "codex" ? <CanvasCodexConnect agent={codex} busy={busy} open={open && codexSettingsOpen} onOpenChange={setCodexSettingsOpen} /> : null}
    {view === "history" ? <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-2">
      <span className="min-w-0 flex-1 text-[11px] tabular-nums text-muted-foreground">{checkedSessionIDs.length ? `已选 ${checkedSessionIDs.length} 条` : `共 ${historySessions.length} 条对话`}</span>
      <Button size="sm"  variant="ghost" aria-label="删除所选对话" disabled={busy || !checkedSessionIDs.length} onClick={() => setDeleteSessionIDs(checkedSessionIDs)}><Trash2  />删除所选</Button>
      <Button size="sm"  variant="ghost" aria-label="删除全部对话" disabled={busy || !historySessions.length} onClick={() => setDeleteSessionIDs(historySessions.map((item) => item.id))}>清空</Button>
    </div> : null}
    <Conversation key={activeSession.id} showScrollButton={view === "chat"} onWheel={(event) => event.stopPropagation()}>
      {view === "history" ? <AssistantHistory sessions={historySessions} activeSession={activeSession} checkedIDs={checkedSessionIDs} deleteDisabled={busy} onToggleChecked={(id, checked) => setCheckedSessionIDs((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id))} onOpen={(id) => void openHistorySession(id)} onDelete={(id) => setDeleteSessionIDs([id])} onRename={(id, nextTitle) => void openHistorySession(id, nextTitle)} /> : activeSession.messages.length ? <CanvasAgentConversation
        run={activeRun}
        resumable={resumable}
        onResume={() => { if (latestAssistantMessage) retryMessage(latestAssistantMessage, undefined, true); }}
        onChooseMedia={() => chooseMediaGeneration("立即生成")}
        protocolMessages={activeSession.protocolMessages}
        messages={activeSession.messages}
        nodes={nodes}
        onFocusNode={onFocusNode}
        onRetry={(message) => { retryMessage(message, undefined, true); }}
        onEdit={editUserMessage}
        editingMessageID={editingUserMessageID}
        onCancelEdit={cancelMessageEdit}
        onSaveEdit={(message, text) => { void submit(text, message.references || [], [], { editUserMessageID: message.id }); }}
        editDisabled={busy || Boolean(activeSession.agentState.pendingQuestion)}
        busy={busy}
        pendingQuestion={activeSession.agentState.pendingQuestion?.question}
      /> : <EmptyState icon={agentMode === "codex" ? Terminal : Sparkles} title={agentMode === "codex" && !codex.connected ? "与 Codex 一起创作" : "从一个想法开始"} description="描述创作目标，Agent 会与你沟通并直接操作当前画布" action={<div className="grid w-full gap-3">{agentMode === "codex" && !codex.connected ? <Button type="button" size="sm" variant="outline" onClick={() => setCodexSettingsOpen(true)}><Plug />{codex.connecting ? "查看连接进度" : "连接 Codex"}</Button> : null}{!input.trim() && (agentMode !== "codex" || codex.connected) ? <Suggestions className="mt-5 grid w-full gap-2 text-left">{["帮我整理当前画布的创作思路", "规划一组风格统一的品牌海报", "把当前创意拆解成分镜方案"].map((suggestion) => <Suggestion key={suggestion} suggestion={suggestion} className="text-left justify-start h-auto min-h-8 whitespace-normal py-2" onClick={(prompt) => { setInput(prompt); requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')?.focus()); }} />)}</Suggestions> : null}</div>} />}
    </Conversation>
    {view === "chat" ? <div data-agent-input-area className="flex min-h-0 max-h-[70%] shrink-0 flex-col border-t border-border/40 bg-card p-3">
      <ScrollArea data-agent-controls-scroll className="min-h-0 max-h-[min(8rem,18cqh)] shrink" contentClassName="space-y-2">
      <CanvasAgentQueuedMessages queue={activeSession.messageQueue} disabled={pausing} onSteer={steerQueuedMessage} onRemove={id => { updateMessageQueue(queue => ({ ...queue, steeringId: queue.steeringId === id ? undefined : queue.steeringId, messages: queue.messages.filter(item => item.id !== id) })); void onPersist().catch(error => toast.error(error.message)); }} />
      </ScrollArea>
      {pendingDelete ? <Confirmation title={`删除“${pendingDelete.title}”？`} description="相关连线和任务记录将按现有逻辑清理" confirmation actions={<><Button variant="outline" size="sm" type="button" onClick={() => settleDeleteConfirmation(false)}>取消</Button><Button variant="destructive" size="sm" type="button" onClick={() => settleDeleteConfirmation(true)}>确认删除</Button></>} /> : null}
      {activeSession.agentState.pendingQuestion && !(busy && activeSession.messages.some((message) => message.questionAnswerFor === activeSession.agentState.pendingQuestion?.id)) ? <CanvasAgentQuestionCard key={`${activeSession.id}:${activeSession.agentState.pendingQuestion.id}`} question={activeSession.agentState.pendingQuestion} busy={busy} active={open && view === "chat"} onAnswer={(answer) => submit(answer, undefined, composerReferenceNodeIDs, { mediaGenerationChoice: canvasAgentQuestionMediaChoice(activeSession.agentState.pendingQuestion!, answer) }) === "started"} onCancel={cancelQuestion} /> : needsMediaChoice && !editingUserMessageID ? <CanvasAgentQuestionCard key={`${activeSession.id}:media-generation`} question={canvasAgentMediaGenerationQuestion(`${activeSession.id}:media-generation`, Number(mediaWaitingReason.match(/(\d+) 个节点/)?.[1] || 1))} busy={busy} active={open && view === "chat" && !editingUserMessageID} onAnswer={chooseMediaGeneration} /> : null}
      <PromptInput className="shrink-0" onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); } }} onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); event.stopPropagation(); void draftAttachments.upload(Array.from(event.dataTransfer.files)); }}>
        <ScrollAreaRoot data-agent-composer-scroll data-slot="scroll-area" className="group/scroll-area relative flex min-h-0 min-w-0 w-full flex-col overflow-hidden max-h-[min(220px,24cqh)]" onWheel={(event) => { event.stopPropagation(); }}><ScrollAreaViewport data-slot="scroll-area-viewport" className="scroll-area-viewport relative min-h-0 min-w-0 w-full flex-1 overflow-auto overscroll-contain"><div className="min-w-0">
        <CanvasAgentPromptChipInput
          value={input}
          references={resourceReferences}
          pendingReferences={pendingReferences}
          attachments={draftAttachments.attachments}
          onRemoveAttachments={draftAttachments.remove}
          onChange={setInput}
          onReferenceIDsChange={(ids) => {
            consumedReferenceNodeClickVersionRef.current = referenceNodeClick.version;
            const removedSelectedIDs = composerReferenceNodeIDs.filter((id) => selectedNodeIDsRef.current.includes(id) && !ids.includes(id));
            if (removedSelectedIDs.length) setRemovedReferenceNodeIDs((current) => new Set([...current, ...removedSelectedIDs]));
            setComposerReferenceNodeIDs(ids);
          }}
          onPasteImage={(file) => { void draftAttachments.upload([file]); }}
          onSubmit={(prompt, referenceIDs) => void sendDraft(prompt, referenceIDs)}
          className="min-h-[min(6rem,18cqh)] w-full px-2.5 py-2 text-base md:text-sm"
          placeholder={activeSession.agentState.pendingQuestion ? "回答上方问题，或补充新的要求" : statusNeedsReview ? "先核对画布和任务状态，再继续" : busy ? "Agent 正在执行，发送后将加入队列" : "开始你的创作，或 @ 引用资源"}
        />
        </div></ScrollAreaViewport><ScrollBar /><ScrollBar orientation="horizontal" /></ScrollAreaRoot>
        {draftAttachments.uploading ? <LoadingState compact className="mt-1 shrink-0" label="附件上传中…" /> : null}
        <PromptInputFooter data-canvas-agent-composer-toolbar>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1">
          <CanvasAgentAssetMenu disabled={pausing} uploading={draftAttachments.uploading} onUpload={() => attachmentInputRef.current?.click()} onOpenAssets={() => setAttachmentPickerOpen(true)} />
          <CanvasAgentModelPicker model={agentMode === "codex" ? codex.model : model} models={agentMode === "codex" ? (codex.connected ? codex.models.map((item) => ({ value: item.model, label: item.displayName })) : []) : models.map((value) => ({ value, label: value }))} codex={agentMode === "codex"} disabled={busy || Boolean(activeSession.agentState.pendingQuestion)} onChange={agentMode === "codex" ? codex.setModel : onModelChange} />
          <CanvasAgentMediaModelPicker models={mediaModels} disabled={busy || Boolean(activeSession.agentState.pendingQuestion)} />
          <CanvasAgentSkillPicker compact selectedIds={activeSession.activeSkillIds ?? agentConfig.activeSkillIds ?? []} onChange={(activeSkillIds) => commit(sessionsRef.current.map((item) => item.id === activeSessionID ? { ...item, activeSkillIds, updatedAt: new Date().toISOString() } : item))} disabled={busy} />
          <Context tokens={contextInfo.tokens} error={contextInfo.error} limit={contextInfo.limit} compacting={contextInfo.compacting} reported={contextInfo.reported} measured={contextInfo.measured} rows={contextInfo.rows} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
          {busy && hasDraft ? <TooltipHint content="暂停执行"><Button type="button" size="icon-sm" variant="ghost" aria-label="暂停执行" disabled={pausing} onClick={() => pauseExecution()}><Pause /></Button></TooltipHint> : null}
          <TooltipHint content={composerActionLabel}><PromptInputSubmit disabled={pausing || (composerAction !== "pause" && draftAttachments.uploading) || (composerAction === "send" && !hasDraft)} aria-busy={pausing} aria-label={composerActionLabel} onClick={handleComposerAction}>{composerAction === "pause" ? <Pause /> : composerAction === "resume" ? <Play /> : <ArrowUp />}</PromptInputSubmit></TooltipHint>
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div> : null}
    <ConfirmDialog open={deleteSessionIDs.length > 0} onOpenChange={(open) => !open && setDeleteSessionIDs([])} title="删除对话记录？" description={`将删除 ${deleteSessionIDs.length} 条对话记录，此操作不可撤销。`} confirmLabel="删除" destructive busy={busy} onConfirm={() => { if (busy) return; removeSessions(deleteSessionIDs); setDeleteSessionIDs([]); }} />
    <input ref={attachmentInputRef} type="file" multiple accept="image/*,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/x-wav" aria-label="上传 Agent 附件" className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; void draftAttachments.upload(files); }} />
    {attachmentPickerOpen && authSession ? <Suspense fallback={<span role="status" className="sr-only">正在加载素材库</span>}><CanvasAgentAssetPicker open session={authSession} onInsert={(payload) => { draftAttachments.add(payload); setAttachmentPickerOpen(false); }} onClose={() => setAttachmentPickerOpen(false)} /></Suspense> : null}
    {codexApproval.dialog}
    </Card>
  </>;
}

function AssistantHistory({ sessions, activeSession, checkedIDs, deleteDisabled, onToggleChecked, onOpen, onDelete, onRename }: { sessions: CanvasAgentSessionSummary[]; activeSession: CanvasAssistantSession; checkedIDs: string[]; deleteDisabled: boolean; onToggleChecked: (id: string, checked: boolean) => void; onOpen: (id: string) => void; onDelete: (id: string) => void; onRename: (id: string, title: string) => void }) {
  const [editingID, setEditingID] = useState("");
  if (!sessions.length) return <EmptyState icon={History} title="暂无历史对话" compact />;
  return <div className="space-y-1">{sessions.map((item) => <Item variant={item.id === activeSession.id ? "muted" : "default"} key={item.id} className="group flex items-center gap-2 px-2 py-1.5"><Checkbox className="shrink-0" aria-label={`选择对话 ${item.title}`} checked={checkedIDs.includes(item.id)} onCheckedChange={(checked) => onToggleChecked(item.id, checked === true)} /><div className="min-w-0 flex-1">{editingID === item.id ? <Input aria-label="对话名称" className="w-full px-1" defaultValue={item.title} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = item.title; setEditingID(""); } }} onBlur={(event) => { const nextTitle = event.target.value.trim(); if (nextTitle) onRename(item.id, nextTitle); setEditingID(""); }} /> : <Button variant="ghost" type="button" className="w-full flex-col items-start text-left h-auto min-h-8 whitespace-normal py-2" disabled={deleteDisabled} onClick={() => onOpen(item.id)}><span className="block truncate">{item.title}</span><span className="text-xs text-muted-foreground">{item.message_count} 条消息</span></Button>}</div><TooltipHint content={"重命名"}><Button size="icon" variant="ghost"  aria-label={`重命名对话 ${item.title}`} disabled={deleteDisabled} onClick={() => setEditingID(item.id)}><Pencil  /></Button></TooltipHint><TooltipHint content={"删除"}><Button size="icon" variant="ghost" className="sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" aria-label={`删除对话 ${item.title}`} disabled={deleteDisabled} onClick={() => onDelete(item.id)}><Trash2  /></Button></TooltipHint></Item>)}</div>;
}

async function referencesForNodeIDs(nodes: CanvasNode[], nodeIDs: readonly string[], referenceByID: ReadonlyMap<string, CanvasResourceReference>, signal?: AbortSignal): Promise<CanvasAssistantReference[]> {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  return Promise.all(nodeIDs.flatMap((nodeID) => {
    const node = nodeByID.get(nodeID);
    const reference = referenceByID.get(nodeID);
    return node && reference ? [canvasAgentReferenceFromNode(node, reference.label, signal)] : [];
  }));
}

async function hydrateSavedReferences(nodes: CanvasNode[], references: readonly CanvasAssistantReference[], referenceByID: ReadonlyMap<string, CanvasResourceReference>, signal?: AbortSignal) {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  return Promise.all(references.map(async (reference) => {
    if (reference.source === "attachment" && signal) return hydrateCanvasAgentAttachment(reference, signal);
    const node = nodeByID.get(reference.id);
    return node && referenceByID.has(reference.id) ? canvasAgentReferenceFromNode(node, referenceByID.get(reference.id)?.label || reference.label, signal) : reference;
  }));
}

async function canvasAgentReferenceFromNode(node: CanvasNode, label?: string, signal?: AbortSignal): Promise<CanvasAssistantReference> {
  const reference: CanvasAssistantReference = { id: node.id, type: node.type, title: node.title || node.type, label: label || node.title || node.id, url: node.url, storageKey: node.storage_key, mimeType: node.mime_type };
  if (signal && (node.type === "image" || node.type === "panorama") && node.url) {
    reference.dataUrl = await canvasAgentImageURL(reference, signal);
  }
  return reference;
}
