import { isCanvasAgentConversation } from "./agent/canvas-agent-conversation";
import { CanvasAgentResumeNotice } from "./canvas-agent-resume-notice";
import { CanvasAgentTaskProcess } from "./canvas-agent-task-process";
import { canvasAgentTaskGroups } from "./agent/canvas-agent-task-groups";
import { canvasAgentTaskTimings } from "./agent/canvas-agent-timing";
import { setCanvasAgentProcessing } from "./agent/canvas-agent-timing";
import { isCanvasAgentSession } from "./agent/canvas-agent-sessions";
import { answerBackendWorkflowReview, runBackendCanvasAgent, runBackendCanvasTool, stopCanvasAgentRun } from "./agent/canvas-agent-backend";
import { copyClipboardText } from "@/lib/clipboard-text";
import { CanvasAgentMessageEditor } from "./canvas-agent-message-editor";
import { useCanvasAgentScroll } from "./use-canvas-agent-scroll";
import { CanvasAgentAssetMenu, CanvasAgentComposer, CanvasAgentComposerToolbar, CanvasAgentSendButton } from "./canvas-agent-composer";
import { CanvasAgentPlanProgress, CanvasAgentQuestionCard } from "./canvas-agent-interaction";
import { canvasAgentMediaGenerationQuestion, canvasAgentQuestionMediaChoice, resolveCanvasAgentQuestion } from "./agent/canvas-agent-interaction";
import { canvasAgentToolKind, updateCanvasAgentQuestionTrace, upsertCanvasAgentOperationTrace, upsertCanvasAgentTrace } from "./agent/canvas-agent-trace";
import { canvasAgentEditBranch, canvasAgentReplyTarget } from "./agent/canvas-agent-message-links";
import { pendingCanvasAgentReferences } from "./agent/canvas-agent-reference";
import { CanvasAgentAttachments } from "./canvas-agent-attachments";
import { useCanvasAgentPanelDrag } from "./use-canvas-agent-panel-drag";
import { useCanvasAgentAttachments } from "./use-canvas-agent-attachments";
import { canvasAgentSessionAttachments, canvasAgentImageURL, hydrateCanvasAgentAttachment } from "./agent/canvas-agent-attachments";
import { canCreateCanvasAgentSession, MAX_CANVAS_AGENT_SESSIONS } from "./agent/canvas-agent-sessions";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { nanoid } from "nanoid";
import { ArrowDown, ArrowUp, Bot, Copy, Pencil, History, Clock, Minus, LoaderCircle, MessageCirclePlus, PanelRight, PanelsTopLeft, Plug, RotateCcw, Sparkles, Square, Terminal, Trash2 } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
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
import type { CanvasAgentConfig, CanvasAgentProtocolMessage, CanvasAssistantMessage, CanvasAssistantReference, CanvasAssistantSession } from "@/app/canvas/agent/canvas-agent-types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CANVAS_AGENT_WIDTH } from "./canvas-workspace-layout";
import { CanvasAgentMediaModelPicker, type CanvasAgentMediaModels } from "./canvas-agent-media-model-picker";
import { CanvasAgentExecutionTrace } from "./canvas-agent-execution-trace";
import { CanvasAgentNodeChip } from "./canvas-agent-node-chip";
import { CanvasAgentModelPicker } from "./canvas-agent-model-picker";
import { CanvasAgentEnginePicker } from "./canvas-agent-engine-picker";
import { useRelayTokenPreferences } from "@/lib/use-relay-token-preferences";
import { cn } from "@/lib/utils";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import type { CanvasNode, CanvasDocument } from "@/services/api/canvas";

export type { CanvasAgentAction, CanvasAgentToolResult } from "@/app/canvas/agent/canvas-agent-tools";

function createSession(): CanvasAssistantSession {
  const now = new Date().toISOString();
  return { id: nanoid(), title: "新对话", messages: [], agentState: createCanvasAgentState(), protocolMessages: [], createdAt: now, updatedAt: now };
}

type PendingDeleteConfirmation = { title: string; resolve: (confirmed: boolean) => void };
type CanvasAgentSubmitResult = "started" | "empty" | "busy" | "missing-model" | "missing-key";
type CanvasAgentSubmitOptions = {
  retryAssistantID?: string;
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

export function CanvasAgentPanel({ backendRun, onBackendDocument, open, nodes, selectedNodeIDs, referenceNodeClick, model, models, onModelChange, mediaModels, configuredSystemPrompt, initialSessions, initialActiveSessionID, initialRequest, agentConfig, displayMode, onDisplayModeChange, getAgentContext, onSessionsChange, onPersist, onAgentConfigChange, onExecuteAction, onInitialRequestConsumed, onFocusNode, onClose }: {
  backendRun?: CanvasDocument["agent_run"];
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
  initialActiveSessionID?: string;
  initialRequest?: CanvasAgentInitialRequest | null;
  agentConfig: CanvasAgentConfig;
  displayMode: "floating" | "docked";
  onDisplayModeChange: (mode: "floating" | "docked") => void;
  getAgentContext: (state: CanvasAssistantSession["agentState"]) => CanvasAgentContext;
  onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionID: string) => void;
  onPersist: () => Promise<void>;
  onAgentConfigChange: (patch: Partial<CanvasAgentConfig>) => void;
  onExecuteAction: (action: CanvasAgentAction, messageReferenceNodeIDs: string[], execution?: { onProgress?: (result: CanvasAgentToolResult) => void; waitForMedia?: boolean; generateMedia?: boolean; attachments?: CanvasAssistantReference[]; signal?: AbortSignal }) => Promise<CanvasAgentToolResult>;
  onInitialRequestConsumed?: () => void;
  onFocusNode?: (nodeID: string) => void;
  onClose: () => void;
}) {
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
  const busy = localBusy || backendRun?.status === "running";
  const [agentMode, setAgentMode] = useState<"native" | "codex">(() => sessions.find((item) => item.id === activeSessionID)?.engine || "native");
  const [codexSettingsOpen, setCodexSettingsOpen] = useState(false);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [checkedSessionIDs, setCheckedSessionIDs] = useState<string[]>([]);
  const [deleteSessionIDs, setDeleteSessionIDs] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteConfirmation | null>(null);
  const [composerReferenceNodeIDs, setComposerReferenceNodeIDs] = useState<string[]>([]);
  const [removedReferenceNodeIDs, setRemovedReferenceNodeIDs] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLElement | null>(null);
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
  const recoverRunRef = useRef<() => void>(() => {});
  const recoveryAttemptsRef = useRef(new Set<string>());
  const sessionsRef = useRef(sessions);
  const activeSessionIDRef = useRef(activeSessionID);
  const nodesRef = useRef(nodes);
  const selectedNodeIDsRef = useRef(selectedNodeIDs);
  nodesRef.current = nodes;
  selectedNodeIDsRef.current = selectedNodeIDs;
  initialRequestRef.current = initialRequest;
  onInitialRequestConsumedRef.current = onInitialRequestConsumed;
  const activeSession = sessions.find((item) => item.id === activeSessionID) || sessions[0];
  const messageScroll = useCanvasAgentScroll(activeSession.id, open && view === "chat");
  const waitingReason = canvasAgentWaitingReason(activeSession.agentState, activeSession.protocolMessages, nodes.map((node) => ({ id: node.id, status: node.generation_status })));
  const mediaWaitingReason = canvasAgentWaitingReason({ ...activeSession.agentState, mediaGenerationDeferred: false }, activeSession.protocolMessages, nodes.map((node) => ({ id: node.id, status: node.generation_status })));
  const conversationReply = activeSession.messages.findLast((message) => message.role === "assistant")?.interactionMode === "conversation";
  const needsMediaChoice = !conversationReply && !busy && !activeSession.agentState.pendingQuestion && !activeSession.agentState.mediaGenerationDeferred && mediaWaitingReason.startsWith("待手动生成");
  const [canvasId] = useState(() => getAgentContext(activeSession.agentState).project.id);
  const codexApproval = useCanvasCodexApproval();
  const codex = useCanvasCodexAgent({ canvasId, onDisconnect: (reason) => { abortCanvasAgentRun(abortRef, reason); settleDeleteConfirmation(false); }, executeAction: executeExternalAction, ask: codexApproval.ask });
  const historySessions = sessions.filter((item) => item.messages.length > 0);
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
      pendingDeleteRef.current?.resolve(false);
      pendingDeleteRef.current = null;
    };
  }, []);

  async function executeExternalAction(action: CanvasAgentAction, signal: AbortSignal) {
    if (abortRef.current || busy || activeSession.agentState.pendingQuestion) return { ok: false, code: "agent_busy", message: "请先完成当前对话或待回答问题，再执行 MCP 操作" };
    if (!["list_workflows", "get_workflow", "save_workflow", "run_saved_workflow", "create_canvas_workflow", "run_canvas_workflow"].includes(action.name)) return onExecuteAction(action, [], { waitForMedia: false });
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
      sessionsRef.current = (document.agent_sessions || []).filter(isCanvasAgentSession);
      onBackendDocument(document);
    };
    try {
      await onPersist();
      runSignal.throwIfAborted();
      const context = getAgentContext(activeSession.agentState);
      const { result, document } = await runBackendCanvasTool(canvasId, {
        id: action.id, sessionId: sessionID, assistantId: assistantID, userMessageId: "", userText: requestText,
        model: "", relayTokenName: "", apiMode: "responses", stream: false, reasoningEnabled: false,
        generation: context.generation,
        relayTokens: { image: tokenNameForModel("image", context.generation.imageModel), video: tokenNameForModel("video", context.generation.videoModel), audio: tokenNameForModel("audio", context.generation.audioModel) },
        references: canvasAgentSessionAttachments(activeSession.messages, []), selectedNodeIds: context.selectedNodeIds, skillIds: [], resume: false, editPreviousRequest: false,
      }, action, acceptDocument, runSignal);
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

  function commit(next: CanvasAssistantSession[], nextActiveID = activeSessionIDRef.current) {
    sessionsRef.current = next;
    activeSessionIDRef.current = nextActiveID;
    onSessionsChange(next, nextActiveID);
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
    if (activeSession?.messages.length && !canCreateCanvasAgentSession(sessionsRef.current)) {
      toast.info(`每个画布最多保存 ${MAX_CANVAS_AGENT_SESSIONS} 个对话，请先删除不需要的历史对话`);
      setView("history");
      return;
    }
    draftAttachments.clear();
    setInput("");
    setEditingUserMessageID("");
    setComposerReferenceNodeIDs([]);
    setRemovedReferenceNodeIDs(new Set());
    if (activeSession && !activeSession.messages.length) {
      setView("chat");
      return commit(sessionsRef.current, activeSession.id);
    }
    const next = { ...createSession(), activeSkillIds: [] };
    commit([next, ...sessionsRef.current], next.id);
    setView("chat");
  }

  function removeSessions(sessionIDs: string[]) {
    if (busy) return;
    const next = sessionsRef.current.filter((item) => !sessionIDs.includes(item.id));
    if (!next.length) {
      const replacement = createSession();
      commit([replacement], replacement.id);
    } else {
      commit(next, sessionIDs.includes(activeSessionIDRef.current) ? next[0].id : activeSessionIDRef.current);
    }
    if (sessionIDs.includes(activeSessionID)) { setInput(""); setEditingUserMessageID(""); draftAttachments.clear(); setComposerReferenceNodeIDs([]); setRemovedReferenceNodeIDs(new Set()); }
    setCheckedSessionIDs((current) => current.filter((sessionID) => !sessionIDs.includes(sessionID)));
  }

  function submit(nextText = input, savedReferences?: CanvasAssistantReference[], referenceNodeIDs = composerReferenceNodeIDs, options: CanvasAgentSubmitOptions = {}): CanvasAgentSubmitResult {
    if (draftAttachments.uploading) return "busy";
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
    const runEpoch = beginCanvasAgentRunEpoch(runLifecycleRef.current);
    const sessionID = activeSession.id;
    const editedProtocolMessages = editBranch?.protocolMessages || activeSession.protocolMessages;
    const accountKey = getCachedAuthSession()?.key;
    setBusy(true);
    messageScroll.scrollToLatest();
    const assistantID = options.retryAssistantID || nanoid();
    const submittedUserID = editedUserMessage?.id || nanoid();
    const replyTarget = retryAssistantMessage ? canvasAgentReplyTarget(activeSession.messages, retryAssistantMessage) : undefined;
    const answeredQuestion = activeSession.agentState.pendingQuestion;
    const userMessage: CanvasAssistantMessage = { id: submittedUserID, role: "user", text, ...(answeredQuestion ? { questionAnswerFor: answeredQuestion.id } : {}), ...(!answeredQuestion ? { agentStateBefore: editBranch?.agentState || structuredClone(activeSession.agentState), contextCheckpointBefore: editBranch ? editBranch.contextCheckpoint : activeSession.contextCheckpoint } : {}), status: "success" };
    const conversationOnly = isCanvasAgentConversation(text) && !activeSession.agentState.pendingQuestion && !referenceNodeIDs.length && !attached.length && !savedReferences?.length && !(activeSession.activeSkillIds ?? agentConfig.activeSkillIds ?? []).length && !options.mediaGenerationChoice;
    const preparingMessage: CanvasAssistantMessage = { id: assistantID, role: "assistant", replyToMessageID: replyTarget?.id || submittedUserID, text: "", ...(conversationOnly ? { interactionMode: "conversation" as const } : {}), trace: retryAssistantMessage?.trace || [], elapsedMs: retryAssistantMessage?.elapsedMs || 0, processingStartedAt: Date.now(), status: "thinking", activity: options.retryAssistantID ? "正在恢复原对话" : attached.length || referenceNodeIDs.length || savedReferences?.length ? "正在读取引用素材" : "正在发送" };
    updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, engine: agentMode, resumeAssistantMessageId: undefined, messages: options.retryAssistantID ? current.messages.map((message) => message.id === assistantID ? preparingMessage : message) : [...current.messages, ...(options.editUserMessageID ? [] : [userMessage]), preparingMessage] }));
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
          return { ...current, ...(options.editUserMessageID || agentMode === "native" ? { codexThreadId: undefined, codexServiceId: undefined } : {}), title: current.messages.some((message) => message.role === "user" && message.id !== submittedUserID) ? current.title : text.slice(0, 18) || "新对话", messages, protocolMessages: options.editUserMessageID ? editedProtocolMessages : current.protocolMessages, agentState: options.editUserMessageID ? editBranch!.agentState : current.agentState, contextCheckpoint: options.editUserMessageID ? editBranch!.contextCheckpoint : current.contextCheckpoint, updatedAt: now };
        })) throw new DOMException("请求已取消", "AbortError");
        if (!options.editUserMessageID) {
          setInput("");
          draftAttachments.remove(attached.map((item) => item.id));
          setComposerReferenceNodeIDs([]);
          setRemovedReferenceNodeIDs(new Set(selectedNodeIDsRef.current));
        }
        setEditingUserMessageID("");
        options.onUserMessageCommitted?.();
        if (agentMode === "native") {
          await onPersist();
          const context = getAgentContext(activeSession.agentState);
          await runBackendCanvasAgent(context.project.id, {
            id: nanoid(), sessionId: sessionID, assistantId: assistantID, userMessageId: submittedUserID,
            userText: text, model, relayTokenName, configuredSystemPrompt,
            apiMode: agentConfig.textApiMode || "responses", stream: agentConfig.textStreaming === true,
            reasoningEnabled: agentConfig.textReasoningEnabled === true, generation: context.generation,
            relayTokens: { image: tokenNameForModel("image", context.generation.imageModel), video: tokenNameForModel("video", context.generation.videoModel), audio: tokenNameForModel("audio", context.generation.audioModel) },
            references, selectedNodeIds: context.selectedNodeIds, skillIds: selectedSkillIDs,
            resume: Boolean(options.retryAssistantID), editPreviousRequest: Boolean(options.editUserMessageID), mediaGenerationChoice: options.mediaGenerationChoice,
          }, (document) => {
            if (!isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) return;
            sessionsRef.current = (document.agent_sessions || []).filter(isCanvasAgentSession);
            onBackendDocument(document);
          }, controller.signal);
          return;
        }
        let lastToolDocument: CanvasDocument | undefined;
        const acceptToolDocument = (document: CanvasDocument) => {
          if (!isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) return;
          lastToolDocument = document;
          sessionsRef.current = (document.agent_sessions || []).filter(isCanvasAgentSession);
          onBackendDocument(document);
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
          mediaGenerationChoice: options.mediaGenerationChoice,
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
                relayTokens: { image: tokenNameForModel("image", context.generation.imageModel), video: tokenNameForModel("video", context.generation.videoModel), audio: tokenNameForModel("audio", context.generation.audioModel) },
                references: sessionAttachments, selectedNodeIds: context.selectedNodeIds, skillIds: [],
                resume: Boolean(options.retryAssistantID), editPreviousRequest: false,
                ...(generateMedia === undefined ? {} : { mediaGenerationChoice: generateMedia ? "generate" : "defer" }),
              }, action, acceptToolDocument, controller.signal);
              const updatedSession = (document.agent_sessions || []).filter(isCanvasAgentSession).find((item) => item.id === sessionID);
              return { ...result, ...(updatedSession ? { agentState: updatedSession.agentState } : {}) };
            }
            const nodeID = typeof action.arguments.nodeId === "string" ? action.arguments.nodeId : "";
            const node = nodesRef.current.find((item) => item.id === nodeID);
            updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantID ? setCanvasAgentProcessing(message, false) : message) }));
            const confirmed = await new Promise<boolean>((resolve) => {
              const pending = { title: node?.title || "未命名节点", resolve };
              pendingDeleteRef.current = pending;
              setPendingDelete(pending);
            });
            if (controller.signal.aborted || !isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) return { ok: false, code: "run_stale", message: "画布已切换，当前执行已停止" };
            updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantID ? setCanvasAgentProcessing(message, true) : message) }));
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
        const stopped = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
        const currentRun = isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch);
        if (assistantID && currentRun && controller.signal.reason !== "canvas-detached") updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, agentState: stopped ? { ...current.agentState, pendingModelTaskId: undefined } : current.agentState, messages: current.messages.map((message) => message.id === assistantID ? { ...setCanvasAgentProcessing(message, false), text: stopped ? "已停止继续执行。已经创建的节点和已经提交的媒体任务会保留。" : error instanceof Error ? error.message : "Agent 执行失败", status: stopped ? "waiting" : "error", activity: undefined } : message), updatedAt: new Date().toISOString() }));
        if (!stopped && currentRun) toast.error(error instanceof Error ? error.message : "Agent 执行失败");
      } finally {
        if (agentMode === "codex" && isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch) && controller.signal.reason !== "canvas-detached") {
          await onPersist().catch((error) => toast.error(error instanceof Error ? error.message : "执行记录保存失败"));
        }
        if (releaseCanvasAgentRun(abortRef, controller)) setBusy(false);
      }
    })();
    return "started";
  }

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

  function retryMessage(message: CanvasAssistantMessage, mediaGenerationChoice?: "generate" | "defer") {
    if (activeSession.agentState.pendingQuestion) { toast.info("请先回答当前问题，或取消本次请求"); return false; }
    const index = activeSession.messages.findIndex((item) => item.id === message.id);
    const userMessage = canvasAgentReplyTarget(activeSession.messages, message) || activeSession.messages.slice(0, index).findLast((item) => item.role === "user");
    return userMessage ? submit(userMessage.text, userMessage.references, [], { retryAssistantID: message.id, mediaGenerationChoice }) === "started" : false;
  }

  function editUserMessage(message: CanvasAssistantMessage) {
    if (busy || activeSession.agentState.pendingQuestion || message.role !== "user" || message.questionAnswerFor) return;
    messageScroll.pause();
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

  recoverRunRef.current = () => {
    if (activeSession.engine !== "codex") return;
    const messageID = activeSession.resumeAssistantMessageId;
    if (!messageID || busy || abortRef.current || activeSession.agentState.pendingQuestion) return;
    if (activeSession.engine && activeSession.engine !== agentMode) return;
    if (agentMode === "native" && (!relayPreferencesReady || !model || !relayTokenName)) return;
    if (agentMode === "codex" && (!codex.connected || !codex.model)) return;
    const key = `${activeSession.id}:${messageID}`;
    if (recoveryAttemptsRef.current.has(key)) return;
    const index = activeSession.messages.findIndex((message) => message.id === messageID);
    const recoveringMessage = activeSession.messages.find((message) => message.id === messageID && message.role === "assistant");
    const previous = recoveringMessage ? canvasAgentReplyTarget(activeSession.messages, recoveringMessage) : activeSession.messages.slice(0, index).findLast((message) => message.role === "user");
    if (!previous) return;
    const result = submit(previous.text, previous.references, [], { retryAssistantID: messageID, notifyMissingConfiguration: false });
    if (result === "started") recoveryAttemptsRef.current.add(key);
  };
  useEffect(() => {
    // Start after mount effects settle so StrictMode cleanup cannot interrupt
    // recovery after it has already consumed the saved resume marker.
    let disposed = false;
    queueMicrotask(() => { if (!disposed) recoverRunRef.current(); });
    return () => { disposed = true; };
  }, [activeSession.id, activeSession.resumeAssistantMessageId, agentMode, busy, codex.connected, codex.model, model, relayPreferencesReady, relayTokenName]);

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
    <aside
    ref={panelRef}
    aria-label="Agent 对话面板"
    aria-hidden={!open}
    inert={!open}
    data-canvas-agent-panel
    data-display-mode={displayMode}
    data-state={open ? "open" : "closed"}
    className={cn("absolute z-40 flex min-h-0 flex-col overflow-hidden bg-card [container-name:agent] [container-type:size] motion-reduce:!transition-none", displayMode === "docked"
      ? "top-0 bottom-[var(--canvas-agent-docked-bottom)] right-0 border-l border-border/60"
      : "bottom-[var(--canvas-agent-bottom)] right-3 max-w-[calc(100%-1.5rem)] h-[min(calc(100%-var(--canvas-agent-bottom)-1rem),calc((min(780px,86dvh)+100%-var(--canvas-agent-bottom)-1rem)/2))] rounded-2xl border border-border/80 shadow-[var(--shadow-dialog)] sm:right-4 sm:max-w-[calc(100%-2rem)] [@media(max-height:540px)]:fixed [@media(max-height:540px)]:h-[min(780px,86dvh,calc(100dvh-var(--canvas-dock-clearance)-2rem))] [@media(max-height:540px)]:bottom-[calc(var(--canvas-dock-clearance)+1rem)] [@media(max-height:540px)]:z-[45]") }
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
      className={cn("flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", displayMode === "floating" && "touch-none select-none cursor-grab", panelDrag.dragging && "cursor-grabbing")}>
      <Bot className="size-5 shrink-0 text-brand" />
      <span title={view === "history" ? "历史对话" : activeSession.title || "Agent"} className="min-w-0 flex-1 truncate text-sm font-semibold">{view === "history" ? "历史对话" : activeSession.title || "Agent"}</span>
      <div data-canvas-agent-toolbar role="group" aria-label="Agent 工具栏" className="ml-auto flex shrink-0 items-center gap-0.5 @max-[320px]/agent:[&_button]:size-7">
        <Button size="icon" className="size-8 rounded-full" variant="ghost" title="新对话" aria-label="新对话" disabled={busy} onClick={newSession}><MessageCirclePlus /></Button>
        <Button size="icon" className="size-8 rounded-full" variant={view === "history" ? "secondary" : "ghost"} title={view === "history" ? "返回对话" : "历史记录"} aria-label={view === "history" ? "返回对话" : "历史记录"} onClick={() => setView((current) => current === "history" ? "chat" : "history")}><Clock /></Button>
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
          onModeChange={setAgentMode}
          onConfigure={() => setCodexSettingsOpen(true)}
        />
        <Button size="icon" className="size-8 rounded-full" variant="ghost" title={displayMode === "docked" ? "切换为悬浮" : "切换为停靠"} aria-label={displayMode === "docked" ? "切换为悬浮" : "切换为停靠"} aria-pressed={displayMode === "docked"} onMouseDown={(event) => event.preventDefault()} onClick={() => onDisplayModeChange(displayMode === "docked" ? "floating" : "docked")}>{displayMode === "docked" ? <PanelsTopLeft /> : <PanelRight />}</Button>
        <Button size="icon" className="size-8 rounded-full" variant="ghost" title="收起对话" aria-label="收起 Agent" onClick={onClose}><Minus /></Button>
      </div>
    </header>
    {agentMode === "codex" ? <CanvasCodexConnect agent={codex} busy={busy} open={open && codexSettingsOpen} onOpenChange={setCodexSettingsOpen} /> : null}
    {view === "history" ? <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-2">
      <span className="min-w-0 flex-1 text-[11px] tabular-nums text-muted-foreground">{checkedSessionIDs.length ? `已选 ${checkedSessionIDs.length} 条` : `共 ${historySessions.length} 条对话`}</span>
      <Button size="sm" className="h-7 gap-1 px-2 text-[11px]" variant="ghost" aria-label="删除所选对话" disabled={busy || !checkedSessionIDs.length} onClick={() => setDeleteSessionIDs(checkedSessionIDs)}><Trash2 className="size-3" />删除所选</Button>
      <Button size="sm" className="h-7 px-2 text-[11px]" variant="ghost" aria-label="删除全部对话" disabled={busy || !historySessions.length} onClick={() => setDeleteSessionIDs(historySessions.map((item) => item.id))}>清空</Button>
    </div> : null}
    <div className="relative flex min-h-0 flex-1 flex-col"><div data-agent-message-scroll tabIndex={0} ref={messageScroll.viewportRef} className="mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 pr-3"><div ref={messageScroll.contentRef} className="space-y-3">{view === "history" ? <AssistantHistory sessions={historySessions} activeSession={activeSession} checkedIDs={checkedSessionIDs} deleteDisabled={busy} onToggleChecked={(id, checked) => setCheckedSessionIDs((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id))} onOpen={(id) => { if (busy || abortRef.current) return; if (id !== activeSessionIDRef.current) { setInput(""); setEditingUserMessageID(""); draftAttachments.clear(); setComposerReferenceNodeIDs([]); setRemovedReferenceNodeIDs(new Set()); } commit(sessionsRef.current, id); setView("chat"); }} onDelete={(id) => setDeleteSessionIDs([id])} onRename={(id, nextTitle) => commit(sessionsRef.current.map((item) => item.id === id ? { ...item, title: nextTitle, updatedAt: new Date().toISOString() } : item))} /> : activeSession.messages.length ? <AssistantMessages protocolMessages={activeSession.protocolMessages} messages={activeSession.messages} nodes={nodes} onFocusNode={onFocusNode} onRetry={retryMessage} onEdit={editUserMessage} editingMessageID={editingUserMessageID} onCancelEdit={cancelMessageEdit} onSaveEdit={(message, text) => { void submit(text, message.references || [], [], { editUserMessageID: message.id }); }} editDisabled={busy || Boolean(activeSession.agentState.pendingQuestion)} busy={busy} pendingQuestion={activeSession.agentState.pendingQuestion?.question} /> : <div className={cn("flex flex-col items-center justify-center px-4 text-center", agentMode === "codex" && !codex.connected ? "py-3" : "min-h-[min(18rem,46cqh)] py-5")}><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">{agentMode === "codex" ? <Terminal className="size-5" /> : <Sparkles className="size-5" />}</div><div className="mt-3 text-sm font-medium">{agentMode === "codex" && !codex.connected ? "与 Codex 一起创作" : "从一个想法开始"}</div><div className="mt-1.5 max-w-[260px] text-xs leading-5 text-muted-foreground">{agentMode === "codex" && !codex.connected ? "连接本地 Codex，让想法变成画布上的内容。你也可以先写下创作目标。" : "描述创作目标，Agent 会与你沟通并直接操作当前画布"}</div>{agentMode === "codex" && !codex.connected ? <Button type="button" size="sm" variant="outline" className="mt-4 gap-1.5 text-xs" onClick={() => setCodexSettingsOpen(true)}><Plug className="size-3.5" />{codex.connecting ? "查看连接进度" : "连接 Codex"}</Button> : null}{!input.trim() && (agentMode !== "codex" || codex.connected) ? <div className="mt-4 grid w-full gap-2 text-left">{["帮我整理当前画布的创作思路", "规划一组风格统一的品牌海报", "把当前创意拆解成分镜方案"].map((suggestion) => <button key={suggestion} type="button" className="rounded-lg bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground transition-colors hover:border-brand/40 hover:bg-brand-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setInput(suggestion); requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')?.focus()); }}>{suggestion}</button>)}</div> : null}</div>}</div></div>
      {view === "chat" && messageScroll.showLatest ? <Button type="button" size="sm" variant="outline" className="absolute bottom-3 left-1/2 z-20 h-8 -translate-x-1/2 gap-1.5 rounded-full bg-card shadow-md" onClick={messageScroll.scrollToLatest}><ArrowDown className="size-3.5" />回到最新</Button> : null}
    </div>
    {view === "chat" ? <div data-agent-input-area className="flex min-h-0 max-h-[70%] shrink-0 flex-col p-3 pt-1">
      <CanvasAgentResumeNotice session={activeSession} run={backendRun} busy={busy} onResume={() => { const latest = activeSession.messages.findLast((message) => message.role === "assistant"); if (latest) retryMessage(latest); }} />
      <CanvasAgentPlanProgress key={activeSession.id} running={busy && !pendingDelete} plan={conversationReply ? undefined : activeSession.agentState.plan} />
      {!conversationReply && !busy && !activeSession.agentState.pendingQuestion && (waitingReason || (activeSession.agentState.mediaGenerationDeferred && mediaWaitingReason.startsWith("待手动生成"))) && !needsMediaChoice ? <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><p role="status" className="flex items-center gap-1.5"><Clock className="size-3.5" />{waitingReason || mediaWaitingReason.replace("待手动生成", "已暂缓生成")}</p>{activeSession.agentState.mediaGenerationDeferred && mediaWaitingReason.startsWith("待手动生成") ? <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => chooseMediaGeneration("立即生成")}>生成待处理节点</Button> : null}</div> : null}
      {pendingDelete ? <div className="mb-2 overflow-hidden rounded-lg border"><div className="px-3 py-2"><p className="truncate text-xs font-medium">删除“{pendingDelete.title}”？</p><p className="mt-1 text-[11px] text-muted-foreground">相关连线和任务记录将按现有逻辑清理</p></div><div className="grid grid-cols-2 border-t"><button type="button" className="h-8 text-xs hover:bg-muted" onClick={() => settleDeleteConfirmation(false)}>取消</button><button type="button" className="h-8 border-l text-xs font-medium text-destructive hover:bg-muted dark:text-rose-300" onClick={() => settleDeleteConfirmation(true)}>确认删除</button></div></div> : null}
      {activeSession.agentState.pendingQuestion ? <CanvasAgentQuestionCard key={`${activeSession.id}:${activeSession.agentState.pendingQuestion.id}`} question={activeSession.agentState.pendingQuestion} busy={busy} active={open && view === "chat"} onAnswer={(answer) => submit(answer, undefined, composerReferenceNodeIDs, { mediaGenerationChoice: canvasAgentQuestionMediaChoice(activeSession.agentState.pendingQuestion!, answer) }) === "started"} onCancel={cancelQuestion} /> : needsMediaChoice && !editingUserMessageID ? <CanvasAgentQuestionCard key={`${activeSession.id}:media-generation`} question={canvasAgentMediaGenerationQuestion(`${activeSession.id}:media-generation`, Number(mediaWaitingReason.match(/(\d+) 个节点/)?.[1] || 1))} busy={busy} active={open && view === "chat" && !editingUserMessageID} onAnswer={chooseMediaGeneration} /> : <CanvasAgentComposer onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); } }} onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); event.stopPropagation(); if (!busy) void draftAttachments.upload(Array.from(event.dataTransfer.files)); }}>
        <ScrollArea native data-agent-composer-scroll className="min-h-0 max-h-[min(220px,24cqh)]" viewportClassName="overscroll-contain pr-2" manageKeyboard={false}>
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
          onPasteImage={(file) => { if (!busy) void draftAttachments.upload([file]); }}
          onSubmit={(prompt, referenceIDs) => void submit(prompt, undefined, referenceIDs, {})}
          className="min-h-[min(6rem,18cqh)] w-full px-1 py-1 text-sm leading-6"
          placeholder={activeSession.agentState.pendingQuestion ? "回答上方问题，或补充新的要求" : "开始你的创作，或 @ 引用资源"}
          placeholderClassName="!left-1 !top-1"
        />
        </ScrollArea>
        {draftAttachments.uploading ? <span role="status" className="mt-1 flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />附件上传中…</span> : null}
        <CanvasAgentComposerToolbar data-canvas-agent-composer-toolbar>
          <CanvasAgentAssetMenu disabled={busy} uploading={draftAttachments.uploading} onUpload={() => attachmentInputRef.current?.click()} onOpenAssets={() => setAttachmentPickerOpen(true)} />
          <CanvasAgentModelPicker model={agentMode === "codex" ? codex.model : model} models={agentMode === "codex" ? (codex.connected ? codex.models.map((item) => ({ value: item.model, label: item.displayName })) : []) : models.map((value) => ({ value, label: value }))} codex={agentMode === "codex"} disabled={busy || Boolean(activeSession.agentState.pendingQuestion)} onChange={agentMode === "codex" ? codex.setModel : onModelChange} />
          <CanvasAgentMediaModelPicker models={mediaModels} disabled={busy || Boolean(activeSession.agentState.pendingQuestion)} />
          <CanvasAgentSkillPicker compact selectedIds={activeSession.activeSkillIds ?? agentConfig.activeSkillIds ?? []} onChange={(activeSkillIds) => commit(sessionsRef.current.map((item) => item.id === activeSessionID ? { ...item, activeSkillIds, updatedAt: new Date().toISOString() } : item))} disabled={busy} />
          <CanvasAgentSendButton disabled={!busy && (draftAttachments.uploading || (!input.trim() && !draftAttachments.attachments.length))} aria-label={busy ? "停止" : "发送"} onClick={() => busy ? (settleDeleteConfirmation(false), (!abortCanvasAgentRun(abortRef) && backendRun?.status === "running" ? void stopCanvasAgentRun(canvasId, backendRun.id).catch((error) => toast.error(error.message)) : undefined)) : void submit(input, undefined, composerReferenceNodeIDs, {})}>{busy ? <Square className="fill-current" /> : <ArrowUp />}</CanvasAgentSendButton>
        </CanvasAgentComposerToolbar>
      </CanvasAgentComposer>}
    </div> : null}
    <Dialog open={deleteSessionIDs.length > 0} onOpenChange={(open) => !open && setDeleteSessionIDs([])}><DialogContent className="w-[min(92vw,420px)]"><DialogHeader><DialogTitle>删除对话记录？</DialogTitle><DialogDescription>将删除 {deleteSessionIDs.length} 条对话记录，此操作不可撤销。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setDeleteSessionIDs([])}>取消</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => { if (busy) return; removeSessions(deleteSessionIDs); setDeleteSessionIDs([]); }}>删除</Button></DialogFooter></DialogContent></Dialog>
    <input ref={attachmentInputRef} type="file" multiple accept="image/*,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/x-wav" aria-label="上传 Agent 附件" className="hidden" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; if (!busy) void draftAttachments.upload(files); }} />
    {attachmentPickerOpen && authSession ? <Suspense fallback={<span role="status" className="sr-only">正在加载素材库</span>}><CanvasAgentAssetPicker open session={authSession} onInsert={(payload) => { if (!busy) draftAttachments.add(payload); setAttachmentPickerOpen(false); }} onClose={() => setAttachmentPickerOpen(false)} /></Suspense> : null}
    {codexApproval.dialog}
    </aside>
  </>;
}

const ASSISTANT_MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4" />,
  pre: ({ node: _node, ...props }) => <ScrollArea native className="my-2 rounded-lg bg-muted" viewClass="w-max min-w-full"><pre {...props} /></ScrollArea>,
  table: ({ node: _node, ...props }) => <ScrollArea native className="my-2" viewClass="w-max min-w-full"><table {...props} /></ScrollArea>,
};

const AssistantMarkdown = memo(function AssistantMarkdown({ children, components = ASSISTANT_MARKDOWN_COMPONENTS }: { children: string; components?: Components }) {
  return <div className={cn("min-w-0 whitespace-normal break-words", "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0", "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h1:first-child]:mt-0", "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2:first-child]:mt-0", "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:font-semibold [&_h3:first-child]:mt-0", "[&_h4]:my-2 [&_h4]:font-semibold", "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1", "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[color:var(--agent-markdown-border)] [&_blockquote]:pl-3 [&_blockquote]:opacity-80", "[&_hr]:my-3 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[color:var(--agent-markdown-border)]", "[&_code]:rounded [&_code]:bg-[var(--agent-markdown-surface)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]", "[&_pre]:m-0 [&_pre]:rounded-lg [&_pre]:bg-[var(--agent-markdown-surface)] [&_pre]:p-3", "[&_pre_code]:bg-transparent [&_pre_code]:p-0", "[&_table]:m-0 [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-[color:var(--agent-markdown-border)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_td]:border-b [&_td]:border-[color:var(--agent-markdown-border)] [&_td]:px-2 [&_td]:py-1.5")} style={{ "--agent-markdown-surface": "var(--muted)", "--agent-markdown-border": "var(--border)" } as CSSProperties}><ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{children}</ReactMarkdown></div>;
});

export function AssistantMessages({ messages, protocolMessages, nodes, onFocusNode, onRetry, onEdit, editDisabled, busy, pendingQuestion, editingMessageID, onSaveEdit, onCancelEdit }: { protocolMessages?: CanvasAgentProtocolMessage[]; editingMessageID?: string; onSaveEdit?: (message: CanvasAssistantMessage, text: string) => void; onCancelEdit?: () => void; onEdit: (message: CanvasAssistantMessage) => void; editDisabled: boolean; pendingQuestion?: string; busy: boolean; messages: CanvasAssistantMessage[]; nodes: CanvasNode[]; onFocusNode?: (nodeID: string) => void; onRetry: (message: CanvasAssistantMessage) => void }) {
  const focusNodeRef = useRef(onFocusNode);
  useLayoutEffect(() => { focusNodeRef.current = onFocusNode; }, [onFocusNode]);
  // Keep history renderers stable while canvas viewport callbacks change.
  const focusNode = useCallback((nodeID: string) => focusNodeRef.current?.(nodeID), []);
  const handleFocusNode = onFocusNode ? focusNode : undefined;
  const components = useMemo<Components>(() => ({ ...ASSISTANT_MARKDOWN_COMPONENTS, code: ({ children, className, node: markdownNode, ...props }) => {
    const node = nodes.find((item) => item.id === String(children).trim());
    if (!node || className || !handleFocusNode || markdownNode?.position?.start.line !== markdownNode?.position?.end.line) return <code className={className} {...props}>{children}</code>;
    return <CanvasAgentNodeChip node={node} onFocus={handleFocusNode} />;
  } }), [nodes, handleFocusNode]);
  const renderTraceText = useCallback((text: string) => <AssistantMarkdown components={components}>{text}</AssistantMarkdown>, [components]);
  const displayTraces = useMemo(() => {
    const commands = new Map((protocolMessages || []).flatMap((message) => message.role === "assistant" ? (message.toolCalls || []).map((call) => [call.id, call.name] as const) : []));
    return new Map(messages.map((message) => [message.id, (message.trace || []).map((entry) => {
      if (entry.type !== "operation") return entry;
      const name = commands.get(entry.id.replace(/^tool:/, ""));
      return name ? { ...entry, kind: canvasAgentToolKind(name) } : entry;
    })]));
  }, [messages, protocolMessages]);
  function renderMessage(message: CanvasAssistantMessage) {
    if (message.questionAnswerFor) return null;
    const running = message.status === "thinking" || message.status === "running";
    const isAssistant = message.role === "assistant";
    const hideReply = isAssistant && (message.trace?.some((entry) => entry.type === "question" && entry.question === message.text) || pendingQuestion === message.text && message.id === messages.findLast((item) => item.role === "assistant")?.id);
    const editing = message.id === editingMessageID && onSaveEdit && onCancelEdit;
    return <div key={message.id} data-agent-message={message.id} className={cn("flex min-w-0 flex-col gap-2", isAssistant ? "items-start py-1" : "items-end")}>
      {editing ? <div className="w-full min-w-0"><UserMessageContent message={message} showText={false} /><CanvasAgentMessageEditor key={message.id} text={message.text} disabled={busy} onSave={(text) => onSaveEdit(message, text)} onCancel={onCancelEdit} /></div> : null}
      {!editing && (message.text && !hideReply && !message.questionAnswerFor) ? <div className={cn("min-w-0 whitespace-pre-wrap break-words text-sm leading-6", isAssistant ? "w-full" : "max-w-[88%] rounded-xl bg-brand-soft px-3 py-2")}>
        {isAssistant ? <AssistantMarkdown components={components}>{message.text}</AssistantMarkdown> : <UserMessageContent message={message} showText={true} />}
      </div> : null}
      {!editing && !running && message.text && !hideReply ? <div className="flex gap-1"><Button size="icon" variant="ghost" className="size-7" title="复制消息" aria-label="复制消息" onClick={() => { void Promise.resolve().then(() => copyClipboardText(message.text)).then(() => toast.success("已复制")).catch((error: Error) => toast.error(error.message)); }}><Copy className="size-3.5" /></Button>{!isAssistant && !message.questionAnswerFor ? <Button size="icon" variant="ghost" className="size-7" aria-label="编辑消息" title="编辑消息" disabled={editDisabled} onClick={() => onEdit(message)}><Pencil className="size-3.5" /></Button> : null}{isAssistant && message.id === messages.findLast((item) => item.role === "assistant")?.id ? <Button size="icon" variant="outline" className="size-7 rounded-full" title="重试" aria-label="重试" disabled={busy} onClick={() => onRetry(message)}><RotateCcw className="size-3.5" /></Button> : null}</div> : null}
    </div>;
  }
  const timings = canvasAgentTaskTimings(messages);
  return <>{canvasAgentTaskGroups(messages).map((task) => {
    const latest = task.replies.at(-1);
    const running = latest?.status === "thinking" || latest?.status === "running";
    const isLatest = latest?.id === messages.findLast((message) => message.role === "assistant")?.id;
    const complete = latest?.status === "success" && !(isLatest && pendingQuestion);
    const conclusion = latest && !running && !task.replies.some((message) => message.trace?.some((entry) => entry.type === "question" && entry.question === latest.text)) && !(isLatest && pendingQuestion === latest.text) ? latest : undefined;
    return <div key={task.id} data-agent-task={task.id} className="min-w-0 space-y-3">
      {task.request ? renderMessage(task.request) : null}
      {latest ? <CanvasAgentTaskProcess complete={complete} running={running} timing={timings.get(latest.id) || {}}>
        {task.replies.map((message) => <div key={message.id} data-agent-process-message={message.id} className="min-w-0 space-y-2">
          <CanvasAgentExecutionTrace entries={(displayTraces.get(message.id) || []).filter((entry) => !(message === conclusion && entry.type === "text" && entry.text === message.text))} pendingQuestion={pendingQuestion} nodes={nodes} running={message === latest && running} activity={message.activity} onFocusNode={handleFocusNode} renderText={renderTraceText} />
          {message !== conclusion && message.text && !message.trace?.some((entry) => entry.type === "text" && entry.text === message.text || entry.type === "question" && entry.question === message.text) && !(isLatest && pendingQuestion === message.text) ? <div className="text-sm leading-6">{renderTraceText(message.text)}</div> : null}
        </div>)}
      </CanvasAgentTaskProcess> : null}
      {conclusion ? <div data-agent-conclusion className="min-w-0">{renderMessage({ ...conclusion, trace: [] })}</div> : null}
    </div>;
  })}</>;

}

function AssistantHistory({ sessions, activeSession, checkedIDs, deleteDisabled, onToggleChecked, onOpen, onDelete, onRename }: { sessions: CanvasAssistantSession[]; activeSession: CanvasAssistantSession; checkedIDs: string[]; deleteDisabled: boolean; onToggleChecked: (id: string, checked: boolean) => void; onOpen: (id: string) => void; onDelete: (id: string) => void; onRename: (id: string, title: string) => void }) {
  const [editingID, setEditingID] = useState("");
  if (!sessions.length) return <EmptyState icon={History} title="暂无历史对话" compact />;
  return <div className="space-y-1">{sessions.map((item) => <div key={item.id} className={cn("group flex items-center gap-2 rounded-lg px-2 py-1.5", item.id === activeSession.id && "bg-muted")}><Checkbox className="shrink-0" aria-label={`选择对话 ${item.title}`} checked={checkedIDs.includes(item.id)} onCheckedChange={(checked) => onToggleChecked(item.id, checked === true)} /><div className="min-w-0 flex-1">{editingID === item.id ? <input aria-label="对话名称" className="w-full rounded border bg-background px-1 text-sm" defaultValue={item.title} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = item.title; setEditingID(""); } }} onBlur={(event) => { const nextTitle = event.target.value.trim(); if (nextTitle) onRename(item.id, nextTitle); setEditingID(""); }} /> : <button type="button" className="w-full text-left text-sm disabled:opacity-50" disabled={deleteDisabled} onClick={() => onOpen(item.id)}><span className="block truncate">{item.title}</span><span className="text-xs text-muted-foreground">{item.messages.length} 条消息</span></button>}</div><Button size="icon" variant="ghost" className="size-7" title="重命名" aria-label={`重命名对话 ${item.title}`} disabled={deleteDisabled} onClick={() => setEditingID(item.id)}><Pencil className="size-3.5" /></Button><Button size="icon" variant="ghost" className="size-7 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" title="删除" aria-label={`删除对话 ${item.title}`} disabled={deleteDisabled} onClick={() => onDelete(item.id)}><Trash2 className="size-3.5" /></Button></div>)}</div>;
}

const UserMessageContent = memo(function UserMessageContent({ message, showText = true }: { message: CanvasAssistantMessage; showText?: boolean }) {
  const references = useMemo(() => message.references?.filter((item) => item.source !== "attachment").map(assistantToPromptReference) || [], [message.references]);
  return <><CanvasAgentAttachments attachments={message.references?.filter((item) => item.source === "attachment") || []} />{showText ? <CanvasAgentPromptChipInput value={message.text} references={references} onChange={() => undefined} readOnly /> : null}</>;
});

function assistantToPromptReference(reference: CanvasAssistantReference): CanvasResourceReference {
  const kind = reference.type === "video" ? "video" : reference.type === "audio" ? "audio" : reference.type === "text" ? "text" : "image";
  return { id: reference.id, nodeID: reference.id, kind, label: reference.label || reference.title, title: reference.title, previewURL: reference.dataUrl || reference.url, text: reference.text, active: true };
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
