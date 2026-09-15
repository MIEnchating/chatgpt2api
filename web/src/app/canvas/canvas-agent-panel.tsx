import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { nanoid } from "nanoid";
import { ArrowUp, BookOpen, Bot, Brain, Copy, Pencil, Settings2, FolderOpen, History, Image as ImageIcon, LoaderCircle, Menu, MessageSquarePlus, PanelRightClose, RotateCcw, Sparkles, Square, Trash2, Upload, Video } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { buildAllCanvasResourceReferences, type CanvasResourceReference } from "@/app/canvas/canvas-resources";
import { CanvasAgentSkillPicker } from "@/app/canvas/canvas-agent-skill-picker";
import { fetchAgentSkills } from "@/services/api/agent-skills";
import { AuthenticatedImage } from "@/components/authenticated-image";
import { CanvasAgentPromptChipInput } from "@/app/canvas/canvas-agent-prompt-chip-input";
import {
  CanvasAgentImageSettings,
  CanvasAgentVideoSettings,
} from "@/app/canvas/canvas-agent-generation-settings";
import {
  canvasAgentImageSettingsSummary,
  canvasAgentVideoSettingsSummary,
} from "@/app/canvas/canvas-agent-generation-settings-summary";
import { useCanvasCodexApproval } from "@/app/canvas/agent/use-canvas-codex-approval";
import { CanvasCodexConnect } from "@/app/canvas/canvas-codex-connect";
import { useCanvasCodexAgent } from "@/app/canvas/agent/canvas-codex-agent";
import { runCanvasAgent, createCanvasAgentState, type RunCanvasAgentInput } from "@/app/canvas/agent/canvas-agent-runtime";
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
import type { CanvasAgentConfig, CanvasAssistantMessage, CanvasAssistantReference, CanvasAssistantSession } from "@/app/canvas/agent/canvas-agent-types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";
import { useRelayTokenPreferences } from "@/lib/use-relay-token-preferences";
import { cn } from "@/lib/utils";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import type { CanvasNode } from "@/services/api/canvas";

export type { CanvasAgentAction, CanvasAgentToolResult } from "@/app/canvas/agent/canvas-agent-tools";

function createSession(): CanvasAssistantSession {
  const now = new Date().toISOString();
  return { id: nanoid(), title: "新对话", messages: [], agentState: createCanvasAgentState(), protocolMessages: [], createdAt: now, updatedAt: now };
}

type PendingDeleteConfirmation = { title: string; resolve: (confirmed: boolean) => void };
type CanvasAgentSubmitResult = "started" | "empty" | "busy" | "missing-model" | "missing-key";
type CanvasAgentSubmitOptions = {
  notifyMissingConfiguration?: boolean;
  onUserMessageCommitted?: () => void;
};
type CanvasAgentInitialRequest = { prompt: string; references: CanvasAssistantReference[] };
type InitialRequestBlockerNotice = {
  request: CanvasAgentInitialRequest;
  reason: "missing-model" | "missing-key";
};

export function CanvasAgentPanel({ open, nodes, selectedNodeIDs, referenceNodeClick, model, imageModel, videoModel, configuredSystemPrompt, initialSessions, initialActiveSessionID, initialRequest, agentConfig, width, getAgentContext, onSessionsChange, onAgentConfigChange, onWidthChange, onExecuteAction, onOpenUpload, onOpenAssets, onPasteImage, onInitialRequestConsumed, onFocusNode, onClose }: {
  open: boolean;
  nodes: CanvasNode[];
  selectedNodeIDs: string[];
  referenceNodeClick: { nodeID: string | null; version: number };
  model: string;
  imageModel: string;
  videoModel: string;
  configuredSystemPrompt?: string;
  initialSessions: CanvasAssistantSession[];
  initialActiveSessionID?: string;
  initialRequest?: CanvasAgentInitialRequest | null;
  agentConfig: CanvasAgentConfig;
  width: number;
  getAgentContext: (state: CanvasAssistantSession["agentState"]) => CanvasAgentContext;
  onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionID: string) => void;
  onAgentConfigChange: (patch: Partial<CanvasAgentConfig>) => void;
  onWidthChange: (width: number) => void;
  onExecuteAction: (action: CanvasAgentAction, messageReferenceNodeIDs: string[], execution?: { waitForMedia?: boolean }) => Promise<CanvasAgentToolResult>;
  onOpenUpload: () => void;
  onOpenAssets: () => void;
  onPasteImage: (file: File) => void;
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
  const [busy, setBusy] = useState(false);
  const [agentMode, setAgentMode] = useState<"native" | "codex">("native");
  const [view, setView] = useState<"chat" | "history">("chat");
  const [checkedSessionIDs, setCheckedSessionIDs] = useState<string[]>([]);
  const [deleteSessionIDs, setDeleteSessionIDs] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteConfirmation | null>(null);
  const [composerReferenceNodeIDs, setComposerReferenceNodeIDs] = useState<string[]>([]);
  const [removedReferenceNodeIDs, setRemovedReferenceNodeIDs] = useState<Set<string>>(new Set());
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runLifecycleRef = useRef(createCanvasAgentRunLifecycle());
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const pendingDeleteRef = useRef<PendingDeleteConfirmation | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const consumedReferenceNodeClickVersionRef = useRef(0);
  const consumedInitialRequestRef = useRef<typeof initialRequest>(null);
  const initialRequestRef = useRef(initialRequest);
  const initialRequestBlockerNoticeRef = useRef<InitialRequestBlockerNotice | null>(null);
  const onInitialRequestConsumedRef = useRef(onInitialRequestConsumed);
  const submitInitialRequestRef = useRef<(prompt: string, references: CanvasAssistantReference[], onUserMessageCommitted: () => void) => CanvasAgentSubmitResult>(() => "empty");
  const sessionsRef = useRef(sessions);
  const activeSessionIDRef = useRef(activeSessionID);
  const nodesRef = useRef(nodes);
  const selectedNodeIDsRef = useRef(selectedNodeIDs);
  nodesRef.current = nodes;
  selectedNodeIDsRef.current = selectedNodeIDs;
  initialRequestRef.current = initialRequest;
  onInitialRequestConsumedRef.current = onInitialRequestConsumed;
  const activeSession = sessions.find((item) => item.id === activeSessionID) || sessions[0];
  const [canvasId] = useState(() => getAgentContext(activeSession.agentState).project.id);
  const codexApproval = useCanvasCodexApproval();
  const codex = useCanvasCodexAgent({ canvasId, onDisconnect: () => { abortCanvasAgentRun(abortRef); settleDeleteConfirmation(false); }, executeAction: async (action) => abortRef.current ? { ok: false, code: "agent_busy", message: "面板 Agent 正在运行，请结束后重试 MCP 操作" } : onExecuteAction(action, [], { waitForMedia: false }), ask: codexApproval.ask });
  const historySessions = sessions.filter((item) => item.messages.length > 0);
  const selectedNodeKey = useMemo(() => [...selectedNodeIDs].sort().join(","), [selectedNodeIDs]);
  const resourceReferences = useMemo(() => buildAllCanvasResourceReferences(nodes), [nodes]);
  const resourceReferenceByID = useMemo(() => new Map(resourceReferences.map((reference) => [reference.nodeID, reference])), [resourceReferences]);
  const pendingReferences = useMemo(() => {
    const clickedNodeID = referenceNodeClick.version > consumedReferenceNodeClickVersionRef.current ? referenceNodeClick.nodeID : null;
    return resourceReferences.filter((reference) => selectedNodeIDs.includes(reference.nodeID)
      && ((!composerReferenceNodeIDs.includes(reference.nodeID) && !removedReferenceNodeIDs.has(reference.nodeID)) || reference.nodeID === clickedNodeID));
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
      abortCanvasAgentRun(abortRef);
      pendingDeleteRef.current?.resolve(false);
      pendingDeleteRef.current = null;
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  useEffect(() => {
    if (view !== "chat") return;
    const frame = window.requestAnimationFrame(() => {
      const element = messageListRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSession.messages, view]);

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
    setInput("");
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
    setCheckedSessionIDs((current) => current.filter((sessionID) => !sessionIDs.includes(sessionID)));
  }

  function submit(nextText = input, savedReferences?: CanvasAssistantReference[], referenceNodeIDs = composerReferenceNodeIDs, options: CanvasAgentSubmitOptions = {}): CanvasAgentSubmitResult {
    const text = nextText.trim();
    if (!text || !activeSession) return "empty";
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
    const runEpoch = beginCanvasAgentRunEpoch(runLifecycleRef.current);
    const sessionID = activeSession.id;
    const accountKey = getCachedAuthSession()?.key;
    setBusy(true);
    void (async () => {
      let assistantID = "";
      try {
        const selectedSkillIDs = activeSession.activeSkillIds ?? agentConfig.activeSkillIds ?? [];
        const availableSkills = selectedSkillIDs.length ? (await fetchAgentSkills(false, controller.signal)).items : [];
        const activeSkills = selectedSkillIDs.map((id) => {
          const skill = availableSkills.find((item) => item.id === id && item.enabled);
          if (!skill) throw new Error("所选 Skill 已删除或停用，请重新选择");
          return skill;
        });
        const references = savedReferences
          ? await hydrateSavedReferences(nodesRef.current, savedReferences, resourceReferenceByID, controller.signal)
          : await referencesForNodeIDs(nodesRef.current, referenceNodeIDs, resourceReferenceByID, controller.signal);
        if (controller.signal.aborted || getCachedAuthSession()?.key !== accountKey || !isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) throw new DOMException("请求已取消", "AbortError");
        const messageReferenceNodeIDs = references.map((reference) => reference.id);
        const userID = nanoid();
        assistantID = nanoid();
        const now = new Date().toISOString();
        const userMessage = { id: userID, role: "user" as const, text, references, status: "success" as const };
        if (!updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, title: current.messages.length ? current.title : text.slice(0, 18) || "新对话", messages: [...current.messages, userMessage, { id: assistantID, role: "assistant", text: "", status: "thinking", activity: "正在理解画布和创作目标" }], updatedAt: now }))) throw new DOMException("请求已取消", "AbortError");
        setInput("");
        setComposerReferenceNodeIDs([]);
        setRemovedReferenceNodeIDs(new Set(selectedNodeIDsRef.current));
        options.onUserMessageCommitted?.();
        const runInput: RunCanvasAgentInput = {
          model,
          relayTokenName,
          configuredSystemPrompt,
          apiMode: agentConfig.textApiMode || "chat",
          reasoningEnabled: agentConfig.textApiMode === "responses" && agentConfig.textReasoningEnabled === true,
          activeSkills,
          contextCheckpoint: activeSession.contextCheckpoint,
          initialState: activeSession.agentState,
          protocolMessages: activeSession.protocolMessages,
          userText: text,
          references,
          getContext: getAgentContext,
          executeAction: async (action) => {
            if (controller.signal.aborted || !isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) return { ok: false, code: "run_stale", message: "画布已切换，当前执行已停止" };
            if (action.name !== "delete_node") return onExecuteAction(action, messageReferenceNodeIDs);
            const nodeID = typeof action.arguments.nodeId === "string" ? action.arguments.nodeId : "";
            const node = nodesRef.current.find((item) => item.id === nodeID);
            const confirmed = await new Promise<boolean>((resolve) => {
              const pending = { title: node?.title || "未命名节点", resolve };
              pendingDeleteRef.current = pending;
              setPendingDelete(pending);
            });
            if (controller.signal.aborted || !isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch)) return { ok: false, code: "run_stale", message: "画布已切换，当前执行已停止" };
            return confirmed ? onExecuteAction(action, messageReferenceNodeIDs) : { ok: false, code: "delete_cancelled", message: "用户取消删除，原节点已保留" };
          },
          signal: controller.signal,
          onEvent: (event) => updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantID ? { ...message, status: event.status, activity: event.label } : message), updatedAt: new Date().toISOString() })),
          onCheckpoint: (checkpoint) => updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, agentState: checkpoint.state, protocolMessages: checkpoint.protocolMessages, contextCheckpoint: checkpoint.contextCheckpoint, activeSkillIds: selectedSkillIDs, updatedAt: new Date().toISOString() })),
        };
        const result = agentMode === "codex"
          ? await codex.run({ ...runInput, codexThreadId: activeSession.codexThreadId, codexServiceId: activeSession.codexServiceId, onThread: (codexThreadId, codexServiceId) => updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, codexThreadId, codexServiceId })) })
          : await runCanvasAgent(runInput);
        updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, agentState: result.state, protocolMessages: result.protocolMessages, contextCheckpoint: result.contextCheckpoint, activeSkillIds: selectedSkillIDs, messages: current.messages.map((message) => message.id === assistantID ? { ...message, text: result.reply, status: "success", activity: undefined } : message), updatedAt: new Date().toISOString() }));
      } catch (error) {
        const stopped = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
        const currentRun = isCurrentCanvasAgentRun(runLifecycleRef.current, runEpoch);
        if (assistantID && currentRun) updateSessionForRun(sessionID, runEpoch, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantID ? { ...message, text: stopped ? "已停止继续执行。已经创建的节点和已经提交的媒体任务会保留。" : error instanceof Error ? error.message : "Agent 执行失败", status: stopped ? "waiting" : "error", activity: undefined } : message), updatedAt: new Date().toISOString() }));
        if (!stopped && currentRun) toast.error(error instanceof Error ? error.message : "Agent 执行失败");
      } finally {
        if (releaseCanvasAgentRun(abortRef, controller)) setBusy(false);
      }
    })();
    return "started";
  }

  function retryMessage(message: CanvasAssistantMessage) {
    const index = activeSession.messages.findIndex((item) => item.id === message.id);
    const userMessage = activeSession.messages.slice(0, index).findLast((item) => item.role === "user");
    if (userMessage) void submit(userMessage.text, userMessage.references);
  }

  function clampPanelWidth(nextWidth: number) {
    const panel = panelRef.current;
    const host = panel?.parentElement;
    if (!panel || !host) return width;
    const rightInset = host.getBoundingClientRect().right - panel.getBoundingClientRect().right;
    const maximum = Math.max(0, Math.min(760, host.clientWidth - 2 * rightInset));
    return Math.min(maximum, Math.max(Math.min(320, maximum), nextWidth));
  }

  function startResize(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = panelRef.current?.getBoundingClientRect().width || width;
    const move = (event: MouseEvent) => onWidthChange(clampPanelWidth(startWidth + startX - event.clientX));
    const stop = () => {
      cleanup();
      setResizing(false);
    };
    const cleanup = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
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

  return <aside
    ref={panelRef}
    aria-label="Agent 对话面板"
    aria-hidden={!open}
    inert={!open}
    data-canvas-agent-panel
    data-state={open ? "open" : "closed"}
    className="absolute inset-y-3 right-3 z-40 flex min-h-0 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-elevated)] [container-name:agent] [container-type:size] motion-reduce:!transition-none sm:inset-y-4 sm:right-4 sm:max-w-[calc(100%-2rem)] [@media(max-height:540px)]:fixed [@media(max-height:540px)]:z-[45]"
    style={{
      width: `min(${width}px, calc(100% - 12px))`,
      transform: open ? "translateX(0)" : "translateX(calc(100% + 16px))",
      opacity: open ? 1 : 0,
      pointerEvents: open ? "auto" : "none",
      transition: resizing ? "none" : "width 150ms ease, transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease",
    }}
  >
    <button
      type="button"
      className="group absolute inset-y-0 left-0 z-40 hidden w-2 cursor-col-resize outline-none md:block"
      onMouseDown={startResize}
      aria-label="调整右侧面板宽度"
      title="拖动调整宽度，方向键微调"
      onKeyDown={(event) => {
        const delta = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0;
        if (!delta) return;
        event.preventDefault();
        onWidthChange(clampPanelWidth((panelRef.current?.clientWidth || width) + delta));
      }}
    ><span className="absolute inset-y-0 left-0 w-0.5 bg-transparent transition-colors group-hover:bg-brand/60 group-focus-visible:bg-brand" /><span className="absolute left-0.5 top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-border transition-colors group-hover:bg-brand group-focus-visible:bg-brand" /></button>
    <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_120px_auto] items-center gap-1.5 border-b px-3 py-2 @max-[340px]/agent:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 items-center gap-2"><Bot className="size-4 shrink-0 text-brand" /><span className="truncate text-sm font-semibold">{view === "history" ? "历史对话" : "Agent"}</span></div>
      <Select value={agentMode} disabled={busy} onValueChange={(value) => setAgentMode(value as "native" | "codex")}>
        <SelectTrigger aria-label="Agent 引擎" className="h-8 px-2 text-xs @max-[340px]/agent:col-span-2 @max-[340px]/agent:row-start-2"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="native">内置 Agent</SelectItem><SelectItem value="codex">Codex</SelectItem></SelectContent>
      </Select>
      <div className="flex shrink-0 items-center gap-0.5">
      <Button size="icon" className="size-8 rounded-lg" variant={view === "history" ? "secondary" : "ghost"} title={view === "history" ? "返回对话" : "历史记录"} aria-label={view === "history" ? "返回对话" : "历史记录"} onClick={() => setView((current) => current === "history" ? "chat" : "history")}><History /></Button>
      <Button size="icon" className="size-8 rounded-lg" variant="ghost" title="新对话" aria-label="新对话" disabled={busy} onClick={newSession}><MessageSquarePlus /></Button>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <Button size="icon" className="size-8 rounded-lg" variant="ghost" title="收起对话" aria-label="收起 Agent" onClick={onClose}><PanelRightClose /></Button>
      </div>
    </header>
    {agentMode === "codex" ? <CanvasCodexConnect agent={codex} busy={busy} /> : null}
    {view === "history" ? <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-2">
      <span className="min-w-0 flex-1 text-[11px] tabular-nums text-muted-foreground">{checkedSessionIDs.length ? `已选 ${checkedSessionIDs.length} 条` : `共 ${historySessions.length} 条对话`}</span>
      <Button size="sm" className="h-7 gap-1 px-2 text-[11px]" variant="ghost" aria-label="删除所选对话" disabled={busy || !checkedSessionIDs.length} onClick={() => setDeleteSessionIDs(checkedSessionIDs)}><Trash2 className="size-3" />删除所选</Button>
      <Button size="sm" className="h-7 px-2 text-[11px]" variant="ghost" aria-label="删除全部对话" disabled={busy || !historySessions.length} onClick={() => setDeleteSessionIDs(historySessions.map((item) => item.id))}>清空</Button>
    </div> : null}
    <ScrollArea className="min-h-0 flex-1" viewportRef={messageListRef} viewportClassName="p-3"><div className="space-y-3">{view === "history" ? <AssistantHistory sessions={historySessions} activeSession={activeSession} checkedIDs={checkedSessionIDs} deleteDisabled={busy} onToggleChecked={(id, checked) => setCheckedSessionIDs((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id))} onOpen={(id) => { commit(sessionsRef.current, id); setView("chat"); }} onDelete={(id) => setDeleteSessionIDs([id])} onRename={(id, nextTitle) => commit(sessionsRef.current.map((item) => item.id === id ? { ...item, title: nextTitle, updatedAt: new Date().toISOString() } : item))} /> : activeSession.messages.length ? <AssistantMessages messages={activeSession.messages} nodes={nodes} onFocusNode={onFocusNode} onRetry={retryMessage} /> : <div className="flex min-h-[min(18rem,46cqh)] flex-col items-center justify-center px-4 py-5 text-center"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><Sparkles className="size-5" /></div><div className="mt-3 text-sm font-medium">从一个想法开始</div><div className="mt-1.5 max-w-[260px] text-xs leading-5 text-muted-foreground">描述创作目标，Agent 会与你沟通并直接操作当前画布</div></div>}</div></ScrollArea>
    {view === "chat" ? <div className="max-h-[60%] shrink-0 overflow-y-auto overscroll-contain border-t bg-muted/15 p-2">
      {pendingDelete ? <div className="mb-2 overflow-hidden rounded-lg border"><div className="px-3 py-2"><p className="truncate text-xs font-medium">删除“{pendingDelete.title}”？</p><p className="mt-1 text-[11px] text-muted-foreground">相关连线和任务记录将按现有逻辑清理</p></div><div className="grid grid-cols-2 border-t"><button type="button" className="h-8 text-xs hover:bg-muted" onClick={() => settleDeleteConfirmation(false)}>取消</button><button type="button" className="h-8 border-l text-xs font-medium text-destructive hover:bg-muted dark:text-rose-300" onClick={() => settleDeleteConfirmation(true)}>确认删除</button></div></div> : null}
      <div className="rounded-xl border border-border bg-card p-2.5 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
        <CanvasAgentPromptChipInput
          value={input}
          references={resourceReferences}
          pendingReferences={pendingReferences}
          onChange={setInput}
          onReferenceIDsChange={(ids) => {
            consumedReferenceNodeClickVersionRef.current = referenceNodeClick.version;
            const removedSelectedIDs = composerReferenceNodeIDs.filter((id) => selectedNodeIDsRef.current.includes(id) && !ids.includes(id));
            if (removedSelectedIDs.length) setRemovedReferenceNodeIDs((current) => new Set([...current, ...removedSelectedIDs]));
            setComposerReferenceNodeIDs(ids);
          }}
          onPasteImage={onPasteImage}
          onSubmit={(prompt, referenceIDs) => void submit(prompt, undefined, referenceIDs)}
          className="min-h-[min(5rem,16cqh)] max-h-[min(220px,24cqh)] w-full px-1 py-0 text-sm leading-5"
          placeholder="描述创作目标，或让我继续操作画布"
          placeholderClassName="!left-1 !top-0"
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <CanvasAgentSkillPicker selectedIds={activeSession.activeSkillIds ?? agentConfig.activeSkillIds ?? []} onChange={(activeSkillIds) => commit(sessionsRef.current.map((item) => item.id === activeSessionID ? { ...item, activeSkillIds, updatedAt: new Date().toISOString() } : item))} disabled={busy} />
          <Popover>
            <PopoverTrigger asChild><Button size="sm" variant="ghost" className="gap-1.5" disabled={busy}><Settings2 className="size-4" />运行设置</Button></PopoverTrigger>
            <PopoverContent aria-label="运行设置" className="w-80 p-4" side="top" align="start">
              <div className="space-y-4">
                <p className="text-sm font-semibold">运行设置</p>
                <div className="space-y-2">
                  <label className="flex items-center justify-between gap-4 text-sm font-medium">
                    <span>自动生成媒体</span>
                    <Switch aria-label="自动生成媒体" aria-describedby="canvas-agent-auto-generate-description" checked={agentConfig.autoGenerateMedia === true} onCheckedChange={(checked) => onAgentConfigChange({ autoGenerateMedia: checked })} />
                  </label>
                  <p id="canvas-agent-auto-generate-description" className="text-xs leading-5 text-muted-foreground">关闭时仅创建节点和参数，由你确认后生成。</p>
                </div>
                {agentMode === "native" ? <>
                  <div className="space-y-2 border-y border-border py-4">
                    <label htmlFor="canvas-agent-text-protocol" className="text-sm font-medium">请求协议</label>
                    <Select value={agentConfig.textApiMode || "chat"} onValueChange={(value) => onAgentConfigChange({ textApiMode: value as "chat" | "responses", ...(value === "chat" ? { textReasoningEnabled: false } : {}) })}>
                      <SelectTrigger id="canvas-agent-text-protocol" aria-label="Agent 请求协议"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="chat">Chat</SelectItem><SelectItem value="responses">Responses</SelectItem></SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="flex items-center justify-between gap-4 text-sm font-medium">
                      <span className="flex items-center gap-2"><Brain className="size-4 text-muted-foreground" />深入思考</span>
                      <Switch aria-label="深入思考" aria-describedby="canvas-agent-reasoning-description" disabled={agentConfig.textApiMode !== "responses"} checked={agentConfig.textReasoningEnabled === true && agentConfig.textApiMode === "responses"} onCheckedChange={(checked) => onAgentConfigChange({ textReasoningEnabled: checked })} />
                    </label>
                    <p id="canvas-agent-reasoning-description" className="text-xs leading-5 text-muted-foreground">仅支持 Responses 协议，Chat 模式下不可用。</p>
                  </div>
                </> : null}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <AgentAssetMenu onOpenUpload={onOpenUpload} onOpenAssets={onOpenAssets} />
          <AgentParameterMenu icon={<ImageIcon />} label="图片参数" summary={canvasAgentImageSettingsSummary(agentConfig.imageQuality, agentConfig.imageSize)}><CanvasAgentImageSettings model={imageModel} quality={agentConfig.imageQuality} size={agentConfig.imageSize} onChange={onAgentConfigChange} /></AgentParameterMenu>
          <AgentParameterMenu icon={<Video />} label="视频参数" summary={canvasAgentVideoSettingsSummary(agentConfig.videoQuality, agentConfig.videoSize)}><CanvasAgentVideoSettings model={videoModel} quality={agentConfig.videoQuality} size={agentConfig.videoSize} onChange={onAgentConfigChange} /></AgentParameterMenu>
          <Button type="button" size="icon" className="size-9 shrink-0 rounded-full" disabled={!busy && !input.trim()} aria-label={busy ? "停止" : "发送"} onClick={() => busy ? (settleDeleteConfirmation(false), abortCanvasAgentRun(abortRef)) : void submit()}>{busy ? <Square className="fill-current" /> : <ArrowUp />}</Button>
        </div>
      </div>
    </div> : null}
    <Dialog open={deleteSessionIDs.length > 0} onOpenChange={(open) => !open && setDeleteSessionIDs([])}><DialogContent className="w-[min(92vw,420px)]"><DialogHeader><DialogTitle>删除对话记录？</DialogTitle><DialogDescription>将删除 {deleteSessionIDs.length} 条对话记录，此操作不可撤销。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setDeleteSessionIDs([])}>取消</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => { if (busy) return; removeSessions(deleteSessionIDs); setDeleteSessionIDs([]); }}>删除</Button></DialogFooter></DialogContent></Dialog>
    {codexApproval.dialog}
  </aside>;
}

function AgentAssetMenu({ onOpenUpload, onOpenAssets }: { onOpenUpload: () => void; onOpenAssets: () => void }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" size="icon" variant="secondary" className="size-9 shrink-0 rounded-lg" aria-label="添加 Agent 素材"><Menu /></Button></PopoverTrigger><PopoverContent side="top" align="start" className="w-40 p-1.5"><button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted" onClick={() => { setOpen(false); onOpenUpload(); }}><Upload className="size-4" />上传文件</button><button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted" onClick={() => { setOpen(false); onOpenAssets(); }}><FolderOpen className="size-4" />我的素材</button></PopoverContent></Popover>;
}

function AgentParameterMenu({ icon, label, summary, children }: { icon: React.ReactNode; label: string; summary: string; children: React.ReactNode }) {
  return <Popover><PopoverTrigger asChild><Button type="button" variant="secondary" className="h-9 min-w-0 flex-1 gap-1 rounded-lg px-1.5 text-[11px] [&_svg]:size-3.5" aria-label={`${label}：${summary}`} title={`${label}：${summary}`}>{icon}<span className="truncate @min-[360px]/agent:hidden">{label.slice(0, 2)}</span><span className="hidden truncate @min-[360px]/agent:inline">{summary}</span></Button></PopoverTrigger><PopoverContent side="top" align="center" scrollable={false} className="w-[min(calc(100vw-2rem),23rem)] overflow-hidden p-0"><ScrollArea className="min-h-0 max-h-[min(70dvh,32rem)] flex-1"><div className="space-y-3 p-3 pr-4"><p className="text-xs font-semibold">{label}</p>{children}</div></ScrollArea></PopoverContent></Popover>;
}

const ASSISTANT_MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4" />,
};

function AssistantMarkdown({ children, components = ASSISTANT_MARKDOWN_COMPONENTS }: { children: string; components?: Components }) {
  return <div className={cn("min-w-0 whitespace-normal break-words", "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0", "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h1:first-child]:mt-0", "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2:first-child]:mt-0", "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:font-semibold [&_h3:first-child]:mt-0", "[&_h4]:my-2 [&_h4]:font-semibold", "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1", "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[color:var(--agent-markdown-border)] [&_blockquote]:pl-3 [&_blockquote]:opacity-80", "[&_hr]:my-3 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[color:var(--agent-markdown-border)]", "[&_code]:rounded [&_code]:bg-[var(--agent-markdown-surface)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]", "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--agent-markdown-surface)] [&_pre]:p-3", "[&_pre_code]:bg-transparent [&_pre_code]:p-0", "[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-[color:var(--agent-markdown-border)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_td]:border-b [&_td]:border-[color:var(--agent-markdown-border)] [&_td]:px-2 [&_td]:py-1.5")} style={{ "--agent-markdown-surface": "var(--muted)", "--agent-markdown-border": "var(--border)" } as CSSProperties}><ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{children}</ReactMarkdown></div>;
}

function AssistantMessages({ messages, nodes, onFocusNode, onRetry }: { messages: CanvasAssistantMessage[]; nodes: CanvasNode[]; onFocusNode?: (nodeID: string) => void; onRetry: (message: CanvasAssistantMessage) => void }) {
  const components = useMemo<Components>(() => ({ ...ASSISTANT_MARKDOWN_COMPONENTS, code: ({ children, className, node: markdownNode, ...props }) => {
    const node = nodes.find((item) => item.id === String(children).trim());
    if (!node || className || !onFocusNode || markdownNode?.position?.start.line !== markdownNode?.position?.end.line) return <code className={className} {...props}>{children}</code>;
    return <button type="button" className="my-1 inline-flex max-w-full items-center gap-2 rounded-lg border px-2 py-1 text-left align-middle" title={`定位到 ${node.title || node.type}`} onClick={() => onFocusNode(node.id)}>{(node.type === "image" || node.type === "panorama") && node.url ? <AuthenticatedImage src={node.thumbnail_url || node.url} alt="" className="size-9 rounded object-cover" /> : <BookOpen className="size-4 shrink-0" />}<span className="truncate text-sm">{node.title || node.type}</span>{node.generation_status ? <span className="text-xs text-muted-foreground">{{ loading: "生成中", success: "已完成", error: "失败", idle: "待生成" }[node.generation_status]}</span> : null}</button>;
  } }), [nodes, onFocusNode]);
  return <>{messages.map((message) => {
    const running = message.status === "thinking" || message.status === "running";
    return <div key={message.id} className={cn("flex flex-col gap-2", message.role === "user" ? "items-end" : "items-start")}>
      {message.text ? <div className={cn("min-w-0 max-w-[88%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm leading-6", message.role === "user" ? "bg-brand-soft" : "bg-muted")}>
        {message.role === "assistant" ? <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Bot className="size-3.5" />Agent</div> : null}
        {message.role === "assistant" ? <AssistantMarkdown components={components}>{message.text}</AssistantMarkdown> : <UserMessageContent message={message} />}
      </div> : null}
      {running ? <div className="flex w-64 max-w-full items-center gap-2 rounded-xl border px-3 py-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{message.activity || "正在执行"}</div> : null}
      {!running && message.text ? <div className="flex gap-1"><Button size="icon" variant="ghost" className="size-7" title="复制消息" aria-label="复制消息" onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(message.text)).then(() => toast.success("已复制")).catch(() => toast.error("复制失败")); }}><Copy className="size-3.5" /></Button>{message.role === "assistant" ? <Button size="icon" variant="outline" className="size-7 rounded-full" title="重试" aria-label="重试" onClick={() => onRetry(message)}><RotateCcw className="size-3.5" /></Button> : null}</div> : null}
    </div>;
  })}</>;
}

function AssistantHistory({ sessions, activeSession, checkedIDs, deleteDisabled, onToggleChecked, onOpen, onDelete, onRename }: { sessions: CanvasAssistantSession[]; activeSession: CanvasAssistantSession; checkedIDs: string[]; deleteDisabled: boolean; onToggleChecked: (id: string, checked: boolean) => void; onOpen: (id: string) => void; onDelete: (id: string) => void; onRename: (id: string, title: string) => void }) {
  const [editingID, setEditingID] = useState("");
  if (!sessions.length) return <EmptyState icon={History} title="暂无历史对话" compact />;
  return <div className="space-y-1">{sessions.map((item) => <div key={item.id} className={cn("group flex items-center gap-2 rounded-lg px-2 py-1.5", item.id === activeSession.id && "bg-muted")}><Checkbox className="shrink-0" aria-label={`选择对话 ${item.title}`} checked={checkedIDs.includes(item.id)} onCheckedChange={(checked) => onToggleChecked(item.id, checked === true)} /><div className="min-w-0 flex-1">{editingID === item.id ? <input aria-label="对话名称" className="w-full rounded border bg-background px-1 text-sm" defaultValue={item.title} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = item.title; setEditingID(""); } }} onBlur={(event) => { const nextTitle = event.target.value.trim(); if (nextTitle) onRename(item.id, nextTitle); setEditingID(""); }} /> : <button type="button" className="w-full text-left text-sm" onClick={() => onOpen(item.id)}><span className="block truncate">{item.title}</span><span className="text-xs text-muted-foreground">{item.messages.length} 条消息</span></button>}</div><Button size="icon" variant="ghost" className="size-7" title="重命名" aria-label={`重命名对话 ${item.title}`} disabled={deleteDisabled} onClick={() => setEditingID(item.id)}><Pencil className="size-3.5" /></Button><Button size="icon" variant="ghost" className="size-7 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" title="删除" aria-label={`删除对话 ${item.title}`} disabled={deleteDisabled} onClick={() => onDelete(item.id)}><Trash2 className="size-3.5" /></Button></div>)}</div>;
}

function UserMessageContent({ message }: { message: CanvasAssistantMessage }) {
  const references = useMemo(() => message.references?.map(assistantToPromptReference) || [], [message.references]);
  return <CanvasAgentPromptChipInput value={message.text} references={references} onChange={() => undefined} readOnly />;
}

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
    const node = nodeByID.get(reference.id);
    return node && referenceByID.has(reference.id) ? canvasAgentReferenceFromNode(node, referenceByID.get(reference.id)?.label || reference.label, signal) : reference;
  }));
}

async function canvasAgentReferenceFromNode(node: CanvasNode, label?: string, signal?: AbortSignal): Promise<CanvasAssistantReference> {
  let dataUrl: string | undefined;
  if ((node.type === "image" || node.type === "panorama") && node.url) {
    try {
      const blob = await fetchAuthenticatedImageBlob(node.url, signal);
      dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("读取引用失败")); reader.onload = () => resolve(String(reader.result || "")); reader.readAsDataURL(blob); });
    } catch {
      if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
      dataUrl = node.url;
    }
  }
  return { id: node.id, type: node.type, title: node.title || node.type, label: label || node.title || node.id, dataUrl, url: node.url, mimeType: node.mime_type, text: node.type === "text" ? node.prompt : undefined };
}
